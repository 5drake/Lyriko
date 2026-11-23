import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Clock,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Target,
  Trash2,
} from 'lucide-react';
import type { KaraokeProject, LyricLine, LyricSegment } from '@shared/types';
import { formatTime, redistributeSegmentTimings } from '@shared/timing';
import {
  buildKoPronFromSegment,
  getReadingCandidatesForSegment,
} from '@shared/jpPronunciation';
import { applyWebFurigana, convertJapaneseLyrics } from '../api';

interface LyricInspectorProps {
  project: KaraokeProject;
  currentTime: number;
  selectedLineId: string | null;
  isPlaying?: boolean;
  aiAligning?: boolean;
  aiAlignStatus?: string;
  onSelectLine: (id: string) => void;
  onSeek: (time: number) => void;
  onUpdateProject: (updater: (prev: KaraokeProject) => KaraokeProject) => void;
  onRunAiLyricsAlign?: () => Promise<void>;
  onShiftAllLyrics?: (deltaSec: number) => void;
  onLineDeleted?: (jpText: string) => void;
}

function TimingNumberInput({
  value,
  onCommit,
  className,
  ariaLabel,
}: {
  value: number;
  onCommit: (nextVal: number) => void;
  className: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(String(value));
    }
  }, [value, focused]);

  const commitDraft = (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setDraft(String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDraft(String(value));
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        commitDraft(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitDraft(draft);
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
}

export function LyricInspector({
  project,
  currentTime,
  selectedLineId,
  isPlaying = false,
  aiAligning = false,
  aiAlignStatus = '',
  onSelectLine,
  onSeek,
  onUpdateProject,
  onRunAiLyricsAlign,
  onShiftAllLyrics,
  onLineDeleted,
}: LyricInspectorProps) {
  const [autoFollow, setAutoFollow] = useState(true);
  const [syncToolsOpen, setSyncToolsOpen] = useState(false);
  const [reconverting, setReconverting] = useState(false);
  const [webFuriganaBusy, setWebFuriganaBusy] = useState(false);
  const [webFuriganaStatus, setWebFuriganaStatus] = useState('');
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const detailEditorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setWebFuriganaStatus('');
  }, [project.id]);
  const selectedLineIdRef = useRef<string | null>(selectedLineId);
  selectedLineIdRef.current = selectedLineId;
  const onSelectLineRef = useRef(onSelectLine);
  onSelectLineRef.current = onSelectLine;

  const activeLine = project.lines.find(
    (l) => currentTime >= l.startTime && currentTime <= l.endTime
  );

  useEffect(() => {
    if (!autoFollow || !activeLine) return;
    const el = rowRefs.current.get(activeLine.id);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (isPlaying && activeLine.id !== selectedLineIdRef.current) {
      const activeEl = document.activeElement;
      const isEditingDetail =
        Boolean(activeEl) &&
        Boolean(detailEditorRef.current?.contains(activeEl)) &&
        (activeEl instanceof HTMLInputElement ||
          activeEl instanceof HTMLTextAreaElement ||
          activeEl instanceof HTMLSelectElement);
      if (!isEditingDetail) {
        onSelectLineRef.current(activeLine.id);
        if (detailEditorRef.current) {
          detailEditorRef.current.scrollTop = 0;
        }
      }
    }
  }, [activeLine?.id, autoFollow, isPlaying]);

  const selectedLine =
    project.lines.find((l) => l.id === selectedLineId) ?? project.lines[0] ?? null;

  const updateLine = (lineId: string, fn: (line: LyricLine) => LyricLine) => {
    onUpdateProject((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => (l.id === lineId ? fn(l) : l)),
    }));
  };

  const handleAddLine = () => {
    const baseStart = selectedLine
      ? Number((selectedLine.endTime + 0.5).toFixed(2))
      : Number(currentTime.toFixed(2));
    const newLine: LyricLine = {
      id: `line_${Date.now().toString(36)}`,
      startTime: baseStart,
      endTime: Number((baseStart + 3.5).toFixed(2)),
      jpText: '新しい歌詞',
      koTranslation: '새 가사 해석',
      segments: [
        {
          id: `seg_${Date.now().toString(36)}_1`,
          jp: '新しい',
          ruby: 'あたら',
          koPron: '아타라시이',
          startTime: baseStart,
          endTime: Number((baseStart + 1.8).toFixed(2)),
        },
        {
          id: `seg_${Date.now().toString(36)}_2`,
          jp: '歌詞',
          ruby: 'かし',
          koPron: '카시',
          startTime: Number((baseStart + 1.8).toFixed(2)),
          endTime: Number((baseStart + 3.5).toFixed(2)),
        },
      ],
    };
    onUpdateProject((prev) => ({
      ...prev,
      lines: [...prev.lines, newLine].sort((a, b) => a.startTime - b.startTime),
    }));
    onSelectLine(newLine.id);
  };

  const handleDeleteLine = (lineId: string) => {
    const deleted = project.lines.find((l) => l.id === lineId);
    onUpdateProject((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => l.id !== lineId),
    }));
    onLineDeleted?.(deleted?.jpText || '');
  };

  const handleReconvertLine = async (line: LyricLine) => {
    setReconverting(true);
    try {
      const converted = await convertJapaneseLyrics({
        title: project.title,
        artist: project.artist,
        lines: [
          {
            id: line.id,
            startTime: line.startTime,
            endTime: line.endTime,
            jpText: line.jpText,
            koTranslation: line.koTranslation,
            slot: line.slot,
          },
        ],
      });
      if (converted[0]) {
        updateLine(line.id, () => converted[0]);
      }
    } finally {
      setReconverting(false);
    }
  };

  const handleApplyWebFurigana = async () => {
    if (project.lines.length === 0) return;
    setWebFuriganaBusy(true);
    setWebFuriganaStatus('UtaTen 일본어 후리가나 검색 중...');
    try {
      const { lines, furiganaSource } = await applyWebFurigana({
        lines: project.lines,
        title: project.title,
        artist: project.artist,
        longVowelMode: 'vowel',
      });
      if (furiganaSource.matched) {
        onUpdateProject((prev) => ({
          ...prev,
          lines,
        }));
        const detail =
          furiganaSource.overriddenSegments > 0
            ? `${furiganaSource.overriddenSegments}개 발음 보정`
            : `${furiganaSource.verifiedSegments}개 검증 완료`;
        setWebFuriganaStatus(
          `${furiganaSource.sourceLabel} 후리가나 매칭 완료 (${furiganaSource.matchedLines}/${furiganaSource.totalLines}소절 · ${detail})`
        );
      } else {
        setWebFuriganaStatus('일치하는 일본어 웹 후리가나를 찾지 못했습니다.');
      }
    } catch (err) {
      setWebFuriganaStatus(
        `웹 후리가나 매칭 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setWebFuriganaBusy(false);
    }
  };

  const handleUpdateSegment = (
    line: LyricLine,
    segId: string,
    patch: Partial<LyricSegment>
  ) => {
    updateLine(line.id, (cur) => {
      const nextSegs = cur.segments.map((s) => (s.id === segId ? { ...s, ...patch } : s));
      return {
        ...cur,
        jpText: nextSegs.map((s) => s.jp).join(''),
        segments: nextSegs,
      };
    });
  };

  const handleSplitSegment = (line: LyricLine, segIdx: number) => {
    const seg = line.segments[segIdx];
    const chars = Array.from(seg.jp);
    if (chars.length < 2) return;
    const mid = Math.ceil(chars.length / 2);
    const tMid = Number(((seg.startTime + seg.endTime) / 2).toFixed(3));
    const s1: LyricSegment = {
      ...seg,
      jp: chars.slice(0, mid).join(''),
      endTime: tMid,
    };
    const s2: LyricSegment = {
      id: `seg_${Date.now().toString(36)}_sp`,
      jp: chars.slice(mid).join(''),
      ruby: '',
      koPron: '',
      startTime: tMid,
      endTime: seg.endTime,
    };
    updateLine(line.id, (cur) => {
      const copy = [...cur.segments];
      copy.splice(segIdx, 1, s1, s2);
      return { ...cur, segments: copy };
    });
  };

  const handleDeleteSegment = (line: LyricLine, segIdx: number) => {
    if (line.segments.length <= 1) return;
    updateLine(line.id, (cur) => {
      const copy = cur.segments.filter((_, i) => i !== segIdx);
      return redistributeSegmentTimings({
        ...cur,
        jpText: copy.map((s) => s.jp).join(''),
        segments: copy,
      });
    });
  };

  const handleShiftSingleLine = (lineId: string, deltaSec: number) => {
    if (!deltaSec || !Number.isFinite(deltaSec)) return;
    updateLine(lineId, (l) => {
      const dur = Math.max(0.1, l.endTime - l.startTime);
      const nextStart = Math.max(0, Number((l.startTime + deltaSec).toFixed(3)));
      const shift = nextStart - l.startTime;
      const nextEnd = Number(Math.max(nextStart + dur, l.endTime + shift).toFixed(3));
      return {
        ...l,
        startTime: nextStart,
        endTime: nextEnd,
        segments: l.segments.map((seg) => {
          const sDur = Math.max(0.05, seg.endTime - seg.startTime);
          const sStart = Math.max(nextStart, Number((seg.startTime + shift).toFixed(3)));
          const sEnd = Number(Math.max(sStart + sDur, seg.endTime + shift).toFixed(3));
          return {
            ...seg,
            startTime: sStart,
            endTime: sEnd,
          };
        }),
      };
    });
  };

  const handleUpdateSegmentTiming = (
    line: LyricLine,
    segIdx: number,
    field: 'startTime' | 'endTime',
    rawVal: number
  ) => {
    if (!Number.isFinite(rawVal)) return;
    const val = Math.max(0, Number(rawVal.toFixed(3)));
    updateLine(line.id, (cur) => {
      const segs = cur.segments.map((s) => ({ ...s }));
      const target = segs[segIdx];
      if (!target) return cur;
      const oldStart = target.startTime;
      const oldEnd = target.endTime;

      let nextLineStart = cur.startTime;
      let nextLineEnd = cur.endTime;

      if (field === 'startTime') {
        target.startTime = val;
        if (target.endTime < val + 0.05) {
          target.endTime = Number((val + 0.05).toFixed(3));
        }
        if (segIdx > 0) {
          const prev = segs[segIdx - 1];
          if (prev.endTime > val || Math.abs(prev.endTime - oldStart) <= 0.15) {
            prev.endTime = Number(Math.max(prev.startTime + 0.05, val).toFixed(3));
          }
        }
        nextLineStart = segIdx === 0 ? val : Math.min(cur.startTime, val);
        nextLineEnd = Math.max(cur.endTime, target.endTime);
      } else {
        target.endTime = Number(Math.max(target.startTime + 0.05, val).toFixed(3));
        if (segIdx < segs.length - 1) {
          const nxt = segs[segIdx + 1];
          if (nxt.startTime < target.endTime || Math.abs(nxt.startTime - oldEnd) <= 0.15) {
            nxt.startTime = target.endTime;
            if (nxt.endTime < nxt.startTime + 0.05) {
              nxt.endTime = Number((nxt.startTime + 0.05).toFixed(3));
            }
          }
        }
        nextLineStart = Math.min(cur.startTime, target.startTime);
        nextLineEnd =
          segIdx === segs.length - 1 ? target.endTime : Math.max(cur.endTime, target.endTime);
      }

      return {
        ...cur,
        startTime: nextLineStart,
        endTime: Math.max(nextLineStart + 0.1, nextLineEnd),
        segments: segs,
      };
    });
  };

  return (
    <aside className="flex w-[356px] xl:w-[396px] shrink-0 flex-col border-l border-white/[0.07] bg-[#0b101d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-1.5 border-b border-white/[0.07] px-2.5 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100 whitespace-nowrap min-w-0">
          <Layers className="h-4 w-4 text-sky-400 shrink-0" />
          <span>가사 편집</span>
          <span className="rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 font-mono tabular-nums text-[10px] font-medium text-slate-400">
            {project.lines.length}줄
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setSyncToolsOpen((v) => !v)}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[10.5px] font-medium transition ${
              syncToolsOpen || aiAligning
                ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                : 'border-white/[0.08] bg-white/[0.03] text-slate-300 hover:text-white'
            }`}
            title="전체 가사 싱크 이동 및 AI 싱크 다시 맞추기"
          >
            {aiAligning ? (
              <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            ) : (
              <Target className="h-3 w-3 shrink-0" />
            )}
            <span>싱크</span>
          </button>

          <button
            type="button"
            onClick={() => setAutoFollow((v) => !v)}
            className={`whitespace-nowrap rounded-md border px-2 py-1 text-[10.5px] font-medium transition ${
              autoFollow
                ? 'border-sky-400/35 bg-sky-500/15 text-sky-200'
                : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-slate-200'
            }`}
            title="재생 중인 소절로 자동 스크롤 및 소절 상세 자동 전환"
          >
            자동 스크롤
          </button>
          <button
            type="button"
            onClick={handleAddLine}
            className="flex items-center gap-1 whitespace-nowrap rounded-md border border-sky-400/30 bg-sky-500/15 px-2 py-1 text-[10.5px] font-semibold text-sky-300 hover:bg-sky-500/25 transition"
          >
            <Plus className="h-3 w-3 shrink-0" />
            추가
          </button>
        </div>
      </div>

      {/* Collapsible Global Sync & AI Align Drawer */}
      {syncToolsOpen && (
        <div className="border-b border-white/[0.08] bg-[#0d1322] px-3 py-2.5 space-y-2 text-xs">
          <button
            type="button"
            onClick={() => void onRunAiLyricsAlign?.()}
            disabled={aiAligning || !project.audioFileId || project.lines.length === 0}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-sky-500 py-1.5 px-2.5 text-[11px] font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-45 transition"
          >
            {aiAligning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Target className="h-3.5 w-3.5" />
            )}
            <span>{aiAligning ? 'AI 싱크 정렬 중...' : 'AI 싱크 다시 맞추기'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleApplyWebFurigana()}
            disabled={webFuriganaBusy || aiAligning || project.lines.length === 0}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-sky-400/35 bg-sky-500/12 py-1.5 px-2.5 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-45 transition"
            title="일본 UtaTen 공식 후리가나 페이지를 찾아 한자 독음과 한국어 발음을 자동 보정합니다"
          >
            {webFuriganaBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <BookOpen className="h-3.5 w-3.5" />
            )}
            <span>
              {webFuriganaBusy ? '일본어 웹 후리가나 매칭 중...' : '웹 후리가나 매칭 (UtaTen)'}
            </span>
          </button>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-medium text-slate-400 whitespace-nowrap">
              전체 이동
            </span>
            <div className="grid grid-cols-4 gap-1 flex-1">
              {[-0.5, -0.1, 0.1, 0.5].map((delta) => (
                <button
                  key={delta}
                  type="button"
                  disabled={project.lines.length === 0}
                  onClick={() => onShiftAllLyrics?.(delta)}
                  className="rounded-md border border-white/[0.09] bg-black/30 py-1 font-mono tabular-nums text-[10.5px] font-medium text-slate-200 hover:border-sky-400/45 hover:bg-sky-500/15 disabled:opacity-40 transition"
                  title={`모든 소절 및 단어 싱크를 ${delta > 0 ? `+${delta}` : delta}초 이동`}
                >
                  {delta > 0 ? `+${delta}s` : `${delta}s`}
                </button>
              ))}
            </div>
          </div>

          {aiAlignStatus && (
            <div className="text-[10.5px] text-sky-300 leading-snug">{aiAlignStatus}</div>
          )}
          {webFuriganaStatus && (
            <div className="text-[10.5px] text-emerald-300/95 leading-snug">
              {webFuriganaStatus}
            </div>
          )}
        </div>
      )}

      {/* Line list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-[180px]">
        {project.lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center p-6 text-xs text-slate-400 space-y-1.5">
            <p className="font-medium text-slate-300">가사가 없습니다</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              상단 [곡 검색 · 라이브러리] 버튼(Ctrl+K)에서 곡을 검색하거나 라이브러리에서 불러오세요.
            </p>
          </div>
        ) : (
          project.lines.map((line, idx) => {
            const isSelected = selectedLine?.id === line.id;
            const isActive = activeLine?.id === line.id;
            return (
              <div
                key={line.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(line.id, el);
                  else rowRefs.current.delete(line.id);
                }}
                onClick={() => {
                  onSelectLine(line.id);
                  onSeek(line.startTime);
                }}
                className={`group rounded-xl border px-3 py-2 cursor-pointer transition text-xs ${
                  isSelected
                    ? 'border-sky-400/40 bg-sky-500/[0.09] shadow-[inset_3px_0_0_#38bdf8]'
                    : isActive
                    ? 'border-indigo-400/35 bg-indigo-500/[0.08] shadow-[inset_3px_0_0_#818cf8]'
                    : 'border-transparent bg-white/[0.02] hover:bg-white/[0.045] hover:border-white/[0.07]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="font-mono tabular-nums text-[10px] text-slate-400">
                    #{idx + 1} · {formatTime(line.startTime, true)} – {formatTime(line.endTime, true)}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteLine(line.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-slate-500 hover:text-rose-400 transition"
                    title="소절 삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="font-semibold text-slate-100 truncate">{line.jpText}</div>
                <div className="text-[11px] text-amber-200/85 truncate">
                  {line.segments.map((s) => s.koPron).filter(Boolean).join(' ')}
                </div>
                {line.koTranslation && (
                  <div className="text-[11px] text-slate-400 truncate">
                    {line.koTranslation}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Selected Line Detailed Editor */}
      {selectedLine && (
        <div
          ref={detailEditorRef}
          data-tour="lyric-inspector"
          className="border-t border-white/[0.08] bg-[#0d1322] p-3 space-y-2.5 max-h-[52%] overflow-y-auto text-xs"
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="font-semibold text-slate-100">소절 상세</span>
            <div className="flex items-center gap-1">
              {[-0.1, 0.1].map((delta) => (
                <button
                  key={delta}
                  type="button"
                  onClick={() => handleShiftSingleLine(selectedLine.id, delta)}
                  className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-1 font-mono tabular-nums text-[10px] font-medium text-slate-200 hover:border-sky-400/45 hover:bg-sky-500/15 transition"
                  title={`이 소절만 ${delta > 0 ? `+${delta}` : delta}초 이동`}
                >
                  {delta > 0 ? `+${delta}s` : `${delta}s`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => handleReconvertLine(selectedLine)}
                disabled={reconverting}
                className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10.5px] font-medium text-slate-200 hover:bg-white/[0.09] transition"
                title="일본어 원문 기준으로 후리가나와 한국어 발음 다시 계산"
              >
                <RefreshCw className={`h-3 w-3 text-sky-400 ${reconverting ? 'animate-spin' : ''}`} />
                발음 재변환
              </button>
            </div>
          </div>

          {/* Timing & Slot */}
          <div className="grid grid-cols-3 gap-1.5">
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">시작(초)</label>
              <div className="flex gap-1">
                <TimingNumberInput
                  value={selectedLine.startTime}
                  ariaLabel="소절 시작(초)"
                  onCommit={(rawV) => {
                    const v = Math.max(0, Number(rawV.toFixed(3)));
                    updateLine(selectedLine.id, (l) =>
                      redistributeSegmentTimings({
                        ...l,
                        startTime: v,
                        endTime: Math.max(v + 0.3, l.endTime),
                      })
                    );
                  }}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-1.5 py-1 font-mono tabular-nums text-[11px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    updateLine(selectedLine.id, (l) =>
                      redistributeSegmentTimings({
                        ...l,
                        startTime: Number(currentTime.toFixed(3)),
                        endTime: Math.max(Number(currentTime.toFixed(3)) + 0.4, l.endTime),
                      })
                    )
                  }
                  className="rounded-lg border border-white/[0.08] bg-black/35 px-1.5 text-sky-300 hover:bg-white/[0.08] transition"
                  title="현재 재생 시간으로 시작 설정"
                >
                  <Clock className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">끝(초)</label>
              <div className="flex gap-1">
                <TimingNumberInput
                  value={selectedLine.endTime}
                  ariaLabel="소절 끝(초)"
                  onCommit={(rawV) => {
                    const v = Math.max(selectedLine.startTime + 0.3, Number(rawV.toFixed(3)));
                    updateLine(selectedLine.id, (l) =>
                      redistributeSegmentTimings({ ...l, endTime: v })
                    );
                  }}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-1.5 py-1 font-mono tabular-nums text-[11px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    updateLine(selectedLine.id, (l) =>
                      redistributeSegmentTimings({
                        ...l,
                        endTime: Math.max(l.startTime + 0.3, Number(currentTime.toFixed(3))),
                      })
                    )
                  }
                  className="rounded-lg border border-white/[0.08] bg-black/35 px-1.5 text-sky-300 hover:bg-white/[0.08] transition"
                  title="현재 재생 시간으로 끝 설정"
                >
                  <Clock className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">줄 위치</label>
              <select
                value={selectedLine.slot === undefined ? 'auto' : String(selectedLine.slot)}
                onChange={(e) => {
                  const val = e.target.value;
                  updateLine(selectedLine.id, (l) => ({
                    ...l,
                    slot: val === 'auto' ? undefined : (Number(val) as 0 | 1 | 2),
                  }));
                }}
                className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-1.5 py-1 text-[11px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
              >
                <option value="auto">자동 교차</option>
                <option value="0">1번 줄</option>
                <option value="1">2번 줄</option>
                <option value="2">3번 줄</option>
              </select>
            </div>
          </div>

          {/* Japanese text & Korean translation */}
          <div className="space-y-1.5">
            <input
              type="text"
              value={selectedLine.jpText}
              onChange={(e) =>
                updateLine(selectedLine.id, (l) => ({ ...l, jpText: e.target.value }))
              }
              placeholder="일본어 원문"
              className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-1.5 font-semibold text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
            />
            <input
              type="text"
              value={selectedLine.koTranslation}
              onChange={(e) =>
                updateLine(selectedLine.id, (l) => ({ ...l, koTranslation: e.target.value }))
              }
              placeholder="한국어 해석"
              className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-1.5 text-slate-200 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
            />
          </div>

          {/* Segment-by-segment editor */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-medium">단어 청크</span>
              <button
                type="button"
                onClick={() =>
                  updateLine(selectedLine.id, (l) => redistributeSegmentTimings(l))
                }
                className="text-sky-400 hover:text-sky-300 text-[10.5px] font-medium transition"
              >
                모라 비율 자동 배분
              </button>
            </div>

            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5 px-1 text-[9.5px] font-medium text-slate-500">
              <span>원문</span>
              <span>후리가나</span>
              <span>발음</span>
              <span className={selectedLine.segments.length > 1 ? 'w-10' : 'w-5'} />
            </div>

            <div className="space-y-1">
              {selectedLine.segments.map((seg, sIdx) => {
                const liveCandidates = getReadingCandidatesForSegment(seg.jp, seg.ruby);
                const mergedMap = new Map<string, { ruby: string; koPron: string }>();
                for (const c of liveCandidates) {
                  mergedMap.set(c.ruby, { ruby: c.ruby, koPron: c.koPron });
                }
                for (const a of seg.altReadings || []) {
                  if (a.ruby && !mergedMap.has(a.ruby)) {
                    mergedMap.set(a.ruby, a);
                  }
                }
                const candidates =
                  mergedMap.size >= 2 ? Array.from(mergedMap.values()) : [];
                const isChunkActive =
                  currentTime >= seg.startTime && currentTime <= seg.endTime;
                return (
                  <div
                    key={seg.id}
                    className={`rounded-lg border p-1.5 space-y-1.5 transition ${
                      isChunkActive
                        ? 'border-sky-400/45 bg-sky-500/[0.08]'
                        : 'border-white/[0.07] bg-black/25'
                    }`}
                  >
                    <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5 items-center">
                      <input
                        type="text"
                        value={seg.jp}
                        onChange={(e) =>
                          handleUpdateSegment(selectedLine, seg.id, {
                            jp: e.target.value,
                            altReadings: undefined,
                          })
                        }
                        title="일본어"
                        placeholder="원문"
                        className="min-w-0 rounded-md border border-transparent bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white placeholder:text-slate-600 focus:border-sky-400/50 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={seg.ruby}
                        onChange={(e) => {
                          const nextRuby = e.target.value;
                          const nextKoPron =
                            nextRuby.trim() || !/[\u4E00-\u9FFF々]/.test(seg.jp)
                              ? buildKoPronFromSegment(seg.jp, nextRuby)
                              : '';
                          handleUpdateSegment(selectedLine, seg.id, {
                            ruby: nextRuby,
                            koPron: nextKoPron,
                            rubySource: 'user',
                          });
                        }}
                        title="후리가나"
                        placeholder="후리가나"
                        className="min-w-0 rounded-md border border-transparent bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-sky-300 placeholder:text-slate-600 focus:border-sky-400/50 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={seg.koPron}
                        onChange={(e) =>
                          handleUpdateSegment(selectedLine, seg.id, { koPron: e.target.value })
                        }
                        title="한국어 발음"
                        placeholder="발음"
                        className="min-w-0 rounded-md border border-transparent bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-amber-200 placeholder:text-slate-600 focus:border-sky-400/50 focus:outline-none"
                      />
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => handleSplitSegment(selectedLine, sIdx)}
                          className="rounded p-1 text-slate-400 hover:bg-white/[0.08] hover:text-sky-300 transition"
                          title="청크 2개로 나누기"
                        >
                          <Scissors className="h-3 w-3" />
                        </button>
                        {selectedLine.segments.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSegment(selectedLine, sIdx)}
                            className="rounded p-1 text-slate-400 hover:bg-white/[0.08] hover:text-rose-400 transition"
                            title="청크 삭제"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Per-word highlight sync timing editor */}
                    <div className="flex items-center gap-1 px-0.5 pt-1 border-t border-white/[0.05] text-[10px]">
                      <button
                        type="button"
                        onClick={() => onSeek(seg.startTime)}
                        className="rounded p-1 text-sky-300 hover:bg-sky-500/20 transition shrink-0"
                        title="이 단어 위치로 이동"
                        aria-label="이 단어 위치로 이동"
                      >
                        <Play className="h-2.5 w-2.5 fill-current" />
                      </button>

                      <span className="text-[9.5px] text-slate-500 shrink-0">시작</span>
                      <TimingNumberInput
                        value={seg.startTime}
                        onCommit={(val) =>
                          handleUpdateSegmentTiming(selectedLine, sIdx, 'startTime', val)
                        }
                        ariaLabel="단어 시작(초)"
                        className="w-[62px] rounded border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[10px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSegmentTiming(
                            selectedLine,
                            sIdx,
                            'startTime',
                            currentTime
                          )
                        }
                        className="rounded p-1 text-sky-300 hover:bg-white/[0.08] transition shrink-0"
                        title="현재 재생 시간으로 단어 시작 설정"
                        aria-label="현재 재생 시간으로 단어 시작 설정"
                      >
                        <Clock className="h-3 w-3" />
                      </button>

                      <span className="text-slate-500">~</span>

                      <span className="text-[9.5px] text-slate-500 shrink-0">끝</span>
                      <TimingNumberInput
                        value={seg.endTime}
                        onCommit={(val) =>
                          handleUpdateSegmentTiming(selectedLine, sIdx, 'endTime', val)
                        }
                        ariaLabel="단어 끝(초)"
                        className="w-[62px] rounded border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[10px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSegmentTiming(
                            selectedLine,
                            sIdx,
                            'endTime',
                            currentTime
                          )
                        }
                        className="rounded p-1 text-sky-300 hover:bg-white/[0.08] transition shrink-0"
                        title="현재 재생 시간으로 단어 끝 설정"
                        aria-label="현재 재생 시간으로 단어 끝 설정"
                      >
                        <Clock className="h-3 w-3" />
                      </button>
                    </div>

                    {candidates.length >= 2 && (
                      <div className="flex flex-wrap items-center gap-1 px-1 pt-0.5 border-t border-white/[0.05]">
                        <span className="text-[9.5px] text-slate-500 mr-0.5">독음 후보</span>
                        {candidates.map((cand) => {
                          const isCurrent =
                            cand.ruby === seg.ruby.trim() ||
                            (Boolean(cand.koPron) && cand.koPron === seg.koPron.trim());
                          return (
                            <button
                              key={cand.ruby}
                              type="button"
                              onClick={() =>
                                handleUpdateSegment(selectedLine, seg.id, {
                                  ruby: cand.ruby,
                                  koPron: cand.koPron,
                                  rubySource: 'user',
                                })
                              }
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition border ${
                                isCurrent
                                  ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 font-semibold'
                                  : 'border-white/[0.08] bg-white/[0.04] text-slate-300 hover:bg-white/[0.1] hover:text-white'
                              }`}
                              title={`${cand.ruby} (${cand.koPron}) 적용`}
                            >
                              <span>{cand.ruby}</span>
                              <span className="text-[9.5px] text-amber-200/80">
                                {cand.koPron}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
