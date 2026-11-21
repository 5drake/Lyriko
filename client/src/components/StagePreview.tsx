import { useEffect, useRef } from 'react';
import {
  AlertCircle,
  Headphones,
  Loader2,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import {
  normalizeAudioPlayMode,
  type AudioPlayMode,
  type KaraokeProject,
} from '@shared/types';
import { formatTime } from '@shared/timing';
import {
  renderKaraokeFrame,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  type RenderResources,
} from '../engine/karaokeRenderer';

interface StagePreviewProps {
  project: KaraokeProject;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  volume: number;
  audioProcessing: boolean;
  aiAligning: boolean;
  aiAlignStatus: string;
  mrSyncing: boolean;
  mrSyncStatus: string;
  mrSyncMonitorOriginal: boolean;
  audioError: string;
  selectedLineId?: string | null;
  resources: RenderResources;
  onTogglePlay: () => void;
  onChangeAudioMode: (mode: AudioPlayMode) => void;
  onChangeKeyShift: (nextShift: number) => void;
  onAutoSyncMr: (targetSlot?: 'mr' | 'karaoke') => Promise<void>;
  onChangeMrSyncOffset: (offsetSec: number) => void;
  onChangeKaraokeSyncOffset: (offsetSec: number) => void;
  onToggleMrSyncMonitor: () => void;
  onClearAudioError: () => void;
  onSeek: (time: number) => void;
  onChangeRate: (rate: number) => void;
  onChangeVolume: (vol: number) => void;
  onOpenSongSearch?: () => void;
  onUpdateProject?: (updater: (prev: KaraokeProject) => KaraokeProject) => void;
  onSelectLine?: (id: string) => void;
}

export function StagePreview({
  project,
  currentTime,
  isPlaying,
  playbackRate,
  volume,
  audioProcessing,
  aiAligning,
  aiAlignStatus,
  mrSyncing,
  mrSyncStatus,
  mrSyncMonitorOriginal,
  audioError,
  resources,
  onTogglePlay,
  onChangeAudioMode,
  onChangeKeyShift,
  onAutoSyncMr,
  onChangeMrSyncOffset,
  onChangeKaraokeSyncOffset,
  onToggleMrSyncMonitor,
  onClearAudioError,
  onSeek,
  onChangeRate,
  onChangeVolume,
  onOpenSongSearch,
}: StagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);

  // Render frame whenever project/time/resources update
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderKaraokeFrame(ctx, project, currentTime, resources);
  }, [project, currentTime, resources]);

  // Ensure re-render once Google Fonts finish loading
  useEffect(() => {
    let alive = true;
    document.fonts.ready.then(() => {
      if (!alive) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx) {
        renderKaraokeFrame(ctx, project, currentTime, resources);
      }
    });
    return () => {
      alive = false;
    };
  }, [project, currentTime, resources]);

  const toggleFullscreen = () => {
    const el = stageBoxRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  };

  const duration = Math.max(1, project.duration || 60);
  const clampedTime = Math.max(0, Math.min(duration, currentTime));
  const progressPct = Math.max(0, Math.min(100, (clampedTime / duration) * 100));

  const stepRate = (delta: number) => {
    const next = Number(Math.max(0.5, Math.min(1.5, playbackRate + delta)).toFixed(2));
    onChangeRate(next);
  };

  return (
    <div data-tour="stage-preview" className="flex flex-col gap-2.5">
      <div
        ref={stageBoxRef}
        data-keep-dark="true"
        onClick={onTogglePlay}
        className="group relative w-full overflow-hidden rounded-xl border border-white/[0.08] bg-black aspect-video flex items-center justify-center cursor-pointer select-none"
        title="클릭: 재생 / 일시정지 (Space)"
      >
        <canvas
          ref={canvasRef}
          width={STAGE_WIDTH}
          height={STAGE_HEIGHT}
          className="h-full w-full object-contain"
        />
        <div className="pointer-events-none absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/75 px-3 py-1 text-[10.5px] text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm whitespace-nowrap">
          클릭 · Space 재생/정지 &nbsp;|&nbsp; ← / → 5초 &nbsp;|&nbsp; , / . 1프레임
        </div>
      </div>

      {/* Unified Media Dock: Transport + Interactive Progress + Mode / Key / Speed */}
      <div className="rounded-xl border border-white/[0.07] bg-[#0c111d] overflow-hidden divide-y divide-white/[0.06]">
        {/* Row 1: Transport & Full-Length Scrubber */}
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onSeek(Math.max(0, currentTime - 5))}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white transition"
              title="5초 뒤로 (← / Shift+← 1초)"
            >
              <RotateCcw className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={onTogglePlay}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-950 hover:bg-sky-100 transition shadow-sm"
              title="재생 / 일시정지 (Space)"
            >
              {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 ml-0.5 fill-current" />}
            </button>

            <button
              type="button"
              onClick={() => onSeek(Math.min(duration, currentTime + 5))}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white transition"
              title="5초 앞으로 (→ / Shift+→ 1초)"
            >
              <RotateCw className="h-4 w-4" />
            </button>

            <span className="ml-1.5 font-mono tabular-nums text-xs text-slate-200">
              <span className="font-semibold text-white">{formatTime(currentTime, true)}</span>
              <span className="text-slate-500"> / {formatTime(duration, false)}</span>
            </span>
          </div>

          {/* Center Interactive Video Progress Bar */}
          <div className="relative flex-1 min-w-[110px] h-5 flex items-center group">
            <div className="relative w-full h-1.5 rounded-full bg-white/[0.1] overflow-hidden">
              {project.lines.map((ln) => {
                const leftPct = Math.max(0, Math.min(100, (ln.startTime / duration) * 100));
                const widthPct = Math.max(
                  0.5,
                  Math.min(100 - leftPct, ((ln.endTime - ln.startTime) / duration) * 100)
                );
                return (
                  <span
                    key={ln.id}
                    className="pointer-events-none absolute top-0 bottom-0 bg-white/15"
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  />
                );
              })}
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-75"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span
              className="pointer-events-none absolute h-3 w-3 -ml-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(56,189,248,0.8)] border border-sky-400/80 transition-transform group-hover:scale-125"
              style={{ left: `${progressPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={duration}
              step={0.05}
              value={clampedTime}
              onChange={(e) => onSeek(Number(e.target.value))}
              aria-label="영상 전체 진행도"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onChangeVolume(volume > 0 ? 0 : 0.25)}
                className="text-slate-400 hover:text-white transition"
                title={volume === 0 ? '음소거 해제' : '음소거'}
              >
                {volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => onChangeVolume(Number(e.target.value))}
                className="w-16"
              />
            </div>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white transition"
              title="전체 화면 미리보기"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Row 2: Audio Mode · Key Transpose · Playback Speed */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-slate-400 mr-0.5">음원 모드</span>
            <div className="inline-flex rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
              {(
                [
                  ['original', '원곡', Boolean(project.audioFileId)],
                  ['mr', 'MR', Boolean(project.mrAudioFileId)],
                  ['karaoke', '노래방', Boolean(project.karaokeAudioFileId)],
                ] as Array<['original' | 'mr' | 'karaoke', string, boolean]>
              ).map(([modeVal, label, hasTrack]) => {
                const active = normalizeAudioPlayMode(project.audioMode) === modeVal;
                return (
                  <button
                    key={modeVal}
                    type="button"
                    onClick={() => onChangeAudioMode(modeVal)}
                    className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                      active
                        ? 'border-sky-400/35 bg-sky-500/20 text-sky-200 shadow-sm'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        hasTrack ? 'bg-emerald-400' : 'bg-white/15'
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            {normalizeAudioPlayMode(project.audioMode) === 'mr' &&
              !project.mrAudioFileId && (
                <button
                  type="button"
                  onClick={() => onOpenSongSearch?.()}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300/90 border border-amber-400/20 hover:bg-amber-500/20 transition whitespace-nowrap"
                  title="상단 [곡 검색 · 라이브러리]에서 MR 음원을 검색해 연결하세요"
                >
                  미연결 · 찾기
                </button>
              )}

            {normalizeAudioPlayMode(project.audioMode) === 'karaoke' &&
              !project.karaokeAudioFileId && (
                <button
                  type="button"
                  onClick={() => onOpenSongSearch?.()}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300/90 border border-amber-400/20 hover:bg-amber-500/20 transition whitespace-nowrap"
                  title="상단 [곡 검색 · 라이브러리]에서 노래방 음원을 검색해 연결하세요"
                >
                  미연결 · 찾기
                </button>
              )}

            {(audioProcessing || aiAligning) && (
              <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-300 border border-sky-400/25">
                <Loader2 className="h-3 w-3 animate-spin" />
                {aiAligning
                  ? aiAlignStatus || 'AI 가사 싱크 정렬 중...'
                  : '키/싱크 변환 중...'}
              </span>
            )}
          </div>

          {/* Connected Key Transpose & Playback Speed Steppers */}
          <div className="flex items-center gap-2 shrink-0">
            {(() => {
              const isOriginalMode =
                normalizeAudioPlayMode(project.audioMode) === 'original';
              const keyShift = project.keyShift ?? 0;
              const displayedKey = isOriginalMode
                ? '원키'
                : keyShift === 0
                ? '원키'
                : `${keyShift > 0 ? '+' : ''}${keyShift}`;
              return (
                <div
                  className={`flex items-center gap-1 ${
                    isOriginalMode ? 'opacity-45' : ''
                  }`}
                  title={
                    isOriginalMode
                      ? '키 조절은 MR 또는 노래방 모드에서만 사용할 수 있습니다'
                      : undefined
                  }
                >
                  <span className="text-[11px] font-medium text-slate-400">키</span>
                  <div className="inline-flex items-center bg-black/35 border border-white/[0.07] rounded-lg overflow-hidden divide-x divide-white/[0.06]">
                    <button
                      type="button"
                      disabled={isOriginalMode || keyShift <= -6}
                      onClick={() => onChangeKeyShift(keyShift - 1)}
                      className="flex h-6 w-6 items-center justify-center text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed transition"
                      title={
                        isOriginalMode
                          ? 'MR · 노래방 모드에서만 키 조절 가능'
                          : '반음 내리기 (-1 키)'
                      }
                    >
                      <Minus className="h-3 w-3" />
                    </button>

                    <button
                      type="button"
                      disabled={isOriginalMode}
                      onClick={() => onChangeKeyShift(0)}
                      className={`min-w-[38px] h-6 px-1.5 font-mono tabular-nums text-[11px] font-semibold transition disabled:cursor-not-allowed ${
                        !isOriginalMode && keyShift !== 0
                          ? 'bg-sky-500/15 text-sky-200'
                          : 'text-slate-300 hover:text-white'
                      }`}
                      title={
                        isOriginalMode
                          ? '원곡은 항상 원키로 재생됩니다 (MR·노래방에서 조절)'
                          : '클릭하면 원키(0)로 되돌립니다'
                      }
                    >
                      {displayedKey}
                    </button>

                    <button
                      type="button"
                      disabled={isOriginalMode || keyShift >= 6}
                      onClick={() => onChangeKeyShift(keyShift + 1)}
                      className="flex h-6 w-6 items-center justify-center text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed transition"
                      title={
                        isOriginalMode
                          ? 'MR · 노래방 모드에서만 키 조절 가능'
                          : '반음 올리기 (+1 키)'
                      }
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })()}

            <span className="h-4 w-px bg-white/[0.08]" />

            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-400">배속</span>
              <div className="inline-flex items-center bg-black/35 border border-white/[0.07] rounded-lg overflow-hidden divide-x divide-white/[0.06]">
                <button
                  type="button"
                  disabled={playbackRate <= 0.5}
                  onClick={() => stepRate(-0.1)}
                  className="flex h-6 w-6 items-center justify-center text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-35 transition"
                  title="재생 속도 늦추기 (-0.1x)"
                >
                  <Minus className="h-3 w-3" />
                </button>

                <button
                  type="button"
                  onClick={() => onChangeRate(1)}
                  className={`min-w-[38px] h-6 px-1.5 font-mono tabular-nums text-[11px] font-semibold transition ${
                    Math.abs(playbackRate - 1) > 0.01
                      ? 'bg-sky-500/15 text-sky-200'
                      : 'text-slate-300 hover:text-white'
                  }`}
                  title="클릭하면 기본 속도(1.0x)로 되돌립니다"
                >
                  {playbackRate.toFixed(1)}x
                </button>

                <button
                  type="button"
                  disabled={playbackRate >= 1.5}
                  onClick={() => stepRate(0.1)}
                  className="flex h-6 w-6 items-center justify-center text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-35 transition"
                  title="재생 속도 높이기 (+0.1x)"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Row 3: Active Track Sync Adjustment Strip */}
        {(() => {
          const normMode = normalizeAudioPlayMode(project.audioMode);
          const usingKaraokeSlot =
            normMode === 'karaoke' && Boolean(project.karaokeAudioFileId);
          const usingMrSlot =
            (normMode === 'mr' && Boolean(project.mrAudioFileId)) ||
            (normMode === 'karaoke' &&
              !project.karaokeAudioFileId &&
              Boolean(project.mrAudioFileId));
          if (!usingKaraokeSlot && !usingMrSlot) return null;

          const activeSlot: 'mr' | 'karaoke' = usingKaraokeSlot ? 'karaoke' : 'mr';
          const activeOffset = usingKaraokeSlot
            ? (project.karaokeSyncOffset ?? 0)
            : (project.mrSyncOffset ?? 0);
          const setOffset = usingKaraokeSlot
            ? onChangeKaraokeSyncOffset
            : onChangeMrSyncOffset;

          return (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-white/[0.015] text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-emerald-300">
                  {usingKaraokeSlot ? '노래방 싱크' : 'MR 싱크'}
                </span>
                <button
                  type="button"
                  onClick={() => setOffset(Number((activeOffset - 0.05).toFixed(3)))}
                  className="rounded-md border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
                >
                  -0.05s
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(0)}
                  title="클릭하면 0.00초로 초기화합니다"
                  className={`min-w-[58px] rounded-md border px-2 py-0.5 font-mono tabular-nums text-[11px] font-semibold transition ${
                    Math.abs(activeOffset) >= 0.001
                      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                      : 'border-white/[0.08] bg-black/35 text-slate-300'
                  }`}
                >
                  {activeOffset >= 0 ? '+' : ''}
                  {activeOffset.toFixed(2)}s
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(Number((activeOffset + 0.05).toFixed(3)))}
                  className="rounded-md border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
                >
                  +0.05s
                </button>

                {project.audioFileId && (
                  <>
                    <button
                      type="button"
                      disabled={mrSyncing}
                      onClick={() => void onAutoSyncMr(activeSlot)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.08] px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/[0.14] disabled:opacity-45 transition"
                    >
                      {mrSyncing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wand2 className="h-3 w-3 text-sky-400" />
                      )}
                      자동 맞춤
                    </button>
                    <button
                      type="button"
                      onClick={onToggleMrSyncMonitor}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition ${
                        mrSyncMonitorOriginal
                          ? 'border-amber-400/45 bg-amber-500/15 text-amber-200'
                          : 'border-white/[0.08] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
                      }`}
                    >
                      <Headphones className="h-3 w-3" />
                      겹쳐 듣기
                    </button>
                  </>
                )}
              </div>
              {mrSyncStatus && (
                <span className="text-[11px] text-emerald-300/90 truncate max-w-xs">
                  {mrSyncStatus}
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {audioError && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{audioError}</span>
          </div>
          <button
            type="button"
            onClick={onClearAudioError}
            className="rounded p-0.5 text-rose-300 hover:bg-rose-500/20"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
