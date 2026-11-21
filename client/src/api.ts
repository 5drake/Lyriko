import type {
  AiConfigPublic,
  AiProvider,
  AudioPlayMode,
  KaraokeProject,
  LrcSearchResult,
  LyricLine,
  PitchNote,
  SmartTranslateResult,
  WorkerHealthResponse,
} from '@shared/types';
import { workerUrl } from './workerClient';

async function handleJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchHealth(): Promise<WorkerHealthResponse> {
  return handleJson(await fetch(workerUrl('/api/health')));
}

export async function fetchDemoProject(): Promise<KaraokeProject> {
  return handleJson(await fetch(workerUrl('/api/demo')));
}

export async function searchLyricsOnline(
  query: string,
  duration?: number
): Promise<LrcSearchResult[]> {
  const durParam =
    duration && Number.isFinite(duration) && duration > 15
      ? `&duration=${Math.round(duration)}`
      : '';
  const data = await handleJson<{ results: LrcSearchResult[] }>(
    await fetch(workerUrl(`/api/lyrics/search?q=${encodeURIComponent(query)}${durParam}`))
  );
  return data.results;
}

export async function convertJapaneseLyrics(payload: {
  rawText?: string;
  duration?: number;
  longVowelMode?: 'vowel' | 'dash';
  lines?: Array<{
    id?: string;
    startTime: number;
    endTime: number;
    jpText: string;
    koTranslation?: string;
    slot?: 0 | 1 | 2;
  }>;
}): Promise<LyricLine[]> {
  const data = await handleJson<{ lines: LyricLine[] }>(
    await fetch(workerUrl('/api/jp/convert'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  return data.lines;
}

export async function uploadMediaFile(
  kind: 'audio' | 'background',
  file: File
): Promise<{
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
}> {
  const form = new FormData();
  form.append('file', file);
  const res = await handleJson<{
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
  }>(
    await fetch(workerUrl(`/api/upload/${kind}`), {
      method: 'POST',
      body: form,
    })
  );
  return {
    ...res,
    url: workerUrl(res.url),
  };
}

export async function listSavedProjects(): Promise<
  Array<Pick<KaraokeProject, 'id' | 'title' | 'artist' | 'updatedAt' | 'duration'>>
> {
  const data = await handleJson<{
    projects: Array<Pick<KaraokeProject, 'id' | 'title' | 'artist' | 'updatedAt' | 'duration'>>;
  }>(await fetch(workerUrl('/api/projects')));
  return data.projects;
}

export async function loadSavedProject(id: string): Promise<KaraokeProject> {
  return handleJson(await fetch(workerUrl(`/api/projects/${encodeURIComponent(id)}`)));
}

export async function saveProjectToServer(project: KaraokeProject): Promise<KaraokeProject> {
  return handleJson(
    await fetch(workerUrl('/api/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    })
  );
}

export async function deleteSavedProject(id: string): Promise<void> {
  await handleJson(
    await fetch(workerUrl(`/api/projects/${encodeURIComponent(id)}`), { method: 'DELETE' })
  );
}

export async function getAiConfig(): Promise<AiConfigPublic> {
  return handleJson(await fetch(workerUrl('/api/ai/config')));
}

export async function saveAiConfig(cfg: {
  provider?: AiProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<AiConfigPublic> {
  return handleJson(
    await fetch(workerUrl('/api/ai/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
  );
}

export async function generateAiPrompt(payload: {
  title: string;
  artist: string;
  lines: LyricLine[];
  options: {
    fixRuby: boolean;
    naturalKoPron: boolean;
    translateKo: boolean;
    smartSegment: boolean;
  };
}): Promise<string> {
  const data = await handleJson<{ prompt: string }>(
    await fetch(workerUrl('/api/ai/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  return data.prompt;
}

export async function applyAiJsonResponse(
  lines: LyricLine[],
  jsonText: string
): Promise<LyricLine[]> {
  const data = await handleJson<{ lines: LyricLine[] }>(
    await fetch(workerUrl('/api/ai/apply-json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines, jsonText }),
    })
  );
  return data.lines;
}

export async function runAiPostProcess(payload: {
  title: string;
  artist: string;
  lines: LyricLine[];
  options: {
    fixRuby: boolean;
    naturalKoPron: boolean;
    translateKo: boolean;
    smartSegment: boolean;
  };
  provider?: AiProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<LyricLine[]> {
  const data = await handleJson<{ lines: LyricLine[] }>(
    await fetch(workerUrl('/api/ai/postprocess'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  return data.lines;
}

export async function translateLyricsFree(lines: LyricLine[]): Promise<LyricLine[]> {
  const data = await handleJson<{ lines: LyricLine[] }>(
    await fetch(workerUrl('/api/ai/translate-free'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    })
  );
  return data.lines;
}

export async function translateLyricsSmart(payload: {
  title: string;
  artist: string;
  youtubeVideoId?: string;
  lines: LyricLine[];
}): Promise<SmartTranslateResult> {
  return handleJson<SmartTranslateResult>(
    await fetch(workerUrl('/api/ai/translate-smart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
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
  meta: {
    videoId: string;
    rawTitle: string;
    title: string;
    artist: string;
    duration: number;
    searchQuery: string;
  };
}

export interface YoutubeJobStatus {
  id: string;
  status: 'preparing' | 'downloading' | 'processing' | 'done' | 'error';
  percent: number;
  message: string;
  result?: YoutubeImportResult;
  error?: string;
}

export async function startYoutubeImport(
  url: string,
  mode: 'audio' | 'video'
): Promise<string> {
  const data = await handleJson<{ jobId: string }>(
    await fetch(workerUrl('/api/youtube/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mode }),
    })
  );
  return data.jobId;
}

export async function pollYoutubeJob(jobId: string): Promise<YoutubeJobStatus> {
  const job = await handleJson<YoutubeJobStatus>(
    await fetch(workerUrl(`/api/youtube/jobs/${encodeURIComponent(jobId)}`))
  );
  if (job.result?.media?.url) {
    job.result = {
      ...job.result,
      media: {
        ...job.result.media,
        url: workerUrl(job.result.media.url),
      },
    };
  }
  return job;
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

export async function suggestSongsApi(query: string): Promise<SongSuggestResponse> {
  return handleJson(
    await fetch(workerUrl(`/api/youtube/song-suggest?q=${encodeURIComponent(query)}`))
  );
}

export async function searchYoutubeTracksApi(
  query: string,
  hints?: Partial<ResolvedSongInfo>
): Promise<YoutubeThreeTrackSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (hints?.title) params.set('title', hints.title);
  if (hints?.artist) params.set('artist', hints.artist);
  if (hints?.duration) params.set('duration', String(hints.duration));
  if (hints?.artworkUrl) params.set('artwork', hints.artworkUrl);
  return handleJson(await fetch(workerUrl(`/api/youtube/search-tracks?${params.toString()}`)));
}

export async function importYoutubeWithProgress(
  url: string,
  mode: 'audio' | 'video',
  onProgress?: (job: YoutubeJobStatus) => void
): Promise<YoutubeImportResult> {
  const jobId = await startYoutubeImport(url, mode);
  while (true) {
    const job = await pollYoutubeJob(jobId);
    onProgress?.(job);
    if (job.status === 'done' && job.result) {
      return job.result;
    }
    if (job.status === 'error') {
      throw new Error(job.error || job.message || 'YouTube 가져오기 실패');
    }
    await new Promise((r) => setTimeout(r, 450));
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

export async function autoSyncMrApi(
  audioFileId: string,
  mrAudioFileId: string
): Promise<AutoSyncMrResult> {
  return handleJson(
    await fetch(workerUrl('/api/audio/sync-mr'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioFileId, mrAudioFileId }),
    })
  );
}

export async function prepareProcessedAudioApi(payload: {
  audioFileId?: string;
  mrAudioFileId?: string;
  karaokeAudioFileId?: string;
  vocalFileId?: string;
  mode: AudioPlayMode;
  keyShift: number;
  mrSyncOffset?: number;
  karaokeSyncOffset?: number;
  monitorOriginal?: boolean;
}): Promise<{ url: string; cacheKey: string; usedAutoMr: boolean }> {
  const res = await handleJson<{ url: string; cacheKey: string; usedAutoMr: boolean }>(
    await fetch(workerUrl('/api/audio/prepare'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  return {
    ...res,
    url: workerUrl(res.url),
  };
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

export interface AiAudioJobStatus {
  id: string;
  status: 'preparing' | 'separating' | 'analyzing' | 'aligning' | 'done' | 'error';
  percent: number;
  message: string;
  result?: AiAudioAnalysisResult | AiAlignLyricsResult;
  error?: string;
}

async function runAiAudioJob<T>(
  endpoint: string,
  payload: unknown,
  fallbackError: string,
  onProgress?: (job: AiAudioJobStatus) => void
): Promise<T> {
  const { jobId } = await handleJson<{ jobId: string }>(
    await fetch(workerUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );

  while (true) {
    const job = await handleJson<AiAudioJobStatus>(
      await fetch(workerUrl(`/api/audio/ai-jobs/${encodeURIComponent(jobId)}`))
    );
    onProgress?.(job);
    if (job.status === 'done' && job.result) {
      return job.result as T;
    }
    if (job.status === 'error') {
      throw new Error(job.error || job.message || fallbackError);
    }
    await new Promise((r) => setTimeout(r, 450));
  }
}

export async function analyzeAudioWithAiProgress(
  payload: {
    audioFileId: string;
    lines?: LyricLine[];
    sensitivity?: number;
    force?: boolean;
  },
  onProgress?: (job: AiAudioJobStatus) => void
): Promise<AiAudioAnalysisResult> {
  return runAiAudioJob<AiAudioAnalysisResult>(
    '/api/audio/ai-analyze',
    payload,
    'AI 오디오 분석 실패',
    onProgress
  );
}

export async function alignLyricsWithAiProgress(
  payload: {
    audioFileId?: string;
    vocalFileId?: string;
    lines: LyricLine[];
    model?: string;
  },
  onProgress?: (job: AiAudioJobStatus) => void
): Promise<AiAlignLyricsResult> {
  return runAiAudioJob<AiAlignLyricsResult>(
    '/api/audio/ai-align-lyrics',
    payload,
    'AI 가사 강제 정렬 실패',
    onProgress
  );
}
