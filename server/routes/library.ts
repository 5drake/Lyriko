import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import type {
  CommunitySongAnalysis,
  LibraryQualityStatus,
  LibraryReportEntry,
  LibraryReportReason,
  LibraryRevisionEntry,
  LibraryRevisionMeta,
  LibrarySongSummary,
  LyricLine,
} from '../../shared/types.js';
import { DATA_DIR, ensureDataDirs } from '../services/storage.js';

export const libraryRouter = Router();

const LIBRARY_FILE = path.join(DATA_DIR, 'community_library.json');
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin_key.txt');
const MAX_REVISIONS_PER_SONG = 15;
const AUTO_HIDE_REPORT_THRESHOLD = 3;

function getAdminKey(): string {
  const envKey = String(
    process.env.LYRIKO_ADMIN_KEY || process.env.UTAKANA_ADMIN_KEY || ''
  ).trim();
  if (envKey) return envKey;
  ensureDataDirs();
  try {
    if (fs.existsSync(ADMIN_KEY_FILE)) {
      const existing = fs.readFileSync(ADMIN_KEY_FILE, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch {
    // regenerate below if unreadable
  }
  const generated = crypto.randomBytes(12).toString('hex');
  try {
    fs.writeFileSync(ADMIN_KEY_FILE, `${generated}\n`, 'utf-8');
  } catch {
    // ignore write failure
  }
  return generated;
}

function verifyAdminKeyString(candidate: string): boolean {
  const clean = (candidate || '').trim();
  if (!clean) return false;
  const actual = getAdminKey();
  const a = Buffer.from(clean, 'utf-8');
  const b = Buffer.from(actual, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAdminRequest(req: Request): boolean {
  return verifyAdminKeyString(String(req.header('x-admin-key') || '').trim());
}

void getAdminKey();

const STATUS_RANK: Record<LibraryQualityStatus, number> = {
  verified: 3,
  edited: 2,
  auto: 1,
};

function computeHash(lines: LyricLine[]): string {
  const canonical = lines
    .map((l) => (l.jpText || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeStatus(raw: unknown, fallback: LibraryQualityStatus = 'auto'): LibraryQualityStatus {
  if (raw === 'verified' || raw === 'edited' || raw === 'auto') {
    return raw;
  }
  return fallback;
}

function normalizeRecord(rec: CommunitySongAnalysis): CommunitySongAnalysis {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const lyricsHash = String(rec.lyricsHash || '').trim() || computeHash(lines);
  const nowIso = rec.updatedAt || new Date().toISOString();
  const baseStatus = normalizeStatus(rec.status, 'auto');
  const hasTranslation = lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim()));

  let revisions: LibraryRevisionEntry[] = Array.isArray(rec.revisions)
    ? rec.revisions.filter(
        (rv): rv is LibraryRevisionEntry =>
          Boolean(rv && typeof rv.revId === 'string' && Array.isArray(rv.lines))
      )
    : [];

  if (revisions.length === 0) {
    const rev1: LibraryRevisionEntry = {
      revId: 'rev_1',
      version: 1,
      status: baseStatus,
      authorName: String(rec.authorName || '').trim() || 'AI 자동 분석',
      editNote: String(rec.editNote || '').trim() || '초기 자동 분석본',
      createdAt: nowIso,
      lineCount: lines.length,
      hasTranslation,
      lyricsHash,
      lines,
      mrYoutubeId: rec.mrYoutubeId,
      mrSyncOffset: Number(rec.mrSyncOffset ?? 0),
      karaokeYoutubeId: rec.karaokeYoutubeId,
      karaokeSyncOffset: Number(rec.karaokeSyncOffset ?? 0),
      disambiguatedCount: Number(rec.disambiguatedCount ?? 0),
      deviceLabel: rec.deviceLabel,
    };
    revisions = [rev1];
  } else {
    revisions = revisions.map((rv, idx) => ({
      ...rv,
      version: Math.max(1, Number(rv.version) || idx + 1),
      status: normalizeStatus(rv.status, 'edited'),
      authorName: String(rv.authorName || '').trim() || '익명 기여자',
      editNote: String(rv.editNote || '').trim() || '가사·싱크 수정',
      createdAt: rv.createdAt || nowIso,
      lineCount: Array.isArray(rv.lines) ? rv.lines.length : 0,
      hasTranslation: Array.isArray(rv.lines)
        ? rv.lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim()))
        : false,
      lyricsHash: rv.lyricsHash || computeHash(rv.lines || []),
    }));
  }

  const activeRev =
    revisions.find((r) => r.revId === rec.activeRevisionId) ||
    revisions[revisions.length - 1];

  const reports: LibraryReportEntry[] = Array.isArray(rec.reports)
    ? rec.reports.filter(
        (rp): rp is LibraryReportEntry =>
          Boolean(rp && typeof rp.id === 'string' && typeof rp.reason === 'string')
      )
    : [];

  const reportCount = Math.max(reports.length, Number(rec.reportCount ?? 0));

  return {
    ...rec,
    lyricsHash,
    status: normalizeStatus(rec.status, activeRev.status),
    locked: Boolean(rec.locked),
    authorName: String(rec.authorName || activeRev.authorName || 'AI 자동 분석'),
    editNote: String(rec.editNote || activeRev.editNote || '초기 자동 분석본'),
    activeRevisionId: activeRev.revId,
    revisionCount: revisions.length,
    revisions,
    reports,
    reportCount,
    hidden: Boolean(rec.hidden),
  };
}

function trimRevisions(
  revisions: LibraryRevisionEntry[],
  activeRevisionId?: string
): LibraryRevisionEntry[] {
  if (revisions.length <= MAX_REVISIONS_PER_SONG) return revisions;
  const active = revisions.find((r) => r.revId === activeRevisionId);
  const tail = revisions.slice(-MAX_REVISIONS_PER_SONG);
  if (!active || tail.some((r) => r.revId === active.revId)) {
    return tail;
  }
  return [active, ...tail.slice(1)];
}

function readLibraryStore(): CommunitySongAnalysis[] {
  ensureDataDirs();
  if (!fs.existsSync(LIBRARY_FILE)) return [];
  try {
    const raw = fs.readFileSync(LIBRARY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is CommunitySongAnalysis =>
          Boolean(
            x &&
              typeof x === 'object' &&
              typeof (x as CommunitySongAnalysis).youtubeVideoId === 'string' &&
              Array.isArray((x as CommunitySongAnalysis).lines)
          )
      )
      .map(normalizeRecord);
  } catch {
    return [];
  }
}

function writeLibraryStore(records: CommunitySongAnalysis[]): void {
  ensureDataDirs();
  const tmp = `${LIBRARY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmp, LIBRARY_FILE);
}

function toSummary(rec: CommunitySongAnalysis): LibrarySongSummary {
  const norm = normalizeRecord(rec);
  const {
    lines,
    revisions: _revs,
    reports: _reps,
    upvoterIds: _upvoters,
    ...rest
  } = norm;
  const arr = Array.isArray(lines) ? lines : [];
  return {
    ...rest,
    lineCount: arr.length,
    hasTranslation: arr.some((l) => Boolean(l.koTranslation && l.koTranslation.trim())),
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

function isValidVideoId(raw: string): boolean {
  return /^[a-zA-Z0-9_-]{4,64}$/.test(raw);
}

function validateSongLines(lines: unknown): string | null {
  if (!Array.isArray(lines) || lines.length < 3 || lines.length > 500) {
    return '가사는 최소 3줄 이상 500줄 이하이어야 합니다.';
  }
  const typed = lines as Partial<LyricLine>[];
  let invalidTiming = 0;
  let validContent = 0;
  for (const ln of typed) {
    const st = Number(ln?.startTime);
    const et = Number(ln?.endTime);
    if (!Number.isFinite(st) || !Number.isFinite(et) || st < 0 || et <= st) {
      invalidTiming += 1;
    }
    if (
      typeof ln?.jpText === 'string' &&
      ln.jpText.trim().length > 0 &&
      Array.isArray(ln.segments) &&
      ln.segments.length > 0
    ) {
      validContent += 1;
    }
  }
  if (invalidTiming / typed.length > 0.3) {
    return '타이밍이 비정상적인 줄이 많아 등록할 수 없습니다.';
  }
  if (validContent / typed.length < 0.5) {
    return '일본어 가사·세그먼트가 충분하지 않아 등록할 수 없습니다.';
  }
  return null;
}

libraryRouter.get('/library', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sort = String(req.query.sort || 'recommended');
  const filter = String(req.query.filter || 'all');
  const includeHidden = String(req.query.includeHidden || '') === '1';
  const limitRaw = Number(req.query.limit) || 50;
  const limit = Math.max(1, Math.min(200, Math.round(limitRaw)));

  const records = readLibraryStore();
  const hiddenCount = records.filter((r) => Boolean(r.hidden)).length;
  const reportedCount = records.filter(
    (r) => (r.reportCount ?? 0) > 0 || Boolean(r.hidden)
  ).length;

  const filtered = records.filter((rec) => {
    const isHidden = Boolean(rec.hidden);
    if (isHidden && !includeHidden && filter !== 'reported') {
      return false;
    }
    if (filter === 'verified' && rec.status !== 'verified') return false;
    if (
      filter === 'edited' &&
      rec.status !== 'edited' &&
      rec.status !== 'verified'
    ) {
      return false;
    }
    if (filter === 'mr' && !rec.mrYoutubeId) return false;
    if (filter === 'karaoke' && !rec.karaokeYoutubeId) return false;
    if (
      filter === 'translated' &&
      !rec.lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim()))
    ) {
      return false;
    }
    if (
      filter === 'reported' &&
      (rec.reportCount ?? 0) === 0 &&
      !isHidden
    ) {
      return false;
    }
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

  res.json({
    items: filtered.slice(0, limit).map(toSummary),
    total: filtered.length,
    hiddenCount,
    reportedCount,
  });
});

libraryRouter.get('/library/:videoId', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const records = readLibraryStore();
  const found = records.find((r) => r.youtubeVideoId === vid);
  if (!found) {
    res.status(404).json({ error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' });
    return;
  }
  const { revisions: _revs, reports: _reps, upvoterIds: _upvoters, ...detail } = found;
  res.json({ record: detail });
});

libraryRouter.get('/library/:videoId/revisions', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const records = readLibraryStore();
  const found = records.find((r) => r.youtubeVideoId === vid);
  if (!found) {
    res.status(404).json({ error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' });
    return;
  }
  const revisionsDesc = [...(found.revisions || [])]
    .sort((a, b) => b.version - a.version)
    .map(toRevisionMeta);

  res.json({
    youtubeVideoId: found.youtubeVideoId,
    activeRevisionId: found.activeRevisionId,
    status: found.status ?? 'auto',
    locked: Boolean(found.locked),
    reportCount: found.reportCount ?? 0,
    hidden: Boolean(found.hidden),
    reports: [...(found.reports || [])].reverse(),
    revisions: revisionsDesc,
  });
});

libraryRouter.get('/library/:videoId/revisions/:revId', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  const revId = String(req.params.revId || '').trim();
  if (!isValidVideoId(vid) || !revId) {
    res.status(400).json({ error: '잘못된 요청입니다.' });
    return;
  }
  const records = readLibraryStore();
  const found = records.find((r) => r.youtubeVideoId === vid);
  const rev = found?.revisions?.find((r) => r.revId === revId);
  if (!found || !rev) {
    res.status(404).json({ error: '해당 버전을 찾을 수 없습니다.' });
    return;
  }
  const hydrated: CommunitySongAnalysis = {
    youtubeVideoId: found.youtubeVideoId,
    lyricsHash: rev.lyricsHash,
    pipelineVersion: found.pipelineVersion,
    title: found.title,
    artist: found.artist,
    duration: found.duration,
    artworkUrl: found.artworkUrl,
    mrYoutubeId: rev.mrYoutubeId ?? found.mrYoutubeId,
    mrSyncOffset: rev.mrSyncOffset ?? found.mrSyncOffset,
    karaokeYoutubeId: rev.karaokeYoutubeId ?? found.karaokeYoutubeId,
    karaokeSyncOffset: rev.karaokeSyncOffset ?? found.karaokeSyncOffset,
    lines: rev.lines,
    lineCount: rev.lines.length,
    hasTranslation: rev.hasTranslation,
    disambiguatedCount: rev.disambiguatedCount ?? found.disambiguatedCount,
    deviceLabel: rev.deviceLabel ?? found.deviceLabel,
    upvotes: found.upvotes,
    updatedAt: rev.createdAt,
    status: rev.status,
    locked: found.locked,
    authorName: rev.authorName,
    editNote: rev.editNote,
    activeRevisionId: rev.revId,
    revisionCount: found.revisionCount,
  };
  res.json({ record: hydrated });
});

libraryRouter.post('/library', (req, res) => {
  const body = req.body as
    | (Partial<CommunitySongAnalysis> & { publishMode?: 'auto' | 'manual' })
    | undefined;
  const vid = String(body?.youtubeVideoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '유효한 youtubeVideoId가 필요합니다.' });
    return;
  }
  const validationErr = validateSongLines(body?.lines);
  if (validationErr) {
    res.status(400).json({ error: validationErr });
    return;
  }

  const lines = body!.lines!;
  const publishMode = body?.publishMode === 'auto' ? 'auto' : 'manual';
  const records = readLibraryStore();
  const existingIdx = records.findIndex((r) => r.youtubeVideoId === vid);
  const existing = existingIdx >= 0 ? records[existingIdx] : undefined;

  if (publishMode === 'auto' && existing) {
    res.json({
      ok: true,
      skipped: true,
      reason: 'already_exists',
      summary: toSummary(existing),
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const revStatus: LibraryQualityStatus = publishMode === 'auto' ? 'auto' : 'edited';
  const authorName =
    String(body?.authorName || '').trim() ||
    (publishMode === 'auto' ? 'AI 자동 분석' : '익명 기여자');
  const editNote =
    String(body?.editNote || '').trim() ||
    (publishMode === 'auto' ? '초기 자동 분석본' : '가사·싱크 수정');
  const lyricsHash = String(body?.lyricsHash || '').trim() || computeHash(lines);

  const prevRevs = existing?.revisions ? [...existing.revisions] : [];
  const nextVer =
    prevRevs.reduce((mx, r) => Math.max(mx, r.version), 0) + 1;

  const newRev: LibraryRevisionEntry = {
    revId: `rev_${Date.now().toString(36)}_v${nextVer}`,
    version: nextVer,
    status: revStatus,
    authorName,
    editNote,
    createdAt: nowIso,
    lineCount: lines.length,
    hasTranslation: lines.some((l) => Boolean(l.koTranslation && l.koTranslation.trim())),
    lyricsHash,
    lines,
    mrYoutubeId: body?.mrYoutubeId ? String(body.mrYoutubeId).trim() : existing?.mrYoutubeId,
    mrSyncOffset: Number(body?.mrSyncOffset ?? existing?.mrSyncOffset ?? 0),
    karaokeYoutubeId: body?.karaokeYoutubeId
      ? String(body.karaokeYoutubeId).trim()
      : existing?.karaokeYoutubeId,
    karaokeSyncOffset: Number(body?.karaokeSyncOffset ?? existing?.karaokeSyncOffset ?? 0),
    disambiguatedCount: Number(body?.disambiguatedCount ?? 0),
    deviceLabel: body?.deviceLabel ? String(body.deviceLabel) : existing?.deviceLabel,
  };

  if (existing && existing.locked) {
    const updatedRevs = trimRevisions([...prevRevs, newRev], existing.activeRevisionId);
    const updatedExisting: CommunitySongAnalysis = {
      ...existing,
      revisions: updatedRevs,
      revisionCount: updatedRevs.length,
    };
    records[existingIdx] = updatedExisting;
    writeLibraryStore(records);
    res.json({
      ok: true,
      pendingSuggestion: true,
      version: newRev.version,
      summary: toSummary(updatedExisting),
    });
    return;
  }

  const nextRevs = trimRevisions([...prevRevs, newRev], newRev.revId);
  const nextRecord: CommunitySongAnalysis = {
    youtubeVideoId: vid,
    lyricsHash,
    pipelineVersion: String(body?.pipelineVersion || 'v1'),
    title: String(body?.title || '').trim() || existing?.title || '제목 없음',
    artist: String(body?.artist || '').trim() || existing?.artist || '',
    duration: Math.max(0, Number(body?.duration) || existing?.duration || 0),
    artworkUrl: body?.artworkUrl ? String(body.artworkUrl) : existing?.artworkUrl,
    mrYoutubeId: newRev.mrYoutubeId,
    mrSyncOffset: newRev.mrSyncOffset ?? 0,
    karaokeYoutubeId: newRev.karaokeYoutubeId,
    karaokeSyncOffset: newRev.karaokeSyncOffset ?? 0,
    lines,
    disambiguatedCount: newRev.disambiguatedCount ?? 0,
    deviceLabel: newRev.deviceLabel,
    upvotes: existing?.upvotes ?? Math.max(1, Number(body?.upvotes) || 1),
    upvoterIds: existing?.upvoterIds,
    updatedAt: nowIso,
    status: revStatus,
    locked: false,
    authorName,
    editNote,
    activeRevisionId: newRev.revId,
    revisionCount: nextRevs.length,
    revisions: nextRevs,
    reports: existing?.reports ?? [],
    reportCount: existing?.reportCount ?? 0,
    hidden: false,
  };

  if (existingIdx >= 0) {
    records[existingIdx] = nextRecord;
  } else {
    records.unshift(nextRecord);
  }
  writeLibraryStore(records);

  res.json({
    ok: true,
    pendingSuggestion: false,
    version: newRev.version,
    summary: toSummary(nextRecord),
  });
});

libraryRouter.post('/library/admin/verify', (req, res) => {
  const body = req.body as { adminKey?: string } | undefined;
  const candidate = String(body?.adminKey || req.header('x-admin-key') || '').trim();
  if (verifyAdminKeyString(candidate)) {
    res.json({ ok: true, isAdmin: true });
    return;
  }
  res.status(403).json({
    ok: false,
    isAdmin: false,
    error: '관리자 키가 올바르지 않습니다.',
  });
});

libraryRouter.post('/library/:videoId/revisions/:revId/activate', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  const revId = String(req.params.revId || '').trim();
  if (!isValidVideoId(vid) || !revId) {
    res.status(400).json({ error: '잘못된 요청입니다.' });
    return;
  }
  const records = readLibraryStore();
  const idx = records.findIndex((r) => r.youtubeVideoId === vid);
  const found = idx >= 0 ? records[idx] : undefined;
  const rev = found?.revisions?.find((r) => r.revId === revId);
  if (!found || !rev) {
    res.status(404).json({ error: '해당 버전을 찾을 수 없습니다.' });
    return;
  }
  if ((found.locked || found.status === 'verified') && !isAdminRequest(req)) {
    res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
    return;
  }

  const nextStatus: LibraryQualityStatus = rev.status === 'verified' ? 'verified' : rev.status;
  const nextRecord: CommunitySongAnalysis = {
    ...found,
    lines: rev.lines,
    lyricsHash: rev.lyricsHash,
    mrYoutubeId: rev.mrYoutubeId ?? found.mrYoutubeId,
    mrSyncOffset: rev.mrSyncOffset ?? found.mrSyncOffset,
    karaokeYoutubeId: rev.karaokeYoutubeId ?? found.karaokeYoutubeId,
    karaokeSyncOffset: rev.karaokeSyncOffset ?? found.karaokeSyncOffset,
    disambiguatedCount: rev.disambiguatedCount ?? found.disambiguatedCount,
    deviceLabel: rev.deviceLabel ?? found.deviceLabel,
    status: nextStatus,
    locked: nextStatus === 'verified' ? Boolean(found.locked) : false,
    authorName: rev.authorName,
    editNote: rev.editNote,
    activeRevisionId: rev.revId,
    hidden: false,
    updatedAt: new Date().toISOString(),
  };

  records[idx] = nextRecord;
  writeLibraryStore(records);
  res.json({ ok: true, summary: toSummary(nextRecord) });
});

libraryRouter.post('/library/:videoId/report', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const body = req.body as { reason?: LibraryReportReason; note?: string } | undefined;
  const reason: LibraryReportReason =
    body?.reason === 'sync' ||
    body?.reason === 'pronunciation' ||
    body?.reason === 'lyrics' ||
    body?.reason === 'other'
      ? body.reason
      : 'other';

  const records = readLibraryStore();
  const idx = records.findIndex((r) => r.youtubeVideoId === vid);
  const found = idx >= 0 ? records[idx] : undefined;
  if (!found) {
    res.status(404).json({ error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' });
    return;
  }

  const entry: LibraryReportEntry = {
    id: `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    reason,
    note: String(body?.note || '').trim().slice(0, 180),
    createdAt: new Date().toISOString(),
  };

  const nextReports = [...(found.reports || []), entry].slice(-20);
  const nextCount = (found.reportCount ?? 0) + 1;
  const shouldHide =
    !found.locked &&
    found.status !== 'verified' &&
    nextCount >= AUTO_HIDE_REPORT_THRESHOLD;

  records[idx] = {
    ...found,
    reports: nextReports,
    reportCount: nextCount,
    hidden: found.hidden || shouldHide,
  };
  writeLibraryStore(records);

  res.json({
    ok: true,
    reportCount: nextCount,
    hidden: Boolean(records[idx].hidden),
    summary: toSummary(records[idx]),
  });
});

libraryRouter.post('/library/:videoId/moderate', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
    return;
  }
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const body = req.body as
    | { action?: 'verify' | 'unverify' | 'lock' | 'unlock' | 'dismiss_reports' | 'restore' }
    | undefined;
  const action = body?.action;
  if (!action) {
    res.status(400).json({ error: '유효한 관리 액션(action)이 필요합니다.' });
    return;
  }

  const records = readLibraryStore();
  const idx = records.findIndex((r) => r.youtubeVideoId === vid);
  const found = idx >= 0 ? records[idx] : undefined;
  if (!found) {
    res.status(404).json({ error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' });
    return;
  }

  const next = { ...found };
  const revs = [...(found.revisions || [])];
  const activeIdx = revs.findIndex((r) => r.revId === found.activeRevisionId);

  if (action === 'verify') {
    next.status = 'verified';
    next.locked = true;
    next.hidden = false;
    next.reports = [];
    next.reportCount = 0;
    if (activeIdx >= 0) {
      revs[activeIdx] = { ...revs[activeIdx], status: 'verified' };
      next.revisions = revs;
    }
  } else if (action === 'unverify') {
    next.status = 'edited';
    next.locked = false;
    if (activeIdx >= 0 && revs[activeIdx].status === 'verified') {
      revs[activeIdx] = { ...revs[activeIdx], status: 'edited' };
      next.revisions = revs;
    }
  } else if (action === 'lock') {
    next.locked = true;
  } else if (action === 'unlock') {
    next.locked = false;
  } else if (action === 'dismiss_reports' || action === 'restore') {
    next.reports = [];
    next.reportCount = 0;
    next.hidden = false;
  } else {
    res.status(400).json({ error: '지원하지 않는 관리 액션입니다.' });
    return;
  }

  records[idx] = next;
  writeLibraryStore(records);
  res.json({ ok: true, summary: toSummary(next) });
});

libraryRouter.post('/library/:videoId/upvote', (req, res) => {
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const body = req.body as { voterId?: string } | undefined;
  const rawVoter = String(body?.voterId || '').trim().slice(0, 64);
  const voterKey = rawVoter || `ip:${req.ip || 'local'}`;

  const records = readLibraryStore();
  const found = records.find((r) => r.youtubeVideoId === vid);
  if (!found) {
    res.status(404).json({ error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' });
    return;
  }

  let voters = Array.isArray(found.upvoterIds) ? [...found.upvoterIds] : [];
  let voted = false;
  if (voters.includes(voterKey)) {
    voters = voters.filter((id) => id !== voterKey);
    found.upvotes = Math.max(0, Number(found.upvotes ?? 1) - 1);
    voted = false;
  } else {
    voters.push(voterKey);
    if (voters.length > 5000) {
      voters = voters.slice(-5000);
    }
    found.upvotes = Math.max(0, Number(found.upvotes ?? 0)) + 1;
    voted = true;
  }
  found.upvoterIds = voters;
  writeLibraryStore(records);
  res.json({ ok: true, upvotes: found.upvotes, voted });
});

libraryRouter.delete('/library/:videoId', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
    return;
  }
  const vid = String(req.params.videoId || '').trim();
  if (!isValidVideoId(vid)) {
    res.status(400).json({ error: '잘못된 YouTube ID입니다.' });
    return;
  }
  const records = readLibraryStore();
  const next = records.filter((r) => r.youtubeVideoId !== vid);
  if (next.length !== records.length) {
    writeLibraryStore(next);
  }
  res.json({ ok: true });
});
