import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  Mic,
  RefreshCw,
  VolumeX,
  X,
} from 'lucide-react';
import { formatTime } from '@shared/timing';
import type { LiveSyncSnapshot } from '../engine/liveKaraokeSync';

interface LiveKaraokeSyncBarProps {
  snapshot: LiveSyncSnapshot;
  hasFingerprint: boolean;
  fingerprintLoading: boolean;
  hasYoutubeVideo: boolean;
  manualOffsetSec: number;
  isMuted: boolean;
  onStart: () => void;
  onStop: () => void;
  onForceLock: () => void;
  onResync: () => void;
  onNudgeManualOffset: (deltaSec: number) => void;
  onResetManualOffset: () => void;
  onMuteLyricsOnly: () => void;
}

export function LiveKaraokeSyncBar({
  snapshot,
  hasFingerprint,
  fingerprintLoading,
  hasYoutubeVideo,
  manualOffsetSec,
  isMuted,
  onStart,
  onStop,
  onForceLock,
  onResync,
  onNudgeManualOffset,
  onResetManualOffset,
  onMuteLyricsOnly,
}: LiveKaraokeSyncBarProps) {
  const {
    status,
    micLevel,
    elapsedSec,
    confidence,
    detectedKeyShift,
    candidateSongTimeSec,
    canForceLock,
    message,
  } = snapshot;

  if (!hasYoutubeVideo) {
    return null;
  }

  return (
    <div
      data-testid="live-karaoke-sync-bar"
      className="rounded-xl border border-white/[0.07] bg-[#0c111d] px-3 py-2 text-xs"
    >
      {status === 'idle' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                fingerprintLoading
                  ? 'bg-sky-400 animate-pulse'
                  : hasFingerprint
                    ? 'bg-emerald-400'
                    : 'bg-slate-600'
              }`}
            />
            <span className="font-semibold text-slate-200 truncate">
              노래방 현장 싱크
            </span>
            <span className="text-[11px] text-slate-400 truncate hidden sm:inline">
              {fingerprintLoading
                ? '지문 불러오는 중...'
                : hasFingerprint
                  ? '전주를 들려주면 이어폰 원곡과 가사를 반주에 맞춥니다'
                  : '이 곡은 아직 지문 데이터가 준비되지 않았습니다'}
            </span>
          </div>

          <button
            type="button"
            disabled={!hasFingerprint || fingerprintLoading}
            onClick={onStart}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/35 bg-sky-500/15 px-3 py-1.5 text-[11.5px] font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-45 disabled:cursor-not-allowed transition shrink-0"
          >
            <Mic className="h-3.5 w-3.5" />
            노래방 실시간 싱크
          </button>
        </div>
      )}

      {(status === 'loading' || status === 'listening') && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {status === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 text-sky-400 animate-spin shrink-0" />
              ) : (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                </span>
              )}
              <span className="font-semibold text-slate-100 truncate">
                반주 듣는 중{' '}
                <span className="font-mono tabular-nums text-sky-300">
                  {Math.floor(elapsedSec)}s
                </span>{' '}
                <span className="text-slate-400 font-normal">/ 10~20초</span>
              </span>
              {confidence >= 0.15 && (
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 shrink-0">
                  일치 {Math.round(confidence * 100)}%
                </span>
              )}
              {canForceLock && (
                <span className="rounded bg-sky-500/15 border border-sky-400/25 px-1.5 py-0.5 font-mono tabular-nums text-[10px] text-sky-200 shrink-0">
                  예상 {formatTime(candidateSongTimeSec, false)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {canForceLock && (
                <button
                  type="button"
                  onClick={onForceLock}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 transition"
                >
                  <Check className="h-3 w-3" />
                  지금 맞추기
                </button>
              )}
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
              >
                <X className="h-3 w-3" />
                취소
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-white/[0.08] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-[width] duration-150"
                style={{ width: `${Math.max(4, Math.round(micLevel * 100))}%` }}
              />
            </div>
            <span className="text-[10.5px] text-slate-400 truncate max-w-[68%]">
              {message || '전주/반주를 폰 마이크에 들려주세요 · 잠금 후 마이크 자동 종료'}
            </span>
          </div>
        </div>
      )}

      {status === 'locked' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="font-semibold text-emerald-300 truncate">
                싱크 잠금됨 · 마이크 자동 종료
              </span>
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                {detectedKeyShift === 0
                  ? '원키'
                  : `${detectedKeyShift > 0 ? '+' : ''}${detectedKeyShift}키`}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onResync}
                className="inline-flex items-center gap-1 rounded-md border border-sky-400/35 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25 transition"
              >
                <RefreshCw className="h-3 w-3" />
                재싱크
              </button>
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
              >
                종료
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-slate-300">이어폰 지연 보정</span>
            <div className="flex items-center gap-1">
              {[
                { label: '-0.2s', delta: -0.2 },
                { label: '-0.05s', delta: -0.05 },
              ].map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  onClick={() => onNudgeManualOffset(btn.delta)}
                  className="rounded border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 font-mono tabular-nums text-[11px] text-slate-200 hover:bg-white/[0.1] transition"
                >
                  {btn.label}
                </button>
              ))}

              <button
                type="button"
                onClick={onResetManualOffset}
                title="클릭하면 0.00초로 초기화합니다"
                className={`min-w-[54px] rounded border px-2 py-0.5 font-mono tabular-nums text-[11px] font-semibold transition ${
                  Math.abs(manualOffsetSec) >= 0.01
                    ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                    : 'border-white/[0.1] bg-black/35 text-slate-300'
                }`}
              >
                {manualOffsetSec >= 0 ? '+' : ''}
                {manualOffsetSec.toFixed(2)}s
              </button>

              {[
                { label: '+0.05s', delta: 0.05 },
                { label: '+0.2s', delta: 0.2 },
              ].map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  onClick={() => onNudgeManualOffset(btn.delta)}
                  className="rounded border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 font-mono tabular-nums text-[11px] text-slate-200 hover:bg-white/[0.1] transition"
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          {detectedKeyShift !== 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              <div className="flex items-center gap-1.5 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="leading-snug">
                  노래방 반주가 원키와 {detectedKeyShift > 0 ? '+' : ''}
                  {detectedKeyShift}키 다릅니다 — 유튜브 원곡은 원키 재생이므로 무음 가사 모드를 권장합니다
                </span>
              </div>
              {!isMuted && (
                <button
                  type="button"
                  onClick={onMuteLyricsOnly}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-400/45 bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/30 transition shrink-0"
                >
                  <VolumeX className="h-3 w-3" />
                  음소거(가사만)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center justify-between gap-2 text-rose-200">
          <span className="truncate text-[11.5px]">{message || '싱크 실행 오류'}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onStart}
              className="rounded-md border border-sky-400/35 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25 transition"
            >
              다시 시도
            </button>
            <button
              type="button"
              onClick={onStop}
              className="rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/[0.08] transition"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
