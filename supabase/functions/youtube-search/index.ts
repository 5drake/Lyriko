// Supabase Edge Function: youtube-search
// Public 3-track (Original / MR / Karaoke) YouTube search & autocomplete for Lyriko

const VALID_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const HANGUL_RE = /[가-힣]/;
const YT_SUGGEST_NOISE_END_RE =
  /\s+(?:라이브|피아노|1시간|1hour|기타|커버|내한|리액션|베이스|드럼|노래방|가사|악보|mr|inst|cover|live|bass|piano|guitar|drums?|acoustic|karaoke|カラオケ)$/i;
const YT_TITLE_BRACKET_RE = /\[[^\]]*\]|【[^】]*】/g;
const LATIN_NOISE_WORDS = new Set([
  'live', 'lyrics', 'lyric', 'kor', 'jp', 'jpn', 'jap', 'kan', 'rom', 'sub',
  'mv', 'pv', 'music', 'video', 'official', 'ver', 'version', 'hd', '4k',
  'short', 'shorts', 'jpop', 'cover', 'karaoke', 'inst', 'instrumental',
  'mr', 'off', 'on', 'vocal', 'audio', 'playlist', 'feat', 'ft', 'with', 'the',
]);

const PURE_MR_KEYWORDS_RE =
  /off\s*vocal|off\s*main\s*vocal|instrumental|\binst\.?\b|\bmr\b|반주|보컬\s*제거|vocal\s*remov|no\s*vocal|backing\s*track|マイナスワン|minus\s*one/i;
const NO_GUIDE_RE =
  /ガイド無し|ガイドなし|ガイドメロディ無し|ガイドメロディなし|no\s*guide|가이드\s*없/i;
const GUIDE_MELODY_RE =
  /ガイドメロディ|ガイドあり|ガイド付き|가이드\s*멜로디|with\s*guide|on\s*melody/i;
const MR_KEYWORDS_RE =
  /off\s*vocal|off\s*main\s*vocal|instrumental|\binst\.?\b|\bmr\b|반주|보컬\s*제거|vocal\s*remov|no\s*vocal|ガイド無し|ガイドなし|가이드\s*없|no\s*guide|backing\s*track|マイナスワン|minus\s*one/i;
const KARAOKE_KEYWORDS_RE =
  /カラオケ|karaoke|노래방|歌っちゃ王|生音風|가라오케|ガイドメロディ|ガイドあり|가이드\s*멜로디|금영|태진|\btj\b|\bky\b|joysound|\bdam\b|ニコカラ/i;
const KARAOKE_CHANNEL_RE =
  /歌っちゃ王|生音風|カラオケ制作|カラオケスタジオ|カラオケ音源|カラオケチャンネル|karaoke|노래방|금영|태진|joysound|\bdam\b|ニコカラ|sing\s*king|karafun|utacchao/i;
const ON_VOCAL_RE = /on\s*vocal|歌付き|ボーカル入り|가이드\s*보컬/i;
const COVER_NOISE_RE = /歌ってみた|cover|커버|live|라이브|일콘|콘서트|reaction|리액션|1시간|1hour/i;
const FAN_LYRIC_NOISE_RE = /가사\/발음|가사\/해석|가사집|kor\/jp\s*lyrics|playlist/i;
const TV_SHORT_OP_RE = /ノンクレジット|non-credit|creditless|\bncop\b|\bnced\b/i;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

interface YoutubeSearchCandidate {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail?: string;
  viewCount?: number;
  badges?: string[];
}

interface ResolvedSongInfo {
  title: string;
  artist: string;
  duration: number;
  artworkUrl?: string;
  canonicalQuery: string;
}

interface SongSuggestTrack {
  trackName: string;
  artistName: string;
  duration: number;
  artworkUrl?: string;
  query: string;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseDurationSeconds(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.trim().split(':').map((p) => Number(p.replace(/[^\d]/g, '')));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseViewCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const numUnit = trimmed.match(/([\d,.]+)\s*(억|万|만|천|M|K|B)/i);
  if (numUnit) {
    const base = Number(numUnit[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return undefined;
    const u = numUnit[2];
    const mult =
      u === '억' ? 100_000_000 :
      u === 'B' || u === 'b' ? 1_000_000_000 :
      u === 'M' || u === 'm' ? 1_000_000 :
      u === '万' || u === '만' ? 10_000 :
      u === '천' || u === 'K' || u === 'k' ? 1_000 : 1;
    return Math.round(base * mult);
  }
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function fetchItunesJpTracks(term: string, limit = 6): Promise<SongSuggestTrack[]> {
  const clean = term.trim();
  if (!clean) return [];
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=song&limit=${limit}&country=JP`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'LyrikoStudio/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{
        trackName?: string;
        artistName?: string;
        trackTimeMillis?: number;
        artworkUrl100?: string;
      }>;
    };
    const tracks: SongSuggestTrack[] = [];
    const seen = new Set<string>();
    for (const item of data.results ?? []) {
      const trackName = (item.trackName ?? '').trim();
      const artistName = (item.artistName ?? '').trim();
      const duration = Math.round(Number(item.trackTimeMillis ?? 0) / 1000);
      if (!trackName || !artistName) continue;
      if (duration > 0 && (duration < 55 || duration > 600)) continue;
      const key = `${trackName.toLowerCase()}|${artistName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({
        trackName,
        artistName,
        duration,
        artworkUrl: item.artworkUrl100 || undefined,
        query: `${trackName} ${artistName}`.trim(),
      });
    }
    return tracks;
  } catch {
    return [];
  }
}

async function fetchYoutubeSuggestKeywords(term: string): Promise<string[]> {
  const clean = term.trim();
  if (!clean) return [];
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&q=${encodeURIComponent(clean)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(3500),
    });
    if (!resp.ok) return [];
    const raw = (await resp.json()) as [string, string[]];
    const items = Array.isArray(raw?.[1]) ? raw[1] : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const s = String(item ?? '').trim();
      if (!s) continue;
      if (YT_SUGGEST_NOISE_END_RE.test(s)) continue;
      const low = s.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(s);
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function searchYoutubeInnertube(
  searchQuery: string,
  limit = 6
): Promise<YoutubeSearchCandidate[]> {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,ko;q=0.9,en;q=0.8',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20241120.01.00',
            hl: 'ja',
            gl: 'JP',
          },
        },
        query: searchQuery,
      }),
      signal: AbortSignal.timeout(5500),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      contents?: {
        twoColumnSearchResultsRenderer?: {
          primaryContents?: {
            sectionListRenderer?: {
              contents?: Array<{
                itemSectionRenderer?: {
                  contents?: Array<{
                    videoRenderer?: {
                      videoId?: string;
                      title?: { runs?: Array<{ text?: string }>; simpleText?: string };
                      ownerText?: { runs?: Array<{ text?: string }> };
                      longBylineText?: { runs?: Array<{ text?: string }> };
                      lengthText?: { simpleText?: string };
                      viewCountText?: { simpleText?: string };
                    };
                  }>;
                };
              }>;
            };
          };
        };
      };
    };

    const sections =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
    const results: YoutubeSearchCandidate[] = [];
    const seen = new Set<string>();

    for (const sec of sections) {
      const items = sec?.itemSectionRenderer?.contents ?? [];
      for (const item of items) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;
        const id = v.videoId.trim();
        if (!VALID_VIDEO_ID_RE.test(id) || seen.has(id)) continue;
        const title = (
          v.title?.runs?.map((r) => r.text ?? '').join('') ||
          v.title?.simpleText ||
          ''
        ).trim();
        if (!title) continue;
        const duration = parseDurationSeconds(v.lengthText?.simpleText);
        if (duration <= 0) continue; // skip livestreams/unplayable shorts without length
        if (duration < 55 || duration > 600) continue;

        seen.add(id);
        const channel = (
          v.ownerText?.runs?.map((r) => r.text ?? '').join('') ||
          v.longBylineText?.runs?.map((r) => r.text ?? '').join('') ||
          ''
        )
          .replace(/\s*-\s*Topic$/i, '')
          .trim();

        results.push({
          videoId: id,
          url: `https://www.youtube.com/watch?v=${id}`,
          title,
          channel,
          duration,
          thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          viewCount: parseViewCount(v.viewCountText?.simpleText),
        });
        if (results.length >= limit) return results;
      }
    }
    return results;
  } catch {
    return [];
  }
}

function extractCanonicalQueriesFromTitles(titles: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const addQ = (q: string) => {
    const clean = q.replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return;
    const low = clean.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      queries.push(clean);
    }
  };

  const jpSegments: string[] = [];
  const latinArtists: string[] = [];

  for (const rawTitle of titles.slice(0, 3)) {
    const stripped = rawTitle.replace(YT_TITLE_BRACKET_RE, ' ');
    const jpMatches =
      stripped.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]+/g) ?? [];
    for (const seg of jpMatches) {
      if (seg.length >= 2 && !jpSegments.includes(seg)) jpSegments.push(seg);
    }

    const latinWords = (stripped.match(/[A-Za-z][A-Za-z0-9'&-]{1,}/g) ?? []).filter(
      (w) => !LATIN_NOISE_WORDS.has(w.toLowerCase())
    );
    for (const w of latinWords) {
      if (!latinArtists.includes(w)) latinArtists.push(w);
    }

    if (jpMatches.length > 0 && latinWords.length > 0) {
      addQ(`${jpMatches.slice(0, 2).join(' ')} ${latinWords.slice(0, 2).join(' ')}`);
    } else if (latinWords.length >= 2) {
      addQ(latinWords.slice(0, 3).join(' '));
    }
  }

  if (jpSegments.length > 0) {
    addQ(`${jpSegments[0]} ${latinArtists.slice(0, 2).join(' ')}`);
    addQ(jpSegments[0]);
  }
  if (latinArtists.length >= 2) {
    addQ(latinArtists.slice(0, 3).join(' '));
  }
  return queries.slice(0, 3);
}

function pickBestResolvedTrack(
  tracks: SongSuggestTrack[],
  referenceText: string
): SongSuggestTrack | null {
  if (tracks.length === 0) return null;
  const lowRef = referenceText.toLowerCase();
  let best = tracks[0];
  let bestScore = -1;
  for (const t of tracks) {
    let sc = 0;
    const trLow = t.trackName.toLowerCase();
    const arLow = t.artistName.toLowerCase();
    if (lowRef.includes(trLow)) sc += 60;
    if (lowRef.includes(arLow)) sc += 40;
    for (const tok of `${trLow} ${arLow}`.split(/\s+/)) {
      if (tok.length >= 2 && lowRef.includes(tok)) sc += 15;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }
  return best;
}

async function resolveCanonicalSongFromQuery(rawQuery: string): Promise<{
  resolvedSong?: ResolvedSongInfo;
  seedPool: YoutubeSearchCandidate[];
}> {
  if (!HANGUL_RE.test(rawQuery)) {
    const tracks = await fetchItunesJpTracks(rawQuery, 5);
    const best = pickBestResolvedTrack(tracks, rawQuery);
    if (!best) return { seedPool: [] };
    return {
      resolvedSong: {
        title: best.trackName,
        artist: best.artistName,
        duration: best.duration,
        artworkUrl: best.artworkUrl,
        canonicalQuery: best.query,
      },
      seedPool: [],
    };
  }

  const seedPool = await searchYoutubeInnertube(rawQuery, 5);
  if (seedPool.length === 0) return { seedPool: [] };

  const candidateQueries = extractCanonicalQueriesFromTitles(seedPool.map((c) => c.title));
  const combinedTitleText = `${rawQuery} ${seedPool.map((c) => c.title).join(' ')}`;

  for (const cq of candidateQueries) {
    const tracks = await fetchItunesJpTracks(cq, 5);
    const best = pickBestResolvedTrack(tracks, combinedTitleText);
    if (best) {
      return {
        resolvedSong: {
          title: best.trackName,
          artist: best.artistName,
          duration: best.duration,
          artworkUrl: best.artworkUrl,
          canonicalQuery: best.query,
        },
        seedPool,
      };
    }
  }
  return { seedPool };
}

function buildQueryTokens(effectiveQuery: string): string[] {
  const tokens = new Set<string>();
  for (const tok of effectiveQuery.toLowerCase().split(/\s+/)) {
    const t = tok.trim();
    if (t.length >= 2) tokens.add(t);
  }
  const jpRuns =
    effectiveQuery.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]{2,}/g) ?? [];
  for (const run of jpRuns) {
    tokens.add(run.toLowerCase());
  }
  return [...tokens];
}

function scoreQueryMatch(c: YoutubeSearchCandidate, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = `${c.title} ${c.channel}`.toLowerCase();
  let matched = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) matched += 1;
  }
  if (matched === 0) return -70;
  return matched * 35;
}

function scoreOriginal(
  c: YoutubeSearchCandidate,
  queryTokens: string[],
  resolvedSong?: ResolvedSongInfo
): number {
  let s = scoreQueryMatch(c, queryTokens);
  if (KARAOKE_KEYWORDS_RE.test(c.title) || MR_KEYWORDS_RE.test(c.title)) s -= 90;
  if (COVER_NOISE_RE.test(c.title)) s -= 40;
  if (FAN_LYRIC_NOISE_RE.test(c.title)) s -= 40;
  if (TV_SHORT_OP_RE.test(c.title) || (c.duration > 0 && c.duration <= 100)) s -= 35;
  if (/music\s*video|\bmv\b|official|공식/i.test(c.title)) s += 35;
  if (resolvedSong?.artist) {
    const ch = c.channel.toLowerCase();
    const ar = resolvedSong.artist.toLowerCase();
    if (ch && ar && (ch.includes(ar) || ar.includes(ch))) s += 40;
  }
  if (typeof c.viewCount === 'number') {
    if (c.viewCount >= 1_000_000) s += 25;
    else if (c.viewCount >= 100_000) s += 15;
    else if (c.viewCount >= 10_000) s += 5;
  }
  const refDur = resolvedSong?.duration || 0;
  if (refDur > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDur);
    if (diff <= 6) s += 25;
    else if (diff <= 15) s += 12;
    else if (diff > 45) s -= 25;
  } else if (c.duration >= 140 && c.duration <= 360) {
    s += 20;
  }
  return s;
}

function scoreMr(
  c: YoutubeSearchCandidate,
  refDuration: number,
  queryTokens: string[],
  resolvedSong?: ResolvedSongInfo,
  fromKarOnly = false
): number {
  let s = scoreQueryMatch(c, queryTokens);
  const isPureMr = PURE_MR_KEYWORDS_RE.test(c.title);
  const hasNoGuide = NO_GUIDE_RE.test(c.title);
  const isKarTitle = KARAOKE_KEYWORDS_RE.test(c.title);
  const isKarChannel = KARAOKE_CHANNEL_RE.test(c.channel);
  const hasGuide = !hasNoGuide && GUIDE_MELODY_RE.test(c.title);

  const ch = c.channel.toLowerCase();
  const ar = (resolvedSong?.artist || '').toLowerCase();
  const isArtistChannel = Boolean(ch && ar && (ch.includes(ar) || ar.includes(ch)));

  if (isPureMr) s += 65;
  if (isPureMr && !isKarTitle && !isKarChannel) s += 45;
  if (
    /\binstrumental\b|\binst\.?\b|\bmr\b|보컬\s*제거|vocal\s*remov/i.test(c.title) &&
    !isKarTitle &&
    !isKarChannel
  ) {
    s += 25;
  }
  if (isArtistChannel && isPureMr) s += 50;
  if (hasNoGuide) s += 15;

  if (isKarChannel) s -= 85;
  if (isKarTitle) s -= hasNoGuide ? 40 : 75;
  if (hasGuide) s -= 60;
  if (ON_VOCAL_RE.test(c.title)) s -= 75;
  if (fromKarOnly && !isPureMr) s -= 45;
  if (COVER_NOISE_RE.test(c.title)) s -= 35;

  if (refDuration > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDuration);
    if (diff <= 6) s += 30;
    else if (diff <= 15) s += 15;
    else if (diff > 45) s -= 30;
  }
  return s;
}

function scoreKaraoke(
  c: YoutubeSearchCandidate,
  refDuration: number,
  queryTokens: string[]
): number {
  let s = scoreQueryMatch(c, queryTokens);
  if (KARAOKE_KEYWORDS_RE.test(c.title) || KARAOKE_CHANNEL_RE.test(c.channel)) s += 60;
  if (
    GUIDE_MELODY_RE.test(c.title) ||
    /【カラオケ】|歌っちゃ王|生音風|노래방|가라오케|\btj\b|\bky\b|joysound|\bdam\b/i.test(
      `${c.title} ${c.channel}`
    )
  ) {
    s += 35;
  }
  if (NO_GUIDE_RE.test(c.title)) {
    s -= 55;
  } else if (
    MR_KEYWORDS_RE.test(c.title) &&
    !GUIDE_MELODY_RE.test(c.title) &&
    !KARAOKE_CHANNEL_RE.test(c.channel) &&
    !/【カラオケ】|\btj\b|\bky\b|joysound|\bdam\b/i.test(`${c.title} ${c.channel}`)
  ) {
    s -= 45;
  }
  if (COVER_NOISE_RE.test(c.title)) s -= 30;
  if (refDuration > 90 && c.duration > 0) {
    const diff = Math.abs(c.duration - refDuration);
    if (diff <= 6) s += 30;
    else if (diff <= 15) s += 15;
    else if (diff > 45) s -= 30;
  }
  return s;
}

function attachCandidateBadges(
  c: YoutubeSearchCandidate,
  slot: 'original' | 'mr' | 'karaoke',
  refDuration: number
): YoutubeSearchCandidate {
  const badges: string[] = [];
  if (slot === 'original' && /music\s*video|\bmv\b|official|공식/i.test(c.title)) {
    badges.push('공식 MV');
  }
  if (
    slot === 'mr' &&
    PURE_MR_KEYWORDS_RE.test(c.title) &&
    !KARAOKE_KEYWORDS_RE.test(c.title) &&
    !KARAOKE_CHANNEL_RE.test(c.channel)
  ) {
    badges.push('순수 MR');
  }
  if (NO_GUIDE_RE.test(c.title)) {
    badges.push('가이드 없음');
  } else if (
    GUIDE_MELODY_RE.test(c.title) ||
    KARAOKE_CHANNEL_RE.test(`${c.title} ${c.channel}`)
  ) {
    badges.push('가이드 멜로디');
  }
  if (refDuration > 90 && c.duration > 0 && Math.abs(c.duration - refDuration) <= 6) {
    badges.push('길이 일치');
  }
  return { ...c, badges };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  const apikey = (req.headers.get('apikey') ?? '').trim();
  if (!apikey) {
    return jsonResp({ error: 'Missing apikey header' }, 401);
  }

  const url = new URL(req.url);
  const action = (url.searchParams.get('action') ?? '').trim();
  const q = (url.searchParams.get('q') ?? '').trim();

  if (q.length < 1 || q.length > 120) {
    return jsonResp({ error: '검색어(q)는 1~120자 이내로 입력해 주세요.' }, 400);
  }

  if (action === 'suggest') {
    const [tracksRes, keywordsRes] = await Promise.allSettled([
      fetchItunesJpTracks(q, 6),
      fetchYoutubeSuggestKeywords(q),
    ]);
    return jsonResp({
      query: q,
      tracks: tracksRes.status === 'fulfilled' ? tracksRes.value : [],
      keywords: keywordsRes.status === 'fulfilled' ? keywordsRes.value : [],
    });
  }

  if (action === 'search-tracks') {
    const titleHint = (url.searchParams.get('title') ?? '').trim();
    const artistHint = (url.searchParams.get('artist') ?? '').trim();
    const durationHint = Number(url.searchParams.get('duration') ?? 0);
    const artworkHint = (url.searchParams.get('artwork') ?? '').trim();

    let resolvedSong: ResolvedSongInfo | undefined;
    let seedPool: YoutubeSearchCandidate[] = [];

    if (titleHint) {
      resolvedSong = {
        title: titleHint,
        artist: artistHint,
        duration: Number.isFinite(durationHint) ? Math.round(durationHint) : 0,
        artworkUrl: artworkHint || undefined,
        canonicalQuery: `${titleHint} ${artistHint}`.trim(),
      };
    } else {
      const resolved = await resolveCanonicalSongFromQuery(q);
      resolvedSong = resolved.resolvedSong;
      seedPool = resolved.seedPool;
    }

    const effectiveQuery = resolvedSong?.canonicalQuery || q;
    const queryTokens = buildQueryTokens(effectiveQuery);

    const [rOrig, rMrInst, rMrOff, rKar] = await Promise.allSettled([
      searchYoutubeInnertube(effectiveQuery, 6),
      searchYoutubeInnertube(`${effectiveQuery} instrumental`, 6),
      searchYoutubeInnertube(`${effectiveQuery} off vocal`, 6),
      searchYoutubeInnertube(`${effectiveQuery} カラオケ`, 6),
    ]);

    const pool: YoutubeSearchCandidate[] = [];
    const seenIds = new Set<string>();
    const nonKarIds = new Set<string>();
    const appendPool = (items: YoutubeSearchCandidate[], trackAsNonKar: boolean) => {
      for (const item of items) {
        if (trackAsNonKar) nonKarIds.add(item.videoId);
        if (!seenIds.has(item.videoId)) {
          seenIds.add(item.videoId);
          pool.push(item);
        }
      }
    };
    if (rOrig.status === 'fulfilled') appendPool(rOrig.value, true);
    if (rMrInst.status === 'fulfilled') appendPool(rMrInst.value, true);
    if (rMrOff.status === 'fulfilled') appendPool(rMrOff.value, true);
    if (rKar.status === 'fulfilled') appendPool(rKar.value, false);
    appendPool(seedPool, true);

    const origListRaw = [...pool]
      .sort(
        (a, b) =>
          scoreOriginal(b, queryTokens, resolvedSong) -
          scoreOriginal(a, queryTokens, resolvedSong)
      )
      .slice(0, 6);
    const bestOrigRaw = origListRaw[0] ?? null;
    const refDur =
      resolvedSong?.duration && resolvedSong.duration > 90
        ? resolvedSong.duration
        : bestOrigRaw?.duration && bestOrigRaw.duration >= 120
        ? bestOrigRaw.duration
        : 0;

    const mrListRaw = [...pool]
      .filter((c) => c.videoId !== bestOrigRaw?.videoId)
      .sort(
        (a, b) =>
          scoreMr(b, refDur, queryTokens, resolvedSong, !nonKarIds.has(b.videoId)) -
          scoreMr(a, refDur, queryTokens, resolvedSong, !nonKarIds.has(a.videoId))
      )
      .slice(0, 6);
    const bestMrRaw = mrListRaw[0] ?? null;

    const karaokeSortedRaw = [...pool]
      .filter((c) => c.videoId !== bestOrigRaw?.videoId)
      .sort(
        (a, b) =>
          scoreKaraoke(b, refDur, queryTokens) - scoreKaraoke(a, refDur, queryTokens)
      )
      .slice(0, 6);

    const bestKaraokeRaw =
      karaokeSortedRaw.find((c) => c.videoId !== bestMrRaw?.videoId) ??
      karaokeSortedRaw[0] ??
      null;

    const origList = origListRaw.map((c) => attachCandidateBadges(c, 'original', refDur));
    const mrList = mrListRaw.map((c) => attachCandidateBadges(c, 'mr', refDur));
    const karaokeList = karaokeSortedRaw.map((c) =>
      attachCandidateBadges(c, 'karaoke', refDur)
    );

    return jsonResp({
      query: q,
      resolvedSong,
      recommended: {
        original: origList[0] ?? null,
        mr: mrList[0] ?? null,
        karaoke: bestKaraokeRaw
          ? attachCandidateBadges(bestKaraokeRaw, 'karaoke', refDur)
          : null,
      },
      candidates: {
        original: origList,
        mr: mrList,
        karaoke: karaokeList,
      },
    });
  }

  return jsonResp({ error: '지원하지 않는 action입니다. (suggest | search-tracks)' }, 400);
});
