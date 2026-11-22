import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  Flag,
  History,
  Library,
  Loader2,
  Lock,
  Monitor,
  Music2,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Shield,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type {
  KaraokeProject,
  LibraryQualityStatus,
  LibraryReportReason,
  LibrarySongSummary,
} from '@shared/types';
import { formatTime } from '@shared/timing';
import type { YoutubeImportResult } from '../api';
import {
  activateLibraryRevision,
  ADMIN_CHANGE_EVENT,
  deleteLibrarySong,
  getLikedSongIds,
  getSavedContributorName,
  isAdminSessionActive,
  listLibraryRevisions,
  listLibrarySongs,
  moderateLibrarySong,
  reportLibrarySong,
  saveContributorName,
  upvoteLibrarySong,
  type LibraryFilterType,
  type LibraryModerateAction,
  type LibraryRevisionsResponse,
  type LibrarySortType,
  type PublishSongOptions,
  type PublishSongResult,
} from '../services/communityDb';
import { YoutubeSongSearchPanel } from './YoutubeSongSearchPanel';

interface SongLibraryModalProps {
  open: boolean;
  isMobile?: boolean;
  initialTab?: 'search' | 'library';
  initialPublishOpen?: boolean;
  initialSearchQuery?: string;
  initialSearchNonce?: number;
  project: KaraokeProject;
  workerConnected: boolean;
  libraryVersion: number;
  loadingVideoId: string | null;
  loadingStatus: string;
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
  onLoadSong: (song: LibrarySongSummary, revId?: string) => Promise<void>;
  onPublishCurrentSong: (opts?: PublishSongOptions) => Promise<PublishSongResult>;
  onLibraryChanged?: () => void;
  onOpenWorkerModal?: () => void;
  onClose: () => void;
}

const LIB_GUIDE_COLLAPSED_KEY = 'lyriko_lib_guide_collapsed_v1';

const EDIT_NOTE_CHIPS = [
  '싱크 보정',
  '발음·독음 교정',
  '번역 다듬기',
  'MR·노래방 추가',
] as const;

const REPORT_REASONS: Array<{ id: LibraryReportReason; label: string }> = [
  { id: 'sync', label: '싱크 밀림' },
  { id: 'pronunciation', label: '발음·독음 오류' },
  { id: 'lyrics', label: '가사 불일치' },
  { id: 'other', label: '기타' },
];

function StatusBadge({
  status,
  locked,
  compact = false,
}: {
  status: LibraryQualityStatus;
  locked?: boolean;
  compact?: boolean;
}) {
  if (status === 'verified') {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded font-semibold ${
          compact ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-1.5 py-0.5 text-[10px]'
        } bg-emerald-500/20 text-emerald-300 border border-emerald-400/25`}
      >
        <ShieldCheck className="h-2.5 w-2.5" />
        ✓ 검수 완료
        {locked && <Lock className="h-2.5 w-2.5 text-emerald-200/90" />}
      </span>
    );
  }
  if (status === 'edited') {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded font-semibold ${
          compact ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-1.5 py-0.5 text-[10px]'
        } bg-violet-500/20 text-violet-200 border border-violet-400/25`}
      >
        <PencilLine className="h-2.5 w-2.5" />
        사용자 수정
        {locked && <Lock className="h-2.5 w-2.5 text-amber-300" />}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${
        compact ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-1.5 py-0.5 text-[10px]'
      } bg-sky-500/15 text-sky-300 border border-sky-400/20`}
    >
      AI 자동
      {locked && <Lock className="h-2.5 w-2.5 text-amber-300" />}
    </span>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}.${dd} ${hh}:${mi}`;
}

export function SongLibraryModal({
  open,
  isMobile = false,
  initialTab = 'library',
  initialPublishOpen = false,
  initialSearchQuery = '',
  initialSearchNonce = 0,
  project,
  workerConnected,
  libraryVersion,
  loadingVideoId,
  loadingStatus,
  onUpdateProject,
  onYoutubeImported,
  onMrAudioLoaded,
  onKaraokeAudioLoaded,
  onLoadSong,
  onPublishCurrentSong,
  onLibraryChanged,
  onOpenWorkerModal,
  onClose,
}: SongLibraryModalProps) {
  const [activeTab, setActiveTab] = useState<'search' | 'library'>(initialTab);
  const [searchBusy, setSearchBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySortType>('recommended');
  const [filter, setFilter] = useState<LibraryFilterType>('all');
  const [items, setItems] = useState<LibrarySongSummary[]>([]);
  const [catalogItems, setCatalogItems] = useState<LibrarySongSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [reportedCount, setReportedCount] = useState(0);
  const [provider, setProvider] = useState<'supabase' | 'local-server' | 'local-cache'>(
    'local-server'
  );
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  // Publish composer drawer
  const [publishOpen, setPublishOpen] = useState(false);
  const [authorInput, setAuthorInput] = useState(() => getSavedContributorName());
  const [editNoteInput, setEditNoteInput] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [guideCollapsed, setGuideCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LIB_GUIDE_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleGuideCollapsed = () => {
    setGuideCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(LIB_GUIDE_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignore storage failure
      }
      return next;
    });
  };

  // Revision history drawer per song
  const [expandedRevVid, setExpandedRevVid] = useState<string | null>(null);
  const [revLoadingVid, setRevLoadingVid] = useState<string | null>(null);
  const [revisionsByVid, setRevisionsByVid] = useState<
    Record<string, LibraryRevisionsResponse>
  >({});
  const [activatingRevId, setActivatingRevId] = useState<string | null>(null);

  // Report drawer per song
  const [reportOpenVid, setReportOpenVid] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<LibraryReportReason>('sync');
  const [reportNote, setReportNote] = useState('');
  const [reporting, setReporting] = useState(false);

  // Curator / Admin mode
  const [isAdmin, setIsAdmin] = useState<boolean>(() => isAdminSessionActive());
  const [manageMode, setManageMode] = useState(false);
  const [moderatingVid, setModeratingVid] = useState<string | null>(null);
  const [confirmDeleteVid, setConfirmDeleteVid] = useState<string | null>(null);
  const [likedVids, setLikedVids] = useState<Set<string>>(() => new Set(getLikedSongIds()));
  const [votingVid, setVotingVid] = useState<string | null>(null);

  useEffect(() => {
    const syncAdmin = () => {
      const active = isAdminSessionActive();
      setIsAdmin(active);
      if (!active) setManageMode(false);
    };
    window.addEventListener(ADMIN_CHANGE_EVENT, syncAdmin);
    return () => window.removeEventListener(ADMIN_CHANGE_EVENT, syncAdmin);
  }, []);

  const fetchCatalog = useCallback(async () => {
    const res = await listLibrarySongs({ sort: 'recommended', limit: 100 });
    setCatalogItems(res.items);
    setCatalogTotal(res.total);
    setReportedCount(res.reportedCount);
    setProvider(res.provider);
  }, []);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listLibrarySongs({
        query,
        sort,
        filter,
        includeHidden: manageMode || filter === 'reported',
        limit: 80,
      });
      setItems(res.items);
      setTotal(res.total);
      setReportedCount(res.reportedCount);
      setProvider(res.provider);
    } finally {
      setLoading(false);
    }
  }, [filter, manageMode, query, sort]);

  useEffect(() => {
    if (!open) return;
    void fetchCatalog();
  }, [open, libraryVersion, fetchCatalog]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      void fetchList();
    }, 90);
    return () => window.clearTimeout(t);
  }, [open, libraryVersion, fetchList]);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      setNotice('');
      setPublishOpen(initialPublishOpen);
      setAuthorInput(getSavedContributorName());
      setEditNoteInput('');
      setConfirmDeleteVid(null);
      setLikedVids(new Set(getLikedSongIds()));
      const activeAdmin = isAdminSessionActive();
      setIsAdmin(activeAdmin);
      if (!activeAdmin) setManageMode(false);
    } else {
      setExpandedRevVid(null);
      setReportOpenVid(null);
      setSearchBusy(false);
    }
  }, [open, initialTab, initialPublishOpen]);

  const existingForProject = useMemo(
    () =>
      project.youtubeVideoId
        ? catalogItems.find((it) => it.youtubeVideoId === project.youtubeVideoId)
        : undefined,
    [catalogItems, project.youtubeVideoId]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !searchBusy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, searchBusy, onClose]);

  if (!open) return null;

  const canPublish = Boolean(project.youtubeVideoId && project.lines.length > 0);
  const providerLabel =
    provider === 'supabase'
      ? 'Supabase 공용 DB'
      : provider === 'local-server'
      ? '로컬 라이브러리 DB'
      : '브라우저 캐시';

  const loadRevisionsFor = async (vid: string) => {
    setRevLoadingVid(vid);
    try {
      const detail = await listLibraryRevisions(vid);
      if (detail) {
        setRevisionsByVid((prev) => ({ ...prev, [vid]: detail }));
      }
    } finally {
      setRevLoadingVid(null);
    }
  };

  const handleToggleRevisions = async (vid: string) => {
    if (expandedRevVid === vid) {
      setExpandedRevVid(null);
      return;
    }
    setReportOpenVid(null);
    setExpandedRevVid(vid);
    await loadRevisionsFor(vid);
  };

  const handleToggleQuickChip = (chip: string) => {
    setEditNoteInput((prev) => {
      const parts = prev
        .split('·')
        .map((s) => s.trim())
        .filter(Boolean);
      const exists = parts.includes(chip);
      const next = exists ? parts.filter((p) => p !== chip) : [...parts, chip];
      return next.join(' · ');
    });
  };

  const handlePublish = async () => {
    setPublishing(true);
    setNotice('');
    try {
      const cleanAuthor = authorInput.trim();
      if (cleanAuthor) {
        saveContributorName(cleanAuthor);
      }
      const res = await onPublishCurrentSong({
        authorName: cleanAuthor || undefined,
        editNote: editNoteInput.trim() || undefined,
      });
      if (res.ok) {
        if (res.pendingSuggestion) {
          setNotice(
            `검수 잠금 곡입니다. 수정 제안(v${res.version ?? ''})으로 안전하게 등록되었습니다.`
          );
        } else {
          setNotice(
            res.version && res.version > 1
              ? `수정본 v${res.version}이 라이브러리에 등록되었습니다. (이전 버전 보존됨)`
              : res.savedTo === 'supabase'
              ? 'Supabase 공용 라이브러리에 새 곡으로 등록했습니다.'
              : '공유 라이브러리에 현재 곡을 등록했습니다.'
          );
        }
        setPublishOpen(false);
        setEditNoteInput('');
        await Promise.all([fetchList(), fetchCatalog()]);
        if (project.youtubeVideoId && expandedRevVid === project.youtubeVideoId) {
          await loadRevisionsFor(project.youtubeVideoId);
        }
      } else {
        setNotice(res.error || '라이브러리 등록에 실패했습니다.');
      }
    } finally {
      setPublishing(false);
    }
  };

  const handleLoadAndClose = async (song: LibrarySongSummary, revId?: string) => {
    await onLoadSong(song, revId);
    onClose();
  };

  const handleUpvote = async (vid: string) => {
    if (votingVid === vid) return;
    setVotingVid(vid);
    try {
      const result = await upvoteLibrarySong(vid);
      if (result) {
        setItems((prev) =>
          prev.map((it) =>
            it.youtubeVideoId === vid ? { ...it, upvotes: result.upvotes } : it
          )
        );
        setCatalogItems((prev) =>
          prev.map((it) =>
            it.youtubeVideoId === vid ? { ...it, upvotes: result.upvotes } : it
          )
        );
        setLikedVids((prev) => {
          const next = new Set(prev);
          if (result.voted) next.add(vid);
          else next.delete(vid);
          return next;
        });
      }
    } finally {
      setVotingVid(null);
    }
  };

  const handleActivateRevision = async (vid: string, revId: string, version: number) => {
    setActivatingRevId(revId);
    setNotice('');
    try {
      const res = await activateLibraryRevision(vid, revId);
      if (res.ok) {
        setNotice(`대표 버전을 v${version}(으)로 전환했습니다.`);
        await Promise.all([fetchList(), fetchCatalog(), loadRevisionsFor(vid)]);
        onLibraryChanged?.();
      } else {
        setNotice(res.error || '버전 전환에 실패했습니다.');
      }
    } finally {
      setActivatingRevId(null);
    }
  };

  const handleSubmitReport = async (vid: string) => {
    setReporting(true);
    setNotice('');
    try {
      const res = await reportLibrarySong(vid, reportReason, reportNote);
      if (res.ok) {
        setNotice(
          res.hidden
            ? '신고가 누적되어 해당 곡이 자동으로 숨김 처리되었습니다.'
            : '오류 신고가 접수되었습니다. 감사합니다.'
        );
        setReportOpenVid(null);
        setReportNote('');
        await Promise.all([fetchList(), fetchCatalog()]);
        onLibraryChanged?.();
      }
    } finally {
      setReporting(false);
    }
  };

  const handleModerate = async (vid: string, action: LibraryModerateAction) => {
    setModeratingVid(vid);
    setNotice('');
    try {
      const res = await moderateLibrarySong(vid, action);
      if (res.ok) {
        const msgMap: Record<LibraryModerateAction, string> = {
          verify: '✓ 검수 완료 및 수정 잠금을 적용했습니다.',
          unverify: '검수·잠금을 해제했습니다.',
          lock: '수정 잠금을 활성화했습니다.',
          unlock: '수정 잠금을 해제했습니다.',
          dismiss_reports: '신고 내역을 초기화하고 정상 복구했습니다.',
          restore: '숨김 해제를 완료했습니다.',
        };
        setNotice(msgMap[action]);
        await Promise.all([fetchList(), fetchCatalog()]);
        if (expandedRevVid === vid) {
          await loadRevisionsFor(vid);
        }
        onLibraryChanged?.();
      } else {
        setNotice(res.error || '관리 권한이 없거나 작업에 실패했습니다.');
      }
    } finally {
      setModeratingVid(null);
    }
  };

  const handleDeleteSong = async (vid: string) => {
    setModeratingVid(vid);
    try {
      const ok = await deleteLibrarySong(vid);
      if (ok) {
        setNotice('라이브러리에서 곡을 삭제했습니다.');
        setConfirmDeleteVid(null);
        await Promise.all([fetchList(), fetchCatalog()]);
        onLibraryChanged?.();
      } else {
        setNotice('관리자 권한이 없거나 삭제에 실패했습니다.');
      }
    } finally {
      setModeratingVid(null);
    }
  };

  const libraryHeaderCount = filter === 'all' && !query ? total : catalogTotal;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !searchBusy) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col rounded-2xl border border-white/[0.1] bg-[#0d1322] shadow-2xl overflow-hidden">
        {/* Header with 2-Tab Switcher */}
        <div className="flex items-center justify-between gap-2 sm:gap-3 border-b border-white/[0.07] px-3.5 sm:px-5 py-2.5 sm:py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="inline-flex rounded-xl border border-white/[0.08] bg-black/40 p-1 gap-1">
              {isMobile ? (
                <>
                  <button
                    type="button"
                    disabled={searchBusy}
                    onClick={() => setActiveTab('library')}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-45 whitespace-nowrap ${
                      activeTab === 'library'
                        ? 'bg-violet-500/20 text-violet-200 border border-violet-400/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <Library className="h-3.5 w-3.5 shrink-0" />
                    <span>공유 라이브러리</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 font-mono text-[10px] text-slate-200">
                      {libraryHeaderCount}곡
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('search')}
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      activeTab === 'search'
                        ? 'bg-sky-500/20 text-sky-200 border border-sky-400/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <Search className="h-3.5 w-3.5 shrink-0" />
                    <span>새 곡 추가 (PC)</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setActiveTab('search')}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'search'
                        ? 'bg-sky-500/20 text-sky-200 border border-sky-400/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <Search className="h-3.5 w-3.5" />
                    <span>새 곡 검색</span>
                  </button>

                  <button
                    type="button"
                    disabled={searchBusy}
                    onClick={() => setActiveTab('library')}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-45 ${
                      activeTab === 'library'
                        ? 'bg-violet-500/20 text-violet-200 border border-violet-400/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <Library className="h-3.5 w-3.5" />
                    <span>공유 라이브러리</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 font-mono text-[10px] text-slate-200">
                      {libraryHeaderCount}곡
                    </span>
                  </button>
                </>
              )}
            </div>

            <span className="hidden md:inline-flex items-center gap-1 rounded-full border border-violet-400/25 bg-violet-500/10 px-2.5 py-0.5 text-[10.5px] font-medium text-violet-200 shrink-0">
              <Database className="h-3 w-3" />
              {providerLabel}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!isMobile && activeTab === 'library' && isAdmin && (
              <button
                type="button"
                onClick={() => setManageMode((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  manageMode
                    ? 'border-amber-400/50 bg-amber-500/20 text-amber-200'
                    : 'border-white/[0.09] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
                }`}
                title="검수 완료·잠금·버전 복구·삭제 관리 도구를 엽니다"
              >
                <Shield className="h-3.5 w-3.5" />
                <span>관리</span>
                {reportedCount > 0 && (
                  <span className="rounded-full bg-rose-500 px-1.5 py-0.2 font-mono text-[9.5px] font-bold text-white">
                    {reportedCount}
                  </span>
                )}
              </button>
            )}

            {!isMobile && (
              <button
                type="button"
                disabled={!canPublish || publishing || searchBusy}
                onClick={() => {
                  if (activeTab !== 'library') {
                    setActiveTab('library');
                    setPublishOpen(true);
                  } else {
                    setPublishOpen((v) => !v);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
                title={
                  canPublish
                    ? '현재 다듬은 가사·싱크·독음·번역을 라이브러리에 새 버전으로 올려 커뮤니티에 기여합니다'
                    : '공유 라이브러리 또는 YouTube에서 곡을 불러온 뒤 공유할 수 있습니다'
                }
              >
                <Share2 className="h-3.5 w-3.5" />
                {existingForProject ? '수정본 올리기' : '현재 곡 공유'}
              </button>
            )}

            <button
              type="button"
              disabled={searchBusy}
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.08] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed transition"
              title={searchBusy ? '가져오기가 끝난 후 닫을 수 있습니다' : '닫기'}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          className={
            activeTab === 'search' ? 'flex flex-1 min-h-0 flex-col' : 'hidden'
          }
        >
          <YoutubeSongSearchPanel
            project={project}
            initialQuery={initialSearchQuery}
            autoSearchNonce={initialSearchNonce}
            libraryItems={catalogItems}
            onUpdateProject={onUpdateProject}
            onYoutubeImported={onYoutubeImported}
            onMrAudioLoaded={onMrAudioLoaded}
            onKaraokeAudioLoaded={onKaraokeAudioLoaded}
            onLoadLibrarySong={(song) => handleLoadAndClose(song)}
            onSwitchToLibrary={() => setActiveTab('library')}
            workerConnected={workerConnected}
            isMobile={isMobile}
            onOpenWorkerModal={onOpenWorkerModal}
            onBusyChange={setSearchBusy}
            onImportComplete={onClose}
          />
        </div>

        {activeTab === 'library' && (
          <>
            {/* Inline Publish Composer Drawer */}
            {publishOpen && canPublish && (
              <div className="border-b border-violet-400/25 bg-violet-950/25 px-5 py-3.5 space-y-2.5 shrink-0 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-violet-100 truncate">
                      {project.title} — {project.artist || '아티스트 미상'}
                    </span>
                    <span className="text-[10.5px] text-slate-400 shrink-0">
                      ({project.lines.length}소절
                      {project.mrYoutubeId ? ' · MR' : ''}
                      {project.karaokeYoutubeId ? ' · 노래방' : ''})
                    </span>
                  </div>

                  {!existingForProject ? (
                    <span className="rounded-full border border-sky-400/30 bg-sky-500/15 px-2.5 py-0.5 text-[10.5px] font-medium text-sky-200">
                      신규 곡으로 라이브러리에 등록됩니다
                    </span>
                  ) : existingForProject.locked ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/15 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-200">
                      <Lock className="h-3 w-3" />
                      검수 잠금 곡 · 수정 제안(v{(existingForProject.revisionCount ?? 1) + 1}
                      )으로 등록 (기존 대표본 유지)
                    </span>
                  ) : (
                    <span className="rounded-full border border-violet-400/35 bg-violet-500/15 px-2.5 py-0.5 text-[10.5px] font-medium text-violet-200">
                      새 버전 v{(existingForProject.revisionCount ?? 1) + 1} 등록 (이전 버전
                      보존)
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-slate-300 leading-relaxed">
                  {existingForProject
                    ? '다듬어 주신 싱크·발음·번역은 새 버전으로 기록되어 모든 사용자가 더 정확한 가사로 함께 즐길 수 있습니다.'
                    : '이 곡을 공유 라이브러리에 등록하면 다른 사용자도 AI 분석 대기 없이 바로 감상하고 함께 다듬을 수 있습니다.'}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-2">
                  <input
                    type="text"
                    value={authorInput}
                    onChange={(e) => setAuthorInput(e.target.value)}
                    maxLength={32}
                    placeholder="닉네임 (예: 우타카나)"
                    className="rounded-lg border border-white/[0.1] bg-black/40 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-violet-400/60 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={editNoteInput}
                    onChange={(e) => setEditNoteInput(e.target.value)}
                    maxLength={120}
                    placeholder="수정 메모 (예: 2분 구간 싱크·다중독음 교정)"
                    className="rounded-lg border border-white/[0.1] bg-black/40 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-violet-400/60 focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] text-slate-400 mr-0.5">빠른 태그:</span>
                    {EDIT_NOTE_CHIPS.map((chip) => {
                      const active = editNoteInput.includes(chip);
                      return (
                        <button
                          key={chip}
                          type="button"
                          onClick={() => handleToggleQuickChip(chip)}
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition ${
                            active
                              ? 'border-violet-400/50 bg-violet-500/25 text-violet-100'
                              : 'border-white/[0.09] bg-black/30 text-slate-300 hover:border-violet-400/35'
                          }`}
                        >
                          {active ? '✓ ' : '+ '}
                          {chip}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setPublishOpen(false)}
                      className="rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.08] transition"
                    >
                      닫기
                    </button>
                    <button
                      type="button"
                      disabled={publishing}
                      onClick={() => void handlePublish()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-400 disabled:opacity-50 transition"
                    >
                      {publishing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      등록하기
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Collapsible Shared Library & Contribution Guide (Desktop) */}
            {!isMobile && (
              <div className="border-b border-violet-400/20 bg-violet-950/25 shrink-0">
                {guideCollapsed ? (
                  <div className="px-5 py-2 flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2 min-w-0 text-slate-200">
                      <BookOpen className="h-3.5 w-3.5 text-violet-300 shrink-0" />
                      <span className="truncate">
                        공유 라이브러리: 모두가 함께 가사·발음·싱크를 다듬어 가는 공동 저장소 (수정본을 올려 기여할 수 있습니다)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={toggleGuideCollapsed}
                      className="inline-flex items-center gap-1 rounded-md border border-violet-400/30 bg-white/[0.04] px-2.5 py-0.5 text-[10.5px] font-semibold text-violet-200 hover:bg-violet-500/20 transition shrink-0"
                    >
                      <span>기여 방법 보기</span>
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <div className="px-5 py-3 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <BookOpen className="h-3.5 w-3.5 text-violet-300 shrink-0" />
                        <span className="font-semibold text-slate-100">
                          함께 만드는 공유 라이브러리 · 수정본 기여 안내
                        </span>
                        <span className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 shrink-0">
                          로컬 워커 없이도 기여 가능
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {canPublish && !publishOpen && (
                          <button
                            type="button"
                            onClick={() => setPublishOpen(true)}
                            className="inline-flex items-center gap-1 rounded-md border border-violet-400/35 bg-violet-500/20 px-2.5 py-0.5 text-[10.5px] font-semibold text-violet-200 hover:bg-violet-500/30 transition"
                          >
                            <Share2 className="h-3 w-3" />
                            <span>{existingForProject ? '수정본 올리기 열기' : '현재 곡 공유 열기'}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={toggleGuideCollapsed}
                          className="inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10.5px] font-medium text-slate-300 hover:bg-white/[0.09] transition"
                        >
                          <span>접기</span>
                          <ChevronUp className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                      <div className="rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 space-y-1">
                        <div className="font-semibold text-violet-200">공유 라이브러리란?</div>
                        <p className="text-slate-300 leading-relaxed">
                          음원 파일 없이 가사·후리가나·한국어 발음·해석·싱크 데이터만 저장되는 공동 저장소입니다. 한 번 등록된 곡은 누구나 AI 재계산 없이 바로 감상하고 노래할 수 있습니다.
                        </p>
                      </div>

                      <div className="rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 space-y-1">
                        <div className="font-semibold text-sky-300">수정본 올려서 기여하는 방법</div>
                        <p className="text-slate-300 leading-relaxed">
                          <span className="block">
                            ① 곡을 불러온 뒤 우측 <strong className="text-slate-100">[가사 편집]</strong>에서 어색한 독음·번역·싱크를 다듬어 주세요.
                          </span>
                          <span className="block">
                            ② 다시 이 창을 열어 우측 상단 <strong className="text-slate-100">[수정본 올리기]</strong>를 눌러 닉네임·수정 메모와 함께 등록하면 새 버전(v2, v3…)으로 모두와 공유됩니다. (이전 버전은 안전하게 보존)
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Search, Sort & Filters */}
            <div className="border-b border-white/[0.07] bg-black/20 px-3.5 sm:px-5 py-2.5 sm:py-3 space-y-2.5 shrink-0 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px] sm:min-w-[220px]">
                  <Search className="h-3.5 w-3.5 text-slate-500 absolute left-2.5 top-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="라이브러리 검색 (곡 제목 · 가수 · 기여자 · YouTube ID)"
                    className="w-full rounded-lg border border-white/[0.08] bg-black/40 pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                  />
                </div>

                <div className="inline-flex rounded-lg border border-white/[0.08] bg-black/35 p-0.5">
                  {(
                    [
                      ['recommended', '품질순'],
                      ['latest', '최신순'],
                      ['popular', '추천순'],
                    ] as Array<[LibrarySortType, string]>
                  ).map(([sId, sLabel]) => (
                    <button
                      key={sId}
                      type="button"
                      onClick={() => setSort(sId)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                        sort === sId
                          ? 'bg-sky-500/20 text-sky-200'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {sLabel}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => void fetchList()}
                  disabled={loading}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.09] transition"
                  title="새로고침"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  새로고침
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ['all', '전체'],
                      ['verified', '✓ 검수 완료'],
                      ['edited', '사용자 수정'],
                      ['mr', 'MR 포함'],
                      ['karaoke', '노래방 포함'],
                      ['translated', '번역 포함'],
                    ] as Array<[LibraryFilterType, string]>
                  ).map(([fId, fLabel]) => (
                    <button
                      key={fId}
                      type="button"
                      onClick={() => setFilter(fId)}
                      className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium transition ${
                        filter === fId
                          ? 'border-sky-400/45 bg-sky-500/15 text-sky-200'
                          : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {fLabel}
                    </button>
                  ))}

                  {(manageMode || reportedCount > 0) && (
                    <button
                      type="button"
                      onClick={() => setFilter('reported')}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium transition ${
                        filter === 'reported'
                          ? 'border-rose-400/50 bg-rose-500/20 text-rose-200'
                          : 'border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15'
                      }`}
                    >
                      <Flag className="h-2.5 w-2.5" />
                      신고/숨김 ({reportedCount})
                    </button>
                  )}
                </div>

                {isMobile ? (
                  <div className="w-full flex items-start gap-2 rounded-lg border border-sky-400/25 bg-sky-500/[0.08] px-3 py-2 text-[11px] text-sky-200 leading-relaxed">
                    <Monitor className="h-3.5 w-3.5 text-sky-400 shrink-0 mt-0.5" />
                    <span>
                      모바일은 공유 곡 노래방 감상 전용입니다. 새 곡 추가나 수정본 기여는 <strong className="font-semibold">PC</strong>에서 접속해 주세요.
                    </span>
                  </div>
                ) : (
                  !workerConnected && (
                    <span className="text-[10.5px] text-amber-300">
                      로컬 워커 미연결: 가사·싱크·발음·번역 데이터만 즉시 로드됩니다
                    </span>
                  )
                )}
              </div>

              {(notice || loadingStatus) && (
                <div className="flex items-center gap-2 rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-200">
                  {loadingVideoId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  )}
                  <span>{loadingStatus || notice}</span>
                </div>
              )}
            </div>

            {/* Song Cards Grid */}
            <div className="flex-1 overflow-y-auto p-3.5 sm:p-5 text-xs">
              {loading && items.length === 0 ? (
                <div className="flex h-48 items-center justify-center gap-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                  라이브러리 목록을 불러오는 중...
                </div>
              ) : items.length === 0 ? (
                <div className="flex h-52 flex-col items-center justify-center text-center gap-2.5 text-slate-400">
                  {isMobile ? (
                    <>
                      <Monitor className="h-6 w-6 text-sky-400" />
                      <p className="font-medium text-slate-200">
                        {query || filter !== 'all'
                          ? '라이브러리에 없는 곡입니다'
                          : '아직 공유 라이브러리에 등록된 곡이 없습니다'}
                      </p>
                      <p className="text-[11px] text-slate-400 max-w-md leading-relaxed">
                        라이브러리에 없는 곡을 불러와 AI 싱크를 만들려면 PC에서 접속해 로컬 GPU 워커를 실행해 주세요. PC에서 등록한 곡은 모바일 라이브러리에도 자동으로 표시됩니다.
                      </p>
                      {(query || filter !== 'all') && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery('');
                            setFilter('all');
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/20 px-3.5 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/30 transition"
                        >
                          검색·필터 초기화
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-6 w-6 text-slate-600" />
                      <p className="font-medium text-slate-300">
                        {query || filter !== 'all'
                          ? '조건에 맞는 공유 곡이 없습니다'
                          : '아직 공유 라이브러리에 등록된 곡이 없습니다'}
                      </p>
                      <p className="text-[11px] text-slate-500 max-w-md leading-relaxed">
                        신규 곡은 AI 싱크 완료 시 자동으로 1회 등록되며, 수정본이나 번역은
                        상단「현재 곡 공유」버튼으로 버전과 함께 안전하게 공유할 수 있습니다.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab('search')}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/20 px-3.5 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/30 transition"
                      >
                        <Search className="h-3.5 w-3.5" />
                        새 곡 검색으로 이동
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                  {items.map((item) => {
                    const isLoadingThis = loadingVideoId === item.youtubeVideoId;
                    const isRevOpen = expandedRevVid === item.youtubeVideoId;
                    const isReportOpen = reportOpenVid === item.youtubeVideoId;
                    const revData = revisionsByVid[item.youtubeVideoId];
                    const isBusyMod = moderatingVid === item.youtubeVideoId;
                    const thumb =
                      item.artworkUrl ||
                      `https://i.ytimg.com/vi/${item.youtubeVideoId}/mqdefault.jpg`;

                    return (
                      <div
                        key={item.youtubeVideoId}
                        className={`flex flex-col justify-between gap-2.5 rounded-xl border p-3 transition ${
                          item.hidden
                            ? 'border-rose-400/35 bg-rose-950/15'
                            : item.status === 'verified'
                            ? 'border-emerald-400/25 bg-black/35 hover:border-emerald-400/45'
                            : 'border-white/[0.08] bg-black/30 hover:border-sky-400/35'
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <img
                            src={thumb}
                            alt=""
                            className="h-14 w-20 rounded-lg object-cover bg-white/[0.04] shrink-0"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center justify-between gap-1.5">
                              <div className="font-semibold text-slate-100 text-[12.5px] truncate">
                                {item.title || '제목 없음'}
                              </div>
                              {item.hidden && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-rose-500/25 px-1.5 py-0.5 text-[9.5px] font-semibold text-rose-200 shrink-0">
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  자동 숨김
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                              <Music2 className="h-3 w-3 shrink-0 text-slate-500" />
                              <span className="truncate">{item.artist || '아티스트 미상'}</span>
                              <span className="text-slate-600">·</span>
                              <span className="font-mono tabular-nums shrink-0">
                                {formatTime(item.duration)}
                              </span>
                              <span className="text-slate-600">·</span>
                              <span className="shrink-0">{item.lineCount}소절</span>
                            </div>

                            {(item.authorName || item.editNote) && (
                              <div className="truncate text-[10.5px] text-slate-400">
                                <span className="text-slate-300 font-medium">
                                  {item.authorName || 'AI 자동 분석'}
                                </span>
                                {item.editNote && (
                                  <span className="text-slate-500"> · {item.editNote}</span>
                                )}
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              <StatusBadge status={item.status} locked={item.locked} compact />
                              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-300">
                                v{item.revisionCount ?? 1}
                              </span>
                              {item.hasTranslation && (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-300">
                                  번역
                                </span>
                              )}
                              {item.mrYoutubeId && (
                                <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-violet-300">
                                  MR
                                </span>
                              )}
                              {item.karaokeYoutubeId && (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-300">
                                  노래방
                                </span>
                              )}
                              {(item.disambiguatedCount ?? 0) > 0 && (
                                <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-indigo-300">
                                  다중독음 {item.disambiguatedCount}
                                </span>
                              )}
                              {item.reportCount > 0 && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-rose-300">
                                  <Flag className="h-2.5 w-2.5" />
                                  신고 {item.reportCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Action Footer */}
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {(() => {
                              const isLiked = likedVids.has(item.youtubeVideoId);
                              return (
                                <button
                                  type="button"
                                  disabled={votingVid === item.youtubeVideoId}
                                  onClick={() => void handleUpvote(item.youtubeVideoId)}
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] transition disabled:opacity-50 ${
                                    isLiked
                                      ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 font-semibold'
                                      : 'border-white/[0.08] bg-white/[0.04] text-slate-300 font-medium hover:border-sky-400/40 hover:text-sky-200'
                                  }`}
                                  title={isLiked ? '좋아요 취소' : '좋아요'}
                                >
                                  <ThumbsUp className="h-3 w-3" />
                                  <span className="font-mono tabular-nums">
                                    {item.upvotes ?? 1}
                                  </span>
                                </button>
                              );
                            })()}

                            {!isMobile && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleToggleRevisions(item.youtubeVideoId)}
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-medium transition ${
                                    isRevOpen
                                      ? 'border-violet-400/45 bg-violet-500/20 text-violet-200'
                                      : 'border-white/[0.08] bg-white/[0.04] text-slate-300 hover:border-violet-400/35 hover:text-violet-200'
                                  }`}
                                  title="버전 기록 보기 및 이전 버전 복구"
                                >
                                  <History className="h-3 w-3" />
                                  <span>v{item.revisionCount ?? 1} 기록</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setExpandedRevVid(null);
                                    setReportOpenVid((prev) =>
                                      prev === item.youtubeVideoId ? null : item.youtubeVideoId
                                    );
                                  }}
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] transition ${
                                    isReportOpen
                                      ? 'border-rose-400/45 bg-rose-500/20 text-rose-200'
                                      : 'border-white/[0.08] bg-white/[0.04] text-slate-400 hover:border-rose-400/35 hover:text-rose-200'
                                  }`}
                                  title="싱크/발음/가사 오류 신고"
                                >
                                  <Flag className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={Boolean(loadingVideoId)}
                            onClick={() => void handleLoadAndClose(item)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50 transition shrink-0"
                          >
                            {isLoadingThis ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                불러오는 중...
                              </>
                            ) : (
                              <>
                                <Download className="h-3.5 w-3.5" />
                                불러오기
                              </>
                            )}
                          </button>
                        </div>

                        {/* Inline Revision History Drawer */}
                        {isRevOpen && (
                          <div className="rounded-lg border border-white/[0.08] bg-black/45 p-2.5 space-y-2">
                            <div className="flex items-center justify-between text-[10.5px] font-semibold text-slate-200">
                              <span className="inline-flex items-center gap-1">
                                <History className="h-3 w-3 text-violet-300" />
                                버전 기록 ({revData?.revisions.length ?? item.revisionCount}개)
                              </span>
                              <span className="text-[10px] font-normal text-slate-400">
                                이전 버전 불러오기 또는 대표본 되돌리기
                              </span>
                            </div>

                            {revLoadingVid === item.youtubeVideoId && !revData ? (
                              <div className="flex items-center gap-1.5 py-2 text-[10.5px] text-slate-400">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                버전 기록 불러오는 중...
                              </div>
                            ) : !revData || revData.revisions.length === 0 ? (
                              <div className="text-[10.5px] text-slate-500">
                                저장된 버전 기록이 없습니다.
                              </div>
                            ) : (
                              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-0.5">
                                {revData.revisions.map((rv) => {
                                  const isActive = rv.revId === revData.activeRevisionId;
                                  return (
                                    <div
                                      key={rv.revId}
                                      className={`rounded-md border px-2 py-1.5 space-y-1 ${
                                        isActive
                                          ? 'border-sky-400/35 bg-sky-500/10'
                                          : 'border-white/[0.07] bg-white/[0.02]'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-1.5">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="font-mono font-semibold text-[10.5px] text-slate-200">
                                            v{rv.version}
                                          </span>
                                          <StatusBadge status={rv.status} compact />
                                          {isActive && (
                                            <span className="rounded bg-sky-500/25 px-1.5 py-0.2 text-[9px] font-semibold text-sky-200">
                                              현재 대표
                                            </span>
                                          )}
                                        </div>
                                        <span className="text-[9.5px] text-slate-500 font-mono shrink-0">
                                          {formatShortDate(rv.createdAt)}
                                        </span>
                                      </div>

                                      <div className="text-[10.5px] text-slate-300 truncate">
                                        <span className="font-medium text-slate-200">
                                          {rv.authorName}
                                        </span>
                                        {rv.editNote && (
                                          <span className="text-slate-400"> · {rv.editNote}</span>
                                        )}
                                      </div>

                                      <div className="flex items-center justify-between gap-1.5 pt-0.5">
                                        <span className="text-[9.5px] text-slate-500">
                                          {rv.lineCount}소절
                                          {rv.hasTranslation ? ' · 번역' : ''}
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={Boolean(loadingVideoId)}
                                            onClick={() =>
                                              void handleLoadAndClose(item, rv.revId)
                                            }
                                            className="rounded border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-slate-200 hover:bg-white/[0.12] transition"
                                          >
                                            이 버전 불러오기
                                          </button>
                                          {!isActive &&
                                            (isAdmin || (!item.locked && item.status !== 'verified') ? (
                                              <button
                                                type="button"
                                                disabled={activatingRevId === rv.revId}
                                                onClick={() =>
                                                  void handleActivateRevision(
                                                    item.youtubeVideoId,
                                                    rv.revId,
                                                    rv.version
                                                  )
                                                }
                                                className="inline-flex items-center gap-1 rounded border border-violet-400/35 bg-violet-500/20 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/30 disabled:opacity-50 transition"
                                              >
                                                <RotateCcw className="h-2.5 w-2.5" />
                                                대표로 적용
                                              </button>
                                            ) : (
                                              <span className="inline-flex items-center gap-1 rounded border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                                                <Lock className="h-2.5 w-2.5" />
                                                잠금
                                              </span>
                                            ))}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {isAdmin && manageMode && revData && revData.reports.length > 0 && (
                              <div className="border-t border-white/[0.07] pt-1.5 space-y-1">
                                <div className="text-[10px] font-semibold text-rose-300">
                                  접수된 신고 ({revData.reports.length})
                                </div>
                                {revData.reports.slice(0, 4).map((rp) => (
                                  <div
                                    key={rp.id}
                                    className="text-[10px] text-slate-400 truncate"
                                  >
                                    • {REPORT_REASONS.find((r) => r.id === rp.reason)?.label}
                                    {rp.note ? `: ${rp.note}` : ''}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Inline Report Form */}
                        {isReportOpen && (
                          <div className="rounded-lg border border-rose-400/30 bg-rose-950/25 p-2.5 space-y-2">
                            <div className="text-[10.5px] font-semibold text-rose-200 flex items-center gap-1">
                              <Flag className="h-3 w-3" />
                              오류 신고 (3회 이상 누적 시 자동 숨김)
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {REPORT_REASONS.map((r) => (
                                <button
                                  key={r.id}
                                  type="button"
                                  onClick={() => setReportReason(r.id)}
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
                                    reportReason === r.id
                                      ? 'border-rose-400/60 bg-rose-500/30 text-rose-100'
                                      : 'border-white/[0.1] bg-black/30 text-slate-300 hover:border-rose-400/35'
                                  }`}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={reportNote}
                                onChange={(e) => setReportNote(e.target.value)}
                                maxLength={140}
                                placeholder="어느 부분에 문제가 있는지 메모 (선택)"
                                className="flex-1 rounded border border-white/[0.1] bg-black/40 px-2 py-1 text-[10.5px] text-slate-100 placeholder:text-slate-500 focus:border-rose-400/50 focus:outline-none"
                              />
                              <button
                                type="button"
                                disabled={reporting}
                                onClick={() => void handleSubmitReport(item.youtubeVideoId)}
                                className="rounded bg-rose-500 px-2.5 py-1 text-[10.5px] font-semibold text-white hover:bg-rose-400 disabled:opacity-50 transition shrink-0"
                              >
                                접수
                              </button>
                              <button
                                type="button"
                                onClick={() => setReportOpenVid(null)}
                                className="rounded border border-white/[0.1] px-2 py-1 text-[10.5px] text-slate-300 hover:bg-white/[0.06] shrink-0"
                              >
                                취소
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Curator / Admin Moderation Bar */}
                        {isAdmin && manageMode && (
                          <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-amber-400/25 bg-amber-950/20 px-2.5 py-1.5">
                            <div className="flex flex-wrap items-center gap-1">
                              {item.status === 'verified' ? (
                                <button
                                  type="button"
                                  disabled={isBusyMod}
                                  onClick={() =>
                                    void handleModerate(item.youtubeVideoId, 'unverify')
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-200 hover:bg-emerald-500/25 transition"
                                >
                                  <Unlock className="h-2.5 w-2.5" />
                                  검수·잠금 해제
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusyMod}
                                  onClick={() =>
                                    void handleModerate(item.youtubeVideoId, 'verify')
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/30 transition"
                                >
                                  <ShieldCheck className="h-2.5 w-2.5" />
                                  검수·잠금
                                </button>
                              )}

                              {item.status !== 'verified' && (
                                <button
                                  type="button"
                                  disabled={isBusyMod}
                                  onClick={() =>
                                    void handleModerate(
                                      item.youtubeVideoId,
                                      item.locked ? 'unlock' : 'lock'
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-white/[0.12] bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-200 hover:bg-white/[0.1] transition"
                                >
                                  {item.locked ? (
                                    <>
                                      <Unlock className="h-2.5 w-2.5" />
                                      잠금 해제
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="h-2.5 w-2.5" />
                                      잠금
                                    </>
                                  )}
                                </button>
                              )}

                              {(item.reportCount > 0 || item.hidden) && (
                                <button
                                  type="button"
                                  disabled={isBusyMod}
                                  onClick={() =>
                                    void handleModerate(
                                      item.youtubeVideoId,
                                      'dismiss_reports'
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-sky-400/35 bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-200 hover:bg-sky-500/25 transition"
                                >
                                  <RotateCcw className="h-2.5 w-2.5" />
                                  신고 초기화/복구
                                </button>
                              )}
                            </div>

                            {confirmDeleteVid === item.youtubeVideoId ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={isBusyMod}
                                  onClick={() => void handleDeleteSong(item.youtubeVideoId)}
                                  className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-rose-500 transition"
                                >
                                  삭제 확인
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteVid(null)}
                                  className="rounded border border-white/[0.1] px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                                >
                                  취소
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteVid(item.youtubeVideoId)}
                                className="inline-flex items-center gap-1 rounded border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/20 transition"
                              >
                                <Trash2 className="h-2.5 w-2.5" />
                                삭제
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
