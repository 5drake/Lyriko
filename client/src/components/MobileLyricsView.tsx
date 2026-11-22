import { useEffect, useMemo, useRef } from 'react';
import { Library, Monitor, Music2 } from 'lucide-react';
import type { KaraokeProject } from '@shared/types';

interface MobileLyricsViewProps {
  project: KaraokeProject;
  currentTime: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onToggleStyleFlag: (key: 'showFurigana' | 'showKoPron' | 'showTranslation') => void;
  onOpenLibrary: () => void;
}

export function MobileLyricsView({
  project,
  currentTime,
  isPlaying,
  onSeek,
  onToggleStyleFlag,
  onOpenLibrary,
}: MobileLyricsViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledIdRef = useRef<string | null>(null);

  const activeLineId = useMemo(() => {
    let matchedId: string | null = null;
    for (const line of project.lines) {
      if (currentTime >= line.startTime - 0.05 && currentTime <= line.endTime + 0.08) {
        matchedId = line.id;
      }
    }
    return matchedId;
  }, [project.lines, currentTime]);

  useEffect(() => {
    if (!isPlaying || !activeLineId) {
      if (!isPlaying) lastScrolledIdRef.current = null;
      return;
    }
    if (lastScrolledIdRef.current === activeLineId) return;
    lastScrolledIdRef.current = activeLineId;

    const listEl = listRef.current;
    if (!listEl) return;
    const activeEl = listEl.querySelector<HTMLElement>(`[data-line-id="${activeLineId}"]`);
    if (!activeEl) return;

    const listRect = listEl.getBoundingClientRect();
    const itemRect = activeEl.getBoundingClientRect();
    const relativeTop = itemRect.top - listRect.top + listEl.scrollTop;
    const targetTop = Math.max(0, relativeTop - listEl.clientHeight * 0.28);
    listEl.scrollTo({ top: targetTop, behavior: 'smooth' });
  }, [activeLineId, isPlaying]);

  const styleFlags: Array<{
    key: 'showFurigana' | 'showKoPron' | 'showTranslation';
    label: string;
    enabled: boolean;
  }> = [
    { key: 'showFurigana', label: '후리가나', enabled: Boolean(project.settings.showFurigana) },
    { key: 'showKoPron', label: '발음', enabled: Boolean(project.settings.showKoPron) },
    { key: 'showTranslation', label: '해석', enabled: Boolean(project.settings.showTranslation) },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col rounded-xl border border-white/[0.07] bg-[#0c111d] overflow-hidden">
        {/* Compact Header */}
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold text-slate-100 whitespace-nowrap">
              실시간 가사
            </span>
            <span className="rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 font-mono tabular-nums text-[10px] font-medium text-slate-400">
              {project.lines.length}소절
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {styleFlags.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onToggleStyleFlag(item.key)}
                className={`rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                  item.enabled
                    ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                    : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable Read-Only Synced Lyrics */}
        <div
          ref={listRef}
          className="flex-1 min-h-[220px] max-h-[48vh] overflow-y-auto px-3 py-2 space-y-1.5"
        >
          {project.lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center gap-2.5">
              <Music2 className="h-6 w-6 text-slate-500" />
              <div className="text-xs text-slate-400">표시할 가사가 없습니다</div>
              <button
                type="button"
                onClick={onOpenLibrary}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition"
              >
                <Library className="h-3.5 w-3.5" />
                공유 라이브러리에서 곡 선택
              </button>
            </div>
          ) : (
            project.lines.map((line) => {
              const isActive = activeLineId === line.id;
              const koPronLine = line.segments
                .map((s) => s.koPron)
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={line.id}
                  type="button"
                  data-line-id={line.id}
                  onClick={() => onSeek(line.startTime)}
                  className={`w-full text-left rounded-lg border px-3 py-2 transition ${
                    isActive
                      ? 'border-sky-400/50 bg-sky-500/15 shadow-sm'
                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05]'
                  }`}
                >
                  <div
                    className={`text-[13px] font-semibold leading-snug break-keep ${
                      isActive ? 'text-slate-100' : 'text-slate-200'
                    }`}
                  >
                    {project.settings.showFurigana && line.segments.length > 0
                      ? line.segments.map((seg) =>
                          seg.ruby && seg.ruby !== seg.jp ? (
                            <ruby key={seg.id}>
                              {seg.jp}
                              <rt className="text-[10px] font-normal text-sky-300">{seg.ruby}</rt>
                            </ruby>
                          ) : (
                            <span key={seg.id}>{seg.jp}</span>
                          )
                        )
                      : line.jpText}
                  </div>

                  {project.settings.showKoPron && koPronLine && (
                    <div
                      className={`mt-0.5 text-[12px] font-medium leading-snug ${
                        isActive ? 'text-sky-200' : 'text-slate-300'
                      }`}
                    >
                      {koPronLine}
                    </div>
                  )}

                  {project.settings.showTranslation && line.koTranslation && (
                    <div className="mt-0.5 text-[11px] text-slate-400 leading-snug">
                      {line.koTranslation}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Bottom PC Guidance Notice */}
      <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-[#0c111d] px-3 py-2.5">
        <Monitor className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
        <div className="min-w-0 space-y-0.5">
          <div className="text-[11.5px] font-semibold text-slate-100">
            새 곡 추가 · 가사/싱크 편집은 PC에서 지원됩니다
          </div>
          <p className="text-[10.5px] text-slate-400 leading-relaxed">
            라이브러리에 없는 곡을 불러오거나 AI 싱크·편집·MP4 저장을 하려면 PC 브라우저로 접속해 주세요.
          </p>
        </div>
      </div>
    </div>
  );
}
