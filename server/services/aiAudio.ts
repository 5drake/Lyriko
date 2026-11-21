import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import type { LyricLine, PitchNote } from '../../shared/types.js';
import { enrichLinesWithAlignRomaji, enrichLinesWithMoras } from './jpKorean.js';
import {
  CACHE_DIR,
  DATA_DIR,
  ensureDataDirs,
  getMediaFilePath,
  ROOT_DIR,
  saveMediaMeta,
  UPLOADS_DIR,
} from './storage.js';

const execFileAsync = promisify(execFile);

const ANALYZE_SCRIPT_PATH = path.join(ROOT_DIR, 'server', 'scripts', 'ai_audio_analyze.py');
const ALIGN_SCRIPT_PATH = path.join(ROOT_DIR, 'server', 'scripts', 'ai_align_lyrics.py');
const EXTRACT_PITCH_SCRIPT_PATH = path.join(ROOT_DIR, 'server', 'scripts', 'ai_extract_pitch.py');
const MODELS_DIR = path.join(DATA_DIR, 'models');

export function findAiPythonPath(): string | null {
  const candidates = [
    process.env.LYRIKO_PYTHON,
    process.env.UTAKANA_PYTHON,
    path.join(ROOT_DIR, 'python', 'python.exe'),
    path.join(ROOT_DIR, 'server', 'ai-env', 'Scripts', 'python.exe'),
    'C:\\Users\\5drak\\ComfyUI_windows_portable\\python_embeded\\python.exe',
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let cachedGpuInfoPromise: Promise<{ available: boolean; name: string; vramMb?: number }> | null = null;

export function getWorkerGpuInfo(): Promise<{ available: boolean; name: string; vramMb?: number }> {
  if (!cachedGpuInfoPromise) {
    cachedGpuInfoPromise = execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2500, windowsHide: true }
    )
      .then(({ stdout }) => {
        const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
        const parts = line.split(',').map((s) => s.trim());
        if (parts[0]) {
          const vramMb = parts[1] ? Math.round(Number(parts[1])) : undefined;
          return {
            available: true,
            name: parts[0],
            ...(Number.isFinite(vramMb) ? { vramMb } : {}),
          };
        }
        return { available: false, name: 'CPU' };
      })
      .catch(() => ({ available: false, name: 'CPU' }));
  }
  return cachedGpuInfoPromise;
}

export function isAiAudioAvailable(): boolean {
  return Boolean(findAiPythonPath() && fs.existsSync(ANALYZE_SCRIPT_PATH) && ffmpegPath);
}

function buildPythonEnv(): NodeJS.ProcessEnv {
  const ffmpegDir = ffmpegPath ? path.dirname(ffmpegPath) : '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TORCH_HOME: MODELS_DIR,
    PYTHONIOENCODING: 'utf-8',
  };
  if (ffmpegDir) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const currentPath = env[pathKey] || '';
    env[pathKey] = `${ffmpegDir}${path.delimiter}${currentPath}`;
  }
  return env;
}

export interface AiAudioAnalysisStats {
  device: string;
  engine?: string;
  sourceStem: string;
  duration: number;
  noteCount: number;
  minMidi: number;
  maxMidi: number;
}

export interface AiAudioAnalysisResult {
  mrFileId: string;
  mrFileName: string;
  vocalFileId: string;
  vocalFileName: string;
  pitchNotes: PitchNote[];
  stats: AiAudioAnalysisStats;
}

export interface AiAlignLyricsResult {
  lines: LyricLine[];
  stats: {
    device: string;
    model: string;
    globalShiftSec?: number;
    alignedLines: number;
    alignedSegments: number;
    totalSegments: number;
    disambiguatedCount?: number;
  };
}

export interface AiExtractPitchResult {
  pitchNotes: PitchNote[];
  syncedLines?: LyricLine[];
  stats: {
    device: string;
    engine?: string;
    source?: 'vocal' | 'karaoke';
    cachedVocal: boolean;
    preset: string;
    lyricLinked: boolean;
    detectedKey?: string;
    noteCount: number;
    minMidi: number;
    maxMidi: number;
    medianMidi: number;
  };
}

export interface AiAudioJob {
  id: string;
  status: 'preparing' | 'separating' | 'analyzing' | 'aligning' | 'done' | 'error';
  percent: number;
  message: string;
  result?: AiAudioAnalysisResult | AiAlignLyricsResult | AiExtractPitchResult;
  error?: string;
  createdAt: number;
}

interface CachedAiAnalysisV2 {
  mrFileId: string;
  mrFileName: string;
  vocalFileId: string;
  vocalFileName: string;
  rawNotes: PitchNote[];
  stats: AiAudioAnalysisStats;
}

const aiJobs = new Map<string, AiAudioJob>();

function pruneOldAiJobs(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of aiJobs.entries()) {
    if (v.createdAt < cutoff) aiJobs.delete(k);
  }
}

export function getAiAudioJob(jobId: string): AiAudioJob | null {
  return aiJobs.get(jobId) ?? null;
}

function filterNotesByLyrics(notes: PitchNote[], lines?: LyricLine[]): PitchNote[] {
  if (!lines || lines.length === 0) return notes;
  return notes.filter((n) =>
    lines.some((l) => n.endTime >= l.startTime - 0.5 && n.startTime <= l.endTime + 0.5)
  );
}

export function startAiAudioAnalyzeJob(opts: {
  audioFileId: string;
  lines?: LyricLine[];
  sensitivity?: number;
  force?: boolean;
}): AiAudioJob {
  pruneOldAiJobs();

  const media = getMediaFilePath(opts.audioFileId);
  if (!media) {
    throw new Error('분석할 음원 파일을 찾을 수 없습니다.');
  }

  const jobId = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: AiAudioJob = {
    id: jobId,
    status: 'preparing',
    percent: 3,
    message: 'AI 보컬·MR 분리 준비 중...',
    createdAt: Date.now(),
  };
  aiJobs.set(jobId, job);

  void runAiAnalyzeJob(job, opts.audioFileId, media.filePath, media.meta.originalName, opts);
  return job;
}

async function runAiAnalyzeJob(
  job: AiAudioJob,
  audioFileId: string,
  audioPath: string,
  originalName: string,
  opts: { lines?: LyricLine[]; sensitivity?: number; force?: boolean }
): Promise<void> {
  ensureDataDirs();
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const safeId = path.basename(audioFileId).replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheJsonPath = path.join(CACHE_DIR, `${safeId}_ai_analysis_v2.json`);

  if (!opts.force && fs.existsSync(cacheJsonPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheJsonPath, 'utf-8')) as CachedAiAnalysisV2;
      if (
        cached.mrFileId &&
        cached.vocalFileId &&
        getMediaFilePath(cached.mrFileId) &&
        getMediaFilePath(cached.vocalFileId)
      ) {
        const filteredNotes = filterNotesByLyrics(cached.rawNotes, opts.lines);
        job.status = 'done';
        job.percent = 100;
        job.message = `캐시된 BS-Roformer 분석 로드 완료 (${filteredNotes.length}개 노트)`;
        job.result = {
          mrFileId: cached.mrFileId,
          mrFileName: cached.mrFileName,
          vocalFileId: cached.vocalFileId,
          vocalFileName: cached.vocalFileName,
          pitchNotes: filteredNotes,
          stats: {
            ...cached.stats,
            noteCount: filteredNotes.length,
            minMidi: filteredNotes.reduce((m, n) => Math.min(m, n.midi), 127) || 0,
            maxMidi: filteredNotes.reduce((m, n) => Math.max(m, n.midi), 0) || 0,
          },
        };
        return;
      }
    } catch {
      // ignore invalid cache
    }
  }

  const pyPath = findAiPythonPath();
  if (!pyPath) {
    job.status = 'error';
    job.error = 'GPU AI 오디오 분석용 Python 환경을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }
  if (!ffmpegPath) {
    job.status = 'error';
    job.error = 'FFmpeg 실행 파일을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }

  const tag = `${safeId}_${Date.now().toString(36)}`;
  const tmpInputWav = path.join(CACHE_DIR, `${tag}_in.wav`);
  const tmpMrWav = path.join(CACHE_DIR, `${tag}_mr.wav`);
  const tmpVocalsWav = path.join(CACHE_DIR, `${tag}_vocals.wav`);
  const tmpNotesJson = path.join(CACHE_DIR, `${tag}_notes.json`);

  const cleanupTemps = () => {
    for (const p of [tmpInputWav, tmpMrWav, tmpVocalsWav, tmpNotesJson]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  };

  try {
    job.status = 'preparing';
    job.percent = 5;
    job.message = '오디오를 AI 분석용 44.1kHz WAV로 디코딩 중...';

    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', audioPath, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', tmpInputWav],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const sensitivity = Math.max(0.1, Math.min(0.45, Number(opts.sensitivity) || 0.25));

    let stderrTail = '';
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(
        pyPath,
        [
          ANALYZE_SCRIPT_PATH,
          '--input',
          tmpInputWav,
          '--mr-out',
          tmpMrWav,
          '--vocals-out',
          tmpVocalsWav,
          '--notes-out',
          tmpNotesJson,
          '--models-dir',
          MODELS_DIR,
          '--sensitivity',
          String(sensitivity),
        ],
        {
          windowsHide: true,
          env: buildPythonEnv(),
        }
      );

      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const m = line.match(/^PROGRESS:(\d+):(.*)$/);
          if (m) {
            const pct = Math.min(93, Math.max(job.percent, Number(m[1])));
            job.percent = pct;
            job.status = pct >= 76 ? 'analyzing' : 'separating';
            job.message = m[2].trim();
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-3000);
      });

      proc.on('error', reject);
      proc.on('close', (code) => resolve(code ?? 1));
    });

    if (
      exitCode !== 0 ||
      !fs.existsSync(tmpMrWav) ||
      !fs.existsSync(tmpVocalsWav) ||
      !fs.existsSync(tmpNotesJson)
    ) {
      job.status = 'error';
      job.error = `AI 오디오 분리 실패 (code ${exitCode}): ${stderrTail.slice(-350)}`;
      job.message = job.error;
      cleanupTemps();
      return;
    }

    job.status = 'analyzing';
    job.percent = 95;
    job.message = '고음질 AI MR · 보컬 트랙 저장 중...';

    const baseTitle = path.parse(originalName).name;

    const mrFileId = `media_aimr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const mrStoredName = `${mrFileId}.mp3`;
    const mrOutPath = path.join(UPLOADS_DIR, mrStoredName);

    const vocalFileId = `media_aivox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const vocalStoredName = `${vocalFileId}.mp3`;
    const vocalOutPath = path.join(UPLOADS_DIR, vocalStoredName);

    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', tmpMrWav, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2', mrOutPath],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', tmpVocalsWav, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2', vocalOutPath],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const mrStat = fs.statSync(mrOutPath);
    const vocalStat = fs.statSync(vocalOutPath);
    const mrFileName = `[AI MR] ${baseTitle}.mp3`;
    const vocalFileName = `[AI 보컬] ${baseTitle}.mp3`;

    saveMediaMeta({
      id: mrFileId,
      kind: 'audio',
      originalName: mrFileName,
      storedName: mrStoredName,
      mimeType: 'audio/mpeg',
      size: mrStat.size,
      createdAt: new Date().toISOString(),
    });
    saveMediaMeta({
      id: vocalFileId,
      kind: 'audio',
      originalName: vocalFileName,
      storedName: vocalStoredName,
      mimeType: 'audio/mpeg',
      size: vocalStat.size,
      createdAt: new Date().toISOString(),
    });

    const parsed = JSON.parse(fs.readFileSync(tmpNotesJson, 'utf-8')) as {
      notes: PitchNote[];
      stats: AiAudioAnalysisStats;
    };

    const cachePayload: CachedAiAnalysisV2 = {
      mrFileId,
      mrFileName,
      vocalFileId,
      vocalFileName,
      rawNotes: parsed.notes,
      stats: parsed.stats,
    };
    fs.writeFileSync(cacheJsonPath, JSON.stringify(cachePayload), 'utf-8');

    const filteredNotes = filterNotesByLyrics(parsed.notes, opts.lines);
    job.status = 'done';
    job.percent = 100;
    job.message = `고음질 AI 보컬·MR 분리 완료 (${parsed.stats.engine || 'bs-roformer'})`;
    job.result = {
      mrFileId,
      mrFileName,
      vocalFileId,
      vocalFileName,
      pitchNotes: filteredNotes,
      stats: {
        ...parsed.stats,
        noteCount: filteredNotes.length,
        minMidi: filteredNotes.reduce((m, n) => Math.min(m, n.midi), 127) || 0,
        maxMidi: filteredNotes.reduce((m, n) => Math.max(m, n.midi), 0) || 0,
      },
    };
  } catch (err) {
    job.status = 'error';
    job.error = `AI 분리 오류: ${err instanceof Error ? err.message : String(err)}`;
    job.message = job.error;
  } finally {
    cleanupTemps();
  }
}

function resolveExistingVocalPath(safeId: string, vocalFileId?: string): string {
  if (vocalFileId) {
    const vMedia = getMediaFilePath(vocalFileId);
    if (vMedia) return vMedia.filePath;
  }
  const cacheJsonPath = path.join(CACHE_DIR, `${safeId}_ai_analysis_v2.json`);
  if (fs.existsSync(cacheJsonPath)) {
    try {
      const cached = JSON.parse(
        fs.readFileSync(cacheJsonPath, 'utf-8')
      ) as CachedAiAnalysisV2;
      if (cached.vocalFileId) {
        const vMedia = getMediaFilePath(cached.vocalFileId);
        if (vMedia) return vMedia.filePath;
      }
    } catch {
      // ignore invalid cache
    }
  }
  return '';
}

async function runPythonWithProgress(
  pyPath: string,
  pyArgs: string[],
  job: AiAudioJob
): Promise<{ exitCode: number; stderrTail: string }> {
  let stderrTail = '';
  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(pyPath, pyArgs, {
      windowsHide: true,
      env: buildPythonEnv(),
    });

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const outLines = buf.split(/\r?\n/);
      buf = outLines.pop() ?? '';
      for (const l of outLines) {
        const m = l.match(/^PROGRESS:(\d+):(.*)$/);
        if (m) {
          job.percent = Math.min(99, Math.max(job.percent, Number(m[1])));
          job.message = m[2].trim();
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-3000);
    });

    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });
  return { exitCode, stderrTail };
}

export function startAiAlignLyricsJob(opts: {
  audioFileId: string;
  vocalFileId?: string;
  lines: LyricLine[];
  model?: string;
}): AiAudioJob {
  pruneOldAiJobs();

  const sourceId = opts.audioFileId || opts.vocalFileId || '';
  const media = getMediaFilePath(sourceId);
  if (!media) {
    throw new Error('정렬할 원곡 음원 파일을 찾을 수 없습니다.');
  }
  if (!Array.isArray(opts.lines) || opts.lines.length === 0) {
    throw new Error('정렬할 가사가 없습니다.');
  }

  ensureDataDirs();
  const safeId = path.basename(sourceId).replace(/[^a-zA-Z0-9_-]/g, '');
  const vocalCachePath = path.join(CACHE_DIR, `${safeId}_align_vocals_16k.wav`);
  const existingVocalPath = resolveExistingVocalPath(safeId, opts.vocalFileId);

  const jobId = `align_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: AiAudioJob = {
    id: jobId,
    status: 'aligning',
    percent: 4,
    message: 'AI 가사 음소 정렬 준비 중...',
    createdAt: Date.now(),
  };
  aiJobs.set(jobId, job);

  void runAiAlignJob(
    job,
    media.filePath,
    vocalCachePath,
    existingVocalPath,
    opts.lines
  );
  return job;
}

async function runAiAlignJob(
  job: AiAudioJob,
  audioPath: string,
  vocalCachePath: string,
  existingVocalPath: string,
  lines: LyricLine[]
): Promise<void> {
  ensureDataDirs();
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const pyPath = findAiPythonPath();
  if (!pyPath || !fs.existsSync(ALIGN_SCRIPT_PATH)) {
    job.status = 'error';
    job.error = '가사 강제 정렬 Python 환경을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }
  if (!ffmpegPath) {
    job.status = 'error';
    job.error = 'FFmpeg 실행 파일을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }

  const tag = `align_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const tmpInJson = path.join(CACHE_DIR, `${tag}_in.json`);
  const tmpOutJson = path.join(CACHE_DIR, `${tag}_out.json`);

  try {
    job.percent = 6;
    job.message = '히라가나 발음 음소(Romaji) 변환 중...';
    const enrichedLines = await enrichLinesWithAlignRomaji(lines);
    fs.writeFileSync(tmpInJson, JSON.stringify(enrichedLines), 'utf-8');

    const pyArgs = [
      ALIGN_SCRIPT_PATH,
      '--audio',
      audioPath,
      '--vocal-cache',
      vocalCachePath,
      '--lines-in',
      tmpInJson,
      '--lines-out',
      tmpOutJson,
      '--models-dir',
      MODELS_DIR,
    ];
    if (existingVocalPath) {
      pyArgs.push('--existing-vocal', existingVocalPath);
    }

    const { exitCode, stderrTail } = await runPythonWithProgress(pyPath, pyArgs, job);

    if (exitCode !== 0 || !fs.existsSync(tmpOutJson)) {
      job.status = 'error';
      job.error = `보컬 음소 가사 정렬 실패 (code ${exitCode}): ${stderrTail.slice(-350)}`;
      job.message = job.error;
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(tmpOutJson, 'utf-8')) as AiAlignLyricsResult;
    const disambigNote =
      (parsed.stats.disambiguatedCount ?? 0) > 0
        ? ` · 다중독음 ${parsed.stats.disambiguatedCount}건 자동 보정`
        : '';
    job.status = 'done';
    job.percent = 100;
    job.message = `보컬 음소 정밀 싱크 완료 (${parsed.stats.alignedLines}소절${disambigNote})`;
    job.result = parsed;
  } catch (err) {
    job.status = 'error';
    job.error = `가사 정렬 오류: ${err instanceof Error ? err.message : String(err)}`;
    job.message = job.error;
  } finally {
    for (const p of [tmpInJson, tmpOutJson]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }
}

export function startAiExtractPitchJob(opts: {
  audioFileId?: string;
  vocalFileId?: string;
  karaokeAudioFileId?: string;
  karaokeSyncOffset?: number;
  mrAudioFileId?: string;
  mrSyncOffset?: number;
  source?: 'vocal' | 'karaoke';
  lines?: LyricLine[];
  preset?: 'precise' | 'balanced' | 'smooth';
  restrictToLyrics?: boolean;
  lyricLinked?: boolean;
  syncLyricsTogether?: boolean;
}): AiAudioJob {
  pruneOldAiJobs();

  const sourceMode: 'vocal' | 'karaoke' =
    opts.source === 'karaoke' ? 'karaoke' : 'vocal';
  const origId = opts.audioFileId || opts.vocalFileId || '';
  const origMedia = origId ? getMediaFilePath(origId) : null;
  const karaokeMedia = opts.karaokeAudioFileId
    ? getMediaFilePath(opts.karaokeAudioFileId)
    : null;
  const mrMedia = opts.mrAudioFileId ? getMediaFilePath(opts.mrAudioFileId) : null;

  if (sourceMode === 'karaoke' && !karaokeMedia) {
    throw new Error('노래방(가이드 멜로디) 음원 파일이 연결되어 있지 않습니다.');
  }
  if (sourceMode === 'vocal' && !origMedia) {
    throw new Error('음정을 추출할 원곡 음원 파일을 찾을 수 없습니다.');
  }

  ensureDataDirs();
  const baseCacheId = origId || opts.karaokeAudioFileId || 'track';
  const safeId = path.basename(baseCacheId).replace(/[^a-zA-Z0-9_-]/g, '');
  const vocalCachePath = path.join(CACHE_DIR, `${safeId}_align_vocals_16k.wav`);
  const existingVocalPath = origId ? resolveExistingVocalPath(safeId, opts.vocalFileId) : '';
  const preset =
    opts.preset === 'precise' || opts.preset === 'smooth' ? opts.preset : 'balanced';
  const restrictToLyrics = opts.restrictToLyrics !== false;
  const lines = opts.lines ?? [];
  const lyricLinked = opts.lyricLinked !== false && lines.length > 0;
  const syncLyricsTogether = opts.syncLyricsTogether !== false && lyricLinked;

  const jobId = `pitch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: AiAudioJob = {
    id: jobId,
    status: 'analyzing',
    percent: 4,
    message:
      sourceMode === 'karaoke'
        ? '노래방 가이드 멜로디 추출 준비 중...'
        : 'GAME 딥러닝 보컬 채보 준비 중...',
    createdAt: Date.now(),
  };
  aiJobs.set(jobId, job);

  void runAiExtractPitchJob(job, {
    audioPath: origMedia?.filePath || '',
    vocalCachePath,
    existingVocalPath,
    karaokeAudioPath: karaokeMedia?.filePath || '',
    karaokeOffset: Number(opts.karaokeSyncOffset) || 0,
    mrAudioPath: mrMedia?.filePath || '',
    mrOffset: Number(opts.mrSyncOffset) || 0,
    sourceMode,
    lines,
    preset,
    restrictToLyrics,
    lyricLinked,
    syncLyricsTogether,
  });
  return job;
}

async function runAiExtractPitchJob(
  job: AiAudioJob,
  opts: {
    audioPath: string;
    vocalCachePath: string;
    existingVocalPath: string;
    karaokeAudioPath: string;
    karaokeOffset: number;
    mrAudioPath: string;
    mrOffset: number;
    sourceMode: 'vocal' | 'karaoke';
    lines: LyricLine[];
    preset: 'precise' | 'balanced' | 'smooth';
    restrictToLyrics: boolean;
    lyricLinked: boolean;
    syncLyricsTogether: boolean;
  }
): Promise<void> {
  ensureDataDirs();
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const pyPath = findAiPythonPath();
  if (!pyPath || !fs.existsSync(EXTRACT_PITCH_SCRIPT_PATH)) {
    job.status = 'error';
    job.error = 'AI 보컬 음정 추출 Python 환경을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }
  if (!ffmpegPath) {
    job.status = 'error';
    job.error = 'FFmpeg 실행 파일을 찾을 수 없습니다.';
    job.message = job.error;
    return;
  }

  const tag = `pitch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const tmpLinesJson = path.join(CACHE_DIR, `${tag}_lines.json`);
  const tmpOutJson = path.join(CACHE_DIR, `${tag}_notes.json`);

  try {
    const pyArgs = [
      EXTRACT_PITCH_SCRIPT_PATH,
      '--vocal-cache',
      opts.vocalCachePath,
      '--notes-out',
      tmpOutJson,
      '--models-dir',
      MODELS_DIR,
      '--preset',
      opts.preset,
      '--source',
      opts.sourceMode,
      '--restrict-to-lyrics',
      opts.restrictToLyrics ? '1' : '0',
      '--lyric-linked',
      opts.lyricLinked ? '1' : '0',
      '--sync-lyrics',
      opts.syncLyricsTogether ? '1' : '0',
    ];
    if (opts.audioPath) {
      pyArgs.push('--audio', opts.audioPath);
    }
    if (opts.existingVocalPath) {
      pyArgs.push('--existing-vocal', opts.existingVocalPath);
    }
    if (opts.karaokeAudioPath) {
      pyArgs.push(
        '--karaoke-audio',
        opts.karaokeAudioPath,
        '--karaoke-offset',
        String(opts.karaokeOffset)
      );
    }
    if (opts.mrAudioPath) {
      pyArgs.push('--mr-audio', opts.mrAudioPath, '--mr-offset', String(opts.mrOffset));
    }
    if (opts.lines.length > 0) {
      job.percent = 6;
      job.message = '일본어 가사 모라(음절) 분해 및 발음 음소 변환 중...';
      const enrichedLines = await enrichLinesWithMoras(opts.lines);
      fs.writeFileSync(tmpLinesJson, JSON.stringify(enrichedLines), 'utf-8');
      pyArgs.push('--lines-in', tmpLinesJson);
    }

    const { exitCode, stderrTail } = await runPythonWithProgress(pyPath, pyArgs, job);

    if (exitCode !== 0 || !fs.existsSync(tmpOutJson)) {
      job.status = 'error';
      job.error = `AI 보컬 음정 추출 실패 (code ${exitCode}): ${stderrTail.slice(-350)}`;
      job.message = job.error;
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(tmpOutJson, 'utf-8')) as AiExtractPitchResult;
    job.status = 'done';
    job.percent = 100;
    job.message = `보컬 음정 가이드 추출 완료 (${parsed.stats.noteCount}개 노트)`;
    job.result = parsed;
  } catch (err) {
    job.status = 'error';
    job.error = `음정 추출 오류: ${err instanceof Error ? err.message : String(err)}`;
    job.message = job.error;
  } finally {
    for (const p of [tmpLinesJson, tmpOutJson]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }
}
