import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  LyricLine,
  SmartTranslateResult,
  TranslationCandidate,
} from '../../shared/types.js';
import { ensureYtDlpBinary } from './ytdlp.js';

const execFileAsync = promisify(execFile);

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VALID_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const HANGUL_CHAR_RE = /[가-힣]/;
const HANGUL_ALL_RE = /[가-힣]/g;
const JAPANESE_CHAR_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/;
const NOISE_YT_TITLE_RE =
  /(?:karaoke|off\s*vocal|inst\.?|instrumental|cover(?:ed)?|가라오케|노래방|커버|반주|\bmr\b)/i;
const FOOTNOTE_PREFIX_RE =
  /^(?:※|\*|#|\[|【|출처|번역|해석|작사|작곡|편곡|노래|가사|발음|공감|댓글|이웃|블로그|저작권|http|www\.)/i;

interface TimedSubtitleEvent {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Clean project title/artist strings for web search queries.
 */
export function cleanSongQuery(
  title: string,
  artist: string
): { cleanTitle: string; cleanArtist: string } {
  let cleanArtist = (artist || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*—.*$/, '')
    .trim();

  let cleanTitle = (title || '')
    .replace(/\s*—.*$/, '')
    .replace(/\s*[|｜]\s*.*$/, '')
    .replace(/\s*[：:]\s*(?:MUSIC VIDEO|Official.*|MV.*)$/i, '')
    .replace(/\s*【[^】]*】/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\((?:[^)]*[가-힣][^)]*|Official.*|Music Video.*|MV.*|Lyric.*)\)/gi, '')
    .replace(/\b(?:Official\s+Music\s+Video|Music\s+Video|Official\s+Video|MV)\b/gi, '')
    .trim();

  if (cleanArtist && cleanTitle.includes('/')) {
    const parts = cleanTitle.split('/').map((s) => s.trim());
    if (
      parts.length === 2 &&
      parts[1].toLowerCase().includes(cleanArtist.toLowerCase())
    ) {
      cleanTitle = parts[0];
    }
  } else if (!cleanArtist && cleanTitle.includes('/')) {
    const parts = cleanTitle.split('/').map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      cleanTitle = parts[0];
      cleanArtist = parts[1];
    }
  }

  return {
    cleanTitle: cleanTitle || (title || '').trim(),
    cleanArtist,
  };
}

function normalizeJpForMatch(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[、。,.!?！？「」『』・…ー〜~\-'"()（）【】\s]/g, '')
    .toLowerCase();
}

function bigramDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) {
    return a === b ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const n = counts.get(bg) ?? 0;
    if (n > 0) {
      hits++;
      counts.set(bg, n - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function lcsRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const s1 = a.length > 160 ? a.slice(0, 160) : a;
  const s2 = b.length > 160 ? b.slice(0, 160) : b;
  const n = s1.length;
  const m = s2.length;
  let prev = new Uint16Array(m + 1);
  let curr = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const c1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (c1 === s2.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return prev[m] / Math.max(n, m);
}

function jpSimilarity(a: string, b: string): number {
  const na = normalizeJpForMatch(a);
  const nb = normalizeJpForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  if (minLen >= 4 && (na.includes(nb) || nb.includes(na))) {
    return 0.85 + 0.15 * (minLen / maxLen);
  }
  return Math.max(bigramDice(na, nb), lcsRatio(na, nb));
}

function hasHangul(s: string): boolean {
  return HANGUL_CHAR_RE.test(s);
}

function hasJapanese(s: string): boolean {
  return JAPANESE_CHAR_RE.test(s);
}

function hangulRatio(s: string): number {
  const compact = s.replace(/\s+/g, '');
  if (!compact) return 0;
  const matches = compact.match(HANGUL_ALL_RE);
  return (matches ? matches.length : 0) / compact.length;
}

function pronunciationSimilarity(candidateKo: string, refKoPron: string): number {
  const k1 = (candidateKo.match(HANGUL_ALL_RE) ?? []).join('');
  const k2 = (refKoPron.match(HANGUL_ALL_RE) ?? []).join('');
  if (!k1 || !k2) return 0;
  const j1 = k1.normalize('NFD');
  const j2 = k2.normalize('NFD');
  return Math.max(bigramDice(j1, j2), lcsRatio(j1, j2));
}

function getLineKoPron(line: LyricLine): string {
  return (line.segments || []).map((s) => s.koPron || '').join('');
}

function overlapSec(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function parseVttTimestamp(ts: string): number {
  const parts = ts.replace(',', '.').split(':');
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return Number(parts[0]) || 0;
}

function parseVttEvents(vttText: string): TimedSubtitleEvent[] {
  const blocks = vttText.replace(/\r/g, '').split(/\n{2,}/);
  const events: TimedSubtitleEvent[] = [];
  for (const blk of blocks) {
    const lines = blk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx < 0) continue;
    const m = lines[tsIdx].match(
      /((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/
    );
    if (!m) continue;
    const startSec = parseVttTimestamp(m[1]);
    const endSec = Math.max(startSec + 0.1, parseVttTimestamp(m[2]));
    const text = lines
      .slice(tsIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      events.push({ startSec, endSec, text });
    }
  }
  return events;
}

function isCleanSubtitleText(text: string): boolean {
  if (!text) return false;
  if (/^\[[^\]]+\]$/.test(text)) return false;
  if (/^♪+$/.test(text) || /^[♪♫★☆\s]+$/.test(text)) return false;
  return true;
}

async function fetchSubtitleEvents(
  subFormats: Array<{ ext?: string; url?: string }>,
  requireHangul: boolean
): Promise<TimedSubtitleEvent[]> {
  const json3Fmt = subFormats.find((f) => f.ext === 'json3' && f.url);
  if (json3Fmt?.url) {
    const resp = await fetch(json3Fmt.url, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        events?: Array<{
          tStartMs?: number;
          dDurationMs?: number;
          segs?: Array<{ utf8?: string }>;
        }>;
      };
      const out: TimedSubtitleEvent[] = [];
      for (const ev of data.events ?? []) {
        if (!Array.isArray(ev.segs)) continue;
        const text = ev.segs
          .map((s) => s.utf8 ?? '')
          .join('')
          .replace(/\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!isCleanSubtitleText(text)) continue;
        if (requireHangul && !hasHangul(text)) continue;
        const startSec = Number(ev.tStartMs ?? 0) / 1000;
        const durSec = Number(ev.dDurationMs ?? 2000) / 1000;
        out.push({
          startSec,
          endSec: startSec + Math.max(0.2, durSec),
          text,
        });
      }
      if (out.length > 0) return out;
    }
  }

  const vttFmt = subFormats.find((f) => f.ext === 'vtt' && f.url);
  if (vttFmt?.url) {
    const resp = await fetch(vttFmt.url, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const text = await resp.text();
      return parseVttEvents(text).filter(
        (ev) => isCleanSubtitleText(ev.text) && (!requireHangul || hasHangul(ev.text))
      );
    }
  }

  return [];
}

function alignYoutubeEventsToLines(
  lines: LyricLine[],
  koEvents: TimedSubtitleEvent[],
  jaEvents: TimedSubtitleEvent[]
): string[] {
  const n = lines.length;
  const lineWindows: Array<{ start: number; end: number }> = new Array(n);

  if (jaEvents.length >= 3) {
    // Anchor line -> YouTube timeline via monotonic JA subtitle text match
    const matchedStart: Array<number | null> = new Array(n).fill(null);
    const matchedEnd: Array<number | null> = new Array(n).fill(null);
    const deltas: number[] = [];
    let jaCursor = 0;

    for (let i = 0; i < n; i++) {
      let bestIdx = -1;
      let bestSim = 0;
      const maxSearch = Math.min(jaEvents.length, jaCursor + 10);
      for (let k = jaCursor; k < maxSearch; k++) {
        const sim = jpSimilarity(lines[i].jpText, jaEvents[k].text);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = k;
        }
      }
      if (bestSim < 0.72) {
        // Check wider ahead / full list when lines are sparse (e.g. demo preset)
        for (let k = jaCursor; k < jaEvents.length; k++) {
          const sim = jpSimilarity(lines[i].jpText, jaEvents[k].text);
          if (sim > bestSim) {
            bestSim = sim;
            bestIdx = k;
          }
        }
      }
      if (bestIdx >= 0 && bestSim >= 0.65) {
        matchedStart[i] = jaEvents[bestIdx].startSec;
        matchedEnd[i] = jaEvents[bestIdx].endSec;
        deltas.push(jaEvents[bestIdx].startSec - lines[i].startTime);
        jaCursor = bestIdx + 1;
      }
    }

    deltas.sort((a, b) => a - b);
    const medianDelta = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;

    for (let i = 0; i < n; i++) {
      if (matchedStart[i] !== null && matchedEnd[i] !== null) {
        lineWindows[i] = { start: matchedStart[i]!, end: matchedEnd[i]! };
      } else {
        lineWindows[i] = {
          start: lines[i].startTime + medianDelta,
          end: Math.max(lines[i].startTime + medianDelta + 0.3, lines[i].endTime + medianDelta),
        };
      }
    }
  } else {
    // Only Korean subtitles exist: estimate constant shift delta in [-25, +25]
    let bestDelta = 0;
    let bestScore = -1;
    for (let d = -25.0; d <= 25.0; d += 0.25) {
      let score = 0;
      for (const ln of lines) {
        const ls = ln.startTime + d;
        const le = ln.endTime + d;
        for (const ev of koEvents) {
          score += overlapSec(ls, le, ev.startSec, ev.endSec);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestDelta = d;
      }
    }
    const coarseBest = bestDelta;
    for (let d = coarseBest - 0.5; d <= coarseBest + 0.5; d += 0.05) {
      let score = 0;
      for (const ln of lines) {
        const ls = ln.startTime + d;
        const le = ln.endTime + d;
        for (const ev of koEvents) {
          score += overlapSec(ls, le, ev.startSec, ev.endSec);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestDelta = d;
      }
    }

    for (let i = 0; i < n; i++) {
      lineWindows[i] = {
        start: lines[i].startTime + bestDelta,
        end: lines[i].endTime + bestDelta,
      };
    }
  }

  // Map each KO subtitle event to the single line with greatest padded overlap
  const perLineBuckets: string[][] = Array.from({ length: n }, () => []);
  for (const ev of koEvents) {
    let bestLine = -1;
    let bestOv = 0;
    for (let i = 0; i < n; i++) {
      const w = lineWindows[i];
      const ov = overlapSec(w.start - 0.35, w.end + 0.35, ev.startSec, ev.endSec);
      if (ov > bestOv) {
        bestOv = ov;
        bestLine = i;
      }
    }
    if (bestLine >= 0 && bestOv > 0.05) {
      const prev = perLineBuckets[bestLine][perLineBuckets[bestLine].length - 1];
      if (prev !== ev.text) {
        perLineBuckets[bestLine].push(ev.text);
      }
    }
  }

  return perLineBuckets.map((parts) => parts.join(' ').trim());
}

/**
 * Tier 1: Fetch official creator-uploaded Korean manual CC from YouTube via yt-dlp.
 * Strictly checks `info.subtitles` and never uses `automatic_captions`.
 */
async function fetchYoutubeOfficialKoCandidate(
  cleanTitle: string,
  cleanArtist: string,
  youtubeVideoId: string | undefined,
  lines: LyricLine[]
): Promise<TranslationCandidate | null> {
  if (!cleanTitle && !youtubeVideoId) return null;

  let ytdlpPath: string;
  try {
    ytdlpPath = await ensureYtDlpBinary();
  } catch {
    return null;
  }

  const videoIdsToTry: string[] = [];
  if (youtubeVideoId && VALID_VIDEO_ID_RE.test(youtubeVideoId)) {
    videoIdsToTry.push(youtubeVideoId);
  }

  if (videoIdsToTry.length === 0 && cleanTitle) {
    try {
      const query = `${cleanArtist} ${cleanTitle} Official MV`.trim();
      const { stdout } = await execFileAsync(
        ytdlpPath,
        ['--dump-single-json', '--no-playlist', '--flat-playlist', `ytsearch3:${query}`],
        { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout) as {
        entries?: Array<{ id?: string; title?: string }>;
      };
      for (const entry of parsed.entries ?? []) {
        if (!entry.id || !VALID_VIDEO_ID_RE.test(entry.id)) continue;
        if (entry.title && NOISE_YT_TITLE_RE.test(entry.title)) continue;
        if (!videoIdsToTry.includes(entry.id)) {
          videoIdsToTry.push(entry.id);
        }
        if (videoIdsToTry.length >= 2) break;
      }
    } catch {
      // Search failed cleanly
    }
  }

  for (const vidId of videoIdsToTry.slice(0, 2)) {
    try {
      const { stdout } = await execFileAsync(
        ytdlpPath,
        [
          '--dump-single-json',
          '--no-playlist',
          '--skip-download',
          `https://www.youtube.com/watch?v=${vidId}`,
        ],
        { timeout: 18000, maxBuffer: 25 * 1024 * 1024 }
      );
      const info = JSON.parse(stdout) as {
        title?: string;
        subtitles?: Record<string, Array<{ ext?: string; url?: string }>>;
      };

      // Strictly manual creator subtitles only (never automatic_captions)
      const subs = info.subtitles ?? {};
      const koKey = Object.keys(subs).find((k) => /^ko(?:-|$)/i.test(k));
      if (!koKey || !Array.isArray(subs[koKey])) continue;

      const koEvents = await fetchSubtitleEvents(subs[koKey], true);
      if (koEvents.length < 2) continue;

      const jaKey = Object.keys(subs).find((k) => /^ja(?:-|$)/i.test(k));
      const jaEvents =
        jaKey && Array.isArray(subs[jaKey])
          ? await fetchSubtitleEvents(subs[jaKey], false)
          : [];

      const translations = alignYoutubeEventsToLines(lines, koEvents, jaEvents);
      const matchedCount = translations.filter((t) => t.length > 0).length;
      const minRequired = Math.min(3, lines.length);
      if (matchedCount >= minRequired && matchedCount / lines.length >= 0.55) {
        const videoTitle = (info.title || vidId).trim();
        return {
          sourceType: 'youtube-cc',
          sourceLabel: `YouTube 공식 한국어 자막 (${videoTitle.slice(0, 42)})`,
          sourceUrl: `https://www.youtube.com/watch?v=${vidId}`,
          matchedCount,
          totalCount: lines.length,
          translations,
        };
      }
    } catch {
      // Skip restricted/failed video candidate and continue
    }
  }

  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    });
}

function htmlToCleanLines(html: string): string[] {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|header|footer|nav)[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<(?:br\s*\/?|\/?(?:p|div|li|tr|h[1-6]|section|article|blockquote))[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(stripped)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split(/\r?\n/)
    .map((ln) => ln.replace(/\s+/g, ' ').trim())
    .filter((ln) => ln.length > 0);
}

interface WebTarget {
  fetchUrl: string;
  displayUrl: string;
  sourceLabel: string;
}

async function searchNaverBlogTargets(query: string): Promise<WebTarget[]> {
  const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return [];
  const html = await resp.text();

  const targets: WebTarget[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/https:\/\/blog\.naver\.com\/([a-zA-Z0-9_-]+)\/(\d+)/g)) {
    const blogId = m[1];
    const logNo = m[2];
    const displayUrl = `https://blog.naver.com/${blogId}/${logNo}`;
    if (seen.has(displayUrl)) continue;
    seen.add(displayUrl);
    targets.push({
      fetchUrl: `https://m.blog.naver.com/${blogId}/${logNo}`,
      displayUrl,
      sourceLabel: `네이버 블로그 (${blogId})`,
    });
    if (targets.length >= 6) return targets;
  }

  for (const m of html.matchAll(/https:\/\/([a-zA-Z0-9_-]+)\.tistory\.com\/(\d+)/g)) {
    const sub = m[1];
    const postId = m[2];
    const displayUrl = `https://${sub}.tistory.com/${postId}`;
    if (seen.has(displayUrl)) continue;
    seen.add(displayUrl);
    targets.push({
      fetchUrl: displayUrl,
      displayUrl,
      sourceLabel: `티스토리 (${sub})`,
    });
    if (targets.length >= 6) return targets;
  }

  return targets;
}

function alignWebPageLines(
  lines: LyricLine[],
  pageLines: string[]
): TranslationCandidate['translations'] | null {
  const n = lines.length;
  const pIdx = new Array<number>(n).fill(-1);

  // Locate line 0 anywhere on the page, then walk monotonically with bounded lookahead
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const lineJp = lines[i].jpText;
    let chosen = -1;
    let bestSim = 0;

    if (i === 0 || cursor === 0) {
      for (let k = 0; k < pageLines.length; k++) {
        if (!hasJapanese(pageLines[k])) continue;
        const sim = jpSimilarity(lineJp, pageLines[k]);
        if (sim > bestSim) {
          bestSim = sim;
          chosen = k;
        }
        if (sim >= 0.92) break;
      }
      if (bestSim >= 0.72 && chosen >= 0) {
        pIdx[i] = chosen;
        cursor = chosen + 1;
      }
      continue;
    }

    const lookEnd = Math.min(pageLines.length, cursor + 35);
    for (let k = cursor; k < lookEnd; k++) {
      if (!hasJapanese(pageLines[k])) continue;
      const sim = jpSimilarity(lineJp, pageLines[k]);
      if (sim >= 0.85) {
        chosen = k;
        bestSim = sim;
        break;
      }
      if (sim > bestSim) {
        bestSim = sim;
        chosen = k;
      }
    }

    if (bestSim < 0.72) {
      // High-confidence full-page scan from cursor (handles chorus/sparse demo skips)
      chosen = -1;
      bestSim = 0;
      for (let k = cursor; k < pageLines.length; k++) {
        if (!hasJapanese(pageLines[k])) continue;
        const sim = jpSimilarity(lineJp, pageLines[k]);
        if (sim > bestSim) {
          bestSim = sim;
          chosen = k;
        }
        if (sim >= 0.94) break;
      }
    }

    if (chosen >= 0 && bestSim >= 0.72) {
      pIdx[i] = chosen;
      cursor = chosen + 1;
    }
  }

  const translations = new Array<string>(n).fill('');

  for (let i = 0; i < n; i++) {
    const pi = pIdx[i];
    if (pi < 0) continue;

    // Upper scan bound: next matched JP line (or +6 lines max)
    let nextMatched = pageLines.length;
    for (let j = i + 1; j < n; j++) {
      if (pIdx[j] > pi) {
        nextMatched = pIdx[j];
        break;
      }
    }
    const scanEnd = Math.min(pageLines.length, pi + 6, nextMatched);
    const hangulCandidates: string[] = [];

    for (let k = pi + 1; k < scanEnd; k++) {
      const s = pageLines[k];
      if (hasJapanese(s) && hangulRatio(s) < 0.2) {
        break;
      }
      if (
        hasHangul(s) &&
        hangulRatio(s) >= 0.35 &&
        s.length >= 1 &&
        s.length <= 120 &&
        !FOOTNOTE_PREFIX_RE.test(s)
      ) {
        hangulCandidates.push(s);
      }
    }

    const koPron = getLineKoPron(lines[i]);
    if (hangulCandidates.length >= 2) {
      const nonPron = hangulCandidates.filter(
        (cand) => pronunciationSimilarity(cand, koPron) < 0.48
      );
      if (nonPron.length > 0) {
        translations[i] = nonPron[0];
      }
    } else if (hangulCandidates.length === 1) {
      if (pronunciationSimilarity(hangulCandidates[0], koPron) < 0.45) {
        translations[i] = hangulCandidates[0];
      }
    } else {
      // Inline bilingual check on the matched line itself (e.g. "痛みの数だけ / 아픔의 수만큼")
      const sameLine = pageLines[pi];
      if (hasHangul(sameLine)) {
        const inlineParts = sameLine.split(/\s*[\/|｜\-–]\s*/);
        const koPart = inlineParts.find(
          (p) =>
            hasHangul(p) &&
            !hasJapanese(p) &&
            hangulRatio(p) >= 0.35 &&
            pronunciationSimilarity(p, koPron) < 0.45 &&
            !FOOTNOTE_PREFIX_RE.test(p.trim())
        );
        if (koPart) {
          translations[i] = koPart.trim();
        }
      }
    }
  }

  return translations;
}

/**
 * Tier 2: Search Naver Blog & Tistory for parallel JP-KO lyric translations and
 * align them monotonically while filtering out phonetic Korean reading lines.
 */
async function fetchWebParallelKoCandidates(
  cleanTitle: string,
  cleanArtist: string,
  lines: LyricLine[]
): Promise<TranslationCandidate[]> {
  if (!cleanTitle || lines.length === 0) return [];

  const q1 = `${cleanArtist} ${cleanTitle} 가사 번역`.trim();
  let targets = await searchNaverBlogTargets(q1).catch(() => [] as WebTarget[]);
  if (targets.length < 3) {
    const q2 = `${cleanTitle} ${cleanArtist} 가사 해석`.trim();
    const extra = await searchNaverBlogTargets(q2).catch(() => [] as WebTarget[]);
    const seen = new Set(targets.map((t) => t.displayUrl));
    for (const item of extra) {
      if (!seen.has(item.displayUrl)) {
        seen.add(item.displayUrl);
        targets.push(item);
      }
      if (targets.length >= 6) break;
    }
  }

  if (targets.length === 0) return [];

  const settled = await Promise.allSettled(
    targets.slice(0, 6).map(async (target): Promise<TranslationCandidate | null> => {
      const resp = await fetch(target.fetchUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      if (!html) return null;

      const pageLines = htmlToCleanLines(html);
      const translations = alignWebPageLines(lines, pageLines);
      if (!translations) return null;

      const matchedCount = translations.filter((t) => t.length > 0).length;
      const minRequired = Math.min(3, lines.length);
      if (matchedCount < minRequired || matchedCount / lines.length < 0.6) {
        return null;
      }

      return {
        sourceType: 'web-parallel',
        sourceLabel: target.sourceLabel,
        sourceUrl: target.displayUrl,
        matchedCount,
        totalCount: lines.length,
        translations,
      };
    })
  );

  const valid: TranslationCandidate[] = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && res.value) {
      valid.push(res.value);
    }
  }
  valid.sort((a, b) => b.matchedCount - a.matchedCount);
  return valid.slice(0, 3);
}

/**
 * Tier 3 helper: Unofficial Google Translate fallback for JA -> KO.
 */
export async function googleFreeTranslateJaToKo(text: string): Promise<string> {
  const clean = text.trim();
  if (!clean) return '';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=ko&dt=t&q=${encodeURIComponent(clean)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`무료 번역 요청 실패 (${resp.status})`);
  }
  const data = (await resp.json()) as unknown[];
  const sentences = Array.isArray(data?.[0]) ? (data[0] as unknown[]) : [];
  return sentences
    .map((s) => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : ''))
    .join('')
    .trim();
}

export async function translateLinesGoogleFree(
  lines: LyricLine[]
): Promise<LyricLine[]> {
  const CHUNK_SIZE = 15;
  const translatedTexts: string[] = new Array(lines.length).fill('');

  for (let offset = 0; offset < lines.length; offset += CHUNK_SIZE) {
    const slice = lines.slice(offset, offset + CHUNK_SIZE);
    const joined = slice.map((l) => l.jpText.replace(/\r?\n/g, ' ').trim()).join('\n');
    let splitOut: string[] = [];

    try {
      const batchTranslated = await googleFreeTranslateJaToKo(joined);
      splitOut = batchTranslated.split(/\r?\n/).map((s) => s.trim());
    } catch {
      splitOut = [];
    }

    if (splitOut.length === slice.length && splitOut.every((s) => s.length > 0)) {
      for (let i = 0; i < slice.length; i++) {
        translatedTexts[offset + i] = splitOut[i];
      }
    } else {
      const singles = await Promise.all(
        slice.map((l) =>
          googleFreeTranslateJaToKo(l.jpText).catch(() => l.koTranslation || '')
        )
      );
      for (let i = 0; i < slice.length; i++) {
        translatedTexts[offset + i] = singles[i];
      }
    }
  }

  return lines.map((line, i) => ({
    ...line,
    koTranslation: translatedTexts[i] || line.koTranslation || '',
  }));
}

async function translateMissingIndicesFallback(
  lines: LyricLine[],
  translations: string[]
): Promise<{ filled: string[]; fallbackFilled: number }> {
  const filled = [...translations];
  const missingIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!filled[i] || !filled[i].trim()) {
      missingIndices.push(i);
    }
  }
  if (missingIndices.length === 0) {
    return { filled, fallbackFilled: 0 };
  }

  const missingLines = missingIndices.map((idx) => lines[idx]);
  const translatedSubset = await translateLinesGoogleFree(missingLines).catch(
    () => missingLines.map((l) => ({ ...l, koTranslation: '' }))
  );

  let fallbackFilled = 0;
  for (let k = 0; k < missingIndices.length; k++) {
    const txt = (translatedSubset[k]?.koTranslation || '').trim();
    if (txt) {
      filled[missingIndices[k]] = txt;
      fallbackFilled++;
    }
  }
  return { filled, fallbackFilled };
}

/**
 * Web-first reliable Korean lyric translation orchestrator:
 * 1) YouTube official creator Korean CC
 * 2) Web JP-KO parallel human translations (Naver Blog / Tistory)
 * 3) Google Translate JA->KO fallback (only for missing lines or full fallback)
 */
export async function smartTranslateLyrics(params: {
  title: string;
  artist: string;
  youtubeVideoId?: string;
  lines: LyricLine[];
}): Promise<SmartTranslateResult> {
  const { cleanTitle, cleanArtist } = cleanSongQuery(params.title, params.artist);
  const { lines } = params;

  const [ytRes, webRes] = await Promise.allSettled([
    fetchYoutubeOfficialKoCandidate(cleanTitle, cleanArtist, params.youtubeVideoId, lines),
    fetchWebParallelKoCandidates(cleanTitle, cleanArtist, lines),
  ]);

  const ytCandidate = ytRes.status === 'fulfilled' ? ytRes.value : null;
  const webCandidates = webRes.status === 'fulfilled' ? webRes.value : [];

  const candidates: TranslationCandidate[] = [];
  if (ytCandidate) candidates.push(ytCandidate);
  for (const c of webCandidates) {
    if (candidates.length < 3) {
      candidates.push(c);
    }
  }

  if (candidates.length > 0) {
    const best = candidates[0];
    const { filled, fallbackFilled } =
      best.matchedCount < lines.length
        ? await translateMissingIndicesFallback(lines, best.translations)
        : { filled: [...best.translations], fallbackFilled: 0 };

    const updatedLines = lines.map((line, i) => ({
      ...line,
      koTranslation: filled[i] || line.koTranslation || '',
    }));

    return {
      lines: updatedLines,
      sourceType: best.sourceType,
      sourceLabel: best.sourceLabel,
      sourceUrl: best.sourceUrl,
      matchedFromWeb: best.matchedCount,
      fallbackFilled,
      totalLines: lines.length,
      candidates,
    };
  }

  // Tier 3: Full machine fallback when no reliable web translation was found
  const machineLines = await translateLinesGoogleFree(lines);
  const fallbackFilled = machineLines.filter((l) => Boolean(l.koTranslation?.trim())).length;

  return {
    lines: machineLines,
    sourceType: 'machine-fallback',
    sourceLabel: '자동 번역 (웹 신뢰 번역 미발견)',
    matchedFromWeb: 0,
    fallbackFilled,
    totalLines: lines.length,
    candidates: [],
  };
}
