import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import type { AudioPlayMode, PitchNote } from '../../shared/types.js';
import { findAiPythonPath } from './aiAudio.js';
import { CACHE_DIR, ensureDataDirs, getMediaFilePath, ROOT_DIR } from './storage.js';

const execFileAsync = promisify(execFile);
const pendingBuilds = new Map<string, Promise<string>>();
const SYNC_SCRIPT_PATH = path.join(ROOT_DIR, 'server', 'scripts', 'ai_sync_mr.py');

function isVbrMp3File(filePath: string): boolean {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes('Xing');
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export interface AutoSyncMrResult {
  offsetSec: number;
  confidence: number;
  method: string;
  coarseZ?: number;
  fineZ?: number;
  warning?: string;
}

export interface ProcessedAudioResult {
  cacheKey: string;
  filePath: string;
  url: string;
  usedAutoMr: boolean;
}

export async function prepareProcessedAudio(opts: {
  audioFileId?: string;
  mrAudioFileId?: string;
  karaokeAudioFileId?: string;
  mode: AudioPlayMode;
  keyShift: number;
  mrSyncOffset?: number;
  karaokeSyncOffset?: number;
  monitorOriginal?: boolean;
  allowOriginalKeyShift?: boolean;
}): Promise<ProcessedAudioResult | null> {
  ensureDataDirs();
  const rawKeyShift = Math.max(-6, Math.min(6, Math.round(Number(opts.keyShift) || 0)));
  const keyShift = opts.mode === 'original' && !opts.allowOriginalKeyShift ? 0 : rawKeyShift;

  let sourceId = opts.audioFileId;
  let usingExternalTrack = false;
  let activeOffsetSec = 0;

  const isKaraoke =
    opts.mode === 'karaoke' || opts.mode === 'mr-vocal' || opts.mode === 'mr-melody';

  if (isKaraoke && opts.karaokeAudioFileId && getMediaFilePath(opts.karaokeAudioFileId)) {
    sourceId = opts.karaokeAudioFileId;
    usingExternalTrack = true;
    activeOffsetSec = Number(opts.karaokeSyncOffset) || 0;
  } else if (
    (opts.mode === 'mr' || isKaraoke) &&
    opts.mrAudioFileId &&
    getMediaFilePath(opts.mrAudioFileId)
  ) {
    sourceId = opts.mrAudioFileId;
    usingExternalTrack = true;
    activeOffsetSec = Number(opts.mrSyncOffset) || 0;
  } else {
    sourceId = opts.audioFileId;
    usingExternalTrack = false;
    activeOffsetSec = 0;
  }

  if (!sourceId) return null;
  const source = getMediaFilePath(sourceId);
  if (!source) return null;

  const wantMonitor = Boolean(
    opts.monitorOriginal &&
      opts.audioFileId &&
      usingExternalTrack &&
      opts.mode !== 'original' &&
      opts.audioFileId !== sourceId
  );
  const origSource = wantMonitor && opts.audioFileId ? getMediaFilePath(opts.audioFileId) : null;

  const rawMrOffset = Math.max(-45, Math.min(45, activeOffsetSec));
  const mrOffsetMs = usingExternalTrack ? Math.round(rawMrOffset * 1000) : 0;
  const needsCbrNormalize = isVbrMp3File(source.filePath);

  if (keyShift === 0 && mrOffsetMs === 0 && !origSource && !needsCbrNormalize) {
    return {
      cacheKey: sourceId,
      filePath: source.filePath,
      url: `/api/media/${encodeURIComponent(sourceId)}`,
      usedAutoMr: false,
    };
  }

  if (!ffmpegPath) {
    throw new Error('FFmpeg 실행 파일을 찾을 수 없습니다.');
  }

  const safeSource = path.basename(sourceId).replace(/[^a-zA-Z0-9_-]/g, '');
  const offsetTag =
    mrOffsetMs !== 0 ? `_o${mrOffsetMs > 0 ? 'p' : 'm'}${Math.abs(mrOffsetMs)}` : '';
  const safeOrig =
    origSource && opts.audioFileId
      ? `_mon_${path.basename(opts.audioFileId).replace(/[^a-zA-Z0-9_-]/g, '')}`
      : '';
  const modeTag = keyShift === 0 && mrOffsetMs === 0 && !origSource ? 'cbr' : 'raw';
  const cacheKey = `${safeSource}_${modeTag}_k${keyShift}${offsetTag}${safeOrig}`;
  const outPath = path.join(CACHE_DIR, `${cacheKey}.mp3`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return {
      cacheKey,
      filePath: outPath,
      url: `/api/audio/cache/${encodeURIComponent(cacheKey)}`,
      usedAutoMr: false,
    };
  }

  let jobPromise = pendingBuilds.get(cacheKey);
  if (!jobPromise) {
    jobPromise = (async () => {
      const tmpPath = path.join(CACHE_DIR, `${cacheKey}.tmp_${Date.now()}.mp3`);
      const pitchRatio = Math.pow(2, keyShift / 12).toFixed(6);
      const rubberbandFilter = `rubberband=pitch=${pitchRatio}:formant=preserved:pitchq=quality:channels=together:transients=crisp`;

      let args: string[];
      if (origSource) {
        const trkFilters: string[] = [];
        if (mrOffsetMs < 0) {
          const trimSec = (Math.abs(mrOffsetMs) / 1000).toFixed(4);
          trkFilters.push(`atrim=start=${trimSec},asetpts=PTS-STARTPTS`);
        } else {
          trkFilters.push('asetpts=PTS-STARTPTS');
        }
        if (keyShift !== 0) {
          trkFilters.push(rubberbandFilter);
        }
        if (mrOffsetMs > 0) {
          trkFilters.push(`adelay=${mrOffsetMs}:all=1`);
        }
        trkFilters.push('aformat=sample_rates=48000:channel_layouts=stereo,volume=0.88');

        const orgFilters: string[] = ['asetpts=PTS-STARTPTS'];
        if (keyShift !== 0) {
          orgFilters.push(rubberbandFilter);
        }
        orgFilters.push('aformat=sample_rates=48000:channel_layouts=stereo,volume=0.45');

        const filterComplex = `[0:a]${trkFilters.join(',')}[trk];[1:a]${orgFilters.join(',')}[org];[trk][org]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[aout]`;

        args = [
          '-y',
          '-i',
          source.filePath,
          '-i',
          origSource.filePath,
          '-vn',
          '-filter_complex',
          filterComplex,
          '-map',
          '[aout]',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '256k',
          '-ar',
          '48000',
          '-ac',
          '2',
          tmpPath,
        ];
      } else {
        args = ['-y', '-i', source.filePath, '-vn'];
        const filters: string[] = [];
        if (mrOffsetMs < 0) {
          const trimSec = (Math.abs(mrOffsetMs) / 1000).toFixed(4);
          filters.push(`atrim=start=${trimSec},asetpts=PTS-STARTPTS`);
        }
        if (keyShift !== 0) {
          filters.push(rubberbandFilter);
        }
        if (mrOffsetMs > 0) {
          filters.push(`adelay=${mrOffsetMs}:all=1`);
        }
        if (filters.length > 0) {
          args.push('-af', filters.join(','));
        }
        args.push('-c:a', 'libmp3lame', '-b:a', '256k', '-ar', '48000', '-ac', '2', tmpPath);
      }

      try {
        await execFileAsync(ffmpegPath!, args, { maxBuffer: 10 * 1024 * 1024 });
        fs.renameSync(tmpPath, outPath);
        return outPath;
      } catch (err) {
        if (fs.existsSync(tmpPath)) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // ignore
          }
        }
        throw err;
      }
    })().finally(() => {
      pendingBuilds.delete(cacheKey);
    });

    pendingBuilds.set(cacheKey, jobPromise);
  }

  await jobPromise;
  return {
    cacheKey,
    filePath: outPath,
    url: `/api/audio/cache/${encodeURIComponent(cacheKey)}`,
    usedAutoMr: false,
  };
}

export async function prepareVocalTrack(
  vocalFileId?: string,
  keyShift = 0
): Promise<ProcessedAudioResult | null> {
  if (!vocalFileId) return null;
  return prepareProcessedAudio({
    audioFileId: vocalFileId,
    mode: 'original',
    keyShift,
    allowOriginalKeyShift: true,
  });
}

export async function computeMrAutoSyncOffset(
  audioFileId: string,
  mrAudioFileId: string
): Promise<AutoSyncMrResult> {
  ensureDataDirs();
  const origMedia = getMediaFilePath(audioFileId);
  if (!origMedia) {
    throw new Error('기준이 될 원곡 음원 파일을 찾을 수 없습니다.');
  }
  const mrMedia = getMediaFilePath(mrAudioFileId);
  if (!mrMedia) {
    throw new Error('싱크를 맞출 MR 음원 파일을 찾을 수 없습니다.');
  }
  if (!ffmpegPath) {
    throw new Error('FFmpeg 실행 파일을 찾을 수 없습니다.');
  }
  const pyPath = findAiPythonPath();
  if (!pyPath || !fs.existsSync(SYNC_SCRIPT_PATH)) {
    throw new Error('자동 싱크 분석용 Python 환경을 찾을 수 없습니다.');
  }

  const tag = `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const tmpOrigWav = path.join(CACHE_DIR, `${tag}_orig.wav`);
  const tmpMrWav = path.join(CACHE_DIR, `${tag}_mr.wav`);

  try {
    const decodeArgs = (src: string, dst: string) => [
      '-y',
      '-t',
      '240',
      '-i',
      src,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      dst,
    ];

    await Promise.all([
      execFileAsync(ffmpegPath, decodeArgs(origMedia.filePath, tmpOrigWav), {
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync(ffmpegPath, decodeArgs(mrMedia.filePath, tmpMrWav), {
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);

    const { stdout } = await execFileAsync(
      pyPath,
      [SYNC_SCRIPT_PATH, '--orig', tmpOrigWav, '--mr', tmpMrWav, '--max-lag', '45.0'],
      {
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      }
    );

    const lastLine = stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .pop();
    if (!lastLine) {
      throw new Error('자동 싱크 분석 결과를 읽지 못했습니다.');
    }
    return JSON.parse(lastLine) as AutoSyncMrResult;
  } finally {
    for (const p of [tmpOrigWav, tmpMrWav]) {
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

/**
 * Generates a 48kHz stereo 16-bit PCM WAV file containing the transposed guide melody
 * for mixing into MP4 exports when audioMode === 'mr-melody'.
 */
export function synthesizeGuideMelodyWav(
  notes: PitchNote[],
  keyShift: number,
  durationSec: number,
  gain: number
): string {
  ensureDataDirs();
  const sampleRate = 48000;
  const channels = 2;
  const totalFrames = Math.max(sampleRate, Math.ceil(Math.max(1, durationSec) * sampleRate));
  const dataBytes = totalFrames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  // RIFF WAVE header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  const clampedGain = Math.max(0, Math.min(1, gain)) * 0.28;
  const shift = Math.max(-6, Math.min(6, Math.round(keyShift)));

  if (clampedGain > 0 && notes.length > 0) {
    const attackSamples = Math.round(0.018 * sampleRate);
    const releaseSamples = Math.round(0.03 * sampleRate);

    for (const note of notes) {
      const startFrame = Math.max(0, Math.floor(note.startTime * sampleRate));
      const endFrame = Math.min(totalFrames, Math.ceil(note.endTime * sampleRate));
      const len = endFrame - startFrame;
      if (len <= 0) continue;

      const freq = 440 * Math.pow(2, (note.midi + shift - 69) / 12);
      for (let i = 0; i < len; i++) {
        const frame = startFrame + i;
        const t = frame / sampleRate;
        const p1 = (t * freq) % 1;
        const tri = 2 * Math.abs(2 * p1 - 1) - 1;
        const harm = 0.25 * Math.sin(2 * Math.PI * 2 * freq * t);

        let env = 1;
        if (i < attackSamples) {
          env = i / attackSamples;
        } else if (len - i < releaseSamples) {
          env = Math.max(0, (len - i) / releaseSamples);
        }

        const sampleFloat = (tri * 0.8 + harm) * env * clampedGain;
        const byteOff = 44 + frame * 4;
        const prev = buf.readInt16LE(byteOff) / 32767;
        const mixed = Math.max(-0.96, Math.min(0.96, prev + sampleFloat));
        const intVal = Math.round(mixed * 32767);
        buf.writeInt16LE(intVal, byteOff);
        buf.writeInt16LE(intVal, byteOff + 2);
      }
    }
  }

  const outWav = path.join(
    CACHE_DIR,
    `guide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.wav`
  );
  fs.writeFileSync(outWav, buf);
  return outWav;
}
