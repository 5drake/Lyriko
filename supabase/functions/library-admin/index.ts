const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_ORIGIN = 'https://5drake.github.io';
const MOD_ACTIONS = new Set(['verify', 'unverify', 'lock', 'unlock', 'dismiss_reports', 'restore']);

function checkOrigin(originHeader: string | null): { allowed: boolean; corsOrigin: string } {
  if (!originHeader?.trim()) return { allowed: true, corsOrigin: DEFAULT_ORIGIN };
  try {
    const u = new URL(originHeader.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, corsOrigin: DEFAULT_ORIGIN };
    const norm = u.origin.toLowerCase();
    const host = u.hostname.toLowerCase();
    const extras = (Deno.env.get('LYRIKO_ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
    if (norm === DEFAULT_ORIGIN || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || extras.includes(norm)) {
      return { allowed: true, corsOrigin: u.origin };
    }
  } catch { /* invalid origin */ }
  return { allowed: false, corsOrigin: DEFAULT_ORIGIN };
}

const corsHdrs = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
});

const jsonResp = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHdrs(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const [ba, bb] = [new Uint8Array(ha), new Uint8Array(hb)];
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function rowToSummary(row: Record<string, any>) {
  const lines = Array.isArray(row.lines_json) ? row.lines_json : [];
  const status = row.status === 'verified' || row.status === 'edited' || row.status === 'auto' ? row.status : 'auto';
  return {
    youtubeVideoId: row.youtube_video_id,
    lyricsHash: row.lyrics_hash || '',
    pipelineVersion: row.pipeline_version || 'v1',
    title: row.title || '',
    artist: row.artist || '',
    duration: Number(row.duration) || 0,
    artworkUrl: row.artwork_url ?? undefined,
    mrYoutubeId: row.mr_youtube_id ?? undefined,
    mrSyncOffset: Number(row.mr_sync_offset ?? 0),
    karaokeYoutubeId: row.karaoke_youtube_id ?? undefined,
    karaokeSyncOffset: Number(row.karaoke_sync_offset ?? 0),
    lineCount: lines.length,
    hasTranslation: lines.some((l: any) => Boolean(l?.koTranslation?.trim?.())),
    disambiguatedCount: Number(row.disambiguated_count ?? 0),
    deviceLabel: row.device_label ?? undefined,
    upvotes: Number(row.upvotes ?? 1),
    updatedAt: row.updated_at || new Date().toISOString(),
    status,
    locked: Boolean(row.locked),
    authorName: row.author_name || 'AI 자동 분석',
    editNote: row.edit_note || '',
    activeRevisionId: row.active_revision_id ?? undefined,
    revisionCount: Math.max(1, Number(row.revision_count ?? 1)),
    reportCount: Number(row.report_count ?? 0),
    hidden: Boolean(row.hidden),
  };
}

Deno.serve(async (req: Request) => {
  const { allowed, corsOrigin } = checkOrigin(req.headers.get('origin'));
  if (!allowed) return jsonResp({ ok: false, error: '허용되지 않은 출처입니다.' }, 403, corsOrigin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHdrs(corsOrigin) });
  if (req.method !== 'POST') return jsonResp({ ok: false, error: 'Method not allowed' }, 405, corsOrigin);

  const url = (Deno.env.get('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const key = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  if (!url || !key) return jsonResp({ ok: false, error: 'Supabase 서비스 구성이 누락되었습니다.' }, 503, corsOrigin);

  const pgRest = (path: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    h.set('apikey', key);
    h.set('Authorization', `Bearer ${key}`);
    if (!h.has('Content-Type') && init.body) h.set('Content-Type', 'application/json');
    return fetch(`${url}/rest/v1/${path}`, { ...init, headers: h, signal: AbortSignal.timeout(9000) });
  };

  let body: Record<string, any> = {};
  try {
    const raw = await req.text();
    if (raw.trim()) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) body = p;
    }
  } catch {
    return jsonResp({ ok: false, error: '잘못된 JSON 요청입니다.' }, 400, corsOrigin);
  }

  const candidate = (req.headers.get('x-admin-key') || (typeof body.adminKey === 'string' ? body.adminKey : '')).trim();
  const envSecret = (Deno.env.get('LYRIKO_ADMIN_KEY') || '').trim();
  const source: 'env' | 'db' = envSecret ? 'env' : 'db';
  let authed = false;
  if (candidate) {
    if (envSecret) {
      authed = await safeEqual(candidate, envSecret);
    } else {
      const vr = await pgRest('rpc/verify_lyriko_admin_key', { method: 'POST', body: JSON.stringify({ candidate }) });
      if (!vr.ok) return jsonResp({ ok: false, error: '관리자 인증 확인 중 서버 오류가 발생했습니다.' }, 500, corsOrigin);
      authed = (await vr.json().catch(() => false)) === true;
    }
  }
  if (!authed) {
    await new Promise((r) => setTimeout(r, 300));
    return jsonResp({ ok: false, isAdmin: false, error: '관리자 키가 올바르지 않습니다.' }, 401, corsOrigin);
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (action === 'verify') {
    return jsonResp({ ok: true, isAdmin: true, mode: 'supabase', passwordSource: source, canChangePassword: source === 'db' }, 200, corsOrigin);
  }
  if (action === 'change_password') {
    if (source === 'env') return jsonResp({ ok: false, error: 'Supabase Secrets(LYRIKO_ADMIN_KEY)로 설정된 키는 Supabase 대시보드에서 변경해 주세요.' }, 400, corsOrigin);
    const newKey = typeof body.newKey === 'string' ? body.newKey.trim() : '';
    if (newKey.length < 4 || newKey.length > 128) return jsonResp({ ok: false, error: '새 비밀번호는 4자 이상 128자 이하로 입력해 주세요.' }, 400, corsOrigin);
    const sr = await pgRest('rpc/set_lyriko_admin_key', { method: 'POST', body: JSON.stringify({ new_key: newKey }) });
    return sr.ok ? jsonResp({ ok: true }, 200, corsOrigin) : jsonResp({ ok: false, error: '비밀번호 변경에 실패했습니다.' }, 500, corsOrigin);
  }

  const vid = typeof body.youtubeVideoId === 'string' ? body.youtubeVideoId.trim() : '';
  if (!VID_RE.test(vid)) return jsonResp({ ok: false, error: '잘못된 YouTube ID입니다.' }, 400, corsOrigin);
  const encVid = encodeURIComponent(vid);

  if (action === 'list_reports') {
    const rr = await pgRest(`song_reports?youtube_video_id=eq.${encVid}&select=id,reason,note,created_at&order=created_at.desc&limit=30`);
    if (!rr.ok) return jsonResp({ ok: false, error: '신고 내역을 불러오지 못했습니다.' }, 500, corsOrigin);
    const rows = (await rr.json().catch(() => [])) as any[];
    const reports = rows.map((r) => ({
      id: String(r.id),
      reason: r.reason === 'sync' || r.reason === 'pronunciation' || r.reason === 'lyrics' || r.reason === 'other' ? r.reason : 'other',
      note: r.note || '',
      createdAt: r.created_at || new Date().toISOString(),
    }));
    return jsonResp({ ok: true, reports }, 200, corsOrigin);
  }

  if (action === 'moderate') {
    const ma = typeof body.moderateAction === 'string' ? body.moderateAction.trim() : '';
    if (!MOD_ACTIONS.has(ma)) return jsonResp({ ok: false, error: '지원하지 않는 관리 액션입니다.' }, 400, corsOrigin);
    const cr = await pgRest(`song_analyses?youtube_video_id=eq.${encVid}&select=*&limit=1`);
    if (!cr.ok) return jsonResp({ ok: false, error: '곡 정보를 조회하지 못했습니다.' }, 500, corsOrigin);
    const existing = ((await cr.json().catch(() => [])) as any[])[0];
    if (!existing) return jsonResp({ ok: false, error: '라이브러리에서 해당 곡을 찾을 수 없습니다.' }, 404, corsOrigin);

    const patchBody =
      ma === 'verify' ? { status: 'verified', locked: true, hidden: false, report_count: 0 }
      : ma === 'unverify' ? { status: 'edited', locked: false }
      : ma === 'lock' ? { locked: true }
      : ma === 'unlock' ? { locked: false }
      : { report_count: 0, hidden: false };
    const pr = await pgRest(`song_analyses?youtube_video_id=eq.${encVid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patchBody) });
    if (!pr.ok) return jsonResp({ ok: false, error: '곡 상태를 변경하지 못했습니다.' }, 500, corsOrigin);
    const updated = ((await pr.json().catch(() => [])) as any[])[0] || existing;

    if (ma === 'verify' || ma === 'dismiss_reports' || ma === 'restore') {
      await pgRest(`song_reports?youtube_video_id=eq.${encVid}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if ((ma === 'verify' || ma === 'unverify') && existing.active_revision_id) {
      const targetRevStatus = ma === 'verify' ? 'verified' : 'edited';
      const filter = ma === 'unverify' ? `&status=eq.verified` : '';
      await pgRest(`song_revisions?youtube_video_id=eq.${encVid}&rev_id=eq.${encodeURIComponent(existing.active_revision_id)}${filter}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: targetRevStatus }),
      }).catch(() => undefined);
    }
    return jsonResp({ ok: true, summary: rowToSummary(updated) }, 200, corsOrigin);
  }

  if (action === 'activate_revision') {
    const revId = typeof body.revId === 'string' ? body.revId.trim() : '';
    if (!revId) return jsonResp({ ok: false, error: '잘못된 버전 ID입니다.' }, 400, corsOrigin);
    const [sr, rr] = await Promise.all([
      pgRest(`song_analyses?youtube_video_id=eq.${encVid}&select=*&limit=1`),
      pgRest(`song_revisions?youtube_video_id=eq.${encVid}&rev_id=eq.${encodeURIComponent(revId)}&select=*&limit=1`),
    ]);
    if (!sr.ok || !rr.ok) return jsonResp({ ok: false, error: '버전 정보를 조회하지 못했습니다.' }, 500, corsOrigin);
    const song = ((await sr.json().catch(() => [])) as any[])[0];
    const rev = ((await rr.json().catch(() => [])) as any[])[0];
    if (!song || !rev || !Array.isArray(rev.lines_json)) return jsonResp({ ok: false, error: '해당 버전을 찾을 수 없습니다.' }, 404, corsOrigin);

    const nextStatus = rev.status === 'verified' ? 'verified' : rev.status === 'auto' ? 'auto' : 'edited';
    const pr = await pgRest(`song_analyses?youtube_video_id=eq.${encVid}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        lines_json: rev.lines_json,
        lyrics_hash: rev.lyrics_hash || song.lyrics_hash,
        mr_youtube_id: rev.mr_youtube_id ?? song.mr_youtube_id ?? null,
        mr_sync_offset: Number(rev.mr_sync_offset ?? song.mr_sync_offset ?? 0),
        karaoke_youtube_id: rev.karaoke_youtube_id ?? song.karaoke_youtube_id ?? null,
        karaoke_sync_offset: Number(rev.karaoke_sync_offset ?? song.karaoke_sync_offset ?? 0),
        disambiguated_count: Number(rev.disambiguated_count ?? song.disambiguated_count ?? 0),
        device_label: rev.device_label ?? song.device_label ?? null,
        status: nextStatus,
        locked: nextStatus === 'verified' ? Boolean(song.locked) : false,
        author_name: rev.author_name || song.author_name || '익명 기여자',
        edit_note: rev.edit_note || '',
        active_revision_id: rev.rev_id,
        hidden: false,
      }),
    });
    if (!pr.ok) return jsonResp({ ok: false, error: '대표 버전 전환에 실패했습니다.' }, 500, corsOrigin);
    const updated = ((await pr.json().catch(() => [])) as any[])[0] || song;
    return jsonResp({ ok: true, summary: rowToSummary(updated) }, 200, corsOrigin);
  }

  if (action === 'delete') {
    const dr = await pgRest(`song_analyses?youtube_video_id=eq.${encVid}`, { method: 'DELETE' });
    return dr.ok ? jsonResp({ ok: true }, 200, corsOrigin) : jsonResp({ ok: false, error: '곡 삭제에 실패했습니다.' }, 500, corsOrigin);
  }

  return jsonResp({ ok: false, error: '지원하지 않는 관리 작업입니다.' }, 400, corsOrigin);
});
