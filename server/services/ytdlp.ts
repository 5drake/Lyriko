import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {
  ensureDataDirs,
  ROOT_DIR,
  saveMediaMeta,
  UPLOADS_DIR,
} from './storage.js';

export const BIN_DIR = path.join(ROOT_DIR, 'server', 'bin');
export const YTDLP_BIN_PATH = path.join(BIN_DIR, 'yt-dlp.exe');
const YTDLP_RELEASE_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

export function isYtDlpAvailable(): boolean {
  return fs.existsSync(YTDLP_BIN_PATH);
}

let ensurePromise: Promise<string> | null = null;

export async function ensureYtDlpBinary(): Promise<string> {
  if (fs.existsSync(YTDLP_BIN_PATH)) {
    return YTDLP_BIN_PATH;
  }
  if (!ensurePromise) {
    ensurePromise = (async () => {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      const tmpPath = `${YTDLP_BIN_PATH}.tmp`;
      const res = await fetch(YTDLP_RELEASE_URL, {
        headers: { 'User-Agent': 'UtaKanaStudio/1.0' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        throw new Error(`yt-dlp 다운로드 실패 (HTTP ${res.status})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, YTDLP_BIN_PATH);
      return YTDLP_BIN_PATH;
    })().finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

const VALID_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function parseYoutubeVideoId(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;

  if (host === 'youtu.be') {
    const seg = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    id = seg;
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/embed/') || parsed.pathname.startsWith('/live/')) {
      id = parsed.pathname.split('/').filter(Boolean)[1] ?? null;
    }
  }

  return id && VALID_VIDEO_ID_RE.test(id) ? id : null;
}

export function canonicalYoutubeUrl(rawUrl: string): string | null {
  const id = parseYoutubeVideoId(rawUrl);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function stripNoiseBrackets(input: string): string {
  return input
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|music video|mv|lyric|audio|karaoke|カラオケ|歌ってみた|カバー|cover)[^)]*\)/gi, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CleanedYoutubeMeta {
  videoId: string;
  rawTitle: string;
  title: string;
  artist: string;
  duration: number;
  searchQuery: string;
}

interface RawYtInfoJson {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  creator?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
}

export function cleanYoutubeMetadata(info: RawYtInfoJson, fallbackId: string): CleanedYoutubeMeta {
  const rawTitle = (info.title ?? '').trim() || 'YouTube Audio';
  const duration = Math.max(0, Number(info.duration) || 0);

  if (info.track && info.artist) {
    const title = stripNoiseBrackets(info.track) || info.track.trim();
    const artist = info.artist.replace(/\s*-\s*Topic$/i, '').trim();
    return {
      videoId: info.id || fallbackId,
      rawTitle,
      title,
      artist,
      duration,
      searchQuery: `${title} ${artist}`.trim(),
    };
  }

  let working = stripNoiseBrackets(rawTitle);
  // If title uses pipe separators (common in Korean lyric videos), prefer segment with " - " or " / "
  if (working.includes('|')) {
    const parts = working.split('|').map((p) => p.trim()).filter(Boolean);
    const dashPart = parts.find((p) => /\s[-/／]\s/.test(p));
    working = dashPart ?? parts[parts.length - 1] ?? working;
  }

  // Handle "Song / Artist - Anime OP" pattern (common in Japanese karaoke channels)
  const slashMatch = working.match(/^(.+?)\s*[/／]\s*(.+)$/);
  if (slashMatch) {
    const title = slashMatch[1].trim();
    const artist = slashMatch[2]
      .replace(/\s*[-–—]\s*(?:アニメ|TVアニメ|映画|OP|ED|主題歌|黄泉).*$/i, '')
      .trim();
    return {
      videoId: info.id || fallbackId,
      rawTitle,
      title,
      artist,
      duration,
      searchQuery: `${title} ${artist}`.trim(),
    };
  }

  // Handle "Artist - Song" pattern
  const dashMatch = working.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    const left = dashMatch[1].trim();
    const right = dashMatch[2].trim();
    return {
      videoId: info.id || fallbackId,
      rawTitle,
      title: right,
      artist: left,
      duration,
      searchQuery: `${right} ${left}`.trim(),
    };
  }

  const uploader = (info.uploader || info.channel || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/^(?:カラオケ歌っちゃ王|歌っちゃ王)$/i, '')
    .trim();

  return {
    videoId: info.id || fallbackId,
    rawTitle,
    title: working || rawTitle,
    artist: uploader,
    duration,
    searchQuery: `${working || rawTitle} ${uploader}`.trim(),
  };
}

export interface YoutubeImportResult {
  media: {
    id: string;
    kind: 'audio' | 'background';
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
  };
  meta: CleanedYoutubeMeta;
}

export interface YoutubeImportJob {
  id: string;
  status: 'preparing' | 'downloading' | 'processing' | 'done' | 'error';
  percent: number;
  message: string;
  result?: YoutubeImportResult;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, YoutubeImportJob>();

function pruneOldJobs(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of jobs.entries()) {
    if (v.createdAt < cutoff) {
      jobs.delete(k);
    }
  }
}

export function getYoutubeImportJob(jobId: string): YoutubeImportJob | null {
  return jobs.get(jobId) ?? null;
}

function formatYtDlpError(stderr: string): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('sign in to confirm') || lower.includes('bot')) {
    return 'YouTube 봇 확인/로그인 제한으로 이 영상을 자동으로 가져올 수 없습니다. 로컬 파일 업로드를 이용해 주세요.';
  }
  if (lower.includes('private video') || lower.includes('members-only')) {
    return '비공개 또는 멤버십 전용 영상은 가져올 수 없습니다.';
  }
  if (lower.includes('age') && lower.includes('sign in')) {
    return '연령 제한이 걸린 영상이라 로그인 없이는 가져올 수 없습니다.';
  }
  if (lower.includes('unavailable') || lower.includes('does not exist')) {
    return '영상을 찾을 수 없거나 삭제된 링크입니다.';
  }
  const lastLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ');
  return `YouTube 가져오기 실패: ${lastLine || '알 수 없는 오류'}`;
}

export function startYoutubeImportJob(
  rawUrl: string,
  mode: 'audio' | 'video'
): YoutubeImportJob {
  pruneOldJobs();
  const videoId = parseYoutubeVideoId(rawUrl);
  const canonicalUrl = canonicalYoutubeUrl(rawUrl);
  if (!videoId || !canonicalUrl) {
    throw new Error('올바른 YouTube 링크가 아닙니다.');
  }

  const jobId = `yt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: YoutubeImportJob = {
    id: jobId,
    status: 'preparing',
    percent: 2,
    message: 'YouTube 다운로더 준비 중...',
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  void runJob(job, canonicalUrl, videoId, mode);
  return job;
}

function runYtDlpAttempt(
  binPath: string,
  args: string[],
  mode: 'audio' | 'video',
  job: YoutubeImportJob
): Promise<{ exitCode: number; stderrLog: string }> {
  return new Promise((resolve, reject) => {
    let stderrLog = '';
    const proc = spawn(binPath, args, { windowsHide: true });

    const handleChunk = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString('utf-8');
      if (isErr) {
        stderrLog = (stderrLog + text).slice(-4000);
      }
      for (const line of text.split(/\r?\n/)) {
        const pctMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        const fragMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/i);
        if (pctMatch) {
          const dlPct = Number(pctMatch[1]);
          job.status = 'downloading';
          job.percent = Math.min(84, Math.max(job.percent, Math.round(5 + dlPct * 0.78)));
          job.message = `다운로드 중 ${Math.round(dlPct)}%...`;
        } else if (fragMatch) {
          const doneFrags = Number(fragMatch[1]);
          const totalFrags = Math.max(1, Number(fragMatch[2]));
          const dlPct = Math.min(100, (doneFrags / totalFrags) * 100);
          job.status = 'downloading';
          job.percent = Math.min(84, Math.max(job.percent, Math.round(5 + dlPct * 0.78)));
          job.message = `스트림 조각 받는 중 (${doneFrags}/${totalFrags})...`;
        } else if (
          line.includes('[ExtractAudio]') ||
          line.includes('[Merger]') ||
          line.includes('[Fixup')
        ) {
          job.status = 'processing';
          job.percent = Math.max(job.percent, 88);
          job.message = mode === 'video' ? 'MP4 영상·오디오 병합 중...' : 'MP3 오디오 변환 중...';
        }
      }
    };

    proc.stdout.on('data', (c: Buffer) => handleChunk(c, false));
    proc.stderr.on('data', (c: Buffer) => handleChunk(c, true));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stderrLog }));
  });
}

async function runJob(
  job: YoutubeImportJob,
  canonicalUrl: string,
  videoId: string,
  mode: 'audio' | 'video'
): Promise<void> {
  ensureDataDirs();
  const mediaId = `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const outTemplate = path.join(UPLOADS_DIR, `${mediaId}.%(ext)s`);
  const expectedExt = mode === 'video' ? '.mp4' : '.mp3';
  const expectedFilePath = path.join(UPLOADS_DIR, `${mediaId}${expectedExt}`);
  const infoJsonPath = path.join(UPLOADS_DIR, `${mediaId}.info.json`);

  const cleanupTemps = () => {
    try {
      const entries = fs.readdirSync(UPLOADS_DIR);
      for (const name of entries) {
        if (name.startsWith(mediaId)) {
          fs.unlinkSync(path.join(UPLOADS_DIR, name));
        }
      }
    } catch {
      // ignore
    }
  };

  try {
    const binPath = await ensureYtDlpBinary();
    job.status = 'downloading';
    job.percent = 5;
    job.message = mode === 'video' ? 'YouTube 영상+음원 다운로드 중...' : 'YouTube 음원 다운로드 중...';

    const commonArgs = [
      '--no-playlist',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '--concurrent-fragments',
      '4',
      '--newline',
      '--progress',
      '--write-info-json',
      ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
    ];

    const attempts: string[][] =
      mode === 'video'
        ? [
            [
              ...commonArgs,
              '-f',
              'bestvideo[height<=1080][protocol^=m3u8][vcodec^=avc1]+bestaudio[protocol^=m3u8]/bestvideo[height<=1080][protocol^=m3u8]+bestaudio[protocol^=m3u8]/bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
              '--merge-output-format',
              'mp4',
              '-o',
              outTemplate,
              canonicalUrl,
            ],
            [
              ...commonArgs,
              '--no-cache-dir',
              '-f',
              'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/18/best[height<=1080]',
              '--merge-output-format',
              'mp4',
              '-o',
              outTemplate,
              canonicalUrl,
            ],
          ]
        : [
            [
              ...commonArgs,
              '-f',
              'bestaudio[protocol^=m3u8]/bestaudio[ext=m4a]/bestaudio/best',
              '-x',
              '--audio-format',
              'mp3',
              '--audio-quality',
              '256K',
              '-o',
              outTemplate,
              canonicalUrl,
            ],
            [
              ...commonArgs,
              '--no-cache-dir',
              '-f',
              'bestaudio[ext=m4a]/bestaudio/18/best',
              '-x',
              '--audio-format',
              'mp3',
              '--audio-quality',
              '256K',
              '-o',
              outTemplate,
              canonicalUrl,
            ],
          ];

    let lastStderr = '';
    let succeeded = false;

    for (let i = 0; i < attempts.length; i++) {
      if (i > 0) {
        cleanupTemps();
        job.status = 'downloading';
        job.percent = 8;
        job.message = '대체 스트림으로 재시도 중...';
      }
      const { exitCode, stderrLog } = await runYtDlpAttempt(binPath, attempts[i], mode, job);
      lastStderr = stderrLog;
      if (exitCode === 0 && fs.existsSync(expectedFilePath)) {
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      cleanupTemps();
      job.status = 'error';
      job.error = formatYtDlpError(lastStderr);
      job.message = job.error;
      return;
    }

    let rawInfo: RawYtInfoJson = {};
    if (fs.existsSync(infoJsonPath)) {
      try {
        rawInfo = JSON.parse(fs.readFileSync(infoJsonPath, 'utf-8')) as RawYtInfoJson;
      } catch {
        // ignore
      } finally {
        try {
          fs.unlinkSync(infoJsonPath);
        } catch {
          // ignore
        }
      }
    }

    const meta = cleanYoutubeMetadata(rawInfo, videoId);
    const stat = fs.statSync(expectedFilePath);
    const storedName = `${mediaId}${expectedExt}`;
    const originalName = `${meta.title}${meta.artist ? ` - ${meta.artist}` : ''}${expectedExt}`;
    const mimeType = mode === 'video' ? 'video/mp4' : 'audio/mpeg';
    const kind = mode === 'video' ? 'background' : 'audio';

    saveMediaMeta({
      id: mediaId,
      kind,
      originalName,
      storedName,
      mimeType,
      size: stat.size,
      createdAt: new Date().toISOString(),
    });

    job.status = 'done';
    job.percent = 100;
    job.message = 'YouTube 불러오기 완료!';
    job.result = {
      media: {
        id: mediaId,
        kind,
        originalName,
        mimeType,
        size: stat.size,
        url: `/api/media/${mediaId}`,
      },
      meta,
    };
  } catch (err) {
    cleanupTemps();
    job.status = 'error';
    job.error = `YouTube 가져오기 오류: ${err instanceof Error ? err.message : String(err)}`;
    job.message = job.error;
  }
}

export interface YoutubeSearchCandidate {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail?: string;
  viewCount?: number;
  badges?: string[];
}

export interface ResolvedSongInfo {
  title: string;
  artist: string;
  duration: number;
  artworkUrl?: string;
  canonicalQuery: string;
}

export interface YoutubeThreeTrackSearchResult {
  query: string;
  resolvedSong?: ResolvedSongInfo;
  recommended: {
    original: YoutubeSearchCandidate | null;
    mr: YoutubeSearchCandidate | null;
    karaoke: YoutubeSearchCandidate | null;
  };
  candidates: {
    original: YoutubeSearchCandidate[];
    mr: YoutubeSearchCandidate[];
    karaoke: YoutubeSearchCandidate[];
  };
}

export interface SongSuggestTrack {
  trackName: string;
  artistName: string;
  duration: number;
  artworkUrl?: string;
  query: string;
}

export interface SongSuggestResponse {
  query: string;
  tracks: SongSuggestTrack[];
  keywords: string[];
}

interface FlatSearchEntry {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
}

const HANGUL_RE = /[가-힣]/;
const YT_SUGGEST_NOISE_END_RE =
  /\s+(?:라이브|피아노|1시간|1hour|기타|커버|내한|리액션|베이스|드럼|노래방|가사|악보|mr|inst|cover|live|bass|piano|guitar|drums?|acoustic|karaoke|カラオケ)$/i;
const YT_TITLE_BRACKET_RE = /\[[^\]]*\]|【[^】]*】/g;
const LATIN_NOISE_WORDS = new Set([
  'live',
  'lyrics',
  'lyric',
  'kor',
  'jp',
  'jpn',
  'jap',
  'kan',
  'rom',
  'sub',
  'mv',
  'pv',
  'music',
  'video',
  'official',
  'ver',
  'version',
  'hd',
  '4k',
  'short',
  'shorts',
  'jpop',
  'cover',
  'karaoke',
  'inst',
  'instrumental',
  'mr',
  'off',
  'on',
  'vocal',
  'audio',
  'playlist',
  'feat',
  'ft',
  'with',
  'the',
]);

async function fetchItunesJpTracks(term: string, limit = 6): Promise<SongSuggestTrack[]> {
  const clean = term.trim();
  if (!clean) return [];
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      clean
    )}&entity=song&limit=${limit}&country=JP`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'UtaKanaStudio/1.0' },
      signal: AbortSignal.timeout(4500),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{
        trackName?: string;
        artistName?: string;
        trackTimeMillis?: number;
        artworkUrl100?: string;
      }>;
    };
    const tracks: SongSuggestTrack[] = [];
    const seen = new Set<string>();
    for (const item of data.results ?? []) {
      const trackName = (item.trackName ?? '').trim();
      const artistName = (item.artistName ?? '').trim();
      const duration = Math.round(Number(item.trackTimeMillis ?? 0) / 1000);
      if (!trackName || !artistName) continue;
      if (duration > 0 && (duration < 55 || duration > 600)) continue;
      const key = `${trackName.toLowerCase()}|${artistName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({
        trackName,
        artistName,
        duration,
        artworkUrl: item.artworkUrl100 || undefined,
        query: `${trackName} ${artistName}`.trim(),
      });
    }
    return tracks;
  } catch {
    return [];
  }
}

async function fetchYoutubeSuggestKeywords(term: string): Promise<string[]> {
  const clean = term.trim();
  if (!clean) return [];
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&q=${encodeURIComponent(
      clean
    )}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return [];
    const raw = (await resp.json()) as [string, string[]];
    const items = Array.isArray(raw?.[1]) ? raw[1] : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const s = String(item ?? '').trim();
      if (!s) continue;
      if (YT_SUGGEST_NOISE_END_RE.test(s)) continue;
      const low = s.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(s);
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Return fast official iTunes JP tracks and clean YouTube keyword suggestions for song search autocomplete.
 */
export async function suggestSongsForQuery(
  rawQuery: string
): Promise<SongSuggestResponse> {
  const query = rawQuery.trim();
  if (!query) {
    return { query: '', tracks: [], keywords: [] };
  }
  const [tracksRes, keywordsRes] = await Promise.allSettled([
    fetchItunesJpTracks(query, 6),
    fetchYoutubeSuggestKeywords(query),
  ]);
  return {
    query,
    tracks: tracksRes.status === 'fulfilled' ? tracksRes.value : [],
    keywords: keywordsRes.status === 'fulfilled' ? keywordsRes.value : [],
  };
}

function runFlatYtSearch(
  binPath: string,
  searchArgs: string[]
): Promise<YoutubeSearchCandidate[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      ...searchArgs,
    ];
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn(binPath, args, { windowsHide: true });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve([]);
      }
    }, 15000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-2000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const results: YoutubeSearchCandidate[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const item = JSON.parse(trimmed) as FlatSearchEntry;
          const id = (item.id ?? '').trim();
          const title = (item.title ?? '').trim();
          const duration = Math.round(Number(item.duration) || 0);
          if (!id || !VALID_VIDEO_ID_RE.test(id) || !title) continue;
          if (duration > 0 && (duration < 55 || duration > 600)) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          results.push({
            videoId: id,
            url: `https://www.youtube.com/watch?v=${id}`,
            title,
            channel: (item.channel || item.uploader || '').replace(/\s*-\s*Topic$/i, '').trim(),
            duration,
            thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
            viewCount: typeof item.view_count === 'number' ? item.view_count : undefined,
          });
        } catch {
          // ignore malformed line
        }
      }
      if (results.length === 0 && stderr) {
        reject(new Error(formatYtDlpError(stderr)));
        return;
      }
      resolve(results);
    });
  });
}

function extractCanonicalQueriesFromTitles(titles: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const addQ = (q: string) => {
    const clean = q.replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return;
    const low = clean.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      queries.push(clean);
    }
  };

  const jpSegments: string[] = [];
  const latinArtists: string[] = [];

  for (const rawTitle of titles.slice(0, 3)) {
    const stripped = rawTitle.replace(YT_TITLE_BRACKET_RE, ' ');
    const jpMatches =
      stripped.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]+/g) ?? [];
    for (const seg of jpMatches) {
      if (seg.length >= 2 && !jpSegments.includes(seg)) {
        jpSegments.push(seg);
      }
    }

    const latinWords = (stripped.match(/[A-Za-z][A-Za-z0-9'&-]{1,}/g) ?? []).filter(
      (w) => !LATIN_NOISE_WORDS.has(w.toLowerCase())
    );
    for (const w of latinWords) {
      if (!latinArtists.includes(w)) {
        latinArtists.push(w);
      }
    }

    if (jpMatches.length > 0 && latinWords.length > 0) {
      addQ(`${jpMatches.slice(0, 2).join(' ')} ${latinWords.slice(0, 2).join(' ')}`);
    } else if (latinWords.length >= 2) {
      addQ(latinWords.slice(0, 3).join(' '));
    }
  }

  if (jpSegments.length > 0) {
    addQ(`${jpSegments[0]} ${latinArtists.slice(0, 2).join(' ')}`);
    addQ(jpSegments[0]);
  }
  if (latinArtists.length >= 2) {
    addQ(latinArtists.slice(0, 3).join(' '));
  }

  return queries.slice(0, 3);
}

function pickBestResolvedTrack(
  tracks: SongSuggestTrack[],
  referenceText: string
): SongSuggestTrack | null {
  if (tracks.length === 0) return null;
  const lowRef = referenceText.toLowerCase();
  let best = tracks[0];
  let bestScore = -1;
  for (const t of tracks) {
    let sc = 0;
    const trLow = t.trackName.toLowerCase();
    const arLow = t.artistName.toLowerCase();
    if (lowRef.includes(trLow)) sc += 60;
    if (lowRef.includes(arLow)) sc += 40;
    for (const tok of `${trLow} ${arLow}`.split(/\s+/)) {
      if (tok.length >= 2 && lowRef.includes(tok)) sc += 15;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }
  return best;
}

async function resolveCanonicalSongFromQuery(
  rawQuery: string,
  binPath: string
): Promise<{
  resolvedSong?: ResolvedSongInfo;
  seedPool: YoutubeSearchCandidate[];
}> {
  if (!HANGUL_RE.test(rawQuery)) {
    const tracks = await fetchItunesJpTracks(rawQuery, 5);
    const best = pickBestResolvedTrack(tracks, rawQuery);
    if (!best) return { seedPool: [] };
    return {
      resolvedSong: {
        title: best.trackName,
        artist: best.artistName,
        duration: best.duration,
        artworkUrl: best.artworkUrl,
        canonicalQuery: best.query,
      },
      seedPool: [],
    };
  }

  // Korean query -> probe YouTube flat search to uncover official JP/Latin title & artist
  const seedPool = await runFlatYtSearch(binPath, [`ytsearch4:${rawQuery}`]).catch(
    () => [] as YoutubeSearchCandidate[]
  );
  if (seedPool.length === 0) {
    return { seedPool: [] };
  }

  const candidateQueries = extractCanonicalQueriesFromTitles(seedPool.map((c) => c.title));
  const combinedTitleText = `${rawQuery} ${seedPool.map((c) => c.title).join(' ')}`;

  for (const cq of candidateQueries) {
    const tracks = await fetchItunesJpTracks(cq, 5);
    const best = pickBestResolvedTrack(tracks, combinedTitleText);
    if (best) {
      return {
        resolvedSong: {
          title: best.trackName,
          artist: best.artistName,
          duration: best.duration,
          artworkUrl: best.artworkUrl,
          canonicalQuery: best.query,
        },
        seedPool,
      };
    }
  }

  return { seedPool };
}

const PURE_MR_KEYWORDS_RE =
  /off\s*vocal|off\s*main\s*vocal|instrumental|\binst\.?\b|\bmr\b|반주|보컬\s*제거|vocal\s*remov|no\s*vocal|backing\s*track|マイナスワン|minus\s*one/i;
const NO_GUIDE_RE =
  /ガイド無し|ガイドなし|ガイドメロディ無し|ガイドメロディなし|no\s*guide|가이드\s*없/i;
const GUIDE_MELODY_RE =
  /ガイドメロディ|ガイドあり|ガイド付き|가이드\s*멜로디|with\s*guide|on\s*melody/i;
const MR_KEYWORDS_RE =
  /off\s*vocal|off\s*main\s*vocal|instrumental|\binst\.?\b|\bmr\b|반주|보컬\s*제거|vocal\s*remov|no\s*vocal|ガイド無し|ガイドなし|가이드\s*없|no\s*guide|backing\s*track|マイナスワン|minus\s*one/i;
const KARAOKE_KEYWORDS_RE =
  /カラオケ|karaoke|노래방|歌っちゃ王|生音風|가라오케|ガイドメロディ|ガイドあり|가이드\s*멜로디|금영|태진|\btj\b|\bky\b|joysound|\bdam\b|ニコカラ/i;
const KARAOKE_CHANNEL_RE =
  /歌っちゃ王|生音風|カラオケ制作|カラオケスタジオ|カラオケ音源|カラオケチャンネル|karaoke|노래방|금영|태진|joysound|\bdam\b|ニコカラ|sing\s*king|karafun|utacchao/i;
const ON_VOCAL_RE = /on\s*vocal|歌付き|ボーカル入り|가이드\s*보컬/i;
const COVER_NOISE_RE = /歌ってみた|cover|커버|live|라이브|일콘|콘서트|reaction|리액션|1시간|1hour/i;
const FAN_LYRIC_NOISE_RE = /가사\/발음|가사\/해석|가사집|kor\/jp\s*lyrics|playlist/i;
const TV_SHORT_OP_RE = /ノンクレジット|non-credit|creditless|\bncop\b|\bnced\b/i;

function buildQueryTokens(effectiveQuery: string): string[] {
  const tokens = new Set<string>();
  for (const tok of effectiveQuery.toLowerCase().split(/\s+/)) {
    const t = tok.trim();
    if (t.length >= 2) tokens.add(t);
  }
  const jpRuns =
    effectiveQuery.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]{2,}/g) ??
    [];
  for (const run of jpRuns) {
    tokens.add(run.toLowerCase());
  }
  return [...tokens];
}

function scoreQueryMatch(c: YoutubeSearchCandidate, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = `${c.title} ${c.channel}`.toLowerCase();
  let matched = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) matched += 1;
  }
  if (matched === 0) return -70;
  return matched * 35;
}

function scoreOriginal(
  c: YoutubeSearchCandidate,
  queryTokens: string[],
  resolvedSong?: ResolvedSongInfo
): number {
  let s = scoreQueryMatch(c, queryTokens);
  if (KARAOKE_KEYWORDS_RE.test(c.title) || MR_KEYWORDS_RE.test(c.title)) s -= 90;
  if (COVER_NOISE_RE.test(c.title)) s -= 40;
  if (FAN_LYRIC_NOISE_RE.test(c.title)) s -= 40;
  if (TV_SHORT_OP_RE.test(c.title) || (c.duration > 0 && c.duration <= 100)) s -= 35;
  if (/music\s*video|\bmv\b|official|공식/i.test(c.title)) s += 35;
  if (resolvedSong?.artist) {
    const ch = c.channel.toLowerCase();
    const ar = resolvedSong.artist.toLowerCase();
    if (ch && ar && (ch.includes(ar) || ar.includes(ch))) s += 40;
  }
  if (typeof c.viewCount === 'number') {
    if (c.viewCount >= 1_000_000) s += 25;
    else if (c.viewCount >= 100_000) s += 15;
    else if (c.viewCount >= 10_000) s += 5;
  }
  const refDur = resolvedSong?.duration || 0;
  if (refDur > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDur);
    if (diff <= 6) s += 25;
    else if (diff <= 15) s += 12;
    else if (diff > 45) s -= 25;
  } else if (c.duration >= 140 && c.duration <= 360) {
    s += 20;
  }
  return s;
}

function scoreMr(
  c: YoutubeSearchCandidate,
  refDuration: number,
  queryTokens: string[],
  resolvedSong?: ResolvedSongInfo,
  fromKarOnly = false
): number {
  let s = scoreQueryMatch(c, queryTokens);
  const isPureMr = PURE_MR_KEYWORDS_RE.test(c.title);
  const hasNoGuide = NO_GUIDE_RE.test(c.title);
  const isKarTitle = KARAOKE_KEYWORDS_RE.test(c.title);
  const isKarChannel = KARAOKE_CHANNEL_RE.test(c.channel);
  const hasGuide = !hasNoGuide && GUIDE_MELODY_RE.test(c.title);

  const ch = c.channel.toLowerCase();
  const ar = (resolvedSong?.artist || '').toLowerCase();
  const isArtistChannel = Boolean(ch && ar && (ch.includes(ar) || ar.includes(ch)));

  // Strongly favor clean Instrumental / Off Vocal / Official MR tracks
  if (isPureMr) s += 65;
  if (isPureMr && !isKarTitle && !isKarChannel) s += 45;
  if (
    /\binstrumental\b|\binst\.?\b|\bmr\b|보컬\s*제거|vocal\s*remov/i.test(c.title) &&
    !isKarTitle &&
    !isKarChannel
  ) {
    s += 25;
  }
  if (isArtistChannel && isPureMr) s += 50;
  if (hasNoGuide) s += 15;

  // Strongly penalize karaoke channels, karaoke guides, and guide-melody uploads
  if (isKarChannel) s -= 85;
  if (isKarTitle) s -= hasNoGuide ? 40 : 75;
  if (hasGuide) s -= 60;
  if (ON_VOCAL_RE.test(c.title)) s -= 75;
  if (fromKarOnly && !isPureMr) s -= 45;
  if (COVER_NOISE_RE.test(c.title)) s -= 35;

  if (refDuration > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDuration);
    if (diff <= 6) s += 30;
    else if (diff <= 15) s += 15;
    else if (diff > 45) s -= 30;
  }
  return s;
}

function scoreKaraoke(
  c: YoutubeSearchCandidate,
  refDuration: number,
  queryTokens: string[]
): number {
  let s = scoreQueryMatch(c, queryTokens);
  if (KARAOKE_KEYWORDS_RE.test(c.title) || KARAOKE_CHANNEL_RE.test(c.channel)) s += 60;
  if (
    GUIDE_MELODY_RE.test(c.title) ||
    /【カラオケ】|歌っちゃ王|生音風|노래방|가라오케|\btj\b|\bky\b|joysound|\bdam\b/i.test(
      `${c.title} ${c.channel}`
    )
  ) {
    s += 35;
  }
  if (NO_GUIDE_RE.test(c.title)) {
    s -= 55;
  } else if (
    MR_KEYWORDS_RE.test(c.title) &&
    !GUIDE_MELODY_RE.test(c.title) &&
    !KARAOKE_CHANNEL_RE.test(c.channel) &&
    !/【カラオケ】|\btj\b|\bky\b|joysound|\bdam\b/i.test(`${c.title} ${c.channel}`)
  ) {
    s -= 45;
  }
  if (COVER_NOISE_RE.test(c.title)) s -= 30;
  if (refDuration > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDuration);
    if (diff <= 6) s += 30;
    else if (diff <= 15) s += 15;
    else if (diff > 45) s -= 30;
  }
  return s;
}

function attachCandidateBadges(
  c: YoutubeSearchCandidate,
  slot: 'original' | 'mr' | 'karaoke',
  refDuration: number
): YoutubeSearchCandidate {
  const badges: string[] = [];
  if (slot === 'original' && /music\s*video|\bmv\b|official|공식/i.test(c.title)) {
    badges.push('공식 MV');
  }
  if (
    slot === 'mr' &&
    PURE_MR_KEYWORDS_RE.test(c.title) &&
    !KARAOKE_KEYWORDS_RE.test(c.title) &&
    !KARAOKE_CHANNEL_RE.test(c.channel)
  ) {
    badges.push('순수 MR');
  }
  if (NO_GUIDE_RE.test(c.title)) {
    badges.push('가이드 없음');
  } else if (
    GUIDE_MELODY_RE.test(c.title) ||
    KARAOKE_CHANNEL_RE.test(`${c.title} ${c.channel}`)
  ) {
    badges.push('가이드 멜로디');
  }
  if (refDuration > 90 && c.duration > 0 && Math.abs(c.duration - refDuration) <= 6) {
    badges.push('길이 일치');
  }
  return { ...c, badges };
}

export async function searchYoutubeTracksForSong(
  rawQuery: string,
  hints?: Partial<ResolvedSongInfo>
): Promise<YoutubeThreeTrackSearchResult> {
  const query = rawQuery.trim();
  if (!query) {
    throw new Error('검색할 노래 제목이나 가수를 입력해 주세요.');
  }

  const binPath = await ensureYtDlpBinary();

  let resolvedSong: ResolvedSongInfo | undefined;
  let seedPool: YoutubeSearchCandidate[] = [];
  if (hints?.title) {
    const artist = (hints.artist || '').trim();
    resolvedSong = {
      title: hints.title.trim(),
      artist,
      duration: Math.round(Number(hints.duration) || 0),
      artworkUrl: hints.artworkUrl || undefined,
      canonicalQuery:
        hints.canonicalQuery?.trim() || `${hints.title.trim()} ${artist}`.trim(),
    };
  } else {
    const resolved = await resolveCanonicalSongFromQuery(query, binPath);
    resolvedSong = resolved.resolvedSong;
    seedPool = resolved.seedPool;
  }

  const effectiveQuery = resolvedSong?.canonicalQuery || query;
  const queryTokens = buildQueryTokens(effectiveQuery);

  // Run original, pure instrumental (MR), off-vocal (MR), and karaoke YouTube searches in parallel
  const [rOrig, rMrInst, rMrOff, rKar] = await Promise.allSettled([
    runFlatYtSearch(binPath, [`ytsearch6:${effectiveQuery}`]),
    runFlatYtSearch(binPath, [`ytsearch6:${effectiveQuery} instrumental`]),
    runFlatYtSearch(binPath, [`ytsearch6:${effectiveQuery} off vocal`]),
    runFlatYtSearch(binPath, [`ytsearch6:${effectiveQuery} カラオケ`]),
  ]);

  const pool: YoutubeSearchCandidate[] = [];
  const seenIds = new Set<string>();
  const nonKarIds = new Set<string>();
  const appendPool = (items: YoutubeSearchCandidate[], trackAsNonKar: boolean) => {
    for (const item of items) {
      if (trackAsNonKar) nonKarIds.add(item.videoId);
      if (!seenIds.has(item.videoId)) {
        seenIds.add(item.videoId);
        pool.push(item);
      }
    }
  };
  if (rOrig.status === 'fulfilled') appendPool(rOrig.value, true);
  if (rMrInst.status === 'fulfilled') appendPool(rMrInst.value, true);
  if (rMrOff.status === 'fulfilled') appendPool(rMrOff.value, true);
  if (rKar.status === 'fulfilled') appendPool(rKar.value, false);
  appendPool(seedPool, true);

  const origListRaw = [...pool]
    .sort(
      (a, b) =>
        scoreOriginal(b, queryTokens, resolvedSong) -
        scoreOriginal(a, queryTokens, resolvedSong)
    )
    .slice(0, 6);
  const bestOrigRaw = origListRaw[0] ?? null;
  const refDur =
    resolvedSong?.duration && resolvedSong.duration > 90
      ? resolvedSong.duration
      : bestOrigRaw?.duration && bestOrigRaw.duration >= 120
      ? bestOrigRaw.duration
      : 0;

  const mrListRaw = [...pool]
    .filter((c) => c.videoId !== bestOrigRaw?.videoId)
    .sort(
      (a, b) =>
        scoreMr(b, refDur, queryTokens, resolvedSong, !nonKarIds.has(b.videoId)) -
        scoreMr(a, refDur, queryTokens, resolvedSong, !nonKarIds.has(a.videoId))
    )
    .slice(0, 6);
  const bestMrRaw = mrListRaw[0] ?? null;

  const karaokeSortedRaw = [...pool]
    .filter((c) => c.videoId !== bestOrigRaw?.videoId)
    .sort(
      (a, b) =>
        scoreKaraoke(b, refDur, queryTokens) - scoreKaraoke(a, refDur, queryTokens)
    )
    .slice(0, 6);

  const bestKaraokeRaw =
    karaokeSortedRaw.find((c) => c.videoId !== bestMrRaw?.videoId) ??
    karaokeSortedRaw[0] ??
    null;

  const origList = origListRaw.map((c) => attachCandidateBadges(c, 'original', refDur));
  const mrList = mrListRaw.map((c) => attachCandidateBadges(c, 'mr', refDur));
  const karaokeList = karaokeSortedRaw.map((c) =>
    attachCandidateBadges(c, 'karaoke', refDur)
  );

  return {
    query,
    resolvedSong,
    recommended: {
      original: origList[0] ?? null,
      mr: mrList[0] ?? null,
      karaoke: bestKaraokeRaw
        ? attachCandidateBadges(bestKaraokeRaw, 'karaoke', refDur)
        : null,
    },
    candidates: {
      original: origList,
      mr: mrList,
      karaoke: karaokeList,
    },
  };
}

