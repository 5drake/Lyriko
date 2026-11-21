import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDefaultProject,
  normalizeAudioPlayMode,
  type AudioPlayMode,
  type KaraokeProject,
  type LibrarySongSummary,
  type LyricLine,
  type SpectrumData,
  type WorkerHealthResponse,
} from '@shared/types';
import {
  alignLyricsWithAiProgress,
  autoSyncMrApi,
  convertJapaneseLyrics,
  fetchDemoProject,
  importYoutubeWithProgress,
  prepareProcessedAudioApi,
  searchLyricsOnline,
  translateLyricsSmart,
  type YoutubeImportResult,
} from './api';
import { ExportModal } from './components/ExportModal';
import { LeftSidebar } from './components/LeftSidebar';
import { LyricInspector } from './components/LyricInspector';
import {
  OnboardingTour,
  TOUR_STORAGE_KEY,
} from './components/OnboardingTour';
import {
  SettingsModal,
  type UiFontSizeMode,
  type UiThemeMode,
} from './components/SettingsModal';
import { StagePreview } from './components/StagePreview';
import { SongLibraryModal } from './components/SongLibraryModal';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';
import { WorkerStatusModal } from './components/WorkerStatusModal';
import type { RenderResources } from './engine/karaokeRenderer';
import { analyzeAudioSpectrum } from './engine/spectrumAnalyzer';
import { YoutubeFallbackController } from './engine/youtubeIframeAudio';
import {
  getCommunityDbStatus,
  getLibraryRevisionDetail,
  getLibrarySongDetail,
  lookupSongAnalysis,
  publishSongAnalysis,
  type PublishSongOptions,
  type PublishSongResult,
} from './services/communityDb';
import { probeWorkerHealth, workerUrl } from './workerClient';

const UI_THEME_KEY = 'utakana_ui_theme_v1';
const UI_FONT_SIZE_KEY = 'utakana_ui_font_size_v1';
const FRAME_STEP_FPS = 30;
const FRAME_STEP_SEC = 1 / FRAME_STEP_FPS;
const SCRUB_BLIP_SEC = 0.068;
const MAX_UNDO_HISTORY = 40;

function loadAudioElementSource(
  el: HTMLAudioElement,
  url: string,
  vol: number,
  rate: number,
  seekToSec?: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let loadTimer: number | undefined;
    let seekTimer: number | undefined;

    const cleanup = () => {
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', finish);
      el.removeEventListener('seeked', finish);
      if (loadTimer !== undefined) window.clearTimeout(loadTimer);
      if (seekTimer !== undefined) window.clearTimeout(seekTimer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onCanPlay = () => {
      el.removeEventListener('canplay', onCanPlay);
      if (loadTimer !== undefined) {
        window.clearTimeout(loadTimer);
        loadTimer = undefined;
      }
      if (seekToSec !== undefined && Number.isFinite(seekToSec) && seekToSec > 0.02) {
        const clamped = Math.min(
          seekToSec,
          Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : seekToSec
        );
        if (Math.abs(el.currentTime - clamped) > 0.015) {
          el.addEventListener('seeked', finish, { once: true });
          seekTimer = window.setTimeout(finish, 700);
          el.currentTime = clamped;
          return;
        }
      }
      finish();
    };

    el.addEventListener('canplay', onCanPlay, { once: true });
    el.addEventListener('error', finish, { once: true });
    loadTimer = window.setTimeout(onCanPlay, 3500);
    el.src = url;
    el.muted = false;
    el.volume = vol;
    el.playbackRate = rate;
    el.load();
  });
}

function clearAudioElementSource(el: HTMLAudioElement | null): void {
  if (!el) return;
  el.pause();
  el.removeAttribute('src');
  el.load();
}

export default function App() {
  const [project, setProject] = useState<KaraokeProject>(() => createDefaultProject());
  const [currentTime, setCurrentTime] = useState(11.6);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(0.25);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [spectrum, setSpectrum] = useState<SpectrumData | undefined>(undefined);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [bgVideo, setBgVideo] = useState<HTMLVideoElement | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [workerOpen, setWorkerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiTheme, setUiTheme] = useState<UiThemeMode>(() => {
    try {
      const saved = window.localStorage.getItem(UI_THEME_KEY);
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [uiFontSize, setUiFontSize] = useState<UiFontSizeMode>(() => {
    try {
      const saved = window.localStorage.getItem(UI_FONT_SIZE_KEY);
      if (saved === 'normal' || saved === 'xlarge') return saved;
      return 'large';
    } catch {
      return 'large';
    }
  });
  const [libraryModalOpen, setLibraryModalOpen] = useState(false);
  const [libraryHubTab, setLibraryHubTab] = useState<'search' | 'library'>('library');
  const [libraryInitialPublish, setLibraryInitialPublish] = useState(false);
  const [libraryInitialQuery, setLibraryInitialQuery] = useState('');
  const [librarySearchNonce, setLibrarySearchNonce] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [libraryLoadingId, setLibraryLoadingId] = useState<string | null>(null);
  const [libraryLoadStatus, setLibraryLoadStatus] = useState('');
  const [tourOpen, setTourOpen] = useState(() => {
    try {
      return window.localStorage.getItem(TOUR_STORAGE_KEY) !== '1';
    } catch {
      return false;
    }
  });
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workerChecking, setWorkerChecking] = useState(true);
  const [dbProvider, setDbProvider] = useState<'supabase' | 'local-cache'>(
    () => getCommunityDbStatus().provider
  );

  const [audioError, setAudioError] = useState('');
  const [audioProcessing, setAudioProcessing] = useState(false);
  const [aiAligning, setAiAligning] = useState(false);
  const [aiAlignStatus, setAiAlignStatus] = useState('');
  const [mrSyncing, setMrSyncing] = useState(false);
  const [mrSyncStatus, setMrSyncStatus] = useState('');
  const [mrSyncMonitorOriginal, setMrSyncMonitorOriginal] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    canUndoAction?: boolean;
  } | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const projectRef = useRef<KaraokeProject>(project);
  const lastFrameTsRef = useRef<number>(0);
  const resolvedAudioSpecRef = useRef<string>('');
  const currentTimeRef = useRef<number>(currentTime);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const playbackRateRef = useRef<number>(playbackRate);
  const volumeRef = useRef<number>(volume);
  const keyShiftRef = useRef<number>(0);
  const prevEffectiveModeRef = useRef<'original' | 'mr' | 'karaoke'>('original');
  const scrubCtxRef = useRef<AudioContext | null>(null);
  const scrubSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const scrubGainRef = useRef<GainNode | null>(null);
  const scrubTimerRef = useRef<number | null>(null);
  const undoStackRef = useRef<KaraokeProject[]>([]);
  const redoStackRef = useRef<KaraokeProject[]>([]);
  const lastHistoryPushRef = useRef<number>(0);
  const toastTimerRef = useRef<number | null>(null);
  const ytControllerRef = useRef<YoutubeFallbackController | null>(null);
  const ytLoadedVideoIdRef = useRef<string>('');

  const audioMode = normalizeAudioPlayMode(project.audioMode);
  const keyShift = Math.max(-6, Math.min(6, Math.round(project.keyShift ?? 0)));
  const mrSyncOffset = Math.max(-45, Math.min(45, Number(project.mrSyncOffset ?? 0)));
  const karaokeSyncOffset = Math.max(
    -45,
    Math.min(45, Number(project.karaokeSyncOffset ?? 0))
  );

  projectRef.current = project;
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  playbackRateRef.current = playbackRate;
  volumeRef.current = volume;
  keyShiftRef.current = keyShift;

  const showToast = useCallback(
    (
      message: string,
      opts?: { canUndoAction?: boolean; durationMs?: number }
    ) => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setToast({ message, canUndoAction: opts?.canUndoAction });
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = null;
        setToast(null);
      }, opts?.durationMs ?? 2400);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastHistoryPushRef.current = 0;
  }, []);

  const updateProjectWithHistory: React.Dispatch<
    React.SetStateAction<KaraokeProject>
  > = useCallback((action) => {
    const prev = projectRef.current;
    const next = typeof action === 'function' ? action(prev) : action;
    if (next === prev) return;
    const now = Date.now();
    const shouldCoalesce =
      undoStackRef.current.length > 0 && now - lastHistoryPushRef.current < 450;
    if (!shouldCoalesce) {
      undoStackRef.current = [
        ...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)),
        prev,
      ];
    }
    lastHistoryPushRef.current = now;
    redoStackRef.current = [];
    projectRef.current = next;
    setProject(next);
  }, []);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    const cur = projectRef.current;
    redoStackRef.current = [
      ...redoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)),
      cur,
    ];
    lastHistoryPushRef.current = 0;
    projectRef.current = prev;
    setProject(prev);
    showToast('실행 취소됨', { durationMs: 1800 });
  }, [showToast]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    const cur = projectRef.current;
    undoStackRef.current = [
      ...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)),
      cur,
    ];
    lastHistoryPushRef.current = 0;
    projectRef.current = next;
    setProject(next);
    showToast('다시 실행됨', { durationMs: 1800 });
  }, [showToast]);

  const refreshWorkerHealth = useCallback(async () => {
    setWorkerChecking(true);
    try {
      const res = await probeWorkerHealth(3000);
      setWorkerHealth(res);
    } finally {
      setWorkerChecking(false);
      setDbProvider(getCommunityDbStatus().provider);
    }
  }, []);

  useEffect(() => {
    void refreshWorkerHealth();
  }, [refreshWorkerHealth]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
    try {
      window.localStorage.setItem(UI_THEME_KEY, uiTheme);
    } catch {
      // ignore storage failure
    }
  }, [uiTheme]);

  useEffect(() => {
    document.documentElement.dataset.fontSize = uiFontSize;
    try {
      window.localStorage.setItem(UI_FONT_SIZE_KEY, uiFontSize);
    } catch {
      // ignore storage failure
    }
  }, [uiFontSize]);

  const openSongSearchModal = useCallback((initialQuery?: string) => {
    setLibraryHubTab('search');
    setLibraryInitialPublish(false);
    if (initialQuery?.trim()) {
      setLibraryInitialQuery(initialQuery.trim());
      setLibrarySearchNonce((n) => n + 1);
    } else {
      setLibraryInitialQuery('');
    }
    setLibraryModalOpen(true);
  }, []);

  // Load demo project on initial mount so the user sees live karaoke styling immediately
  const loadDemo = useCallback(async () => {
    try {
      const demo = await fetchDemoProject();
      resolvedAudioSpecRef.current = '';
      setMrSyncMonitorOriginal(false);
      setMrSyncStatus('');
      setProject(demo);
      setAudioBuffer(null);
      setSpectrum(undefined);
      setAudioError('');
      setSelectedLineId(demo.lines[1]?.id ?? demo.lines[0]?.id ?? null);
      setIsPlaying(false);
      setCurrentTime(12.8); // Right in the middle of line 2 with line 3 preview visible!
      clearAudioElementSource(audioElRef.current);
    } catch {
      // ignore initial offline error
    }
  }, []);

  useEffect(() => {
    loadDemo();
  }, [loadDemo]);

  // Decode audio file into AudioBuffer + precompute 60fps spectrum
  const decodeAndAnalyzeAudio = useCallback(async (url: string) => {
    try {
      const res = await fetch(url);
      const arrBuf = await res.arrayBuffer();
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const decoded = await ctx.decodeAudioData(arrBuf);
      await ctx.close().catch(() => {});

      setAudioBuffer(decoded);
      setProject((prev) => ({
        ...prev,
        duration: Number(decoded.duration.toFixed(2)),
      }));
      const spec = await analyzeAudioSpectrum(decoded, 60, 64);
      setSpectrum(spec);
    } catch (err) {
      console.error('Audio decode error:', err);
    }
  }, []);

  const handleAudioLoaded = useCallback(
    async (
      fileId: string,
      originalName: string,
      url: string,
      opts?: {
        youtubeVideoId?: string;
        initialKeyShift?: number;
        preserveTrackOffsets?: boolean;
      }
    ) => {
      const nextKeyShift =
        typeof opts?.initialKeyShift === 'number' && Number.isFinite(opts.initialKeyShift)
          ? Math.max(-6, Math.min(6, Math.round(opts.initialKeyShift)))
          : 0;
      keyShiftRef.current = nextKeyShift;
      setIsPlaying(false);
      setCurrentTime(0);
      setAudioError('');
      setMrSyncMonitorOriginal(false);
      setMrSyncStatus('');
      resolvedAudioSpecRef.current = `orig|${fileId}|k0`;
      prevEffectiveModeRef.current = 'original';
      setProject((prev) => {
        const keepTrackSlots =
          Boolean(opts?.preserveTrackOffsets) || prev.audioFileId === fileId;
        return {
          ...prev,
          id: prev.id === 'demo_tobu_toki' ? `proj_${Date.now().toString(36)}` : prev.id,
          audioFileId: fileId,
          audioFileName: originalName,
          youtubeVideoId:
            opts?.youtubeVideoId ??
            (prev.audioFileId !== fileId ? undefined : prev.youtubeVideoId),
          mrAudioFileId: keepTrackSlots ? prev.mrAudioFileId : undefined,
          mrAudioFileName: keepTrackSlots ? prev.mrAudioFileName : undefined,
          mrYoutubeId: keepTrackSlots ? prev.mrYoutubeId : undefined,
          mrSyncOffset: keepTrackSlots ? (prev.mrSyncOffset ?? 0) : 0,
          karaokeAudioFileId: keepTrackSlots ? prev.karaokeAudioFileId : undefined,
          karaokeAudioFileName: keepTrackSlots ? prev.karaokeAudioFileName : undefined,
          karaokeYoutubeId: keepTrackSlots ? prev.karaokeYoutubeId : undefined,
          karaokeSyncOffset: keepTrackSlots ? (prev.karaokeSyncOffset ?? 0) : 0,
          vocalFileId: undefined,
          vocalFileName: undefined,
          pitchNotes: prev.audioFileId !== fileId ? [] : prev.pitchNotes,
          audioMode: 'original',
          keyShift: nextKeyShift,
        };
      });
      let playUrl = url;
      try {
        const prepared = await prepareProcessedAudioApi({
          audioFileId: fileId,
          mode: 'original',
          keyShift: 0,
        });
        playUrl = prepared.url;
      } catch {
        // fallback to raw media URL
      }
      if (audioElRef.current) {
        await loadAudioElementSource(audioElRef.current, playUrl, volume, playbackRate, 0);
      }
      await decodeAndAnalyzeAudio(playUrl);
    },
    [decodeAndAnalyzeAudio, playbackRate, volume]
  );

  const runAutoSyncMr = useCallback(
    async (
      targetSlot: 'mr' | 'karaoke' = 'mr',
      overrideAudioId?: string,
      overrideTargetId?: string,
      overrideKeyShift?: number
    ) => {
      const targetAudioId = overrideAudioId ?? project.audioFileId;
      const targetTrackId =
        overrideTargetId ??
        (targetSlot === 'karaoke' ? project.karaokeAudioFileId : project.mrAudioFileId);
      if (!targetAudioId || !targetTrackId) return;

      const label = targetSlot === 'karaoke' ? '노래방' : 'MR';
      setMrSyncing(true);
      setMrSyncStatus(`원곡·${label} 파형 정밀 싱크 분석 중...`);
      setAudioError('');
      try {
        const res = await autoSyncMrApi(targetAudioId, targetTrackId);
        const cleanOffset = Number(res.offsetSec.toFixed(3));
        setProject((prev) => {
          const currentSlotId =
            targetSlot === 'karaoke' ? prev.karaokeAudioFileId : prev.mrAudioFileId;
          if (prev.audioFileId !== targetAudioId || currentSlotId !== targetTrackId) {
            return prev;
          }
          return targetSlot === 'karaoke'
            ? { ...prev, karaokeSyncOffset: cleanOffset }
            : { ...prev, mrSyncOffset: cleanOffset };
        });

        const effectiveShift =
          typeof overrideKeyShift === 'number' && Number.isFinite(overrideKeyShift)
            ? Math.max(-6, Math.min(6, Math.round(overrideKeyShift)))
            : keyShiftRef.current;
        setMrSyncStatus(`${label} 오디오 사전 변환·준비 중...`);
        const prepareArgs = {
          audioFileId: targetAudioId,
          mrAudioFileId: targetSlot === 'mr' ? targetTrackId : undefined,
          karaokeAudioFileId: targetSlot === 'karaoke' ? targetTrackId : undefined,
          mode: targetSlot,
          keyShift: effectiveShift,
          mrSyncOffset: targetSlot === 'mr' ? cleanOffset : undefined,
          karaokeSyncOffset: targetSlot === 'karaoke' ? cleanOffset : undefined,
        };
        await prepareProcessedAudioApi({ ...prepareArgs, monitorOriginal: false }).catch(
          () => {}
        );
        void prepareProcessedAudioApi({ ...prepareArgs, monitorOriginal: true }).catch(
          () => {}
        );

        const sign = cleanOffset >= 0 ? '+' : '';
        const warnSuffix = res.warning ? ` · ⚠ ${res.warning}` : '';
        setMrSyncStatus(
          `${label} 자동 싱크 및 오디오 준비 완료 (${sign}${cleanOffset.toFixed(2)}초 · 일치도 ${res.confidence}%)${warnSuffix}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMrSyncStatus(`자동 싱크 실패: ${msg}`);
        setAudioError(msg);
      } finally {
        setMrSyncing(false);
      }
    },
    [project.audioFileId, project.karaokeAudioFileId, project.mrAudioFileId]
  );

  const handleChangeMrSyncOffset = useCallback((offsetSec: number) => {
    const clamped = Math.max(-45, Math.min(45, Number(offsetSec) || 0));
    setProject((prev) => ({ ...prev, mrSyncOffset: Number(clamped.toFixed(3)) }));
  }, []);

  const handleChangeKaraokeSyncOffset = useCallback((offsetSec: number) => {
    const clamped = Math.max(-45, Math.min(45, Number(offsetSec) || 0));
    setProject((prev) => ({ ...prev, karaokeSyncOffset: Number(clamped.toFixed(3)) }));
  }, []);

  const loadSyncedSlotTrack = useCallback(
    async (
      slot: 'mr' | 'karaoke',
      fileId: string,
      originalName: string,
      overrideAudioId?: string,
      overrideKeyShift?: number,
      youtubeVideoId?: string
    ) => {
      setAudioError('');
      setMrSyncStatus('');
      const baseAudioId = overrideAudioId ?? project.audioFileId;
      const effectiveShift =
        typeof overrideKeyShift === 'number' && Number.isFinite(overrideKeyShift)
          ? Math.max(-6, Math.min(6, Math.round(overrideKeyShift)))
          : keyShiftRef.current;
      if (typeof overrideKeyShift === 'number' && Number.isFinite(overrideKeyShift)) {
        keyShiftRef.current = effectiveShift;
      }
      setProject((prev) => ({
        ...prev,
        ...(slot === 'karaoke'
          ? {
              karaokeAudioFileId: fileId,
              karaokeAudioFileName: originalName,
              karaokeYoutubeId: youtubeVideoId ?? prev.karaokeYoutubeId,
              karaokeSyncOffset: 0,
            }
          : {
              mrAudioFileId: fileId,
              mrAudioFileName: originalName,
              mrYoutubeId: youtubeVideoId ?? prev.mrYoutubeId,
              mrSyncOffset: 0,
            }),
        ...(typeof overrideKeyShift === 'number' && Number.isFinite(overrideKeyShift)
          ? { keyShift: effectiveShift }
          : {}),
        audioMode: overrideAudioId ? prev.audioMode : slot,
      }));
      if (baseAudioId) {
        await runAutoSyncMr(slot, baseAudioId, fileId, effectiveShift);
      } else {
        await prepareProcessedAudioApi({
          mrAudioFileId: slot === 'mr' ? fileId : undefined,
          karaokeAudioFileId: slot === 'karaoke' ? fileId : undefined,
          mode: slot,
          keyShift: effectiveShift,
          mrSyncOffset: 0,
          karaokeSyncOffset: 0,
          monitorOriginal: false,
        }).catch(() => {});
      }
    },
    [project.audioFileId, runAutoSyncMr]
  );

  const handleMrAudioLoaded = useCallback(
    (
      fileId: string,
      originalName: string,
      overrideAudioId?: string,
      overrideKeyShift?: number,
      youtubeVideoId?: string
    ) =>
      loadSyncedSlotTrack(
        'mr',
        fileId,
        originalName,
        overrideAudioId,
        overrideKeyShift,
        youtubeVideoId
      ),
    [loadSyncedSlotTrack]
  );

  const handleKaraokeAudioLoaded = useCallback(
    (
      fileId: string,
      originalName: string,
      overrideAudioId?: string,
      overrideKeyShift?: number,
      youtubeVideoId?: string
    ) =>
      loadSyncedSlotTrack(
        'karaoke',
        fileId,
        originalName,
        overrideAudioId,
        overrideKeyShift,
        youtubeVideoId
      ),
    [loadSyncedSlotTrack]
  );

  const loadBackgroundMedia = useCallback(
    (kind: 'image' | 'video', url: string) => {
      if (kind === 'image') {
        setBgVideo(null);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => setBgImage(img);
        img.src = url;
      } else {
        setBgImage(null);
        const vid = document.createElement('video');
        vid.crossOrigin = 'anonymous';
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.onloadeddata = () => setBgVideo(vid);
        vid.src = url;
      }
    },
    []
  );

  const handleBackgroundLoaded = useCallback(
    (
      kind: 'image' | 'video',
      fileId: string,
      originalName: string,
      url: string,
      keepBgType?: boolean
    ) => {
      const shouldLinkAudio = kind === 'video' && !project.audioFileId;
      setProject((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          bgType: keepBgType ? prev.settings.bgType : kind,
          bgFileId: fileId,
          bgFileName: originalName,
        },
      }));
      loadBackgroundMedia(kind, url);
      if (shouldLinkAudio) {
        void handleAudioLoaded(fileId, originalName, url);
      }
    },
    [handleAudioLoaded, loadBackgroundMedia, project.audioFileId]
  );

  // Auto-load album cover artwork when no custom background file is uploaded
  useEffect(() => {
    if (project.settings.bgFileId) return;
    if (project.settings.albumArtUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => setBgImage(img);
      img.onerror = () => setBgImage(null);
      img.src = project.settings.albumArtUrl;
    } else {
      setBgImage(null);
    }
  }, [project.settings.albumArtUrl, project.settings.bgFileId]);

  const handleShiftAllLyrics = useCallback((deltaSec: number) => {
    if (!deltaSec || !Number.isFinite(deltaSec)) return;
    updateProjectWithHistory((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => {
        const dur = Math.max(0.1, line.endTime - line.startTime);
        const nextStart = Math.max(0, Number((line.startTime + deltaSec).toFixed(3)));
        const shift = nextStart - line.startTime;
        const nextEnd = Number(
          Math.max(nextStart + dur, line.endTime + shift).toFixed(3)
        );
        return {
          ...line,
          startTime: nextStart,
          endTime: nextEnd,
          segments: line.segments.map((seg) => {
            const sDur = Math.max(0.05, seg.endTime - seg.startTime);
            const sStart = Math.max(
              nextStart,
              Number((seg.startTime + shift).toFixed(3))
            );
            const sEnd = Number(
              Math.max(sStart + sDur, seg.endTime + shift).toFixed(3)
            );
            return {
              ...seg,
              startTime: sStart,
              endTime: sEnd,
            };
          }),
        };
      }),
    }));
  }, [updateProjectWithHistory]);

  // Master playback loop (local audio, YouTube IFrame fallback, OR virtual clock)
  const hasAnyAudioTrack = Boolean(
    project.audioFileId || project.mrAudioFileId || project.karaokeAudioFileId
  );

  const activeYtTarget = useMemo(() => {
    if (hasAnyAudioTrack) return null;
    if (audioMode === 'karaoke' && project.karaokeYoutubeId) {
      return {
        videoId: project.karaokeYoutubeId,
        offsetSec: karaokeSyncOffset,
      };
    }
    if ((audioMode === 'mr' || audioMode === 'karaoke') && project.mrYoutubeId) {
      return {
        videoId: project.mrYoutubeId,
        offsetSec: mrSyncOffset,
      };
    }
    if (project.youtubeVideoId) {
      return {
        videoId: project.youtubeVideoId,
        offsetSec: 0,
      };
    }
    return null;
  }, [
    hasAnyAudioTrack,
    audioMode,
    project.karaokeYoutubeId,
    project.mrYoutubeId,
    project.youtubeVideoId,
    karaokeSyncOffset,
    mrSyncOffset,
  ]);
  const usingYoutubeFallback = Boolean(activeYtTarget);

  // Clean up YouTube fallback controller on unmount
  useEffect(() => {
    return () => {
      ytControllerRef.current?.destroy();
      ytControllerRef.current = null;
    };
  }, []);

  // Load / switch YouTube fallback video whenever local audio isn't attached
  useEffect(() => {
    if (!activeYtTarget) {
      ytLoadedVideoIdRef.current = '';
      ytControllerRef.current?.pause();
      return;
    }

    if (!ytControllerRef.current) {
      ytControllerRef.current = new YoutubeFallbackController({
        onStateChange: (state) => {
          if (state === 0) {
            setIsPlaying(false);
          }
        },
        onError: (_code, msg) => {
          setAudioError(msg);
          setIsPlaying(false);
        },
      });
    }

    if (ytLoadedVideoIdRef.current !== activeYtTarget.videoId) {
      ytLoadedVideoIdRef.current = activeYtTarget.videoId;
      const startYtSec = Math.max(0, currentTimeRef.current - activeYtTarget.offsetSec);
      const shouldAutoplay =
        isPlayingRef.current &&
        (activeYtTarget.offsetSec <= 0 || currentTimeRef.current >= activeYtTarget.offsetSec);
      void ytControllerRef.current.load(
        activeYtTarget.videoId,
        startYtSec,
        shouldAutoplay,
        volumeRef.current,
        playbackRateRef.current
      );
    }
  }, [activeYtTarget]);

  // Sync audio playbackRate and volume across local <audio> and YouTube fallback
  useEffect(() => {
    const audio = audioElRef.current;
    if (audio) {
      audio.playbackRate = playbackRate;
      audio.volume = volume;
    }
    if (ytControllerRef.current) {
      ytControllerRef.current.setPlaybackRate(playbackRate);
      ytControllerRef.current.setVolume(volume);
    }
  }, [playbackRate, volume]);

  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    lastFrameTsRef.current = performance.now();

    const tick = (now: number) => {
      const audio = audioElRef.current;
      const yt = ytControllerRef.current;
      if (hasAnyAudioTrack && audio && audio.src) {
        if (!audio.paused) {
          setCurrentTime(audio.currentTime);
        }
        if (audio.ended) {
          setIsPlaying(false);
          return;
        }
      } else if (activeYtTarget && yt) {
        if (
          activeYtTarget.offsetSec > 0 &&
          currentTimeRef.current < activeYtTarget.offsetSec
        ) {
          const dt = ((now - lastFrameTsRef.current) / 1000) * playbackRate;
          lastFrameTsRef.current = now;
          const next = currentTimeRef.current + dt;
          if (yt.isPlayingState()) {
            yt.pause();
          }
          if (next >= activeYtTarget.offsetSec) {
            currentTimeRef.current = activeYtTarget.offsetSec;
            setCurrentTime(activeYtTarget.offsetSec);
            yt.seekTo(0);
            yt.play();
          } else {
            currentTimeRef.current = next;
            setCurrentTime(next);
          }
        } else {
          lastFrameTsRef.current = now;
          if (yt.isPlayingState()) {
            const rawYtTime = yt.getCurrentTime();
            const synced = Math.min(project.duration, rawYtTime + activeYtTarget.offsetSec);
            if (Number.isFinite(synced) && synced >= 0) {
              currentTimeRef.current = synced;
              setCurrentTime(synced);
            }
            if (synced >= project.duration) {
              yt.pause();
              setIsPlaying(false);
              return;
            }
          }
        }
      } else {
        const dt = ((now - lastFrameTsRef.current) / 1000) * playbackRate;
        lastFrameTsRef.current = now;
        setCurrentTime((t) => {
          const next = t + dt;
          if (next >= project.duration) {
            setIsPlaying(false);
            return project.duration;
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, playbackRate, hasAnyAudioTrack, activeYtTarget, project.duration]);

  // Keep background <video> synchronized with preview currentTime
  useEffect(() => {
    if (!bgVideo || !Number.isFinite(bgVideo.duration) || bgVideo.duration <= 0) return;
    if (isPlaying) {
      if (bgVideo.paused) bgVideo.play().catch(() => {});
    } else {
      if (!bgVideo.paused) bgVideo.pause();
      const target = currentTime % bgVideo.duration;
      if (Math.abs(bgVideo.currentTime - target) > 0.08) {
        bgVideo.currentTime = target;
      }
    }
  }, [bgVideo, isPlaying, currentTime]);

  // Auto-prepare processed audio whenever tracks, audioMode, keyShift, or sync offsets change
  useEffect(() => {
    const audioId = project.audioFileId;
    const mrId = project.mrAudioFileId;
    const karaokeId = project.karaokeAudioFileId;
    const vocalId = project.vocalFileId;
    if (!audioId && !mrId && !karaokeId) {
      resolvedAudioSpecRef.current = '';
      return;
    }

    const effectiveMode: 'original' | 'mr' | 'karaoke' = audioMode;
    const activeOffsetSec =
      audioMode === 'karaoke' && karaokeId
        ? karaokeSyncOffset
        : audioMode !== 'original' && mrId
          ? mrSyncOffset
          : 0;
    const effectiveOffsetMs = Math.round(activeOffsetSec * 1000);
    const hasMonitor =
      mrSyncMonitorOriginal &&
      audioMode !== 'original' &&
      Boolean(audioId && (mrId || karaokeId));
    const effectiveTrackId =
      effectiveMode === 'karaoke'
        ? karaokeId || mrId || audioId || ''
        : effectiveMode === 'mr'
          ? mrId || audioId || ''
          : audioId || '';
    const spec =
      effectiveMode === 'original'
        ? `orig|${audioId || ''}|k0`
        : `${effectiveMode}|${effectiveTrackId}|${hasMonitor ? audioId || '' : ''}|k${keyShift}|o${effectiveOffsetMs}`;
    if (spec === resolvedAudioSpecRef.current) {
      return;
    }

    const modeChanged = prevEffectiveModeRef.current !== effectiveMode;
    prevEffectiveModeRef.current = effectiveMode;
    const delayMs = modeChanged ? 15 : 180;

    let cancelled = false;
    let spinnerTimer: number | undefined;
    const timer = window.setTimeout(async () => {
      setAudioError('');
      spinnerTimer = window.setTimeout(() => {
        if (!cancelled) setAudioProcessing(true);
      }, 120);
      try {
        const res = await prepareProcessedAudioApi({
          audioFileId: audioId,
          mrAudioFileId: mrId,
          karaokeAudioFileId: karaokeId,
          vocalFileId: vocalId,
          mode: audioMode,
          keyShift: effectiveMode === 'original' ? 0 : keyShift,
          mrSyncOffset,
          karaokeSyncOffset,
          monitorOriginal: hasMonitor,
        });
        if (cancelled) return;
        resolvedAudioSpecRef.current = spec;

        const audio = audioElRef.current;
        if (audio) {
          const wasPlaying = !audio.paused || isPlayingRef.current;
          const resumeAt =
            !audio.paused && Number.isFinite(audio.currentTime)
              ? audio.currentTime
              : currentTimeRef.current;
          audio.pause();

          await loadAudioElementSource(
            audio,
            res.url,
            volumeRef.current,
            playbackRateRef.current,
            resumeAt
          );
          if (cancelled) return;

          if (Number.isFinite(audio.currentTime)) {
            setCurrentTime(audio.currentTime);
          }
          if (wasPlaying) {
            audio.play().catch((err) => {
              setAudioError(
                `오디오 재생 실패: ${err instanceof Error ? err.message : String(err)}`
              );
              setIsPlaying(false);
            });
          }
        }
      } catch (err) {
        if (!cancelled) {
          setAudioError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (spinnerTimer !== undefined) {
          window.clearTimeout(spinnerTimer);
        }
        if (!cancelled) {
          setAudioProcessing(false);
        }
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (spinnerTimer !== undefined) {
        window.clearTimeout(spinnerTimer);
      }
    };
  }, [
    project.audioFileId,
    project.mrAudioFileId,
    project.karaokeAudioFileId,
    project.vocalFileId,
    audioMode,
    keyShift,
    mrSyncOffset,
    karaokeSyncOffset,
    mrSyncMonitorOriginal,
  ]);

  const runAiLyricsForcedAlign = useCallback(
    async (
      overrideAudioFileId?: string,
      overrideLines?: LyricLine[],
      metaOverride?: {
        youtubeVideoId?: string;
        title?: string;
        artist?: string;
        duration?: number;
      }
    ) => {
      const snap = projectRef.current;
      const targetAudioId = overrideAudioFileId ?? snap.audioFileId;
      const targetLines = overrideLines ?? snap.lines;
      if (!targetAudioId || targetLines.length === 0 || aiAligning) {
        return;
      }
      setAiAligning(true);
      setAiAlignStatus('보컬 음소 가사 싱크 정렬 준비 중...');
      setAudioError('');
      try {
        const res = await alignLyricsWithAiProgress(
          {
            audioFileId: targetAudioId,
            lines: targetLines,
          },
          (job) => {
            setAiAlignStatus(job.message);
          }
        );
        setProject((prev) => ({
          ...prev,
          lines: res.lines,
        }));
        const shiftInfo =
          typeof res.stats.globalShiftSec === 'number' &&
          Math.abs(res.stats.globalShiftSec) >= 0.05
            ? ` · 전체 ${res.stats.globalShiftSec > 0 ? '+' : ''}${res.stats.globalShiftSec.toFixed(2)}초 보정`
            : '';
        const disambigInfo =
          (res.stats.disambiguatedCount ?? 0) > 0
            ? ` · 다중독음 ${res.stats.disambiguatedCount}건 자동 보정`
            : '';
        const baseStatus = `정렬 완료 (${res.stats.alignedLines}줄 · 음소 CTC 정렬${shiftInfo}${disambigInfo})`;
        setAiAlignStatus(baseStatus);

        const latest = projectRef.current;
        const targetVid = metaOverride?.youtubeVideoId || latest.youtubeVideoId;
        if (targetVid && res.lines.length > 0) {
          void publishSongAnalysis(
            {
              youtubeVideoId: targetVid,
              title: metaOverride?.title || latest.title,
              artist: metaOverride?.artist || latest.artist,
              duration: metaOverride?.duration || latest.duration,
              artworkUrl:
                latest.settings.albumArtUrl ||
                `https://i.ytimg.com/vi/${targetVid}/hqdefault.jpg`,
              mrYoutubeId: latest.mrYoutubeId,
              mrSyncOffset: latest.mrSyncOffset,
              karaokeYoutubeId: latest.karaokeYoutubeId,
              karaokeSyncOffset: latest.karaokeSyncOffset,
              lines: res.lines,
              disambiguatedCount: res.stats.disambiguatedCount,
              deviceLabel: workerHealth?.gpu?.name || res.stats.device,
            },
            {
              mode: 'auto',
              authorName: 'AI 자동 분석',
              editNote: '초기 AI 음소 싱크',
            }
          ).then((pubRes) => {
            setDbProvider(getCommunityDbStatus().provider);
            if (pubRes.ok && !pubRes.skipped) {
              setLibraryVersion((v) => v + 1);
              setAiAlignStatus(`${baseStatus} · 라이브러리 자동 등록`);
            }
          });
        }
      } catch (err) {
        setAudioError(err instanceof Error ? err.message : String(err));
      } finally {
        setAiAligning(false);
      }
    },
    [aiAligning, workerHealth?.gpu?.name]
  );

  const runAutoLyricsPipeline = useCallback(
    async (opts: {
      query: string;
      audioFileId?: string;
      audioDuration?: number;
      youtubeVideoId?: string;
      fallbackTitle?: string;
      fallbackArtist?: string;
      autoApplyIfDemo?: boolean;
      forceApply?: boolean;
      autoTranslate?: boolean;
      autoAlign?: boolean;
    }) => {
      const q = opts.query.trim();
      if (!q) return;
      const snap = projectRef.current;
      setAiAlignStatus('공식 가사 검색 중...');
      try {
        const targetDur =
          opts.audioDuration ?? (snap.audioFileId ? snap.duration : undefined);
        const results = await searchLyricsOnline(q, targetDur);
        if (results.length === 0) {
          setAiAlignStatus('자동 검색된 공식 가사가 없습니다.');
          return;
        }
        const preferred = results.find((r) => r.hasSynced) ?? results[0];
        if (
          !preferred ||
          !((opts.autoApplyIfDemo && results[0]?.hasSynced) || opts.forceApply)
        ) {
          return;
        }
        const rawText = preferred.syncedLyrics || preferred.plainLyrics;
        if (!rawText) return;
        const dur = targetDur || preferred.duration || snap.duration;
        const lines = await convertJapaneseLyrics({
          rawText,
          duration: dur,
          longVowelMode: 'vowel',
        });
        let finalLines = lines;
        const appliedTitle = preferred.trackName || opts.fallbackTitle || snap.title;
        const appliedArtist = preferred.artistName || opts.fallbackArtist || snap.artist;
        setProject((prev) => ({
          ...prev,
          title: preferred.trackName || prev.title,
          artist: preferred.artistName || prev.artist,
          duration: prev.audioFileId
            ? prev.duration
            : Math.max(prev.duration, preferred.duration || 240),
          lines,
        }));
        setSelectedLineId(lines[0]?.id ?? null);

        const targetVid = opts.youtubeVideoId || projectRef.current.youtubeVideoId;
        if (opts.autoTranslate) {
          setAiAlignStatus(`공식 가사 ${lines.length}줄 변환 완료 · 신뢰 번역 찾는 중...`);
          try {
            const transRes = await translateLyricsSmart({
              title: appliedTitle,
              artist: appliedArtist,
              youtubeVideoId: targetVid,
              lines,
            });
            finalLines = transRes.lines;
            setProject((prev) => ({
              ...prev,
              lines: transRes.lines,
              settings: { ...prev.settings, showTranslation: true },
            }));
          } catch {
            // keep lyrics even if translation fails
          }
        }

        const targetAudioId = opts.audioFileId || projectRef.current.audioFileId;
        if (opts.autoAlign && targetAudioId && finalLines.length > 0) {
          await runAiLyricsForcedAlign(targetAudioId, finalLines, {
            youtubeVideoId: targetVid,
            title: appliedTitle,
            artist: appliedArtist,
            duration: dur,
          });
        } else {
          setAiAlignStatus(`공식 가사 ${finalLines.length}줄 적용 완료!`);
        }
      } catch (err) {
        setAiAlignStatus(
          `가사 자동 적용 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [runAiLyricsForcedAlign]
  );

  const handleYoutubeImported = useCallback(
    async (
      result: YoutubeImportResult,
      mode: 'audio' | 'video',
      autoSearchLyrics: boolean,
      opts?: {
        autoTranslate?: boolean;
        autoAlign?: boolean;
        searchQueryOverride?: string;
        forceApplyLyrics?: boolean;
        initialKeyShift?: number;
      }
    ) => {
      const wasDemoOrEmpty =
        project.id === 'demo_tobu_toki' || project.lines.length === 0;

      clearHistory();
      setProject((prev) => ({
        ...prev,
        id: prev.id === 'demo_tobu_toki' ? `proj_${Date.now().toString(36)}` : prev.id,
        title: result.meta.title || prev.title,
        artist: result.meta.artist || prev.artist,
        youtubeVideoId: result.meta.videoId || prev.youtubeVideoId,
        duration: result.meta.duration > 0 ? result.meta.duration : prev.duration,
        pitchNotes: [],
        mrAudioFileId: undefined,
        mrAudioFileName: undefined,
        mrSyncOffset: 0,
        karaokeAudioFileId: undefined,
        karaokeAudioFileName: undefined,
        karaokeSyncOffset: 0,
        vocalFileId: undefined,
        vocalFileName: undefined,
        ...(mode === 'video'
          ? {
              settings: {
                ...prev.settings,
                bgType: 'video',
                bgFileId: result.media.id,
                bgFileName: result.media.originalName,
              },
            }
          : {}),
      }));

      if (mode === 'video') {
        loadBackgroundMedia('video', result.media.url);
      }

      await handleAudioLoaded(
        result.media.id,
        result.media.originalName,
        result.media.url,
        {
          youtubeVideoId: result.meta.videoId,
          initialKeyShift: opts?.initialKeyShift,
        }
      );

      if (autoSearchLyrics && result.meta.videoId) {
        const cached = await lookupSongAnalysis(result.meta.videoId);
        if (cached && cached.record.lines.length > 0) {
          setProject((prev) => ({
            ...prev,
            title: cached.record.title || prev.title,
            artist: cached.record.artist || prev.artist,
            mrYoutubeId: cached.record.mrYoutubeId ?? prev.mrYoutubeId,
            mrSyncOffset: cached.record.mrSyncOffset ?? prev.mrSyncOffset,
            karaokeYoutubeId: cached.record.karaokeYoutubeId ?? prev.karaokeYoutubeId,
            karaokeSyncOffset: cached.record.karaokeSyncOffset ?? prev.karaokeSyncOffset,
            lines: cached.record.lines,
            settings: {
              ...prev.settings,
              albumArtUrl:
                cached.record.artworkUrl ||
                prev.settings.albumArtUrl ||
                `https://i.ytimg.com/vi/${result.meta.videoId}/hqdefault.jpg`,
            },
          }));
          setSelectedLineId(cached.record.lines[0]?.id ?? null);
          setAiAlignStatus(
            `공용 DB에서 즉시 불러왔습니다 · ${cached.record.lines.length}소절`
          );
          setDbProvider(getCommunityDbStatus().provider);
          return;
        }
      }

      const searchQ = opts?.searchQueryOverride || result.meta.searchQuery;
      if (autoSearchLyrics && searchQ) {
        void runAutoLyricsPipeline({
          query: searchQ,
          autoApplyIfDemo: wasDemoOrEmpty,
          forceApply: opts?.forceApplyLyrics,
          autoTranslate: opts?.autoTranslate,
          autoAlign: opts?.autoAlign,
          audioFileId: result.media.id,
          audioDuration: result.meta.duration,
          youtubeVideoId: result.meta.videoId,
          fallbackTitle: result.meta.title,
          fallbackArtist: result.meta.artist,
        });
      }
    },
    [clearHistory, handleAudioLoaded, loadBackgroundMedia, project.id, project.lines.length, runAutoLyricsPipeline]
  );

  const handlePublishCurrentSong = useCallback(
    async (opts?: PublishSongOptions): Promise<PublishSongResult> => {
      if (!project.youtubeVideoId || project.lines.length === 0) {
        return {
          savedTo: 'local-cache',
          ok: false,
          error: 'YouTube 곡 정보가 없습니다.',
        };
      }
      const res = await publishSongAnalysis(
        {
          youtubeVideoId: project.youtubeVideoId,
          title: project.title,
          artist: project.artist,
          duration: project.duration,
          artworkUrl: project.settings.albumArtUrl,
          mrYoutubeId: project.mrYoutubeId,
          mrSyncOffset: project.mrSyncOffset,
          karaokeYoutubeId: project.karaokeYoutubeId,
          karaokeSyncOffset: project.karaokeSyncOffset,
          lines: project.lines,
          deviceLabel: workerHealth?.gpu?.name || undefined,
        },
        {
          mode: 'manual',
          authorName: opts?.authorName,
          editNote: opts?.editNote,
        }
      );
      setDbProvider(getCommunityDbStatus().provider);
      if (res.ok) {
        setLibraryVersion((v) => v + 1);
      }
      return res;
    },
    [
      project.artist,
      project.duration,
      project.karaokeSyncOffset,
      project.karaokeYoutubeId,
      project.lines,
      project.mrSyncOffset,
      project.mrYoutubeId,
      project.settings.albumArtUrl,
      project.title,
      project.youtubeVideoId,
      workerHealth?.gpu?.name,
    ]
  );

  const handleLoadLibrarySong = useCallback(
    async (song: LibrarySongSummary, revId?: string) => {
      if (libraryLoadingId) return;
      setLibraryLoadingId(song.youtubeVideoId);
      setLibraryLoadStatus(`"${song.title}" 분석 데이터 불러오는 중...`);
      setAudioError('');
      try {
        const record = revId
          ? await getLibraryRevisionDetail(song.youtubeVideoId, revId)
          : await getLibrarySongDetail(song.youtubeVideoId);
        if (!record || !record.lines.length) {
          setLibraryLoadStatus('라이브러리에서 곡 데이터를 찾을 수 없습니다.');
          return;
        }

        clearAudioElementSource(audioElRef.current);
        setAudioBuffer(null);
        setSpectrum(undefined);
        setIsPlaying(false);
        setCurrentTime(0);
        setMrSyncMonitorOriginal(false);
        setMrSyncStatus('');
        resolvedAudioSpecRef.current = '';
        prevEffectiveModeRef.current = 'original';
        keyShiftRef.current = 0;

        clearHistory();
        setProject((prev) => ({
          ...prev,
          id: prev.id === 'demo_tobu_toki' ? `proj_${Date.now().toString(36)}` : prev.id,
          title: record.title || prev.title,
          artist: record.artist || prev.artist,
          duration: record.duration > 0 ? record.duration : prev.duration,
          youtubeVideoId: record.youtubeVideoId,
          audioFileId: undefined,
          audioFileName: undefined,
          mrAudioFileId: undefined,
          mrAudioFileName: undefined,
          mrYoutubeId: record.mrYoutubeId,
          mrSyncOffset: record.mrSyncOffset ?? 0,
          karaokeAudioFileId: undefined,
          karaokeAudioFileName: undefined,
          karaokeYoutubeId: record.karaokeYoutubeId,
          karaokeSyncOffset: record.karaokeSyncOffset ?? 0,
          vocalFileId: undefined,
          vocalFileName: undefined,
          audioMode: 'original',
          keyShift: 0,
          pitchNotes: [],
          lines: record.lines,
          settings: {
            ...prev.settings,
            albumArtUrl:
              record.artworkUrl ||
              `https://i.ytimg.com/vi/${record.youtubeVideoId}/hqdefault.jpg`,
          },
        }));
        setSelectedLineId(record.lines[0]?.id ?? null);
        setAiAlignStatus(
          `라이브러리 로드 완료 · ${record.lines.length}소절`
        );

        if (!workerHealth?.ok) {
          setLibraryLoadStatus(
            `"${record.title}" 불러오기 완료! YouTube 스트리밍으로 바로 재생할 수 있습니다.`
          );
          setLibraryModalOpen(false);
          return;
        }

        setLibraryLoadStatus(`원곡 음원 연결 중 (${record.title})...`);
        const origRes = await importYoutubeWithProgress(
          `https://www.youtube.com/watch?v=${record.youtubeVideoId}`,
          'audio',
          (job) => {
            setLibraryLoadStatus(`원곡 연결 중: ${job.message} (${job.percent}%)`);
          }
        );

        await handleAudioLoaded(
          origRes.media.id,
          origRes.media.originalName,
          origRes.media.url,
          {
            youtubeVideoId: record.youtubeVideoId,
            initialKeyShift: 0,
            preserveTrackOffsets: true,
          }
        );

        if (record.mrYoutubeId) {
          setLibraryLoadStatus('MR 트랙 자동 연결 중...');
          try {
            const mrRes = await importYoutubeWithProgress(
              `https://www.youtube.com/watch?v=${record.mrYoutubeId}`,
              'audio',
              (job) => {
                setLibraryLoadStatus(`MR 연결 중: ${job.message} (${job.percent}%)`);
              }
            );
            const mrOffset = record.mrSyncOffset ?? 0;
            setProject((prev) => ({
              ...prev,
              mrAudioFileId: mrRes.media.id,
              mrAudioFileName: mrRes.media.originalName,
              mrYoutubeId: record.mrYoutubeId,
              mrSyncOffset: mrOffset,
            }));
            void prepareProcessedAudioApi({
              audioFileId: origRes.media.id,
              mrAudioFileId: mrRes.media.id,
              mode: 'mr',
              keyShift: 0,
              mrSyncOffset: mrOffset,
              monitorOriginal: false,
            }).catch(() => {});
          } catch {
            // original + lyrics still loaded cleanly
          }
        }

        if (record.karaokeYoutubeId) {
          setLibraryLoadStatus('노래방 트랙 자동 연결 중...');
          try {
            const krRes = await importYoutubeWithProgress(
              `https://www.youtube.com/watch?v=${record.karaokeYoutubeId}`,
              'audio',
              (job) => {
                setLibraryLoadStatus(`노래방 연결 중: ${job.message} (${job.percent}%)`);
              }
            );
            const krOffset = record.karaokeSyncOffset ?? 0;
            setProject((prev) => ({
              ...prev,
              karaokeAudioFileId: krRes.media.id,
              karaokeAudioFileName: krRes.media.originalName,
              karaokeYoutubeId: record.karaokeYoutubeId,
              karaokeSyncOffset: krOffset,
            }));
            void prepareProcessedAudioApi({
              audioFileId: origRes.media.id,
              karaokeAudioFileId: krRes.media.id,
              mode: 'karaoke',
              keyShift: 0,
              karaokeSyncOffset: krOffset,
              monitorOriginal: false,
            }).catch(() => {});
          } catch {
            // original + lyrics still loaded cleanly
          }
        }

        setLibraryLoadStatus(`"${record.title}" 불러오기 완료!`);
        setLibraryModalOpen(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLibraryLoadStatus(`라이브러리 로드 오류: ${msg}`);
        setAudioError(msg);
      } finally {
        setLibraryLoadingId(null);
      }
    },
    [clearHistory, handleAudioLoaded, libraryLoadingId, workerHealth?.ok]
  );

  const stopAudioScrub = useCallback(() => {
    if (scrubTimerRef.current !== null) {
      window.clearTimeout(scrubTimerRef.current);
      scrubTimerRef.current = null;
    }
    const prevSource = scrubSourceRef.current;
    if (prevSource) {
      scrubSourceRef.current = null;
      try {
        prevSource.onended = null;
        prevSource.stop();
      } catch {
        // source already stopped
      }
      try {
        prevSource.disconnect();
      } catch {
        // already disconnected
      }
    }
    const prevGain = scrubGainRef.current;
    if (prevGain) {
      scrubGainRef.current = null;
      try {
        prevGain.disconnect();
      } catch {
        // already disconnected
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      stopAudioScrub();
      const ctx = scrubCtxRef.current;
      scrubCtxRef.current = null;
      if (ctx) {
        ctx.close().catch(() => {});
      }
    };
  }, [stopAudioScrub]);

  const playAudioScrubBlip = useCallback(
    (atSec: number) => {
      stopAudioScrub();
      if (volumeRef.current <= 0.001) return;

      if (audioBuffer && audioMode === 'original' && keyShift === 0) {
        let ctx = scrubCtxRef.current;
        if (!ctx) {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!AudioCtx) return;
          ctx = new AudioCtx();
          scrubCtxRef.current = ctx;
        }
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const offset = Math.max(
          0,
          Math.min(atSec, Math.max(0, audioBuffer.duration - 0.02))
        );
        const dur = Math.min(
          SCRUB_BLIP_SEC,
          Math.max(0.015, audioBuffer.duration - offset)
        );
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const gain = ctx.createGain();
        const peakGain = Math.min(1, Math.max(0.05, volumeRef.current));
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(peakGain, now + 0.005);
        gain.gain.setValueAtTime(peakGain, now + Math.max(0.01, dur - 0.014));
        gain.gain.linearRampToValueAtTime(0.0001, now + dur);

        source.connect(gain);
        gain.connect(ctx.destination);
        scrubSourceRef.current = source;
        scrubGainRef.current = gain;
        source.onended = () => {
          if (scrubSourceRef.current === source) {
            scrubSourceRef.current = null;
            try {
              source.disconnect();
            } catch {
              // ignore
            }
          }
          if (scrubGainRef.current === gain) {
            scrubGainRef.current = null;
            try {
              gain.disconnect();
            } catch {
              // ignore
            }
          }
        };
        source.start(now, offset, dur);
        return;
      }

      const audio = audioElRef.current;
      if (hasAnyAudioTrack && audio && audio.src) {
        audio.muted = false;
        audio.volume = volumeRef.current;
        audio.playbackRate = 1;
        audio.currentTime = atSec;
        audio.play().catch(() => {});
        scrubTimerRef.current = window.setTimeout(() => {
          scrubTimerRef.current = null;
          if (!isPlayingRef.current && audioElRef.current) {
            if (!audioElRef.current.paused) {
              audioElRef.current.pause();
            }
            audioElRef.current.currentTime = currentTimeRef.current;
          }
        }, 75);
      }
    },
    [audioBuffer, audioMode, keyShift, hasAnyAudioTrack, stopAudioScrub]
  );

  const handleTogglePlay = useCallback(() => {
    stopAudioScrub();
    const audio = audioElRef.current;
    const yt = ytControllerRef.current;
    if (isPlaying) {
      if (audio && !audio.paused) audio.pause();
      if (yt) yt.pause();
      setIsPlaying(false);
    } else {
      setAudioError('');
      let startAt = currentTime;
      if (startAt >= project.duration - 0.1) {
        startAt = 0;
        currentTimeRef.current = 0;
        setCurrentTime(0);
      }
      if (hasAnyAudioTrack && audio && audio.src) {
        audio.muted = false;
        audio.volume = volume;
        audio.playbackRate = playbackRate;
        if (Math.abs(audio.currentTime - startAt) > 0.08) {
          audio.currentTime = startAt;
        }
        audio.play().catch((err) => {
          setAudioError(
            `오디오 재생 실패: ${err instanceof Error ? err.message : String(err)}`
          );
          setIsPlaying(false);
        });
      } else if (activeYtTarget && yt) {
        const ytStart = Math.max(0, startAt - activeYtTarget.offsetSec);
        yt.setVolume(volume);
        yt.setPlaybackRate(playbackRate);
        if (ytLoadedVideoIdRef.current !== activeYtTarget.videoId) {
          ytLoadedVideoIdRef.current = activeYtTarget.videoId;
          void yt.load(
            activeYtTarget.videoId,
            ytStart,
            startAt >= activeYtTarget.offsetSec,
            volume,
            playbackRate
          );
        } else if (startAt >= activeYtTarget.offsetSec) {
          yt.seekTo(ytStart);
          yt.play();
        }
      }
      setIsPlaying(true);
    }
  }, [
    stopAudioScrub,
    isPlaying,
    currentTime,
    project.duration,
    hasAnyAudioTrack,
    activeYtTarget,
    volume,
    playbackRate,
  ]);

  const handleSeek = useCallback((time: number) => {
    const clamped = Math.max(0, Math.min(project.duration || 300, time));
    currentTimeRef.current = clamped;
    setCurrentTime(clamped);
    if (audioElRef.current && hasAnyAudioTrack) {
      audioElRef.current.currentTime = clamped;
    } else if (activeYtTarget && ytControllerRef.current) {
      ytControllerRef.current.seekTo(Math.max(0, clamped - activeYtTarget.offsetSec));
    }
    if (bgVideo && Number.isFinite(bgVideo.duration) && bgVideo.duration > 0) {
      bgVideo.currentTime = clamped % bgVideo.duration;
    }
  }, [project.duration, hasAnyAudioTrack, activeYtTarget, bgVideo]);

  const handleStepFrame = useCallback(
    (frameDelta: number) => {
      if (isPlayingRef.current) {
        const audio = audioElRef.current;
        if (audio && !audio.paused) audio.pause();
        ytControllerRef.current?.pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
      }
      const duration = project.duration || 300;
      const nextTime = Math.max(
        0,
        Math.min(
          duration,
          Number((currentTimeRef.current + frameDelta * FRAME_STEP_SEC).toFixed(4))
        )
      );
      handleSeek(nextTime);
      playAudioScrubBlip(nextTime);
    },
    [project.duration, handleSeek, playAudioScrubBlip]
  );

  // Global keyboard shortcuts: Ctrl/Cmd+K (search), Ctrl/Cmd+Z/Y (undo/redo), Space (play/pause), ArrowLeft/Right seek, Comma/Period 1-frame scrub
  useEffect(() => {
    const anyModalOpen =
      tourOpen || libraryModalOpen || settingsOpen || workerOpen || exportOpen;
    if (anyModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const lower = e.key.toLowerCase();
        if (lower === 'k') {
          e.preventDefault();
          openSongSearchModal();
          return;
        }
        if (isEditableTarget) return;
        if (lower === 'z') {
          e.preventDefault();
          if (e.shiftKey) handleRedo();
          else handleUndo();
          return;
        }
        if (lower === 'y') {
          e.preventDefault();
          handleRedo();
          return;
        }
        return;
      }

      if (e.altKey || isEditableTarget) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        const delta = e.code === 'ArrowRight' ? step : -step;
        handleSeek(currentTimeRef.current + delta);
      } else if (e.code === 'Comma' || e.code === 'Period') {
        e.preventDefault();
        const frames = (e.shiftKey ? 5 : 1) * (e.code === 'Period' ? 1 : -1);
        handleStepFrame(frames);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    tourOpen,
    libraryModalOpen,
    settingsOpen,
    workerOpen,
    exportOpen,
    handleTogglePlay,
    handleSeek,
    handleStepFrame,
    handleUndo,
    handleRedo,
    openSongSearchModal,
  ]);

  const resources: RenderResources = useMemo(
    () => ({
      spectrum,
      bgImage,
      bgVideo,
    }),
    [spectrum, bgImage, bgVideo]
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#070b14] text-slate-100">
      <audio ref={audioElRef} crossOrigin="anonymous" className="hidden" />

      <TopBar
        uiTheme={uiTheme}
        songTitle={project.title}
        songArtist={project.artist}
        onToggleTheme={() => setUiTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onOpenExport={() => {
          if (isPlaying) handleTogglePlay();
          setMrSyncMonitorOriginal(false);
          setExportOpen(true);
        }}
        onOpenTour={() => setTourOpen(true)}
        onOpenSongSearch={() => openSongSearchModal()}
        workerHealth={workerHealth}
        workerChecking={workerChecking}
        dbProvider={dbProvider}
        onOpenWorkerModal={() => {
          setWorkerOpen(true);
          void refreshWorkerHealth();
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex flex-1 min-h-0 overflow-hidden">
        <LeftSidebar
          project={project}
          onUpdateProject={updateProjectWithHistory}
          onBackgroundLoaded={handleBackgroundLoaded}
        />

        <section className="flex flex-1 min-w-0 flex-col gap-2.5 overflow-y-auto p-3 bg-[#070b14]">
          <StagePreview
            project={project}
            currentTime={currentTime}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            volume={volume}
            audioProcessing={audioProcessing}
            aiAligning={aiAligning}
            aiAlignStatus={aiAlignStatus}
            mrSyncing={mrSyncing}
            mrSyncStatus={mrSyncStatus}
            mrSyncMonitorOriginal={mrSyncMonitorOriginal}
            usingYoutubeFallback={usingYoutubeFallback}
            audioError={audioError}
            selectedLineId={selectedLineId}
            resources={resources}
            onTogglePlay={handleTogglePlay}
            onChangeAudioMode={(mode) => {
              if (mode === 'original') setMrSyncMonitorOriginal(false);
              updateProjectWithHistory((prev) => ({ ...prev, audioMode: mode }));
            }}
            onChangeKeyShift={(nextShift) => {
              updateProjectWithHistory((prev) => {
                if ((prev.audioMode ?? 'original') === 'original') return prev;
                const clamped = Math.max(-6, Math.min(6, Math.round(nextShift)));
                return { ...prev, keyShift: clamped };
              });
            }}
            onAutoSyncMr={(slot) => runAutoSyncMr(slot)}
            onChangeMrSyncOffset={handleChangeMrSyncOffset}
            onChangeKaraokeSyncOffset={handleChangeKaraokeSyncOffset}
            onToggleMrSyncMonitor={() => setMrSyncMonitorOriginal((v) => !v)}
            onClearAudioError={() => setAudioError('')}
            onSeek={handleSeek}
            onChangeRate={setPlaybackRate}
            onChangeVolume={setVolume}
            onOpenSongSearch={() => openSongSearchModal()}
            onUpdateProject={updateProjectWithHistory}
            onSelectLine={setSelectedLineId}
          />

          <Timeline
            project={project}
            audioBuffer={audioBuffer}
            currentTime={currentTime}
            selectedLineId={selectedLineId}
            uiTheme={uiTheme}
            onSeek={handleSeek}
            onSelectLine={setSelectedLineId}
          />
        </section>

        <LyricInspector
          project={project}
          currentTime={currentTime}
          selectedLineId={selectedLineId}
          aiAligning={aiAligning}
          aiAlignStatus={aiAlignStatus}
          onSelectLine={setSelectedLineId}
          onSeek={handleSeek}
          onUpdateProject={updateProjectWithHistory}
          onRunAiLyricsAlign={() => runAiLyricsForcedAlign()}
          onShiftAllLyrics={handleShiftAllLyrics}
          onLineDeleted={() =>
            showToast('소절을 삭제했습니다', { canUndoAction: true, durationMs: 4200 })
          }
        />
      </main>

      <ExportModal
        open={exportOpen}
        project={project}
        resources={resources}
        onClose={() => setExportOpen(false)}
      />

      <WorkerStatusModal
        open={workerOpen}
        project={project}
        workerHealth={workerHealth}
        workerChecking={workerChecking}
        onRefreshWorker={refreshWorkerHealth}
        onPublishCurrentSong={handlePublishCurrentSong}
        onClose={() => setWorkerOpen(false)}
      />

      <SongLibraryModal
        open={libraryModalOpen}
        initialTab={libraryHubTab}
        initialPublishOpen={libraryInitialPublish}
        initialSearchQuery={libraryInitialQuery}
        initialSearchNonce={librarySearchNonce}
        project={project}
        workerConnected={Boolean(workerHealth?.ok)}
        libraryVersion={libraryVersion}
        loadingVideoId={libraryLoadingId}
        loadingStatus={libraryLoadStatus}
        onUpdateProject={setProject}
        onYoutubeImported={handleYoutubeImported}
        onMrAudioLoaded={handleMrAudioLoaded}
        onKaraokeAudioLoaded={handleKaraokeAudioLoaded}
        onLoadSong={handleLoadLibrarySong}
        onPublishCurrentSong={handlePublishCurrentSong}
        onLibraryChanged={() => setLibraryVersion((v) => v + 1)}
        onClose={() => {
          setLibraryModalOpen(false);
          setLibraryInitialPublish(false);
        }}
      />

      <SettingsModal
        open={settingsOpen}
        uiTheme={uiTheme}
        uiFontSize={uiFontSize}
        onChangeTheme={setUiTheme}
        onChangeFontSize={setUiFontSize}
        onOpenTour={() => setTourOpen(true)}
        onOpenWorkerModal={() => {
          setWorkerOpen(true);
          void refreshWorkerHealth();
        }}
        onClose={() => setSettingsOpen(false)}
      />

      <OnboardingTour
        open={tourOpen}
        onClose={() => {
          try {
            window.localStorage.setItem(TOUR_STORAGE_KEY, '1');
          } catch {
            // ignore
          }
          setTourOpen(false);
        }}
      />

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 rounded-xl border border-white/[0.14] bg-[#0d1322] px-3.5 py-2 text-xs text-slate-100 shadow-xl backdrop-blur-md"
        >
          <span>{toast.message}</span>
          {toast.canUndoAction && (
            <button
              type="button"
              onClick={handleUndo}
              className="rounded-md border border-sky-400/35 bg-sky-500/15 px-2 py-0.5 font-semibold text-sky-300 hover:bg-sky-500/25 transition"
            >
              되돌리기 (Ctrl+Z)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
