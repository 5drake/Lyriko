import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Film, Loader2, X } from 'lucide-react';
import type { ExportQualityPreset, KaraokeProject } from '@shared/types';
import { formatTime } from '@shared/timing';
import type { RenderResources } from '../engine/karaokeRenderer';
import { exportProjectToMp4, type ExportResult } from '../engine/videoExporter';

const QUALITY_META: Record<
  ExportQualityPreset,
  { spec: string; mbps30: number; mbps60: number }
> = {
  compact: {
    spec: 'H.264 MP4 (CRF 28 · AAC 160k)',
    mbps30: 1.15,
    mbps60: 1.35,
  },
  balanced: {
    spec: 'H.264 MP4 (CRF 25 · AAC 160k)',
    mbps30: 1.55,
    mbps60: 1.85,
  },
  high: {
    spec: 'H.264 MP4 (CRF 21 · AAC 256k)',
    mbps30: 2.4,
    mbps60: 3.0,
  },
};

interface ExportModalProps {
  open: boolean;
  project: KaraokeProject;
  resources: RenderResources;
  onClose: () => void;
}

export function ExportModal({ open, project, resources, onClose }: ExportModalProps) {
  const [fps, setFps] = useState<60 | 30>(30);
  const [quality, setQuality] = useState<ExportQualityPreset>('compact');
  const [preferWebCodecs, setPreferWebCodecs] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({
    frame: 0,
    totalFrames: 0,
    percent: 0,
    fps: 0,
    etaSeconds: 0,
    encoderUsed: '',
  });
  const [result, setResult] = useState<ExportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exporting) {
        e.preventDefault();
        setResult(null);
        setErrorMsg('');
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, exporting, onClose]);

  if (!open) return null;

  const handleStart = async () => {
    setExporting(true);
    setResult(null);
    setErrorMsg('');
    setProgress({
      frame: 0,
      totalFrames: 0,
      percent: 0,
      fps: 0,
      etaSeconds: 0,
      encoderUsed: '',
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await exportProjectToMp4({
        project,
        resources,
        fps,
        quality,
        preferWebCodecs,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setResult(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleClose = () => {
    if (exporting) {
      abortRef.current?.abort();
    }
    setResult(null);
    setErrorMsg('');
    onClose();
  };

  const estDuration = Math.max(
    4,
    project.duration || project.lines.reduce((m, l) => Math.max(m, l.endTime), 0) + 3
  );
  const qualityMeta = QUALITY_META[quality];
  const baseMbps = fps === 60 ? qualityMeta.mbps60 : qualityMeta.mbps30;
  const estMbps = project.settings.bgType === 'video' ? baseMbps * 1.55 : baseMbps;
  const estSizeMb = (estDuration * estMbps) / 8;
  const estSizeLabel = `약 ${estSizeMb < 10 ? estSizeMb.toFixed(1) : Math.round(estSizeMb)} MB`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !exporting) {
          handleClose();
        }
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#0d1322] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
          <div className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
            <Film className="h-4 w-4 text-sky-400" />
            MP4 영상 내보내기
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/[0.08] hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {/* Spec summary */}
          <div className="rounded-xl border border-white/[0.07] bg-black/30 p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-200">내보내기 사양</div>
            <div className="grid grid-cols-2 gap-y-1 text-slate-400">
              <span>해상도 / 비율</span>
              <span className="text-slate-200 font-medium tabular-nums">1920 × 1080 Full HD (16:9)</span>
              <span>비디오 / 오디오</span>
              <span className="text-slate-200 font-medium">{qualityMeta.spec}</span>
              <span>총 길이</span>
              <span className="text-slate-200 font-medium tabular-nums">{formatTime(estDuration)}</span>
              <span>예상 용량</span>
              <span className="text-emerald-300 font-medium tabular-nums">
                {estSizeLabel}
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  (화면 움직임에 따라 변동)
                </span>
              </span>
              <span>오디오 모드 / 키</span>
              <span className="text-sky-300 font-medium tabular-nums">
                {(() => {
                  const exportMode = project.audioMode ?? 'original';
                  const isOrigMode = exportMode !== 'mr' && exportMode !== 'karaoke';
                  const exportKey = isOrigMode ? 0 : (project.keyShift ?? 0);
                  const modeLabel =
                    exportMode === 'mr'
                      ? 'MR'
                      : exportMode === 'karaoke'
                      ? '노래방'
                      : '원곡';
                  const keyLabel = isOrigMode
                    ? '원키 (고정)'
                    : exportKey === 0
                    ? '원키'
                    : `${exportKey > 0 ? '+' : ''}${exportKey}키`;
                  return `${modeLabel} · ${keyLabel}`;
                })()}
              </span>
              {((project.audioMode === 'mr' &&
                project.mrAudioFileId &&
                Math.abs(project.mrSyncOffset ?? 0) >= 0.001) ||
                ((project.audioMode === 'karaoke' ||
                  project.audioMode === 'mr-vocal' ||
                  project.audioMode === 'mr-melody') &&
                  ((project.karaokeAudioFileId &&
                    Math.abs(project.karaokeSyncOffset ?? 0) >= 0.001) ||
                    (!project.karaokeAudioFileId &&
                      project.mrAudioFileId &&
                      Math.abs(project.mrSyncOffset ?? 0) >= 0.001)))) && (
                <>
                  <span>싱크 보정</span>
                  <span className="text-emerald-300 font-mono tabular-nums font-medium">
                    {(() => {
                      const off =
                        project.audioMode !== 'mr' && project.karaokeAudioFileId
                          ? (project.karaokeSyncOffset ?? 0)
                          : (project.mrSyncOffset ?? 0);
                      return `${off > 0 ? '+' : ''}${off.toFixed(2)}초`;
                    })()}
                  </span>
                </>
              )}
              <span>음원 연결</span>
              {(() => {
                const mode = project.audioMode ?? 'original';
                const activeName =
                  mode === 'mr'
                    ? project.mrAudioFileName || project.audioFileName
                    : mode === 'karaoke' && project.karaokeAudioFileName
                    ? project.karaokeAudioFileName
                    : mode === 'karaoke'
                    ? project.mrAudioFileName || project.audioFileName
                    : project.audioFileName;
                const hasExportAudio =
                  mode === 'mr'
                    ? Boolean(project.mrAudioFileId || project.audioFileId)
                    : mode === 'karaoke'
                    ? Boolean(
                        project.karaokeAudioFileId ||
                          project.mrAudioFileId ||
                          project.audioFileId
                      )
                    : Boolean(project.audioFileId);
                return (
                  <span
                    className={
                      hasExportAudio ? 'text-emerald-300 font-medium truncate' : 'text-amber-300'
                    }
                    title={activeName || undefined}
                  >
                    {activeName || '음원 미지정 (무음)'}
                  </span>
                );
              })()}
            </div>
          </div>

          {/* Options */}
          {!exporting && !result && (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-[11px] text-slate-400 mb-1">압축 / 화질</label>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as ExportQualityPreset)}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-2 text-slate-100 focus:border-sky-400/60 focus:outline-none"
                >
                  <option value="compact">초경량 (권장 · 최대 압축, 화질 저하 최소)</option>
                  <option value="balanced">표준 (화질·용량 균형)</option>
                  <option value="high">고화질 (유튜브 원본 업로드용)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">프레임레이트</label>
                <select
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) as 60 | 30)}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-2 text-slate-100 focus:border-sky-400/60 focus:outline-none"
                >
                  <option value={30}>30 fps (가볍고 빠름 · 권장)</option>
                  <option value={60}>60 fps (부드러운 와이프)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">캡처 방식</label>
                <select
                  value={preferWebCodecs ? 'webcodecs' : 'ffmpeg'}
                  onChange={(e) => setPreferWebCodecs(e.target.value === 'webcodecs')}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-2 text-slate-100 focus:border-sky-400/60 focus:outline-none"
                >
                  <option value="webcodecs">GPU 고속 캡처 + x264 압축 (권장)</option>
                  <option value="ffmpeg">FFmpeg 호환 모드</option>
                </select>
              </div>
            </div>
          )}

          {/* Live progress */}
          {exporting && (
            <div className="rounded-xl border border-sky-400/25 bg-sky-500/[0.07] p-4 space-y-2.5">
              <div className="flex items-center justify-between font-semibold text-sky-200">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                  1080p MP4 렌더링 중...
                </span>
                <span className="font-mono tabular-nums text-sm">{progress.percent}%</span>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full bg-sky-400 transition-all duration-150"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              <div className="flex justify-between text-[11px] text-slate-400 tabular-nums">
                <span>
                  프레임 {progress.frame} / {progress.totalFrames} ({progress.fps} fps)
                </span>
                <span>남은 시간 약 {progress.etaSeconds}초</span>
              </div>
              {progress.encoderUsed && (
                <div className="text-[10px] text-slate-500">엔진: {progress.encoderUsed}</div>
              )}
            </div>
          )}

          {/* Error */}
          {errorMsg && (
            <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-rose-200">
              {errorMsg}
            </div>
          )}

          {/* Done */}
          {result && (
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 space-y-3">
              <div className="flex items-center gap-2 font-semibold text-emerald-300 text-sm">
                <CheckCircle2 className="h-5 w-5" />
                MP4 생성 완료
              </div>
              <div className="text-[11px] text-slate-300 space-y-0.5 break-all tabular-nums">
                <div>파일명: {result.fileName}</div>
                <div>크기: {(result.fileSize / (1024 * 1024)).toFixed(2)} MB</div>
                <div className="text-slate-400">저장 위치: {result.filePath}</div>
              </div>
              <a
                href={result.downloadUrl}
                download={result.fileName}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 font-semibold text-slate-950 hover:bg-emerald-400 transition"
              >
                <Download className="h-4 w-4" />
                MP4 파일 다운로드
              </a>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex justify-end gap-2 pt-1">
            {exporting ? (
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg bg-rose-500 px-4 py-2 font-semibold text-white hover:bg-rose-400 transition"
              >
                렌더링 취소
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-2 font-medium text-slate-200 hover:bg-white/[0.09] transition"
                >
                  닫기
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  className="rounded-lg bg-sky-500 px-5 py-2 font-semibold text-slate-950 hover:bg-sky-400 shadow-sm shadow-sky-500/20 transition"
                >
                  {result ? '다시 렌더링' : '렌더링 시작'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
