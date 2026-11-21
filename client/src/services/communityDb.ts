import type {
  CommunitySongAnalysis,
  LibraryQualityStatus,
  LibraryReportEntry,
  LibraryReportReason,
  LibraryRevisionEntry,
  LibraryRevisionMeta,
  LibrarySongSummary,
  LyricLine,
} from '@shared/types';
import { workerUrl } from '../workerClient';

export const COMMUNITY_PIPELINE_VERSION = 'v1';

const LOCAL_CACHE_KEY = 'utakana_community_cache_v1';
const SUPABASE_OVERRIDE_KEY = 'utakana_supabase_override_v1';
const CONTRIBUTOR_NAME_KEY = 'utakana_contributor_name_v1';
const VOTER_ID_KEY = 'utakana_voter_id_v1';
const LIKED_SONGS_KEY = 'utakana_liked_songs_v1';
const ADMIN_KEY_SESSION_KEY = 'utakana_admin_key_v1';
export const ADMIN_CHANGE_EVENT = 'utakana-admin-change';
const MAX_LOCAL_ENTRIES = 40;
const AUTO_HIDE_REPORT_THRESHOLD = 3;

const STATUS_RANK: Record<LibraryQualityStatus, number> = {
  verified: 3,
  edited: 2,
  auto: 1,
};

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

interface SupabaseRow {
  youtube_video_id: string;
  lyrics_hash: string;
  pipeline_version: string;
  title: string;
  artist: string;
  duration: number;
  artwork_url?: string | null;
  mr_youtube_id?: string | null;
  mr_sync_offset?: number | null;
  karaoke_youtube_id?: string | null;
  karaoke_sync_offset?: number | null;
  lines_json: LyricLine[];
  disambiguated_count?: number | null;
  device_label?: string | null;
  upvotes?: number | null;
  status?: string | null;
  locked?: boolean | null;
  author_name?: string | null;
  edit_note?: string | null;
  active_revision_id?: string | null;
  revision_count?: number | null;
  report_count?: number | null;
  hidden?: boolean | null;
  updated_at: string;
}

export type LibraryFilterType =
  | 'all'
  | 'verified'
  | 'edited'
  | 'mr'
  | 'karaoke'
  | 'translated'
  | 'reported';

export type LibrarySortType = 'recommended' | 'latest' | 'popular';

export type LibraryModerateAction =
  | 'verify'
  | 'unverify'
  | 'lock'
  | 'unlock'
  | 'dismiss_reports'
  | 'restore';

export interface LibraryRevisionsResponse {
  youtubeVideoId: string;
  activeRevisionId?: string;
  status: LibraryQualityStatus;
  locked: boolean;
  reportCount: number;
  hidden: boolean;
  reports: LibraryReportEntry[];
  revisions: LibraryRevisionMeta[];
}

export function getSavedContributorName(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(CONTRIBUTOR_NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function saveContributorName(name: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = name.trim();
    if (clean) {
      window.localStorage.setItem(CONTRIBUTOR_NAME_KEY, clean);
    } else {
      window.localStorage.removeItem(CONTRIBUTOR_NAME_KEY);
    }
  } catch {
    // ignore
  }
}

function getSupabaseCredentials(): SupabaseCredentials | null {
  const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
  const envKey =
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';
  if (envUrl && envKey) {
    return {
      url: envUrl.replace(/\/+$/, ''),
      anonKey: envKey,
    };
  }
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(SUPABASE_OVERRIDE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SupabaseCredentials>;
        if (parsed.url?.trim() && parsed.anonKey?.trim()) {
          return {
            url: parsed.url.trim().replace(/\/+$/, ''),
            anonKey: parsed.anonKey.trim(),
          };
        }
      }
    } catch {
      // ignore malformed storage
    }
  }
  return null;
}

export function getClientVoterId(): string {
  if (typeof window === 'undefined') return 'anon';
  try {
    const existing = window.localStorage.getItem(VOTER_ID_KEY)?.trim();
    if (existing) return existing;
    const generated = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(VOTER_ID_KEY, generated);
    return generated;
  } catch {
    return 'anon';
  }
}

export function getLikedSongIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LIKED_SONGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

function setSongLikedLocal(vid: string, liked: boolean): void {
  if (typeof window === 'undefined' || !vid) return;
  try {
    const cur = new Set(getLikedSongIds());
    if (liked) cur.add(vid);
    else cur.delete(vid);
    window.localStorage.setItem(LIKED_SONGS_KEY, JSON.stringify([...cur].slice(-200)));
  } catch {
    // ignore storage errors
  }
}

export function getSavedAdminKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(ADMIN_KEY_SESSION_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function isAdminSessionActive(): boolean {
  return getSavedAdminKey().length > 0;
}

export function clearAdminSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ADMIN_KEY_SESSION_KEY);
    window.dispatchEvent(new Event(ADMIN_CHANGE_EVENT));
  } catch {
    // ignore storage errors
  }
}

export async function verifyAdminKey(
  adminKey: string
): Promise<{ ok: boolean; error?: string }> {
  const clean = (adminKey || '').trim();
  if (!clean) return { ok: false, error: '관리자 키를 입력하세요.' };
  try {
    const res = await fetch(workerUrl('/api/library/admin/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: clean }),
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      isAdmin?: boolean;
      error?: string;
    };
    if (res.ok && data.ok) {
      try {
        window.sessionStorage.setItem(ADMIN_KEY_SESSION_KEY, clean);
        window.dispatchEvent(new Event(ADMIN_CHANGE_EVENT));
      } catch {
        // ignore storage errors
      }
      return { ok: true };
    }
    return {
      ok: false,
      error: data.error || '관리자 키가 올바르지 않습니다.',
    };
  } catch {
    return {
      ok: false,
      error: '관리자 인증 서버에 연결할 수 없습니다.',
    };
  }
}

export function computeLyricsHash(lines: LyricLine[]): string {
  const canonical = lines
    .map((l) => (l.jpText || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeStatus(
  raw: unknown,
  fallback: LibraryQualityStatus = 'auto'
): LibraryQualityStatus {
  if (raw === 'verified' || raw === 'edited' || raw === 'auto') {
    return raw;
  }
  return fallback;
}

function readLocalCacheMap(): Record<string, CommunitySongAnalysis> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CommunitySongAnalysis>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalCacheMap(map: Record<string, CommunitySongAnalysis>): void {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(map)
      .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
      .slice(0, MAX_LOCAL_ENTRIES);
    window.localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore quota errors
  }
}

let starterCatalogPromise: Promise<Record<string, CommunitySongAnalysis>> | null = null;

async function loadStarterCatalogMap(): Promise<Record<string, CommunitySongAnalysis>> {
  if (typeof window === 'undefined') return {};
  if (!starterCatalogPromise) {
    starterCatalogPromise = (async () => {
      try {
        const base = (import.meta.env.BASE_URL || './').replace(/\/?$/, '/');
        const res = await fetch(`${base}starter-library.json`, { cache: 'force-cache' });
        if (!res.ok) return {};
        const raw = (await res.json()) as CommunitySongAnalysis[];
        if (!Array.isArray(raw)) return {};
        const map: Record<string, CommunitySongAnalysis> = {};
        for (const item of raw) {
          if (item && item.youtubeVideoId && Array.isArray(item.lines) && item.lines.length > 0) {
            map[item.youtubeVideoId] = normalizeRecord(item);
          }
        }
        return map;
      } catch {
        return {};
      }
    })();
  }
  return starterCatalogPromise;
}

async function readMergedLocalMap(): Promise<Record<string, CommunitySongAnalysis>> {
  const starter = await loadStarterCatalogMap();
  const local = readLocalCacheMap();
  return { ...starter, ...local };
}

function normalizeRecord(rec: CommunitySongAnalysis): CommunitySongAnalysis {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const status = normalizeStatus(rec.status, 'auto');
  const hash = rec.lyricsHash || computeLyricsHash(lines);
  const nowIso = rec.updatedAt || new Date().toISOString();
  const hasTranslation =
    rec.hasTranslation ?? lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim()));

  let revisions = Array.isArray(rec.revisions) ? rec.revisions : [];
  if (revisions.length === 0) {
    revisions = [
      {
        revId: 'rev_1',
        version: 1,
        status,
        authorName: rec.authorName || 'AI 자동 분석',
        editNote: rec.editNote || '초기 자동 분석본',
        createdAt: nowIso,
        lineCount: lines.length,
        hasTranslation,
        lyricsHash: hash,
        lines,
        mrYoutubeId: rec.mrYoutubeId,
        mrSyncOffset: rec.mrSyncOffset ?? 0,
        karaokeYoutubeId: rec.karaokeYoutubeId,
        karaokeSyncOffset: rec.karaokeSyncOffset ?? 0,
        disambiguatedCount: rec.disambiguatedCount ?? 0,
        deviceLabel: rec.deviceLabel,
      },
    ];
  }

  const activeRev =
    revisions.find((r) => r.revId === rec.activeRevisionId) ||
    revisions[revisions.length - 1];
  const reports = Array.isArray(rec.reports) ? rec.reports : [];
  const reportCount = Math.max(reports.length, Number(rec.reportCount ?? 0));

  return {
    ...rec,
    lyricsHash: hash,
    status,
    locked: Boolean(rec.locked),
    authorName: rec.authorName || activeRev?.authorName || 'AI 자동 분석',
    editNote: rec.editNote || activeRev?.editNote || '초기 자동 분석본',
    activeRevisionId: activeRev?.revId || 'rev_1',
    revisionCount: Math.max(1, Number(rec.revisionCount ?? revisions.length)),
    revisions,
    reports,
    reportCount,
    hidden: Boolean(rec.hidden),
  };
}

function toSummary(rec: CommunitySongAnalysis): LibrarySongSummary {
  const norm = normalizeRecord(rec);
  const { lines, revisions: _revs, reports: _reps, ...rest } = norm;
  const arr = Array.isArray(lines) ? lines : [];
  return {
    ...rest,
    lineCount: norm.lineCount ?? arr.length,
    hasTranslation:
      norm.hasTranslation ??
      arr.some((l) => Boolean(l.koTranslation && l.koTranslation.trim())),
    status: normalizeStatus(norm.status, 'auto'),
    locked: Boolean(norm.locked),
    revisionCount: Math.max(1, Number(norm.revisionCount ?? 1)),
    reportCount: Number(norm.reportCount ?? 0),
    hidden: Boolean(norm.hidden),
  };
}

function toRevisionMeta(rev: LibraryRevisionEntry): LibraryRevisionMeta {
  const {
    lines: _lines,
    mrYoutubeId: _mr,
    mrSyncOffset: _mro,
    karaokeYoutubeId: _kar,
    karaokeSyncOffset: _karo,
    disambiguatedCount: _dis,
    deviceLabel: _dev,
    ...meta
  } = rev;
  return meta;
}

function rowToRecord(row: SupabaseRow): CommunitySongAnalysis {
  const lines = Array.isArray(row.lines_json) ? row.lines_json : [];
  return normalizeRecord({
    youtubeVideoId: row.youtube_video_id,
    lyricsHash: row.lyrics_hash,
    pipelineVersion: row.pipeline_version || COMMUNITY_PIPELINE_VERSION,
    title: row.title || '',
    artist: row.artist || '',
    duration: Number(row.duration) || 0,
    artworkUrl: row.artwork_url ?? undefined,
    mrYoutubeId: row.mr_youtube_id ?? undefined,
    mrSyncOffset: Number(row.mr_sync_offset ?? 0),
    karaokeYoutubeId: row.karaoke_youtube_id ?? undefined,
    karaokeSyncOffset: Number(row.karaoke_sync_offset ?? 0),
    lines,
    lineCount: lines.length,
    hasTranslation: lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim())),
    disambiguatedCount: Number(row.disambiguated_count ?? 0),
    deviceLabel: row.device_label ?? undefined,
    upvotes: Number(row.upvotes ?? 1),
    status: normalizeStatus(row.status, 'auto'),
    locked: Boolean(row.locked),
    authorName: row.author_name ?? undefined,
    editNote: row.edit_note ?? undefined,
    activeRevisionId: row.active_revision_id ?? undefined,
    revisionCount: Number(row.revision_count ?? 1),
    reportCount: Number(row.report_count ?? 0),
    hidden: Boolean(row.hidden),
    updatedAt: row.updated_at || new Date().toISOString(),
  });
}

function filterAndSortRecords(
  records: CommunitySongAnalysis[],
  opts?: {
    query?: string;
    sort?: LibrarySortType;
    filter?: LibraryFilterType;
    includeHidden?: boolean;
    limit?: number;
  }
): {
  items: LibrarySongSummary[];
  total: number;
  hiddenCount: number;
  reportedCount: number;
} {
  const normalized = records.map(normalizeRecord);
  const q = (opts?.query || '').trim().toLowerCase();
  const sort = opts?.sort || 'recommended';
  const filter = opts?.filter || 'all';
  const includeHidden = Boolean(opts?.includeHidden);
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));

  const hiddenCount = normalized.filter((r) => Boolean(r.hidden)).length;
  const reportedCount = normalized.filter(
    (r) => (r.reportCount ?? 0) > 0 || Boolean(r.hidden)
  ).length;

  const filtered = normalized.filter((rec) => {
    const sum = toSummary(rec);
    if (sum.hidden && !includeHidden && filter !== 'reported') return false;
    if (filter === 'verified' && sum.status !== 'verified') return false;
    if (filter === 'edited' && sum.status !== 'edited' && sum.status !== 'verified') {
      return false;
    }
    if (filter === 'mr' && !sum.mrYoutubeId) return false;
    if (filter === 'karaoke' && !sum.karaokeYoutubeId) return false;
    if (filter === 'translated' && !sum.hasTranslation) return false;
    if (filter === 'reported' && sum.reportCount === 0 && !sum.hidden) return false;
    if (!q) return true;
    const hay = `${rec.title || ''} ${rec.artist || ''} ${rec.youtubeVideoId || ''} ${rec.authorName || ''}`.toLowerCase();
    return hay.includes(q);
  });

  filtered.sort((a, b) => {
    if (sort === 'recommended') {
      const rankDiff =
        (STATUS_RANK[b.status ?? 'auto'] ?? 1) -
        (STATUS_RANK[a.status ?? 'auto'] ?? 1);
      if (rankDiff !== 0) return rankDiff;
      const voteDiff = (b.upvotes ?? 1) - (a.upvotes ?? 1);
      if (voteDiff !== 0) return voteDiff;
    } else if (sort === 'popular') {
      const voteDiff = (b.upvotes ?? 1) - (a.upvotes ?? 1);
      if (voteDiff !== 0) return voteDiff;
    }
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  return {
    items: filtered.slice(0, limit).map(toSummary),
    total: filtered.length,
    hiddenCount,
    reportedCount,
  };
}

export function getCommunityDbStatus(): {
  configured: boolean;
  provider: 'supabase' | 'local-cache';
  cachedLocalCount: number;
} {
  const creds = getSupabaseCredentials();
  const localCount = Object.keys(readLocalCacheMap()).length;
  return {
    configured: Boolean(creds),
    provider: creds ? 'supabase' : 'local-cache',
    cachedLocalCount: localCount,
  };
}

export function listLocalCachedSongs(): CommunitySongAnalysis[] {
  return Object.values(readLocalCacheMap()).sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
}

export async function listLibrarySongs(opts?: {
  query?: string;
  sort?: LibrarySortType;
  filter?: LibraryFilterType;
  includeHidden?: boolean;
  limit?: number;
}): Promise<{
  items: LibrarySongSummary[];
  total: number;
  hiddenCount: number;
  reportedCount: number;
  provider: 'supabase' | 'local-server' | 'local-cache';
}> {
  const creds = getSupabaseCredentials();
  if (creds) {
    try {
      const orderParam =
        opts?.sort === 'popular' ? 'upvotes.desc,updated_at.desc' : 'updated_at.desc';
      const endpoint =
        `${creds.url}/rest/v1/song_analyses` +
        `?select=youtube_video_id,lyrics_hash,pipeline_version,title,artist,duration,artwork_url,mr_youtube_id,mr_sync_offset,karaoke_youtube_id,karaoke_sync_offset,disambiguated_count,device_label,upvotes,status,locked,author_name,edit_note,active_revision_id,revision_count,report_count,hidden,updated_at,lines_json` +
        `&order=${orderParam}&limit=100`;
      const res = await fetch(endpoint, {
        headers: {
          apikey: creds.anonKey,
          Authorization: `Bearer ${creds.anonKey}`,
        },
        signal: AbortSignal.timeout(4500),
      });
      if (res.ok) {
        const rows = (await res.json()) as SupabaseRow[];
        if (Array.isArray(rows)) {
          const recs = rows.map(rowToRecord);
          const result = filterAndSortRecords(recs, opts);
          return { ...result, provider: 'supabase' };
        }
      }
    } catch {
      // fall through
    }
  }

  try {
    const params = new URLSearchParams();
    if (opts?.query?.trim()) params.set('q', opts.query.trim());
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.filter) params.set('filter', opts.filter);
    if (opts?.includeHidden) params.set('includeHidden', '1');
    if (opts?.limit) params.set('limit', String(opts.limit));
    const res = await fetch(workerUrl(`/api/library?${params.toString()}`), {
      signal: AbortSignal.timeout(3500),
      cache: 'no-store',
    });
    if (res.ok) {
      const data = (await res.json()) as {
        items: LibrarySongSummary[];
        total: number;
        hiddenCount?: number;
        reportedCount?: number;
      };
      if (Array.isArray(data.items)) {
        return {
          items: data.items,
          total: Number(data.total ?? data.items.length),
          hiddenCount: Number(data.hiddenCount ?? 0),
          reportedCount: Number(data.reportedCount ?? 0),
          provider: 'local-server',
        };
      }
    }
  } catch {
    // fall through to browser localStorage cache
  }

  const localResult = filterAndSortRecords(Object.values(await readMergedLocalMap()), opts);
  return { ...localResult, provider: 'local-cache' };
}

export async function lookupSongAnalysis(youtubeVideoId: string): Promise<{
  record: CommunitySongAnalysis;
  source: 'supabase' | 'local-server' | 'local-cache';
} | null> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return null;

  const creds = getSupabaseCredentials();
  if (creds) {
    try {
      const endpoint =
        `${creds.url}/rest/v1/song_analyses` +
        `?youtube_video_id=eq.${encodeURIComponent(vid)}&limit=1`;
      const res = await fetch(endpoint, {
        headers: {
          apikey: creds.anonKey,
          Authorization: `Bearer ${creds.anonKey}`,
        },
        signal: AbortSignal.timeout(4500),
      });
      if (res.ok) {
        const rows = (await res.json()) as SupabaseRow[];
        if (
          Array.isArray(rows) &&
          rows[0] &&
          Array.isArray(rows[0].lines_json) &&
          rows[0].lines_json.length > 0
        ) {
          const rec = rowToRecord(rows[0]);
          const local = readLocalCacheMap();
          local[vid] = rec;
          writeLocalCacheMap(local);
          return { record: rec, source: 'supabase' };
        }
      }
    } catch {
      // fall through
    }
  }

  try {
    const res = await fetch(workerUrl(`/api/library/${encodeURIComponent(vid)}`), {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    });
    if (res.ok) {
      const data = (await res.json()) as { record?: CommunitySongAnalysis };
      if (data.record && Array.isArray(data.record.lines) && data.record.lines.length > 0) {
        const norm = normalizeRecord(data.record);
        const local = readLocalCacheMap();
        local[vid] = norm;
        writeLocalCacheMap(local);
        return { record: norm, source: 'local-server' };
      }
    }
  } catch {
    // fall through
  }

  const local = await readMergedLocalMap();
  const hit = local[vid];
  if (hit && Array.isArray(hit.lines) && hit.lines.length > 0) {
    return { record: normalizeRecord(hit), source: 'local-cache' };
  }
  return null;
}

export async function getLibrarySongDetail(
  youtubeVideoId: string
): Promise<CommunitySongAnalysis | null> {
  const hit = await lookupSongAnalysis(youtubeVideoId);
  return hit ? hit.record : null;
}

export interface PublishSongOptions {
  mode?: 'auto' | 'manual';
  authorName?: string;
  editNote?: string;
}

export interface PublishSongResult {
  savedTo: 'supabase' | 'local-server' | 'local-cache';
  ok: boolean;
  skipped?: boolean;
  pendingSuggestion?: boolean;
  version?: number;
  summary?: LibrarySongSummary;
  error?: string;
}

export async function publishSongAnalysis(
  payload: Omit<CommunitySongAnalysis, 'pipelineVersion' | 'lyricsHash' | 'updatedAt'>,
  opts: PublishSongOptions = {}
): Promise<PublishSongResult> {
  const vid = (payload.youtubeVideoId || '').trim();
  if (!vid || !payload.lines?.length) {
    return { savedTo: 'local-cache', ok: false, error: '유효한 곡 정보가 없습니다.' };
  }

  const mode = opts.mode === 'auto' ? 'auto' : 'manual';
  const authorName =
    opts.authorName?.trim() ||
    payload.authorName?.trim() ||
    (mode === 'auto' ? 'AI 자동 분석' : getSavedContributorName() || '익명 기여자');
  const editNote =
    opts.editNote?.trim() ||
    payload.editNote?.trim() ||
    (mode === 'auto' ? '초기 자동 분석본' : '가사·싱크 수정');

  if (mode === 'manual' && opts.authorName?.trim()) {
    saveContributorName(opts.authorName.trim());
  }

  const nowIso = new Date().toISOString();
  const lyricsHash = computeLyricsHash(payload.lines);

  const creds = getSupabaseCredentials();
  if (creds) {
    try {
      // Check existing first so auto-publish never overwrites existing songs
      const checkRes = await fetch(
        `${creds.url}/rest/v1/song_analyses?youtube_video_id=eq.${encodeURIComponent(vid)}&select=youtube_video_id,locked,status,revision_count&limit=1`,
        {
          headers: {
            apikey: creds.anonKey,
            Authorization: `Bearer ${creds.anonKey}`,
          },
          signal: AbortSignal.timeout(4000),
        }
      );
      const existingRows = checkRes.ok
        ? ((await checkRes.json()) as Array<{
            youtube_video_id: string;
            locked?: boolean;
            status?: string;
            revision_count?: number;
          }>)
        : [];
      const existingRow = existingRows[0];

      if (mode === 'auto' && existingRow) {
        return { savedTo: 'supabase', ok: true, skipped: true };
      }

      const nextVersion = Math.max(1, Number(existingRow?.revision_count ?? 0) + 1);
      const revId = `rev_${Date.now().toString(36)}_v${nextVersion}`;
      const revStatus: LibraryQualityStatus = mode === 'auto' ? 'auto' : 'edited';

      // Always append revision record
      await fetch(`${creds.url}/rest/v1/song_revisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: creds.anonKey,
          Authorization: `Bearer ${creds.anonKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          youtube_video_id: vid,
          rev_id: revId,
          version: nextVersion,
          status: revStatus,
          author_name: authorName,
          edit_note: editNote,
          lyrics_hash: lyricsHash,
          mr_youtube_id: payload.mrYoutubeId ?? null,
          mr_sync_offset: payload.mrSyncOffset ?? 0,
          karaoke_youtube_id: payload.karaokeYoutubeId ?? null,
          karaoke_sync_offset: payload.karaokeSyncOffset ?? 0,
          lines_json: payload.lines,
          disambiguated_count: payload.disambiguatedCount ?? 0,
          device_label: payload.deviceLabel ?? null,
        }),
        signal: AbortSignal.timeout(4500),
      }).catch(() => undefined);

      if (existingRow?.locked) {
        await fetch(
          `${creds.url}/rest/v1/song_analyses?youtube_video_id=eq.${encodeURIComponent(vid)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              apikey: creds.anonKey,
              Authorization: `Bearer ${creds.anonKey}`,
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ revision_count: nextVersion }),
            signal: AbortSignal.timeout(4000),
          }
        ).catch(() => undefined);
        return {
          savedTo: 'supabase',
          ok: true,
          pendingSuggestion: true,
          version: nextVersion,
        };
      }

      const endpoint = `${creds.url}/rest/v1/song_analyses?on_conflict=youtube_video_id`;
      const bodyRow = {
        youtube_video_id: vid,
        lyrics_hash: lyricsHash,
        pipeline_version: COMMUNITY_PIPELINE_VERSION,
        title: payload.title,
        artist: payload.artist,
        duration: payload.duration,
        artwork_url: payload.artworkUrl ?? null,
        mr_youtube_id: payload.mrYoutubeId ?? null,
        mr_sync_offset: payload.mrSyncOffset ?? 0,
        karaoke_youtube_id: payload.karaokeYoutubeId ?? null,
        karaoke_sync_offset: payload.karaokeSyncOffset ?? 0,
        lines_json: payload.lines,
        disambiguated_count: payload.disambiguatedCount ?? 0,
        device_label: payload.deviceLabel ?? null,
        status: revStatus,
        locked: false,
        author_name: authorName,
        edit_note: editNote,
        active_revision_id: revId,
        revision_count: nextVersion,
        hidden: false,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: creds.anonKey,
          Authorization: `Bearer ${creds.anonKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(bodyRow),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return {
          savedTo: 'local-cache',
          ok: false,
          error: `Supabase HTTP ${res.status}: ${txt.slice(0, 120)}`,
        };
      }
      return { savedTo: 'supabase', ok: true, version: nextVersion };
    } catch (err) {
      return {
        savedTo: 'local-cache',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    const res = await fetch(workerUrl('/api/library'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        youtubeVideoId: vid,
        lyricsHash,
        pipelineVersion: COMMUNITY_PIPELINE_VERSION,
        publishMode: mode,
        authorName,
        editNote,
      }),
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      skipped?: boolean;
      pendingSuggestion?: boolean;
      version?: number;
      summary?: LibrarySongSummary;
      error?: string;
    };
    if (!res.ok) {
      return {
        savedTo: 'local-server',
        ok: false,
        error: data.error || `서버 오류 (${res.status})`,
      };
    }
    return {
      savedTo: 'local-server',
      ok: true,
      skipped: data.skipped,
      pendingSuggestion: data.pendingSuggestion,
      version: data.version,
      summary: data.summary,
    };
  } catch {
    // fall back to localStorage below
  }

  const local = readLocalCacheMap();
  const existingLocal = local[vid] ? normalizeRecord(local[vid]) : undefined;
  if (mode === 'auto' && existingLocal) {
    return {
      savedTo: 'local-cache',
      ok: true,
      skipped: true,
      summary: toSummary(existingLocal),
    };
  }

  const prevRevs = existingLocal?.revisions ?? [];
  const nextVer = prevRevs.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  const revStatus: LibraryQualityStatus = mode === 'auto' ? 'auto' : 'edited';
  const newRev: LibraryRevisionEntry = {
    revId: `rev_${Date.now().toString(36)}_v${nextVer}`,
    version: nextVer,
    status: revStatus,
    authorName,
    editNote,
    createdAt: nowIso,
    lineCount: payload.lines.length,
    hasTranslation: payload.lines.some((l) => Boolean(l.koTranslation?.trim())),
    lyricsHash,
    lines: payload.lines,
    mrYoutubeId: payload.mrYoutubeId ?? existingLocal?.mrYoutubeId,
    mrSyncOffset: payload.mrSyncOffset ?? existingLocal?.mrSyncOffset ?? 0,
    karaokeYoutubeId: payload.karaokeYoutubeId ?? existingLocal?.karaokeYoutubeId,
    karaokeSyncOffset: payload.karaokeSyncOffset ?? existingLocal?.karaokeSyncOffset ?? 0,
    disambiguatedCount: payload.disambiguatedCount ?? 0,
    deviceLabel: payload.deviceLabel ?? existingLocal?.deviceLabel,
  };

  if (existingLocal?.locked) {
    const nextRevs = [...prevRevs, newRev].slice(-15);
    local[vid] = {
      ...existingLocal,
      revisions: nextRevs,
      revisionCount: nextRevs.length,
    };
    writeLocalCacheMap(local);
    return {
      savedTo: 'local-cache',
      ok: true,
      pendingSuggestion: true,
      version: nextVer,
      summary: toSummary(local[vid]),
    };
  }

  const nextRevs = [...prevRevs, newRev].slice(-15);
  const nextRecord: CommunitySongAnalysis = normalizeRecord({
    ...payload,
    youtubeVideoId: vid,
    lyricsHash,
    pipelineVersion: COMMUNITY_PIPELINE_VERSION,
    upvotes: existingLocal?.upvotes ?? payload.upvotes ?? 1,
    updatedAt: nowIso,
    status: revStatus,
    locked: false,
    authorName,
    editNote,
    activeRevisionId: newRev.revId,
    revisionCount: nextRevs.length,
    revisions: nextRevs,
    reports: existingLocal?.reports ?? [],
    reportCount: existingLocal?.reportCount ?? 0,
    hidden: false,
  });
  local[vid] = nextRecord;
  writeLocalCacheMap(local);
  return {
    savedTo: 'local-cache',
    ok: true,
    version: nextVer,
    summary: toSummary(nextRecord),
  };
}

export async function listLibraryRevisions(
  youtubeVideoId: string
): Promise<LibraryRevisionsResponse | null> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return null;

  try {
    const res = await fetch(
      workerUrl(`/api/library/${encodeURIComponent(vid)}/revisions`),
      { signal: AbortSignal.timeout(3500), cache: 'no-store' }
    );
    if (res.ok) {
      return (await res.json()) as LibraryRevisionsResponse;
    }
  } catch {
    // fallback to local-cache
  }

  const local = await readMergedLocalMap();
  const hit = local[vid] ? normalizeRecord(local[vid]) : undefined;
  if (!hit) return null;
  return {
    youtubeVideoId: hit.youtubeVideoId,
    activeRevisionId: hit.activeRevisionId,
    status: hit.status ?? 'auto',
    locked: Boolean(hit.locked),
    reportCount: hit.reportCount ?? 0,
    hidden: Boolean(hit.hidden),
    reports: [...(hit.reports || [])].reverse(),
    revisions: [...(hit.revisions || [])]
      .sort((a, b) => b.version - a.version)
      .map(toRevisionMeta),
  };
}

export async function getLibraryRevisionDetail(
  youtubeVideoId: string,
  revId: string
): Promise<CommunitySongAnalysis | null> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid || !revId) return null;

  try {
    const res = await fetch(
      workerUrl(
        `/api/library/${encodeURIComponent(vid)}/revisions/${encodeURIComponent(revId)}`
      ),
      { signal: AbortSignal.timeout(3500), cache: 'no-store' }
    );
    if (res.ok) {
      const data = (await res.json()) as { record?: CommunitySongAnalysis };
      if (data.record) return data.record;
    }
  } catch {
    // fallback
  }

  const local = await readMergedLocalMap();
  const hit = local[vid] ? normalizeRecord(local[vid]) : undefined;
  const rev = hit?.revisions?.find((r) => r.revId === revId);
  if (!hit || !rev) return null;
  return {
    ...hit,
    lines: rev.lines,
    lyricsHash: rev.lyricsHash,
    mrYoutubeId: rev.mrYoutubeId ?? hit.mrYoutubeId,
    mrSyncOffset: rev.mrSyncOffset ?? hit.mrSyncOffset,
    karaokeYoutubeId: rev.karaokeYoutubeId ?? hit.karaokeYoutubeId,
    karaokeSyncOffset: rev.karaokeSyncOffset ?? hit.karaokeSyncOffset,
    status: rev.status,
    authorName: rev.authorName,
    editNote: rev.editNote,
    activeRevisionId: rev.revId,
    updatedAt: rev.createdAt,
  };
}

export async function activateLibraryRevision(
  youtubeVideoId: string,
  revId: string
): Promise<{ ok: boolean; summary?: LibrarySongSummary; error?: string }> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid || !revId) return { ok: false, error: '잘못된 요청입니다.' };

  const adminKey = getSavedAdminKey();
  try {
    const res = await fetch(
      workerUrl(
        `/api/library/${encodeURIComponent(vid)}/revisions/${encodeURIComponent(revId)}/activate`
      ),
      {
        method: 'POST',
        headers: adminKey ? { 'x-admin-key': adminKey } : undefined,
        signal: AbortSignal.timeout(3500),
      }
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      summary?: LibrarySongSummary;
      error?: string;
    };
    if (res.ok) return { ok: true, summary: data.summary };
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch {
    // fallback to local-cache
  }

  const local = readLocalCacheMap();
  const hit = local[vid] ? normalizeRecord(local[vid]) : undefined;
  const rev = hit?.revisions?.find((r) => r.revId === revId);
  if (!hit || !rev) return { ok: false, error: '해당 버전을 찾을 수 없습니다.' };
  const next: CommunitySongAnalysis = {
    ...hit,
    lines: rev.lines,
    lyricsHash: rev.lyricsHash,
    mrYoutubeId: rev.mrYoutubeId ?? hit.mrYoutubeId,
    mrSyncOffset: rev.mrSyncOffset ?? hit.mrSyncOffset,
    karaokeYoutubeId: rev.karaokeYoutubeId ?? hit.karaokeYoutubeId,
    karaokeSyncOffset: rev.karaokeSyncOffset ?? hit.karaokeSyncOffset,
    status: rev.status,
    locked: rev.status === 'verified' ? hit.locked : false,
    authorName: rev.authorName,
    editNote: rev.editNote,
    activeRevisionId: rev.revId,
    hidden: false,
    updatedAt: new Date().toISOString(),
  };
  local[vid] = next;
  writeLocalCacheMap(local);
  return { ok: true, summary: toSummary(next) };
}

export async function reportLibrarySong(
  youtubeVideoId: string,
  reason: LibraryReportReason,
  note = ''
): Promise<{
  ok: boolean;
  reportCount?: number;
  hidden?: boolean;
  summary?: LibrarySongSummary;
}> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return { ok: false };

  try {
    const res = await fetch(
      workerUrl(`/api/library/${encodeURIComponent(vid)}/report`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, note }),
        signal: AbortSignal.timeout(3500),
      }
    );
    if (res.ok) {
      return (await res.json()) as {
        ok: boolean;
        reportCount?: number;
        hidden?: boolean;
        summary?: LibrarySongSummary;
      };
    }
  } catch {
    // fallback
  }

  const local = readLocalCacheMap();
  const hit = local[vid] ? normalizeRecord(local[vid]) : undefined;
  if (!hit) return { ok: false };
  const rep: LibraryReportEntry = {
    id: `rep_${Date.now().toString(36)}`,
    reason,
    note: note.trim().slice(0, 180),
    createdAt: new Date().toISOString(),
  };
  const nextCount = (hit.reportCount ?? 0) + 1;
  const shouldHide =
    !hit.locked && hit.status !== 'verified' && nextCount >= AUTO_HIDE_REPORT_THRESHOLD;
  local[vid] = {
    ...hit,
    reports: [...(hit.reports || []), rep].slice(-20),
    reportCount: nextCount,
    hidden: Boolean(hit.hidden) || shouldHide,
  };
  writeLocalCacheMap(local);
  return {
    ok: true,
    reportCount: nextCount,
    hidden: Boolean(local[vid].hidden),
    summary: toSummary(local[vid]),
  };
}

export async function moderateLibrarySong(
  youtubeVideoId: string,
  action: LibraryModerateAction
): Promise<{ ok: boolean; summary?: LibrarySongSummary; error?: string }> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return { ok: false, error: '잘못된 곡 ID입니다.' };

  const adminKey = getSavedAdminKey();
  try {
    const res = await fetch(
      workerUrl(`/api/library/${encodeURIComponent(vid)}/moderate`),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminKey ? { 'x-admin-key': adminKey } : {}),
        },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(3500),
      }
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      summary?: LibrarySongSummary;
      error?: string;
    };
    if (res.ok) {
      return { ok: true, summary: data.summary };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: data.error || '관리자 권한이 필요합니다.' };
    }
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch {
    // fallback only if offline
  }

  if (!adminKey) {
    return { ok: false, error: '관리자 권한이 필요합니다.' };
  }

  const local = readLocalCacheMap();
  const hit = local[vid] ? normalizeRecord(local[vid]) : undefined;
  if (!hit) return { ok: false, error: '해당 곡을 찾을 수 없습니다.' };
  if (action === 'verify') {
    hit.status = 'verified';
    hit.locked = true;
    hit.hidden = false;
    hit.reports = [];
    hit.reportCount = 0;
  } else if (action === 'unverify') {
    hit.status = 'edited';
    hit.locked = false;
  } else if (action === 'lock') {
    hit.locked = true;
  } else if (action === 'unlock') {
    hit.locked = false;
  } else if (action === 'dismiss_reports' || action === 'restore') {
    hit.reports = [];
    hit.reportCount = 0;
    hit.hidden = false;
  }
  local[vid] = hit;
  writeLocalCacheMap(local);
  return { ok: true, summary: toSummary(hit) };
}

export async function upvoteLibrarySong(
  youtubeVideoId: string
): Promise<{ upvotes: number; voted: boolean } | null> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return null;

  const wasLiked = getLikedSongIds().includes(vid);
  const delta = wasLiked ? -1 : 1;

  const creds = getSupabaseCredentials();
  if (creds) {
    try {
      const getRes = await fetch(
        `${creds.url}/rest/v1/song_analyses?youtube_video_id=eq.${encodeURIComponent(vid)}&select=upvotes&limit=1`,
        {
          headers: {
            apikey: creds.anonKey,
            Authorization: `Bearer ${creds.anonKey}`,
          },
          signal: AbortSignal.timeout(4000),
        }
      );
      if (getRes.ok) {
        const rows = (await getRes.json()) as Array<{ upvotes?: number }>;
        const nextVal = Math.max(0, Number(rows?.[0]?.upvotes ?? 1) + delta);
        const patchRes = await fetch(
          `${creds.url}/rest/v1/song_analyses?youtube_video_id=eq.${encodeURIComponent(vid)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              apikey: creds.anonKey,
              Authorization: `Bearer ${creds.anonKey}`,
              Prefer: 'return=representation',
            },
            body: JSON.stringify({ upvotes: nextVal }),
            signal: AbortSignal.timeout(4000),
          }
        );
        if (patchRes.ok) {
          const updated = (await patchRes.json()) as Array<{ upvotes?: number }>;
          const nextVotes = Number(updated?.[0]?.upvotes ?? nextVal);
          setSongLikedLocal(vid, !wasLiked);
          return { upvotes: nextVotes, voted: !wasLiked };
        }
      }
    } catch {
      return null;
    }
  }

  try {
    const res = await fetch(
      workerUrl(`/api/library/${encodeURIComponent(vid)}/upvote`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voterId: getClientVoterId() }),
        signal: AbortSignal.timeout(3000),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { upvotes?: number; voted?: boolean };
      const nextVotes =
        typeof data.upvotes === 'number' ? data.upvotes : undefined;
      const nextVoted =
        typeof data.voted === 'boolean' ? data.voted : !wasLiked;
      setSongLikedLocal(vid, nextVoted);
      const local = readLocalCacheMap();
      if (local[vid] && typeof nextVotes === 'number') {
        local[vid].upvotes = nextVotes;
        writeLocalCacheMap(local);
      }
      return typeof nextVotes === 'number'
        ? { upvotes: nextVotes, voted: nextVoted }
        : null;
    }
  } catch {
    // fallback
  }

  const local = readLocalCacheMap();
  if (!local[vid]) {
    const starter = await loadStarterCatalogMap();
    if (starter[vid]) {
      local[vid] = { ...starter[vid] };
    }
  }
  if (local[vid]) {
    local[vid].upvotes = Math.max(0, Number(local[vid].upvotes ?? 1) + delta);
    writeLocalCacheMap(local);
    setSongLikedLocal(vid, !wasLiked);
    return { upvotes: local[vid].upvotes ?? 0, voted: !wasLiked };
  }
  return null;
}

export async function deleteLibrarySong(youtubeVideoId: string): Promise<boolean> {
  const vid = (youtubeVideoId || '').trim();
  if (!vid) return false;
  const adminKey = getSavedAdminKey();
  const creds = getSupabaseCredentials();
  if (!creds) {
    try {
      const res = await fetch(workerUrl(`/api/library/${encodeURIComponent(vid)}`), {
        method: 'DELETE',
        headers: adminKey ? { 'x-admin-key': adminKey } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const local = readLocalCacheMap();
      if (local[vid]) {
        delete local[vid];
        writeLocalCacheMap(local);
      }
      return true;
    } catch {
      return false;
    }
  }
  if (!adminKey) return false;
  const local = readLocalCacheMap();
  if (local[vid]) {
    delete local[vid];
    writeLocalCacheMap(local);
  }
  return true;
}
