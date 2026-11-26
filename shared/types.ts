export interface LyricSegment {
  id: string;
  jp: string;
  ruby: string;
  koPron: string;
  startTime: number;
  endTime: number;
  altReadings?: Array<{ ruby: string; koPron: string }>;
  rubySource?: 'web' | 'user' | 'kuromoji';
}

export interface LyricLine {
  id: string;
  startTime: number;
  endTime: number;
  appearTime?: number;
  slot?: 0 | 1 | 2;
  jpText: string;
  koTranslation: string;
  segments: LyricSegment[];
}

export interface PitchNote {
  id: string;
  startTime: number;
  endTime: number;
  midi: number;
  lyric?: string;
  lineId?: string;
}

export type LayoutMode = 'auto' | '2-line' | '3-line';
export type WipeStyle = 'stroke-glow' | 'fill-wipe';
export type BackgroundType = 'gradient' | 'image' | 'video';
export type BackgroundLoopStyle =
  | 'cd-spin'
  | 'aurora-wave'
  | 'neon-rings'
  | 'classic-bokeh';
export type VisualizerStyle =
  | 'cd-radial'
  | 'bottom-bars'
  | 'mirror-wave'
  | 'silk-ribbon'
  | 'floating-dots'
  | 'dual-ring';

export interface RenderSettings {
  presetId: string;
  layoutMode: LayoutMode;
  lyricAlign?: 'staggered' | 'center';
  leadInSeconds: number;
  wipeStyle: WipeStyle;
  showFurigana: boolean;
  showKoPron: boolean;
  koPronPosition: 'below' | 'above';
  showTranslation: boolean;
  showCountdown: boolean;
  countdownThreshold: number;
  showPitchGuide: boolean;
  showVisualizer: boolean;
  visualizerStyle?: VisualizerStyle;
  showParticles?: boolean;
  showProgressBar?: boolean;
  lyricBackdrop?: boolean;
  showTitleCard: boolean;
  bgType: BackgroundType;
  bgLoopStyle?: BackgroundLoopStyle;
  albumArtUrl?: string;
  bgFileId?: string;
  bgFileName?: string;
  bgDim: number;
  bgBlur: number;
  gradientStops: [string, string, string];
  baseTextColor: string;
  baseStrokeColor: string;
  highlightTextColor: string;
  highlightStrokeColor: string;
  koPronBaseColor: string;
  koPronHighlightColor: string;
  translationColor: string;
  pitchNoteColor: string;
  pitchSungColor: string;
  fontScale: number;
  badgeText: string;
  watermarkText: string;
}

export type AudioPlayMode = 'original' | 'mr' | 'karaoke' | 'mr-vocal' | 'mr-melody';

export function normalizeAudioPlayMode(
  mode?: AudioPlayMode
): 'original' | 'mr' | 'karaoke' {
  if (mode === 'mr') return 'mr';
  if (mode === 'karaoke' || mode === 'mr-vocal' || mode === 'mr-melody') {
    return 'karaoke';
  }
  return 'original';
}

export interface KaraokeProject {
  id: string;
  title: string;
  artist: string;
  subtitle: string;
  credits: string;
  duration: number;
  audioFileId?: string;
  audioFileName?: string;
  youtubeVideoId?: string;
  mrAudioFileId?: string;
  mrAudioFileName?: string;
  mrYoutubeId?: string;
  karaokeAudioFileId?: string;
  karaokeAudioFileName?: string;
  karaokeYoutubeId?: string;
  vocalFileId?: string;
  vocalFileName?: string;
  audioMode: AudioPlayMode;
  keyShift: number;
  guideVocalVolume: number;
  guideMelodyVolume: number;
  syncOffset: number;
  mrSyncOffset: number;
  karaokeSyncOffset: number;
  lines: LyricLine[];
  pitchNotes: PitchNote[];
  settings: RenderSettings;
  updatedAt: string;
}

export type AiProvider = 'gemini' | 'openai' | 'prompt';

export interface AiConfigPublic {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  maskedKey: string;
}

export interface LrcSearchResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  hasSynced: boolean;
  syncedLyrics: string;
  plainLyrics: string;
}

export type TranslationSourceType = 'youtube-cc' | 'web-parallel' | 'machine-fallback';

export interface TranslationCandidate {
  sourceType: Exclude<TranslationSourceType, 'machine-fallback'>;
  sourceLabel: string;
  sourceUrl: string;
  matchedCount: number;
  totalCount: number;
  translations: string[];
}

export interface SmartTranslateResult {
  lines: LyricLine[];
  sourceType: TranslationSourceType;
  sourceLabel: string;
  sourceUrl?: string;
  matchedFromWeb: number;
  fallbackFilled: number;
  totalLines: number;
  candidates: TranslationCandidate[];
}

export interface WebFuriganaMatchInfo {
  matched: boolean;
  sourceLabel: string;
  sourceUrl?: string;
  songTitle?: string;
  songArtist?: string;
  matchedLines: number;
  totalLines: number;
  overriddenSegments: number;
  verifiedSegments: number;
}

export interface SpectrumData {
  fps: number;
  bands: number;
  totalFrames: number;
  data: Uint8Array;
}

export type ExportQualityPreset = 'compact' | 'balanced' | 'high';

export interface WorkerGpuInfo {
  available: boolean;
  name: string;
  vramMb?: number;
}

export interface WorkerHealthResponse {
  ok: boolean;
  mode?: 'portable-worker' | 'local-worker';
  portable?: boolean;
  ffmpeg: boolean;
  kuromojiReady: boolean;
  ytdlp?: boolean;
  aiAudio?: boolean;
  gpu?: WorkerGpuInfo;
  dataDir?: string;
  version?: string;
}

export type LibraryQualityStatus = 'auto' | 'edited' | 'verified';
export type LibraryReportReason = 'sync' | 'pronunciation' | 'lyrics' | 'other';

export type ChromaSourceKind = 'mr' | 'original' | 'karaoke';

export interface SongChromaFingerprint {
  youtubeVideoId: string;
  algoVersion: string;
  sourceKind: ChromaSourceKind;
  fps: number;
  frameCount: number;
  offsetSec: number;
  chromaB64: string;
  updatedAt?: string;
}

export interface LibraryRevisionMeta {
  revId: string;
  version: number;
  status: LibraryQualityStatus;
  authorName: string;
  editNote: string;
  createdAt: string;
  lineCount: number;
  hasTranslation: boolean;
  lyricsHash: string;
}

export interface LibraryRevisionEntry extends LibraryRevisionMeta {
  lines: LyricLine[];
  mrYoutubeId?: string;
  mrSyncOffset?: number;
  karaokeYoutubeId?: string;
  karaokeSyncOffset?: number;
  disambiguatedCount?: number;
  deviceLabel?: string;
}

export interface LibraryReportEntry {
  id: string;
  reason: LibraryReportReason;
  note: string;
  createdAt: string;
}

export interface CommunitySongAnalysis {
  youtubeVideoId: string;
  lyricsHash: string;
  pipelineVersion: string;
  title: string;
  artist: string;
  duration: number;
  artworkUrl?: string;
  mrYoutubeId?: string;
  mrSyncOffset?: number;
  karaokeYoutubeId?: string;
  karaokeSyncOffset?: number;
  lines: LyricLine[];
  lineCount?: number;
  hasTranslation?: boolean;
  disambiguatedCount?: number;
  deviceLabel?: string;
  upvotes?: number;
  upvoterIds?: string[];
  updatedAt: string;
  status?: LibraryQualityStatus;
  locked?: boolean;
  authorName?: string;
  editNote?: string;
  activeRevisionId?: string;
  revisionCount?: number;
  revisions?: LibraryRevisionEntry[];
  reportCount?: number;
  reports?: LibraryReportEntry[];
  hidden?: boolean;
}

export interface LibrarySongSummary
  extends Omit<CommunitySongAnalysis, 'lines' | 'revisions' | 'reports' | 'upvoterIds'> {
  lineCount: number;
  hasTranslation: boolean;
  status: LibraryQualityStatus;
  locked: boolean;
  revisionCount: number;
  reportCount: number;
  hidden: boolean;
}

export interface ExportProgressMessage {
  type: 'ready' | 'progress' | 'done' | 'error';
  frame?: number;
  totalFrames?: number;
  fps?: number;
  percent?: number;
  fileName?: string;
  filePath?: string;
  downloadUrl?: string;
  fileSize?: number;
  message?: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  patch: Partial<RenderSettings>;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  presetId: 'utachaoh-teal',
  layoutMode: 'auto',
  lyricAlign: 'staggered',
  leadInSeconds: 3.5,
  wipeStyle: 'stroke-glow',
  showFurigana: true,
  showKoPron: true,
  koPronPosition: 'below',
  showTranslation: true,
  showCountdown: true,
  countdownThreshold: 4.5,
  showPitchGuide: false,
  showVisualizer: true,
  visualizerStyle: 'cd-radial',
  showParticles: true,
  showProgressBar: true,
  lyricBackdrop: false,
  showTitleCard: false,
  bgType: 'gradient',
  bgLoopStyle: 'cd-spin',
  bgDim: 0.45,
  bgBlur: 4,
  gradientStops: ['#0A343B', '#112A4A', '#1B193D'],
  baseTextColor: '#FFFFFF',
  baseStrokeColor: '#0A101D',
  highlightTextColor: '#FFFFFF',
  highlightStrokeColor: '#1E88FF',
  koPronBaseColor: '#DCE9FA',
  koPronHighlightColor: '#FFD54F',
  translationColor: '#E2E8F0',
  pitchNoteColor: '#FF4D94',
  pitchSungColor: '#334155',
  fontScale: 1.0,
  badgeText: '',
  watermarkText: '',
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'utachaoh-teal',
    name: '가라오케 클래식',
    description: '청록·남색 + 회전 CD 루프 + 파란 글로우',
    patch: {
      presetId: 'utachaoh-teal',
      bgType: 'gradient',
      bgLoopStyle: 'cd-spin',
      visualizerStyle: 'cd-radial',
      wipeStyle: 'stroke-glow',
      lyricAlign: 'staggered',
      gradientStops: ['#0A343B', '#112A4A', '#1B193D'],
      baseTextColor: '#FFFFFF',
      baseStrokeColor: '#0A101D',
      highlightTextColor: '#FFFFFF',
      highlightStrokeColor: '#1E88FF',
      koPronBaseColor: '#DCE9FA',
      koPronHighlightColor: '#FFD54F',
      translationColor: '#E2E8F0',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: true,
      showParticles: true,
      lyricBackdrop: false,
    },
  },
  {
    id: 'midnight-aurora',
    name: '미드나잇 오로라',
    description: '오로라 웨이브 루프 + 민트 채우기 와이프',
    patch: {
      presetId: 'midnight-aurora',
      bgType: 'gradient',
      bgLoopStyle: 'aurora-wave',
      visualizerStyle: 'silk-ribbon',
      wipeStyle: 'fill-wipe',
      lyricAlign: 'staggered',
      gradientStops: ['#06202B', '#0D3B49', '#1B1642'],
      baseTextColor: '#F8FAFC',
      baseStrokeColor: '#041016',
      highlightTextColor: '#34D399',
      highlightStrokeColor: '#064E3B',
      koPronBaseColor: '#D1FAE5',
      koPronHighlightColor: '#67E8F9',
      translationColor: '#E2E8F0',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: true,
      showParticles: true,
      lyricBackdrop: false,
    },
  },
  {
    id: 'sakura-dusk',
    name: '사쿠라 선셋',
    description: '로즈·인디고 회전 CD + 코랄 외곽선 글로우',
    patch: {
      presetId: 'sakura-dusk',
      bgType: 'gradient',
      bgLoopStyle: 'cd-spin',
      visualizerStyle: 'cd-radial',
      wipeStyle: 'stroke-glow',
      lyricAlign: 'staggered',
      gradientStops: ['#3B132B', '#2A1843', '#151B3A'],
      baseTextColor: '#FFFFFF',
      baseStrokeColor: '#170B14',
      highlightTextColor: '#FFFFFF',
      highlightStrokeColor: '#FB7185',
      koPronBaseColor: '#FCE7F3',
      koPronHighlightColor: '#FDE047',
      translationColor: '#F8FAFC',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: true,
      showParticles: true,
      lyricBackdrop: false,
    },
  },
  {
    id: 'neon-tokyo',
    name: '네온 도쿄',
    description: '사이버 네온 링 루프 + 시안 채우기 와이프',
    patch: {
      presetId: 'neon-tokyo',
      bgType: 'gradient',
      bgLoopStyle: 'neon-rings',
      visualizerStyle: 'dual-ring',
      wipeStyle: 'fill-wipe',
      lyricAlign: 'staggered',
      gradientStops: ['#13092B', '#26104C', '#0B2740'],
      baseTextColor: '#F8FAFC',
      baseStrokeColor: '#090714',
      highlightTextColor: '#38BDF8',
      highlightStrokeColor: '#082F49',
      koPronBaseColor: '#CBD5E1',
      koPronHighlightColor: '#F472B6',
      translationColor: '#E2E8F0',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: true,
      showParticles: true,
      lyricBackdrop: false,
    },
  },
  {
    id: 'warm-acoustic',
    name: '감성 어쿠스틱',
    description: '따뜻한 바이닐 CD 루프 + 앰버 골드 글로우',
    patch: {
      presetId: 'warm-acoustic',
      bgType: 'gradient',
      bgLoopStyle: 'cd-spin',
      visualizerStyle: 'mirror-wave',
      wipeStyle: 'stroke-glow',
      lyricAlign: 'staggered',
      gradientStops: ['#241712', '#2F2019', '#151A28'],
      baseTextColor: '#FFFBF2',
      baseStrokeColor: '#140C08',
      highlightTextColor: '#FFFFFF',
      highlightStrokeColor: '#F59E0B',
      koPronBaseColor: '#FEF3C7',
      koPronHighlightColor: '#FDE68A',
      translationColor: '#F1F5F9',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: true,
      showParticles: true,
      lyricBackdrop: false,
    },
  },
  {
    id: 'mv-cinema',
    name: 'MV 시네마',
    description: '중앙 정렬 + 반투명 자막 배경 + 영상 가독성 최적화',
    patch: {
      presetId: 'mv-cinema',
      bgLoopStyle: 'classic-bokeh',
      visualizerStyle: 'bottom-bars',
      wipeStyle: 'stroke-glow',
      lyricAlign: 'center',
      bgDim: 0.52,
      bgBlur: 2,
      baseTextColor: '#FFFDF0',
      baseStrokeColor: '#05070B',
      highlightTextColor: '#FFFFFF',
      highlightStrokeColor: '#2563EB',
      koPronBaseColor: '#FFFFFF',
      koPronHighlightColor: '#FACC15',
      translationColor: '#F8FAFC',
      showPitchGuide: false,
      showTitleCard: false,
      showProgressBar: true,
      showVisualizer: false,
      showParticles: true,
      lyricBackdrop: true,
    },
  },
];

export function createDefaultProject(): KaraokeProject {
  return {
    id: `proj_${Date.now().toString(36)}`,
    title: '가라오케',
    artist: '',
    subtitle: '',
    credits: '',
    duration: 240,
    audioMode: 'original',
    keyShift: 0,
    guideVocalVolume: 0.28,
    guideMelodyVolume: 0.75,
    syncOffset: 0,
    mrSyncOffset: 0,
    karaokeSyncOffset: 0,
    lines: [],
    pitchNotes: [],
    settings: { ...DEFAULT_RENDER_SETTINGS },
    updatedAt: new Date().toISOString(),
  };
}
