import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  FolderX,
  HardDrive,
  Loader2,
  Monitor,
  RefreshCw,
  Share2,
  Terminal,
  X,
} from 'lucide-react';
import type { KaraokeProject, WorkerHealthResponse } from '@shared/types';
import {
  getSavedWorkerOverrideUrl,
  getWorkerBaseUrl,
  setWorkerBaseUrl,
} from '../workerClient';
import { getCommunityDbStatus } from '../services/communityDb';

interface WorkerStatusModalProps {
  open: boolean;
  project: KaraokeProject;
  workerHealth: WorkerHealthResponse | null;
  workerChecking: boolean;
  onRefreshWorker: () => Promise<void>;
  onPublishCurrentSong: () => Promise<{
    savedTo: 'supabase' | 'local-server' | 'local-cache';
    ok: boolean;
    error?: string;
  }>;
  onClose: () => void;
}

export function WorkerStatusModal({
  open,
  project,
  workerHealth,
  workerChecking,
  onRefreshWorker,
  onPublishCurrentSong,
  onClose,
}: WorkerStatusModalProps) {
  const [workerUrlInput, setWorkerUrlInput] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');

  useEffect(() => {
    if (open) {
      setWorkerUrlInput(getSavedWorkerOverrideUrl());
      setPublishMsg('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const dbStatus = getCommunityDbStatus();
  const gpuInfo = workerHealth?.gpu;
  const vramGb =
    gpuInfo?.vramMb && gpuInfo.vramMb > 0
      ? `${(gpuInfo.vramMb / 1024).toFixed(0)} GB VRAM`
      : '';
  const activeBase = getWorkerBaseUrl() || '동일 출처 (로컬 개발 서버)';

  const handleApplyUrl = async () => {
    setWorkerBaseUrl(workerUrlInput);
    await onRefreshWorker();
  };

  const handlePublish = async () => {
    setPublishing(true);
    setPublishMsg('');
    try {
      const res = await onPublishCurrentSong();
      if (res.savedTo === 'supabase' && res.ok) {
        setPublishMsg('Supabase 공용 DB에 분석 결과를 저장·공유했습니다.');
      } else if (res.savedTo === 'local-server' && res.ok) {
        setPublishMsg('로컬 공유 라이브러리 DB에 분석 결과를 저장했습니다.');
      } else if (res.ok) {
        setPublishMsg('로컬 브라우저 캐시에 저장했습니다 (.env Supabase 키 연결 시 전체 공유).');
      } else {
        setPublishMsg(res.error || '저장에 실패했습니다.');
      }
    } finally {
      setPublishing(false);
    }
  };

  const capBadge = (label: string, enabled?: boolean) => (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-medium ${
        enabled
          ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
          : 'border-white/[0.08] bg-white/[0.03] text-slate-500'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? 'bg-emerald-400' : 'bg-slate-600'
        }`}
      />
      {label}
    </span>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-white/[0.1] bg-[#0d1322] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
          <div className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
            <Cpu className="h-4 w-4 text-sky-400" />
            로컬 GPU 워커 & 공용 DB 캐시
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/[0.08] hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
          {/* Local Worker Status */}
          <div className="rounded-xl border border-white/[0.08] bg-black/30 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-slate-100">
                <Terminal className="h-3.5 w-3.5 text-sky-400" />
                로컬 GPU 워커 상태
              </div>
              {workerChecking ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10.5px] font-medium text-sky-300">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  확인 중
                </span>
              ) : workerHealth?.ok ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  연결됨
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-amber-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  미연결
                </span>
              )}
            </div>

            {workerHealth?.ok ? (
              <>
                <div className="grid grid-cols-[90px_1fr] gap-y-1 text-[11px] text-slate-400">
                  <span>연산 장치</span>
                  <span className="font-medium text-slate-100">
                    {gpuInfo?.available
                      ? `${gpuInfo.name}${vramGb ? ` · ${vramGb}` : ''}`
                      : 'CPU 모드'}
                  </span>
                  <span>연결 주소</span>
                  <span className="font-mono text-[10.5px] text-slate-300 truncate">
                    {activeBase}
                  </span>
                  <span>AI 싱크 예상</span>
                  <span className="text-slate-300 tabular-nums">
                    4분 곡 기준 · RTX 3060 약 30~45초 · RTX 5090 약 10~15초
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {capBadge('FFmpeg', workerHealth.ffmpeg)}
                  {capBadge('yt-dlp', workerHealth.ytdlp)}
                  {capBadge('Kuromoji', workerHealth.kuromojiReady)}
                  {capBadge('AI GPU 싱크', workerHealth.aiAudio)}
                </div>
              </>
            ) : (
              <div className="space-y-1.5 text-[11px] text-slate-400 leading-relaxed">
                <p>
                  공용 DB에 이미 분석된 곡은 워커 없이 바로 감상할 수 있습니다. 새로운 곡을
                  YouTube에서 가져오거나 AI 싱크·MP4 인코딩을 실행하려면 로컬 워커를 실행해 주세요.
                </p>
                <p className="text-[10.5px] text-slate-300 tabular-nums">
                  예상 AI 작업 시간 (4분 곡 기준): RTX 3060 약 30~45초 · RTX 5090 약 10~15초
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                value={workerUrlInput}
                onChange={(e) => setWorkerUrlInput(e.target.value)}
                placeholder="기본: http://127.0.0.1:3840 (비우면 자동 감지)"
                className="flex-1 rounded-lg border border-white/[0.08] bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleApplyUrl}
                disabled={workerChecking}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-slate-100 hover:bg-white/[0.12] disabled:opacity-50 transition"
              >
                <RefreshCw className={`h-3 w-3 ${workerChecking ? 'animate-spin' : ''}`} />
                재연결
              </button>
            </div>
          </div>

          {/* Portable ZIP Quick Guide */}
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-slate-200">
                <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                무설치 포터블 워커 사용 및 완전 삭제 안내
              </div>
              <a
                href="https://github.com/5drake/Lyriko/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10.5px] font-medium text-sky-300 hover:bg-white/[0.1] transition shrink-0"
              >
                <span>GitHub 다운로드</span>
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-400 leading-relaxed">
              <li>
                <span className="text-slate-200 font-medium">1. 사전 설치 없이 간편 실행:</span>{' '}
                <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[10.5px] text-sky-300">
                  Lyriko-Worker-Portable.zip
                </code>{' '}
                압축 해제 후{' '}
                <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[10.5px] text-sky-300">
                  Lyriko-Worker.bat
                </code>{' '}
                더블클릭 (최초 1회 PC에 Node.js가 없으면{' '}
                <code className="text-[10.5px] text-slate-300">.\node</code>에 포터블 Node.js 22 LTS를,{' '}
                <code className="text-[10.5px] text-slate-300">.\python</code>에 AI 환경을 폴더 내부로 자동 구성)
                <div className="mt-1 pl-3 text-[10.5px] text-slate-500">
                  방화벽·오프라인 환경에서 자동 다운로드 실패 시{' '}
                  <a
                    href="https://nodejs.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200"
                  >
                    nodejs.org (LTS)
                  </a>{' '}
                  수동 설치 또는{' '}
                  <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-slate-300">
                    winget install OpenJS.NodeJS.LTS
                  </code>{' '}
                  후 재실행해 주세요.
                </div>
              </li>
              <li className="flex items-start gap-1">
                <FolderX className="h-3.5 w-3.5 text-rose-400 shrink-0 mt-0.5" />
                <span>
                  <span className="text-slate-200 font-medium">2. 100% 완전 삭제:</span> 레지스트리나{' '}
                  <code className="text-[10.5px]">AppData</code>에 흔적을 남기지 않으므로, 워커 창을 닫고{' '}
                  <strong className="text-slate-200">압축 푼 폴더 통째로 삭제</strong>하면 Node.js·Python·모델·캐시까지 깔끔하게 지워집니다.
                </span>
              </li>
            </ul>
          </div>

          {/* PC Minimum / Recommended Specs */}
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-slate-200">
                <Monitor className="h-3.5 w-3.5 text-sky-400" />
                PC 최소 / 권장 사양 (로컬 GPU 워커)
              </div>
              <span className="text-[10.5px] text-slate-500 shrink-0">웹 감상·편집은 사양 무관</span>
            </div>

            <div className="overflow-hidden rounded-lg border border-white/[0.08]">
              <table className="w-full text-left border-collapse text-[10.5px]">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.03] text-slate-300">
                    <th className="px-2.5 py-1.5 font-semibold w-[74px]">항목</th>
                    <th className="px-2.5 py-1.5 font-semibold">최소 사양</th>
                    <th className="px-2.5 py-1.5 font-semibold">권장 사양</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-slate-400">
                  <tr>
                    <td className="px-2.5 py-1.5 font-medium text-slate-200">OS</td>
                    <td className="px-2.5 py-1.5">Windows 10/11 (64-bit)</td>
                    <td className="px-2.5 py-1.5 text-slate-300">Windows 10/11 (64-bit)</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-medium text-slate-200">GPU</td>
                    <td className="px-2.5 py-1.5">
                      NVIDIA GTX 16 / RTX 20+ (VRAM 6 GB+)
                      <span className="block text-[10px] text-slate-500">(CPU 폴백 가능)</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-200 font-medium">
                      RTX 3060 (8~12 GB) 이상
                    </td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-medium text-slate-200">RAM</td>
                    <td className="px-2.5 py-1.5">8 GB</td>
                    <td className="px-2.5 py-1.5 text-slate-300">16 GB 이상</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-medium text-slate-200">저장공간</td>
                    <td className="px-2.5 py-1.5">여유 10 GB (AI 환경·모델 포함)</td>
                    <td className="px-2.5 py-1.5 text-slate-300">여유 15 GB 이상</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-medium text-slate-200">사전 설치</td>
                    <td className="px-2.5 py-1.5">없음 (Node.js·Python 자동 구성)</td>
                    <td className="px-2.5 py-1.5 text-slate-300">없음 (최신 NVIDIA 드라이버 권장)</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="text-[10.5px] text-slate-400 tabular-nums">
              4분 곡 AI 보컬 분리 + 음소 싱크 기준: RTX 3060 약 30~45초 · RTX 5090 약 10~15초 (최초 모델 다운로드 제외)
            </p>
          </div>

          {/* Public DB Cache Section */}
          <div className="rounded-xl border border-white/[0.08] bg-black/30 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-slate-100">
                <Database className="h-3.5 w-3.5 text-violet-400" />
                공용 곡 분석 DB 캐시
              </div>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  dbStatus.configured
                    ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                    : 'border-slate-600/40 bg-white/[0.04] text-slate-300'
                }`}
              >
                {dbStatus.configured
                  ? 'Supabase 공용 DB 연결됨'
                  : '로컬 캐시 모드 (.env 키 미설정)'}
              </span>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              음원 파일 대신 <strong className="text-slate-200">타이밍 · 다중독음 후리가나 · 한국어 발음 · 번역</strong> JSON만 저장합니다. 같은 YouTube 곡은 재계산 없이 바로 불러옵니다. (로컬 캐시 {dbStatus.cachedLocalCount}곡 보관 중)
            </p>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span className="text-[10.5px] text-slate-500 truncate">
                {project.youtubeVideoId
                  ? `현재 곡 ID: ${project.youtubeVideoId}`
                  : 'YouTube에서 곡을 가져오면 공유할 수 있습니다'}
              </span>
              <button
                type="button"
                disabled={
                  publishing || !project.youtubeVideoId || project.lines.length === 0
                }
                onClick={handlePublish}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40 disabled:cursor-not-allowed transition shrink-0"
              >
                {publishing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Share2 className="h-3.5 w-3.5" />
                )}
                현재 곡 분석 결과 DB에 저장·공유
              </button>
            </div>

            {publishMsg && (
              <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{publishMsg}</span>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-1.5 text-slate-200 hover:bg-white/[0.09] transition"
            >
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
