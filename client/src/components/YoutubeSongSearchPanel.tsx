import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Library,
  Loader2,
  Music,
  Search,
  Sparkles,
  X,
  Youtube,
} from 'lucide-react';
import type { KaraokeProject, LibrarySongSummary } from '@shared/types';
import { formatTime } from '@shared/timing';
import {
  importYoutubeWithProgress,
  searchYoutubeTracksApi,
  suggestSongsApi,
  type ResolvedSongInfo,
  type SongSuggestResponse,
  type YoutubeImportResult,
  type YoutubeSearchCandidate,
  type YoutubeThreeTrackSearchResult,
} from '../api';

type AudioSlotType = 'original' | 'mr' | 'karaoke';

const RECENT_SEARCHES_KEY = 'utakana_recent_song_queries_v1';

function loadRecentQueries(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function saveRecentQueries(list: string[]): void {
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    // ignore storage errors
  }
}

function formatViews(views?: number): string {
  if (typeof views !== 'number' || views <= 0) return '';
  if (views >= 100_000_000) return `${(views / 100_000_000).toFixed(1)}억`;
  if (views >= 10_000) {
    return views >= 100_000
      ? `${Math.round(views / 10_000)}만`
      : `${(views / 10_000).toFixed(1)}만`;
  }
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}천`;
  return `${views}`;
}

export interface YoutubeSongSearchPanelProps {
  project: KaraokeProject;
  initialQuery?: string;
  autoSearchNonce?: number;
  libraryItems: LibrarySongSummary[];
  onUpdateProject: React.Dispatch<React.SetStateAction<KaraokeProject>>;
  onYoutubeImported: (
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
  ) => Promise<void>;
  onMrAudioLoaded: (
    fileId: string,
    originalName: string,
    overrideAudioId?: string,
    overrideKeyShift?: number,
    youtubeVideoId?: string
  ) => Promise<void>;
  onKaraokeAudioLoaded: (
    fileId: string,
    originalName: string,
    overrideAudioId?: string,
    overrideKeyShift?: number,
    youtubeVideoId?: string
  ) => Promise<void>;
  onLoadLibrarySong: (song: LibrarySongSummary) => Promise<void>;
  onSwitchToLibrary: () => void;
  onBusyChange?: (busy: boolean) => void;
  onImportComplete?: () => void;
}

const EXAMPLE_SONGS = [
  'Overdose なとり',
  '밤을 달리다 요아소비',
  '높은 산의 하나코상',
  'Lemon 요네즈 켄시',
];

export function YoutubeSongSearchPanel({
  project,
  initialQuery = '',
  autoSearchNonce = 0,
  libraryItems,
  onUpdateProject,
  onYoutubeImported,
  onMrAudioLoaded,
  onKaraokeAudioLoaded,
  onLoadLibrarySong,
  onSwitchToLibrary,
  onBusyChange,
  onImportComplete,
}: YoutubeSongSearchPanelProps) {
  const defaultQuery =
    initialQuery.trim() ||
    (project.id !== 'demo_tobu_toki' &&
    project.title &&
    !project.title.includes('새 가라오케')
      ? `${project.title.replace(/\s*\([^)]*\)/g, '').replace(/\s*—.*$/, '').trim()} ${project.artist}`.trim()
      : '');

  const [songQuery, setSongQuery] = useState(defaultQuery);
  const [recentQueries, setRecentQueries] = useState<string[]>(loadRecentQueries);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestRes, setSuggestRes] = useState<SongSuggestResponse | null>(null);
  const suggestContainerRef = useRef<HTMLDivElement | null>(null);
  const skipNextSuggestRef = useRef<boolean>(false);
  const handledNonceRef = useRef<number>(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [ytSearching, setYtSearching] = useState(false);
  const [ytError, setYtError] = useState('');
  const [ytSearchRes, setYtSearchRes] =
    useState<YoutubeThreeTrackSearchResult | null>(null);
  const [pickedIds, setPickedIds] = useState<Record<AudioSlotType, string>>({
    original: '',
    mr: '',
    karaoke: '',
  });
  const [enabledSlots, setEnabledSlots] = useState<Record<AudioSlotType, boolean>>({
    original: true,
    mr: true,
    karaoke: true,
  });

  const [batchImporting, setBatchImporting] = useState(false);
  const [batchStatus, setBatchStatus] = useState('');
  const [batchPercent, setBatchPercent] = useState(0);
  const [loadingLibMatch, setLoadingLibMatch] = useState(false);

  const slotLabel = (slot: AudioSlotType) =>
    slot === 'original' ? '원곡' : slot === 'mr' ? 'MR' : '노래방';

  useEffect(() => {
    onBusyChange?.(batchImporting);
  }, [batchImporting, onBusyChange]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (
        suggestContainerRef.current &&
        !suggestContainerRef.current.contains(e.target as Node)
      ) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const recordRecentQuery = useCallback((q: string) => {
    const clean = q.trim();
    if (!clean) return;
    setRecentQueries((prev) => {
      const next = [clean, ...prev.filter((item) => item !== clean)].slice(0, 6);
      saveRecentQueries(next);
      return next;
    });
  }, []);

  const handleRemoveRecentQuery = (q: string) => {
    setRecentQueries((prev) => {
      const next = prev.filter((item) => item !== q);
      saveRecentQueries(next);
      return next;
    });
  };

  useEffect(() => {
    if (!suggestOpen) return;
    if (skipNextSuggestRef.current) {
      skipNextSuggestRef.current = false;
      return;
    }
    const q = songQuery.trim();
    if (q.length < 2) {
      setSuggestRes(null);
      setSuggestLoading(false);
      return;
    }
    let cancelled = false;
    setSuggestLoading(true);
    const timer = window.setTimeout(() => {
      suggestSongsApi(q)
        .then((res) => {
          if (!cancelled) setSuggestRes(res);
        })
        .catch(() => {
          if (!cancelled) setSuggestRes(null);
        })
        .finally(() => {
          if (!cancelled) setSuggestLoading(false);
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [songQuery, suggestOpen]);

  const handleSearchYoutube3Tracks = useCallback(
    async (
      e?: React.FormEvent,
      override?: { query: string; hints?: Partial<ResolvedSongInfo> }
    ) => {
      e?.preventDefault();
      const q = (override?.query ?? songQuery).trim();
      if (!q || ytSearching || batchImporting) return null;

      setSuggestOpen(false);
      recordRecentQuery(q);
      setYtSearching(true);
      setYtError('');
      try {
        const res = await searchYoutubeTracksApi(q, override?.hints);
        setYtSearchRes(res);
        setPickedIds({
          original:
            res.recommended.original?.videoId ?? res.candidates.original[0]?.videoId ?? '',
          mr: res.recommended.mr?.videoId ?? res.candidates.mr[0]?.videoId ?? '',
          karaoke:
            res.recommended.karaoke?.videoId ?? res.candidates.karaoke[0]?.videoId ?? '',
        });
        setEnabledSlots({
          original: Boolean(res.recommended.original ?? res.candidates.original[0]),
          mr: Boolean(res.recommended.mr ?? res.candidates.mr[0]),
          karaoke: Boolean(res.recommended.karaoke ?? res.candidates.karaoke[0]),
        });
        if (res.resolvedSong?.artworkUrl) {
          const hiResArt = res.resolvedSong.artworkUrl.replace('100x100bb', '600x600bb');
          onUpdateProject((prev) => ({
            ...prev,
            settings: {
              ...prev.settings,
              albumArtUrl: hiResArt,
            },
          }));
        }
        return res;
      } catch (err) {
        setYtError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setYtSearching(false);
      }
    },
    [batchImporting, onUpdateProject, recordRecentQuery, songQuery, ytSearching]
  );

  useEffect(() => {
    if (
      autoSearchNonce > 0 &&
      autoSearchNonce !== handledNonceRef.current &&
      initialQuery.trim()
    ) {
      handledNonceRef.current = autoSearchNonce;
      const q = initialQuery.trim();
      skipNextSuggestRef.current = true;
      setSongQuery(q);
      setSuggestOpen(false);
      void handleSearchYoutube3Tracks(undefined, { query: q });
    }
  }, [autoSearchNonce, initialQuery, handleSearchYoutube3Tracks]);

  const runBatchImportFromCandidates = async (
    origCand: YoutubeSearchCandidate | null,
    mrCand: YoutubeSearchCandidate | null,
    karaokeCand: YoutubeSearchCandidate | null,
    canonicalQueryOverride?: string
  ) => {
    const queue: Array<{ slot: AudioSlotType; cand: YoutubeSearchCandidate }> = [];
    if (origCand) queue.push({ slot: 'original', cand: origCand });
    if (mrCand) queue.push({ slot: 'mr', cand: mrCand });
    if (karaokeCand) queue.push({ slot: 'karaoke', cand: karaokeCand });

    if (queue.length === 0) {
      setYtError('가져올 YouTube 항목을 하나 이상 선택해 주세요.');
      return;
    }

    setBatchImporting(true);
    setYtError('');
    setBatchPercent(3);

    let importedOrigId = project.audioFileId;

    try {
      for (let i = 0; i < queue.length; i++) {
        const { slot, cand } = queue[i];
        const label = slotLabel(slot);
        const stepPrefix = `(${i + 1}/${queue.length}) ${label}`;
        setBatchStatus(`${stepPrefix}: "${cand.title}" 다운로드 준비 중...`);

        const result = await importYoutubeWithProgress(
          cand.url,
          'audio',
          (job) => {
            const overall = Math.round(((i + job.percent / 100) / queue.length) * 100);
            setBatchPercent(Math.max(4, Math.min(99, overall)));
            setBatchStatus(`${stepPrefix}: ${job.message}`);
          }
        );

        if (slot === 'original') {
          importedOrigId = result.media.id;
          await onYoutubeImported(result, 'audio', true, {
            autoTranslate: true,
            autoAlign: true,
            searchQueryOverride: canonicalQueryOverride,
            forceApplyLyrics: true,
            initialKeyShift: 0,
          });
        } else if (slot === 'mr') {
          setBatchStatus(`${stepPrefix}: 원곡과 MR 싱크 정렬 및 오디오 준비 중...`);
          await onMrAudioLoaded(
            result.media.id,
            result.media.originalName,
            importedOrigId,
            0,
            result.meta.videoId
          );
        } else {
          setBatchStatus(`${stepPrefix}: 원곡과 노래방 싱크 정렬 및 오디오 준비 중...`);
          await onKaraokeAudioLoaded(
            result.media.id,
            result.media.originalName,
            importedOrigId,
            0,
            result.meta.videoId
          );
        }
      }

      setBatchPercent(100);
      setBatchImporting(false);
      setBatchStatus('');
      onImportComplete?.();
    } catch (err) {
      setYtError(err instanceof Error ? err.message : String(err));
      setBatchImporting(false);
      setBatchStatus('');
    }
  };

  const handleImportPickedCandidates = async () => {
    if (!ytSearchRes) return;
    const findCand = (slot: AudioSlotType): YoutubeSearchCandidate | null => {
      if (!enabledSlots[slot]) return null;
      const vid = pickedIds[slot];
      return (
        ytSearchRes.candidates[slot].find((c) => c.videoId === vid) ??
        ytSearchRes.recommended[slot] ??
        ytSearchRes.candidates[slot][0] ??
        null
      );
    };
    await runBatchImportFromCandidates(
      findCand('original'),
      findCand('mr'),
      findCand('karaoke'),
      ytSearchRes.resolvedSong?.canonicalQuery
    );
  };

  const matchedLibrarySong = useMemo(() => {
    if (!libraryItems.length) return null;
    if (ytSearchRes) {
      const origIds = new Set<string>();
      if (pickedIds.original) origIds.add(pickedIds.original);
      if (ytSearchRes.recommended.original?.videoId) {
        origIds.add(ytSearchRes.recommended.original.videoId);
      }
      for (const c of ytSearchRes.candidates.original) {
        origIds.add(c.videoId);
      }
      const byVid = libraryItems.find((it) => origIds.has(it.youtubeVideoId));
      if (byVid) return byVid;

      const resolvedTitle = ytSearchRes.resolvedSong?.title?.trim().toLowerCase();
      if (resolvedTitle) {
        const byTitle = libraryItems.find(
          (it) => it.title.trim().toLowerCase() === resolvedTitle
        );
        if (byTitle) return byTitle;
      }
    }
    const cleanQ = songQuery.trim().toLowerCase();
    if (cleanQ.length >= 2) {
      const words = cleanQ.split(/\s+/).filter(Boolean);
      const byQuery = libraryItems.find((it) => {
        const hay = `${it.title} ${it.artist}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (byQuery) return byQuery;
    }
    return null;
  }, [libraryItems, pickedIds.original, songQuery, ytSearchRes]);

  const selectedOrigCand = ytSearchRes
    ? ytSearchRes.candidates.original.find((c) => c.videoId === pickedIds.original) ??
      ytSearchRes.recommended.original ??
      ytSearchRes.candidates.original[0]
    : null;
  const origDur = selectedOrigCand?.duration || ytSearchRes?.resolvedSong?.duration || 0;
  const selectedSlotsList = (['original', 'mr', 'karaoke'] as AudioSlotType[]).filter(
    (s) =>
      ytSearchRes &&
      enabledSlots[s] &&
      Boolean(pickedIds[s] || ytSearchRes.recommended[s] || ytSearchRes.candidates[s][0])
  );

  const slotAccent: Record<
    AudioSlotType,
    { label: string; border: string; badge: string; ring: string }
  > = {
    original: {
      label: '원곡 (Original)',
      border: 'border-sky-400/35',
      badge: 'bg-sky-500/20 text-sky-200 border-sky-400/30',
      ring: 'border-sky-400/50 bg-sky-500/[0.06]',
    },
    mr: {
      label: 'MR (반주)',
      border: 'border-violet-400/35',
      badge: 'bg-violet-500/20 text-violet-200 border-violet-400/30',
      ring: 'border-violet-400/50 bg-violet-500/[0.06]',
    },
    karaoke: {
      label: '노래방 (가이드)',
      border: 'border-amber-400/35',
      badge: 'bg-amber-500/20 text-amber-200 border-amber-400/30',
      ring: 'border-amber-400/50 bg-amber-500/[0.06]',
    },
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Top Clean Search Header */}
      <div className="border-b border-white/[0.07] bg-black/20 px-5 py-3.5 space-y-2.5 shrink-0">
        <form
          onSubmit={(e) => void handleSearchYoutube3Tracks(e)}
          className="flex flex-wrap items-center gap-2"
        >
          <div ref={suggestContainerRef} className="relative flex-1 min-w-[260px]">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={songQuery}
              onFocus={() => setSuggestOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSuggestOpen(false);
                }
              }}
              onChange={(e) => {
                setSongQuery(e.target.value);
                setSuggestOpen(true);
              }}
              placeholder="곡명 + 가수 검색 (예: 밤을 달리다 요아소비, Overdose なとり)"
              disabled={ytSearching || batchImporting}
              className="w-full rounded-xl border border-white/[0.1] bg-black/45 pl-9 pr-8 py-2 text-xs sm:text-[13px] text-slate-100 placeholder:text-slate-500 focus:border-sky-400/70 focus:outline-none disabled:opacity-60 transition"
            />
            {suggestLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-sky-400 absolute right-3 top-2.5 pointer-events-none" />
            )}

            {suggestOpen &&
              (suggestLoading ||
                (suggestRes &&
                  (suggestRes.tracks.length > 0 || suggestRes.keywords.length > 0))) && (
                <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border border-white/[0.12] bg-[#0b101d]/98 shadow-2xl backdrop-blur-md p-2 space-y-2">
                  {suggestRes && suggestRes.tracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="px-2 py-0.5 text-[10.5px] font-medium text-slate-500">
                        공식 음원 추천
                      </div>
                      {suggestRes.tracks.map((trk) => (
                        <button
                          key={`${trk.trackName}-${trk.artistName}`}
                          type="button"
                          onClick={() => {
                            skipNextSuggestRef.current = true;
                            setSongQuery(trk.query);
                            setSuggestOpen(false);
                            void handleSearchYoutube3Tracks(undefined, {
                              query: trk.query,
                              hints: {
                                title: trk.trackName,
                                artist: trk.artistName,
                                duration: trk.duration,
                                artworkUrl: trk.artworkUrl,
                                canonicalQuery: trk.query,
                              },
                            });
                          }}
                          className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.07] transition"
                        >
                          {trk.artworkUrl ? (
                            <img
                              src={trk.artworkUrl}
                              alt=""
                              className="h-9 w-9 rounded-md object-cover shrink-0 bg-black/40"
                            />
                          ) : (
                            <div className="h-9 w-9 rounded-md bg-white/[0.05] flex items-center justify-center shrink-0 text-slate-500">
                              <Music className="h-4 w-4" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold text-slate-100">
                              {trk.trackName}
                            </div>
                            <div className="truncate text-[10.5px] text-slate-400">
                              {trk.artistName}
                            </div>
                          </div>
                          {trk.duration > 0 && (
                            <span className="shrink-0 font-mono tabular-nums text-[10.5px] text-slate-500">
                              {formatTime(trk.duration)}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {suggestRes && suggestRes.keywords.length > 0 && (
                    <div className="space-y-1 border-t border-white/[0.06] pt-1.5">
                      <div className="px-2 text-[10.5px] font-medium text-slate-500">
                        연관 검색어
                      </div>
                      <div className="flex flex-wrap gap-1 px-1.5 pb-0.5">
                        {suggestRes.keywords.map((kw) => (
                          <button
                            key={kw}
                            type="button"
                            onClick={() => {
                              skipNextSuggestRef.current = true;
                              setSongQuery(kw);
                              setSuggestOpen(false);
                              void handleSearchYoutube3Tracks(undefined, { query: kw });
                            }}
                            className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 text-[10.5px] text-slate-300 hover:border-sky-400/50 hover:text-sky-200 transition"
                          >
                            {kw}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
          </div>

          <button
            type="submit"
            disabled={ytSearching || batchImporting || !songQuery.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition shadow-sm shadow-sky-500/20 shrink-0"
          >
            {ytSearching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            후보 검색
          </button>
        </form>

        {/* Recent Searches / Recommended Chips */}
        {(recentQueries.length > 0 || !ytSearchRes) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {recentQueries.length > 0 ? (
              <>
                <span className="text-[10.5px] text-slate-500 mr-0.5">최근:</span>
                {recentQueries.map((rq) => (
                  <span
                    key={rq}
                    className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/30 pl-2.5 pr-1.5 py-0.5 text-[10.5px] text-slate-300"
                  >
                    <button
                      type="button"
                      disabled={ytSearching || batchImporting}
                      onClick={() => {
                        skipNextSuggestRef.current = true;
                        setSongQuery(rq);
                        void handleSearchYoutube3Tracks(undefined, { query: rq });
                      }}
                      className="hover:text-sky-300 truncate max-w-[160px] transition"
                    >
                      {rq}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveRecentQuery(rq)}
                      className="text-slate-500 hover:text-rose-400 transition"
                      title="기록 삭제"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </>
            ) : (
              <>
                <span className="text-[10.5px] text-slate-500 mr-0.5">추천 검색:</span>
                {EXAMPLE_SONGS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={ytSearching || batchImporting}
                    onClick={() => {
                      skipNextSuggestRef.current = true;
                      setSongQuery(q);
                      setSuggestOpen(false);
                      void handleSearchYoutube3Tracks(undefined, { query: q });
                    }}
                    className="rounded-full border border-white/[0.08] bg-black/30 px-2.5 py-0.5 text-[10.5px] text-slate-300 hover:border-sky-400/50 hover:text-sky-200 transition"
                  >
                    {q}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {ytError && (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {ytError}
          </div>
        )}
      </div>

      {/* Main Content Area: Instant Library Match + 3-Column Video Picker or Empty State */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {matchedLibrarySong && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-400/35 bg-violet-500/10 px-4 py-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <Library className="h-4 w-4 text-violet-300 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-violet-100 truncate">
                  공유 라이브러리에 이미 분석된 곡이 있습니다: {matchedLibrarySong.title}
                  {matchedLibrarySong.artist ? ` — ${matchedLibrarySong.artist}` : ''}
                </div>
                <div className="text-[10.5px] text-violet-300/80">
                  v{matchedLibrarySong.revisionCount ?? 1} ·{' '}
                  {matchedLibrarySong.status === 'verified'
                    ? '✓ 검수 완료'
                    : matchedLibrarySong.status === 'edited'
                    ? '사용자 수정본'
                    : 'AI 자동 분석본'}{' '}
                  · {matchedLibrarySong.lineCount}소절 (GPU 재계산 없이 즉시 불러오기 가능)
                </div>
              </div>
            </div>
            <button
              type="button"
              disabled={loadingLibMatch || batchImporting}
              onClick={async () => {
                setLoadingLibMatch(true);
                try {
                  await onLoadLibrarySong(matchedLibrarySong);
                } finally {
                  setLoadingLibMatch(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-50 transition shrink-0"
            >
              {loadingLibMatch ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              라이브러리에서 바로 불러오기
            </button>
          </div>
        )}

        {ytSearching ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-300">
            <Loader2 className="h-7 w-7 animate-spin text-sky-400" />
            <div className="text-sm font-medium">
              원곡 · MR · 노래방 YouTube 영상 후보를 찾는 중...
            </div>
            <div className="text-xs text-slate-500">
              잠시만 기다리면 3개 트랙의 썸네일과 길이를 한눈에 비교해 드립니다.
            </div>
          </div>
        ) : ytSearchRes ? (
          <div className="space-y-4">
            {ytSearchRes.resolvedSong && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/25 bg-sky-500/[0.06] px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  {ytSearchRes.resolvedSong.artworkUrl ? (
                    <img
                      src={ytSearchRes.resolvedSong.artworkUrl}
                      alt=""
                      className="h-10 w-10 rounded-lg object-cover bg-black/40 shrink-0"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-lg bg-white/[0.06] flex items-center justify-center text-sky-300 shrink-0">
                      <Music className="h-5 w-5" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-[10.5px] font-medium text-sky-300">원제 인식 완료</div>
                    <div className="truncate text-sm font-semibold text-slate-100">
                      {ytSearchRes.resolvedSong.title}{' '}
                      <span className="font-normal text-slate-400">
                        — {ytSearchRes.resolvedSong.artist}
                      </span>
                    </div>
                  </div>
                </div>
                {ytSearchRes.resolvedSong.duration > 0 && (
                  <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
                    기준 길이 {formatTime(ytSearchRes.resolvedSong.duration)}
                  </span>
                )}
              </div>
            )}

            {/* Side-by-Side 3-Column Visual Video Picker */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
              {(['original', 'mr', 'karaoke'] as AudioSlotType[]).map((slot) => {
                const cands = ytSearchRes.candidates[slot];
                const activeCand =
                  cands.find((c) => c.videoId === pickedIds[slot]) ??
                  ytSearchRes.recommended[slot] ??
                  cands[0] ??
                  null;
                const otherCands = activeCand
                  ? cands.filter((c) => c.videoId !== activeCand.videoId)
                  : cands;
                const isEnabled = enabledSlots[slot];
                const accent = slotAccent[slot];

                const renderDiffPill = (cand: YoutubeSearchCandidate) => {
                  if (slot === 'original' || origDur <= 0 || cand.duration <= 0) {
                    return null;
                  }
                  const diff = cand.duration - origDur;
                  const absDiff = Math.abs(diff);
                  const text =
                    absDiff <= 1 ? '길이 동일' : `${diff > 0 ? '+' : ''}${diff}초`;
                  const cls =
                    absDiff <= 6
                      ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                      : 'border-amber-400/30 bg-amber-500/15 text-amber-300';
                  return (
                    <span className={`rounded border px-1.5 py-0 text-[9.5px] tabular-nums ${cls}`}>
                      {text}
                    </span>
                  );
                };

                return (
                  <div
                    key={slot}
                    className={`flex flex-col rounded-xl border bg-black/30 p-3 space-y-2.5 transition ${
                      isEnabled ? accent.border : 'border-white/[0.06] opacity-55'
                    }`}
                  >
                    {/* Column Header */}
                    <div className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          disabled={batchImporting || !activeCand}
                          onChange={(e) =>
                            setEnabledSlots((p) => ({ ...p, [slot]: e.target.checked }))
                          }
                        />
                        <span className="text-xs font-bold text-slate-100">{accent.label}</span>
                      </label>
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        후보 {cands.length}
                      </span>
                    </div>

                    {/* Featured Selected Video */}
                    {activeCand ? (
                      <div className={`rounded-lg border p-2 space-y-2 ${accent.ring}`}>
                        <div
                          data-keep-dark="true"
                          className="relative aspect-video w-full overflow-hidden rounded-md bg-black/60"
                        >
                          {activeCand.thumbnail ? (
                            <img
                              src={activeCand.thumbnail}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-slate-600">
                              <Youtube className="h-8 w-8" />
                            </div>
                          )}
                          <span className="absolute left-1.5 top-1.5 rounded border border-sky-400/40 bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200 backdrop-blur-sm">
                            선택됨 ✓
                          </span>
                          <a
                            href={activeCand.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-1.5 top-1.5 rounded bg-black/75 p-1 text-white hover:text-sky-300 transition"
                            title="YouTube에서 새 탭으로 미리보기"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          {activeCand.duration > 0 && (
                            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white tabular-nums">
                              {formatTime(activeCand.duration)}
                            </span>
                          )}
                        </div>

                        <div className="space-y-1">
                          <div className="line-clamp-2 text-[11.5px] font-semibold leading-snug text-slate-100 min-h-[2rem]">
                            {activeCand.title}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
                            <span className="truncate max-w-[130px]">
                              {activeCand.channel || 'YouTube'}
                            </span>
                            {formatViews(activeCand.viewCount) && (
                              <span>· 조회 {formatViews(activeCand.viewCount)}</span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {renderDiffPill(activeCand)}
                            {(activeCand.badges ?? []).map((b) => (
                              <span
                                key={b}
                                className="rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-0 text-[9.5px] text-slate-200"
                              >
                                {b}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-white/[0.08] text-xs text-slate-500">
                        검색된 {slotLabel(slot)} 후보 없음
                      </div>
                    )}

                    {/* Always-Visible Other Candidates List */}
                    {otherCands.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-medium text-slate-400">
                          다른 영상 후보 (클릭하여 교체)
                        </div>
                        <div className="max-h-52 overflow-y-auto space-y-1.5 pr-0.5">
                          {otherCands.map((cand) => (
                            <button
                              key={cand.videoId}
                              type="button"
                              disabled={batchImporting}
                              onClick={() => {
                                setPickedIds((p) => ({ ...p, [slot]: cand.videoId }));
                                setEnabledSlots((p) => ({ ...p, [slot]: true }));
                              }}
                              className="w-full flex items-start gap-2 rounded-lg border border-white/[0.07] bg-black/35 p-1.5 text-left hover:border-sky-400/45 hover:bg-white/[0.05] transition"
                            >
                              <div
                                data-keep-dark="true"
                                className="relative h-11 w-20 rounded overflow-hidden bg-black/50 shrink-0"
                              >
                                {cand.thumbnail ? (
                                  <img
                                    src={cand.thumbnail}
                                    alt=""
                                    className="h-full w-full object-cover"
                                  />
                                ) : null}
                                {cand.duration > 0 && (
                                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 py-0 font-mono text-[9px] text-white tabular-nums">
                                    {formatTime(cand.duration)}
                                  </span>
                                )}
                              </div>
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="line-clamp-2 text-[10.5px] font-medium leading-tight text-slate-200">
                                  {cand.title}
                                </div>
                                <div className="flex flex-wrap items-center gap-1 text-[9.5px] text-slate-400">
                                  <span className="truncate max-w-[95px]">
                                    {cand.channel || 'YouTube'}
                                  </span>
                                  {formatViews(cand.viewCount) && (
                                    <span>· {formatViews(cand.viewCount)}</span>
                                  )}
                                  {renderDiffPill(cand)}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-5">
            <div className="max-w-lg space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-100">
                원하는 곡을 검색하고, 원곡 · MR · 노래방 영상을 한눈에 고르세요
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                검색어만 입력하고 <strong className="text-sky-300">후보 검색</strong>을
                누르면 3가지 트랙의 YouTube 썸네일과 영상 길이를 비교해 고를 수 있습니다.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-3xl text-left">
              {[
                {
                  title: '1. 3트랙 동시 검색',
                  desc: '원곡·반주(MR)·가이드 보컬(노래방) 후보 영상을 3열 화면에서 썸네일과 함께 비교합니다.',
                  tone: 'border-sky-400/25 bg-sky-500/[0.05]',
                },
                {
                  title: '2. 길이 차이 자동 표시',
                  desc: '원곡과 싱크가 어긋나는 다른 버전은 +초 차이 배지로 미리 걸러낼 수 있습니다.',
                  tone: 'border-violet-400/25 bg-violet-500/[0.05]',
                },
                {
                  title: '3. 가사·번역·싱크 일괄 적용',
                  desc: '4분 곡 기준 AI 싱크 약 30~45초(RTX 3060) · 약 10~15초(RTX 5090) 소요 (라이브러리 곡은 즉시 로드).',
                  tone: 'border-emerald-400/25 bg-emerald-500/[0.05]',
                },
              ].map((card) => (
                <div
                  key={card.title}
                  className={`rounded-xl border p-3.5 space-y-1 ${card.tone}`}
                >
                  <div className="text-xs font-semibold text-slate-100">{card.title}</div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{card.desc}</p>
                </div>
              ))}
            </div>

            {libraryItems.length > 0 && (
              <button
                type="button"
                onClick={onSwitchToLibrary}
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-500/15 px-3.5 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 transition"
              >
                <Library className="h-3.5 w-3.5" />
                공유 라이브러리 {libraryItems.length}곡 먼저 둘러보기
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Import Action / Progress Bar */}
      {(batchImporting || ytSearchRes) && (
        <div className="border-t border-white/[0.08] bg-[#0a0f1c] px-5 py-3 shrink-0">
          {batchImporting ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs text-sky-200">
                <span className="truncate font-medium">{batchStatus}</span>
                <span className="font-mono tabular-nums shrink-0">{batchPercent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full bg-sky-400 transition-all duration-200"
                  style={{ width: `${batchPercent}%` }}
                />
              </div>
              <div className="text-[10.5px] text-slate-400 flex items-center gap-1.5">
                <Cpu className="h-3 w-3 text-sky-400 shrink-0" />
                <span>
                  예상 AI 작업 시간 (4분 곡 기준): RTX 3060 약 30~45초 · RTX 5090 약 10~15초 (최초 1회 모델 다운로드 제외)
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <span className="text-slate-400">선택된 트랙:</span>
                  {selectedSlotsList.length > 0 ? (
                    selectedSlotsList.map((s) => (
                      <span
                        key={s}
                        className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${slotAccent[s].badge}`}
                      >
                        {slotLabel(s)} ✓
                      </span>
                    ))
                  ) : (
                    <span className="text-amber-300">가져올 트랙을 하나 이상 선택하세요</span>
                  )}
                </div>
                <div className="text-[10.5px] text-slate-400 flex items-center gap-1.5">
                  <Cpu className="h-3 w-3 text-sky-400 shrink-0" />
                  <span>
                    AI 싱크 예상 (4분 곡): RTX 3060 약 30~45초 · RTX 5090 약 10~15초
                  </span>
                </div>
              </div>

              <button
                type="button"
                disabled={selectedSlotsList.length === 0}
                onClick={() => void handleImportPickedCandidates()}
                className="inline-flex items-center gap-2 rounded-xl bg-sky-500 px-5 py-2 text-xs font-bold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition shadow-md shadow-sky-500/20"
              >
                <CheckCircle2 className="h-4 w-4" />
                {`선택한 ${selectedSlotsList.length}종 가져오기`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
