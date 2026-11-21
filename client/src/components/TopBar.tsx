import {
  Cpu,
  Film,
  HelpCircle,
  Moon,
  Music2,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import type { WorkerHealthResponse } from '@shared/types';

interface TopBarProps {
  uiTheme: 'light' | 'dark';
  songTitle?: string;
  songArtist?: string;
  onToggleTheme: () => void;
  onOpenExport: () => void;
  onOpenTour: () => void;
  onOpenSongSearch: () => void;
  workerHealth: WorkerHealthResponse | null;
  workerChecking: boolean;
  dbProvider: 'supabase' | 'local-cache';
  onOpenWorkerModal: () => void;
  onOpenSettings: () => void;
}

function formatShortGpuName(name?: string): string {
  return (name || '')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^AMD\s+Radeon\s+/i, '')
    .trim();
}

export function TopBar({
  uiTheme,
  songTitle,
  songArtist,
  onToggleTheme,
  onOpenExport,
  onOpenTour,
  onOpenSongSearch,
  workerHealth,
  workerChecking,
  dbProvider,
  onOpenWorkerModal,
  onOpenSettings,
}: TopBarProps) {
  const gpuShort = formatShortGpuName(workerHealth?.gpu?.name);
  const workerBadgeText = workerChecking
    ? '워커 확인 중...'
    : workerHealth?.ok
    ? workerHealth.gpu?.available
      ? `GPU · ${gpuShort}`
      : '워커 연결 (CPU)'
    : '로컬 워커 미연결';

  return (
    <header className="flex min-h-[52px] shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#0a0f1c]/95 px-3.5 py-1.5 backdrop-blur-md">
      <div className="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-slate-950 shadow-sm shadow-sky-500/25 shrink-0">
            <Music2 className="h-4 w-4 stroke-[2.25]" />
          </div>
          <div className="flex items-baseline gap-1 tracking-tight whitespace-nowrap">
            <span className="text-[15px] font-extrabold text-white">Lyriko</span>
          </div>
        </div>

        {/* High-Visibility Unified Pop-up Hub Launcher */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            data-tour="topbar-song-search"
            onClick={onOpenSongSearch}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-sky-400/35 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 hover:text-white transition shadow-sm shadow-sky-500/10"
            title="곡 검색 및 공유 라이브러리 팝업 열기"
          >
            <Search className="h-3.5 w-3.5 text-sky-300 shrink-0" />
            <span>곡 검색 · 라이브러리</span>
          </button>
        </div>

        {songTitle && (
          <button
            type="button"
            onClick={onOpenSongSearch}
            className="hidden lg:flex items-center gap-1.5 min-w-0 max-w-[280px] xl:max-w-[360px] rounded-lg border border-white/[0.06] bg-white/[0.025] px-2.5 py-1 text-[11.5px] text-slate-300 hover:bg-white/[0.06] transition"
            title={`현재 작업 중인 곡: ${songTitle}${songArtist ? ` · ${songArtist}` : ''} (클릭하여 곡 검색/공유 열기)`}
          >
            <span className="truncate font-medium text-slate-100">{songTitle}</span>
            {songArtist && (
              <span className="truncate text-slate-400 shrink-0 max-w-[110px]">
                · {songArtist}
              </span>
            )}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onOpenTour}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/15 hover:text-sky-200 transition"
          title="처음 사용자 안내 튜토리얼 보기"
        >
          <HelpCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden md:inline">사용법</span>
        </button>

        <button
          type="button"
          data-tour="worker-btn"
          onClick={onOpenWorkerModal}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium transition ${
            workerHealth?.ok
              ? 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-200 hover:bg-emerald-500/[0.14]'
              : 'border-amber-400/25 bg-amber-500/[0.07] text-amber-200 hover:bg-amber-500/[0.14]'
          }`}
          title={`로컬 워커 상태 및 공용 DB (${dbProvider === 'supabase' ? 'Supabase' : '로컬 캐시'})`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              workerChecking
                ? 'bg-sky-400 animate-pulse'
                : workerHealth?.ok
                ? 'bg-emerald-400'
                : 'bg-amber-400'
            }`}
          />
          <Cpu className="h-3.5 w-3.5 opacity-80 shrink-0" />
          <span className="truncate max-w-[130px] lg:max-w-[200px]">{workerBadgeText}</span>
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={
            uiTheme === 'light'
              ? '테마 전환 (현재: 밝은 테마)'
              : '테마 전환 (현재: 다크 테마)'
          }
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-200 hover:bg-white/[0.08] hover:text-white transition"
          title={
            uiTheme === 'light'
              ? '현재: 밝은 테마 (클릭하여 다크 테마로 전환)'
              : '현재: 다크 테마 (클릭하여 밝은 테마로 전환)'
          }
        >
          {uiTheme === 'light' ? (
            <Sun className="h-4 w-4 text-amber-500 shrink-0" />
          ) : (
            <Moon className="h-4 w-4 text-sky-300 shrink-0" />
          )}
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="설정"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-200 hover:bg-white/[0.08] hover:text-white transition"
          title="설정 · 정보"
        >
          <Settings className="h-4 w-4 text-slate-400 shrink-0" />
        </button>

        <button
          type="button"
          data-tour="export-btn"
          onClick={onOpenExport}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 shadow-sm shadow-sky-500/20 hover:bg-sky-400 transition"
        >
          <Film className="h-3.5 w-3.5 stroke-[2.25] shrink-0" />
          MP4 내보내기
        </button>
      </div>
    </header>
  );
}
