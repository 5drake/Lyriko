import type { LyricLine, LyricSegment, WebFuriganaMatchInfo } from '../../shared/types.js';
import { alignFuriganaToKanji, toHiragana } from '../../shared/timing.js';
import {
  getReadingCandidatesForSegment,
  type LongVowelMode,
} from '../../shared/jpPronunciation.js';
import { computeKoPronWithParticles } from './jpKorean.js';
import { cleanSongQuery } from './lyricTranslation.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 5500;
const OVERALL_BUDGET_MS = 7500;
const POSITIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 30;

const KANJI_TEST = /[\u4E00-\u9FFF々]/;
const KANJI_OR_DIGIT_TEST = /[\u4E00-\u9FFF々0-9０-９]/;
const DIGIT_CHAR_TEST = /[0-9０-９]/;
const JAPANESE_CHAR_TEST = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF々]/;
const HIRAGANA_OR_CHOON_TEST = /[\u3040-\u309Fー]/;
const PURE_KANA_STR_TEST = /^[\u3040-\u309Fー]+$/;
const MATCH_CHAR_TEST = /^[\u4E00-\u9FFF々\u3040-\u309F\u30A0-\u30FFーa-zA-Z0-9]$/;
const VARIANT_NOISE_RE = /\b(tv\s*size|short(?:\s+ver)?|cover|acoustic|english|remix|live|piano|orchestra|karaoke|off\s*vocal)\b/i;

export interface RubyGroup {
  baseExact: string;
  baseFold: string;
  rubyHira: string;
}

export interface DocStreamChar {
  exact: string;
  fold: string;
  rubyGroupId: number | null;
  posInGroup: number;
  groupLen: number;
}

export interface ParsedRubySong {
  sourceLabel: string;
  sourceUrl: string;
  songTitle: string;
  songArtist: string;
  rubyGroups: RubyGroup[];
  docStream: DocStreamChar[];
  docFold: string;
}

interface SearchCandidate {
  href: string;
  url: string;
  title: string;
  artist: string;
  beginning: string;
  score: number;
  metaStrong: boolean;
}

interface CacheEntry {
  song: ParsedRubySong | null;
  expiresAt: number;
}

const songCache = new Map<string, CacheEntry>();

function touchCacheSet(key: string, entry: CacheEntry): void {
  if (songCache.has(key)) {
    songCache.delete(key);
  }
  songCache.set(key, entry);
  while (songCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = songCache.keys().next().value;
    if (oldestKey === undefined) break;
    songCache.delete(oldestKey);
  }
}

function getCacheEntry(key: string): { hit: boolean; song: ParsedRubySong | null } {
  if (!key) return { hit: false, song: null };
  const entry = songCache.get(key);
  if (!entry) return { hit: false, song: null };
  if (Date.now() > entry.expiresAt) {
    songCache.delete(key);
    return { hit: false, song: null };
  }
  // Refresh LRU order
  songCache.delete(key);
  songCache.set(key, entry);
  return { hit: true, song: entry.song };
}

function decodeHtmlEntities(input: string): string {
  return (input || '')
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

function normalizeExactChar(ch: string): string {
  const nfkc = ch.normalize('NFKC');
  return /^[A-Z]+$/.test(nfkc) ? nfkc.toLowerCase() : nfkc;
}

function foldMatchChar(ch: string): string {
  const exact = normalizeExactChar(ch);
  return toHiragana(exact);
}

function toFoldString(text: string): string {
  let out = '';
  for (const rawCh of Array.from(text || '')) {
    const norm = rawCh.normalize('NFKC');
    for (const ch of Array.from(norm)) {
      if (MATCH_CHAR_TEST.test(ch)) {
        out += foldMatchChar(ch);
      }
    }
  }
  return out;
}

function normalizeMetaForScore(s: string): string {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function stripTitleParens(title: string): string {
  return (title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigramDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
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
      hits += 1;
      counts.set(bg, n - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function metaMatchRatio(query: string, target: string): number {
  const nq = normalizeMetaForScore(stripTitleParens(query));
  const nt = normalizeMetaForScore(stripTitleParens(target));
  const fq = normalizeMetaForScore(query);
  const ft = normalizeMetaForScore(target);
  if (!fq || !ft) return 0;
  if (fq === ft || (nq && nt && nq === nt)) return 1;
  if (nq && nt && nq.length >= 2 && nt.length >= 2 && (nt.includes(nq) || nq.includes(nt))) {
    return 0.88;
  }
  if (fq.length >= 2 && ft.length >= 2 && (ft.includes(fq) || fq.includes(ft))) {
    return 0.84;
  }
  return bigramDice(nq || fq, nt || ft);
}

function isAntiBotChallenge(html: string): boolean {
  if (!html) return true;
  const head = html.slice(0, 8000);
  if (/<title>[^<]*(?:Just a moment|Attention Required|Access Denied)[^<]*<\/title>/i.test(head)) {
    return true;
  }
  if (/cf-browser-verification|cf-challenge-running|cf-turnstile|g-recaptcha|h-captcha/i.test(head)) {
    return true;
  }
  return false;
}

async function fetchHtmlSafe(url: string, deadlineMs: number): Promise<string | null> {
  const remaining = deadlineMs - Date.now();
  if (remaining < 400) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining)),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || isAntiBotChallenge(html)) {
      return null;
    }
    return html;
  } catch {
    return null;
  }
}

function parseUtaTenSearchRows(
  html: string
): Array<Omit<SearchCandidate, 'score' | 'metaStrong'>> {
  const out: Array<Omit<SearchCandidate, 'score' | 'metaStrong'>> = [];
  for (const rowMatch of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const row = rowMatch[0];
    const hrefMatch = row.match(/href="(\/lyric\/[a-zA-Z0-9]+\/)"/);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];

    const titleMatch = row.match(/class="searchResult__title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const artistMatch = row.match(/class="searchResult__artist"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const begMatch = row.match(/class="lyricList__beginning"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);

    const cleanField = (raw?: string): string =>
      decodeHtmlEntities((raw || '').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();

    const title = cleanField(titleMatch?.[1]);
    const artist = cleanField(artistMatch?.[1]);
    const beginning = cleanField(begMatch?.[1]);
    if (!title) continue;

    out.push({
      href,
      url: `https://utaten.com${href}`,
      title,
      artist,
      beginning,
    });
  }
  return out;
}

function scoreCandidate(
  row: Omit<SearchCandidate, 'score' | 'metaStrong'>,
  openingSampleFold: string,
  cleanTitle: string,
  cleanArtist: string
): SearchCandidate {
  let score = 0;
  const begFold = toFoldString(row.beginning);

  if (begFold && openingSampleFold) {
    const minLen = Math.min(begFold.length, openingSampleFold.length);
    if (
      minLen >= 6 &&
      (openingSampleFold.startsWith(begFold.slice(0, Math.min(14, begFold.length))) ||
        openingSampleFold.includes(begFold.slice(0, Math.min(18, begFold.length))) ||
        begFold.includes(openingSampleFold.slice(0, Math.min(18, openingSampleFold.length))))
    ) {
      score += 60;
    } else {
      const sliceA = openingSampleFold.slice(0, Math.max(begFold.length + 12, 36));
      const sim = bigramDice(begFold, sliceA);
      score += Math.round(sim * 55);
    }
  }

  const titleSim = cleanTitle ? metaMatchRatio(cleanTitle, row.title) : 0;
  const artistSim = cleanArtist ? metaMatchRatio(cleanArtist, row.artist) : 0;

  if (titleSim >= 0.9) score += 35;
  else if (titleSim >= 0.72) score += 26;
  else if (titleSim >= 0.5) score += 12;

  if (artistSim >= 0.85) score += 25;
  else if (artistSim >= 0.65) score += 15;

  const variantHit = row.title.match(VARIANT_NOISE_RE)?.[0] || '';
  if (variantHit && !VARIANT_NOISE_RE.test(cleanTitle)) {
    score -= 22;
  }

  const metaStrong =
    (titleSim >= 0.8 && (!cleanArtist || artistSim >= 0.65)) ||
    (titleSim >= 0.92 && score >= 50);

  return {
    ...row,
    score,
    metaStrong,
  };
}

function pickSearchPhraseFromLine(lineText: string, maxLen = 18): string {
  const cleaned = (lineText || '')
    .normalize('NFKC')
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ' ')
    .replace(/[、。,.!?！？「」『』・…〜~\-'"()（）【】]/g, ' ')
    .trim();
  if (!cleaned) return '';

  // Extract runs containing Japanese chars
  const clauses = cleaned
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      const jpCount = (s.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF々]/g) || []).length;
      return jpCount >= 4;
    });

  const best = clauses[0] || '';
  if (best) {
    return Array.from(best).slice(0, maxLen).join('');
  }
  const jpOnly = cleaned.replace(/[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF々]/g, '');
  if (Array.from(jpOnly).length >= 5) {
    return Array.from(jpOnly).slice(0, maxLen).join('');
  }
  return '';
}

function extractHiraganaContainerHtml(html: string): string | null {
  const openMatch = html.match(/<div\b[^>]*class="[^"]*\bhiragana\b[^"]*"[^>]*>/i);
  if (!openMatch || openMatch.index === undefined) return null;

  const contentStart = openMatch.index + openMatch[0].length;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(contentStart, m.index);
      }
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return null;
}

function parsePageTitleAndArtist(html: string): { songTitle: string; songArtist: string } {
  const titleTag = decodeHtmlEntities(
    (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  );
  // UtaTen format: "<Title> 歌詞 <Artist> ふりがな付 - うたてん"
  const m = titleTag.match(/^(.+?)\s+歌詞\s+(.+?)\s+ふりがな付/);
  if (m) {
    return {
      songTitle: m[1].trim(),
      songArtist: m[2].trim(),
    };
  }
  return {
    songTitle: titleTag.replace(/\s*[-|｜].*$/, '').trim(),
    songArtist: '',
  };
}

export function parseUtaTenRubyPage(html: string, sourceUrl: string): ParsedRubySong | null {
  const container = extractHiraganaContainerHtml(html);
  if (!container) return null;

  const normalizedHtml = container.replace(/<br\s*\/?>/gi, '\n');
  const rubyGroups: RubyGroup[] = [];
  const docStream: DocStreamChar[] = [];

  const appendPlainSegment = (rawHtml: string) => {
    const plain = decodeHtmlEntities(rawHtml.replace(/<[^>]+>/g, ''));
    for (const rawCh of Array.from(plain)) {
      const norm = rawCh.normalize('NFKC');
      for (const ch of Array.from(norm)) {
        if (!MATCH_CHAR_TEST.test(ch)) continue;
        docStream.push({
          exact: normalizeExactChar(ch),
          fold: foldMatchChar(ch),
          rubyGroupId: null,
          posInGroup: 0,
          groupLen: 0,
        });
      }
    }
  };

  const appendRubySegment = (rawRb: string, rawRt: string) => {
    const cleanRbHtml = rawRb.replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '');
    const rbText = decodeHtmlEntities(cleanRbHtml.replace(/<[^>]+>/g, '')).trim();
    const rtRaw = decodeHtmlEntities(rawRt.replace(/<[^>]+>/g, '')).replace(/\s+/g, '');
    const rtHira = toHiragana(rtRaw).replace(/[^\u3040-\u309Fー]/g, '');

    const rbChars: string[] = [];
    for (const rawCh of Array.from(rbText)) {
      const norm = rawCh.normalize('NFKC');
      for (const ch of Array.from(norm)) {
        if (MATCH_CHAR_TEST.test(ch)) {
          rbChars.push(ch);
        }
      }
    }

    if (rbChars.length === 0) return;
    if (!rtHira) {
      appendPlainSegment(rbText);
      return;
    }

    const groupId = rubyGroups.length;
    rubyGroups.push({
      baseExact: rbChars.map(normalizeExactChar).join(''),
      baseFold: rbChars.map(foldMatchChar).join(''),
      rubyHira: rtHira,
    });

    for (let k = 0; k < rbChars.length; k++) {
      docStream.push({
        exact: normalizeExactChar(rbChars[k]),
        fold: foldMatchChar(rbChars[k]),
        rubyGroupId: groupId,
        posInGroup: k,
        groupLen: rbChars.length,
      });
    }
  };

  const utaTenRubyRe =
    /<span\b[^>]*class="[^"]*\bruby\b[^"]*"[^>]*>[\s\S]*?<span\b[^>]*class="[^"]*\brb\b[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span\b[^>]*class="[^"]*\brt\b[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/span>/gi;
  const stdRubyRe = /<ruby\b[^>]*>([\s\S]*?)<rt\b[^>]*>([\s\S]*?)<\/rt>[\s\S]*?<\/ruby>/gi;

  let cursor = 0;
  while (cursor < normalizedHtml.length) {
    utaTenRubyRe.lastIndex = cursor;
    stdRubyRe.lastIndex = cursor;
    const m1 = utaTenRubyRe.exec(normalizedHtml);
    const m2 = stdRubyRe.exec(normalizedHtml);

    let chosen: { index: number; len: number; rb: string; rt: string } | null = null;
    if (m1 && (!m2 || m1.index <= m2.index)) {
      chosen = { index: m1.index, len: m1[0].length, rb: m1[1], rt: m1[2] };
    } else if (m2) {
      chosen = { index: m2.index, len: m2[0].length, rb: m2[1], rt: m2[2] };
    }

    if (!chosen) {
      appendPlainSegment(normalizedHtml.slice(cursor));
      break;
    }

    if (chosen.index > cursor) {
      appendPlainSegment(normalizedHtml.slice(cursor, chosen.index));
    }
    appendRubySegment(chosen.rb, chosen.rt);
    cursor = chosen.index + chosen.len;
  }

  if (docStream.length === 0 || rubyGroups.length === 0) return null;

  const { songTitle, songArtist } = parsePageTitleAndArtist(html);
  return {
    sourceLabel: 'UtaTen',
    sourceUrl,
    songTitle,
    songArtist,
    rubyGroups,
    docStream,
    docFold: docStream.map((c) => c.fold).join(''),
  };
}

interface LineMatchChar {
  segIdx: number;
  exact: string;
  fold: string;
  origChar: string;
}

function buildLineMatchChars(line: LyricLine): LineMatchChar[] {
  const segs = line.segments || [];
  const segChars: LineMatchChar[] = [];
  for (let segIdx = 0; segIdx < segs.length; segIdx++) {
    const jp = segs[segIdx]?.jp || '';
    for (const rawCh of Array.from(jp)) {
      const norm = rawCh.normalize('NFKC');
      for (const ch of Array.from(norm)) {
        if (!MATCH_CHAR_TEST.test(ch)) continue;
        segChars.push({
          segIdx,
          exact: normalizeExactChar(ch),
          fold: foldMatchChar(ch),
          origChar: ch,
        });
      }
    }
  }
  return segChars;
}

function runSemiGlobalDp(
  lineChars: LineMatchChar[],
  docStream: DocStreamChar[],
  winStart: number,
  winEnd: number
): { charMap: Array<number | null>; matchedCount: number; startDocPos: number; endDocPos: number } {
  const n = lineChars.length;
  const m = Math.max(0, winEnd - winStart);
  if (n === 0 || m === 0) {
    return { charMap: new Array(n).fill(null), matchedCount: 0, startDocPos: -1, endDocPos: -1 };
  }

  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  const back = new Uint8Array((n + 1) * width); // 1=diag, 2=up(gap B), 3=left(gap A)

  for (let i = 1; i <= n; i++) {
    score[i * width] = -2 * i;
    back[i * width] = 2;
  }

  for (let i = 1; i <= n; i++) {
    const lc = lineChars[i - 1];
    const rowOff = i * width;
    const prevOff = (i - 1) * width;
    for (let j = 1; j <= m; j++) {
      const dc = docStream[winStart + j - 1];
      const matchScore = lc.exact === dc.exact ? 3 : lc.fold === dc.fold ? 2 : -2;
      const diag = score[prevOff + (j - 1)] + matchScore;
      const up = score[prevOff + j] - 2;
      const left = score[rowOff + (j - 1)] - 2;

      if (diag >= up && diag >= left) {
        score[rowOff + j] = diag;
        back[rowOff + j] = 1;
      } else if (up >= left) {
        score[rowOff + j] = up;
        back[rowOff + j] = 2;
      } else {
        score[rowOff + j] = left;
        back[rowOff + j] = 3;
      }
    }
  }

  let bestJ = 0;
  let bestVal = -Infinity;
  const lastRowOff = n * width;
  for (let j = 0; j <= m; j++) {
    if (score[lastRowOff + j] > bestVal) {
      bestVal = score[lastRowOff + j];
      bestJ = j;
    }
  }

  const charMap: Array<number | null> = new Array(n).fill(null);
  let i = n;
  let j = bestJ;
  let matchedCount = 0;
  let startDocPos = Infinity;
  let endDocPos = -1;

  while (i > 0) {
    const op = j === 0 ? 2 : back[i * width + j];
    if (op === 1 && j > 0) {
      const docPos = winStart + j - 1;
      if (lineChars[i - 1].fold === docStream[docPos].fold) {
        charMap[i - 1] = docPos;
        matchedCount += 1;
        if (docPos < startDocPos) startDocPos = docPos;
        if (docPos > endDocPos) endDocPos = docPos;
      }
      i -= 1;
      j -= 1;
    } else if (op === 3 && j > 0) {
      j -= 1;
    } else {
      i -= 1;
    }
  }

  return {
    charMap,
    matchedCount,
    startDocPos: Number.isFinite(startDocPos) ? startDocPos : -1,
    endDocPos,
  };
}

function alignLineToRubyStream(
  lineChars: LineMatchChar[],
  song: ParsedRubySong,
  cursor: number
): { charMap: Array<number | null>; startDocPos: number; endDocPos: number } | null {
  const n = lineChars.length;
  if (n === 0) return null;
  const lineFold = lineChars.map((c) => c.fold).join('');
  const docLen = song.docStream.length;

  // Short lines: strict exact window match near cursor to avoid false matches
  if (n <= 4) {
    const winStart = Math.max(0, cursor - 8);
    const winEnd = Math.min(docLen, cursor + 90);
    const sub = song.docFold.slice(winStart, winEnd);
    const hit = sub.indexOf(lineFold);
    if (hit < 0) return null;
    const startDocPos = winStart + hit;
    return {
      charMap: lineChars.map((_, idx) => startDocPos + idx),
      startDocPos,
      endDocPos: startDocPos + n - 1,
    };
  }

  // 1. Forward window exact match (fast path)
  const fwdStart = Math.max(0, cursor - 24);
  const fwdEnd = Math.min(docLen, cursor + Math.max(340, n * 6));
  const fwdSlice = song.docFold.slice(fwdStart, fwdEnd);
  const fwdHit = fwdSlice.indexOf(lineFold);
  if (fwdHit >= 0) {
    const startDocPos = fwdStart + fwdHit;
    return {
      charMap: lineChars.map((_, idx) => startDocPos + idx),
      startDocPos,
      endDocPos: startDocPos + n - 1,
    };
  }

  // 2. Forward window fuzzy DP
  const fwdDp = runSemiGlobalDp(lineChars, song.docStream, fwdStart, fwdEnd);
  if (fwdDp.matchedCount / n >= 0.72 && fwdDp.endDocPos >= fwdDp.startDocPos) {
    return {
      charMap: fwdDp.charMap,
      startDocPos: fwdDp.startDocPos,
      endDocPos: fwdDp.endDocPos,
    };
  }

  // 3. Global exact fallback (prefers position >= cursor; handles skipped sections & repeated choruses)
  const globalAfterCursor = song.docFold.indexOf(lineFold, Math.max(0, cursor));
  const globalAny = globalAfterCursor >= 0 ? globalAfterCursor : song.docFold.indexOf(lineFold);
  if (globalAny >= 0) {
    return {
      charMap: lineChars.map((_, idx) => globalAny + idx),
      startDocPos: globalAny,
      endDocPos: globalAny + n - 1,
    };
  }

  // 4. Global anchor-guided DP for lines >= 6 chars
  if (n >= 6) {
    const anchorHits = new Map<number, number>();
    const gramSize = 4;
    const stride = n > 14 ? 2 : 1;
    for (let k = 0; k <= n - gramSize; k += stride) {
      const gram = lineFold.slice(k, k + gramSize);
      let pos = song.docFold.indexOf(gram);
      let guard = 0;
      while (pos >= 0 && guard < 8) {
        const estStart = Math.max(0, pos - k);
        const bucket = Math.floor(estStart / 12) * 12;
        anchorHits.set(bucket, (anchorHits.get(bucket) ?? 0) + 1);
        pos = song.docFold.indexOf(gram, pos + gramSize);
        guard += 1;
      }
    }

    let bestBucket = -1;
    let bestScore = -1;
    for (const [bucket, count] of anchorHits.entries()) {
      const forwardBoost = bucket >= cursor - 12 ? 0.25 : 0;
      const weighted = count + forwardBoost;
      if (weighted > bestScore) {
        bestScore = weighted;
        bestBucket = bucket;
      }
    }

    if (bestBucket >= 0) {
      const winStart = Math.max(0, bestBucket - 16);
      const winEnd = Math.min(docLen, bestBucket + n + Math.max(24, Math.ceil(n * 0.5)));
      const anchorDp = runSemiGlobalDp(lineChars, song.docStream, winStart, winEnd);
      if (anchorDp.matchedCount / n >= 0.75 && anchorDp.endDocPos >= anchorDp.startDocPos) {
        return {
          charMap: anchorDp.charMap,
          startDocPos: anchorDp.startDocPos,
          endDocPos: anchorDp.endDocPos,
        };
      }
    }
  }

  return null;
}

function slicePartialRubyGroup(
  group: RubyGroup,
  startPos: number,
  endPos: number
): string | null {
  if (startPos === 0 && endPos === group.baseFold.length - 1) {
    return group.rubyHira;
  }
  const uncoveredPrefix = group.baseFold.slice(0, startPos);
  const uncoveredSuffix = group.baseFold.slice(endPos + 1);
  if (
    (uncoveredPrefix && !PURE_KANA_STR_TEST.test(uncoveredPrefix)) ||
    (uncoveredSuffix && !PURE_KANA_STR_TEST.test(uncoveredSuffix))
  ) {
    return null;
  }
  if (uncoveredPrefix && !group.rubyHira.startsWith(uncoveredPrefix)) {
    return null;
  }
  if (uncoveredSuffix && !group.rubyHira.endsWith(uncoveredSuffix)) {
    return null;
  }
  const sliced = group.rubyHira.slice(
    uncoveredPrefix.length,
    group.rubyHira.length - uncoveredSuffix.length
  );
  return sliced || null;
}

function reconstructSegmentRubyFromAlignment(
  seg: LyricSegment,
  segMatchIndices: number[],
  lineChars: LineMatchChar[],
  charMap: Array<number | null>,
  song: ParsedRubySong
): string | null {
  if (!KANJI_OR_DIGIT_TEST.test(seg.jp)) return null;
  if (segMatchIndices.length === 0) return null;

  let nextRuby = '';
  let lastDocPos = -1;
  let idx = 0;

  while (idx < segMatchIndices.length) {
    const j = segMatchIndices[idx];
    const chInfo = lineChars[j];
    const docPos = charMap[j];

    if (docPos === null || docPos <= lastDocPos) {
      return null;
    }
    const dc = song.docStream[docPos];
    if (!dc) return null;

    if (dc.rubyGroupId !== null) {
      const groupId = dc.rubyGroupId;
      const group = song.rubyGroups[groupId];
      if (!group) return null;

      let endIdx = idx;
      let prevGroupPos = dc.posInGroup;
      let prevDocPos = docPos;
      while (endIdx + 1 < segMatchIndices.length) {
        const nextJ = segMatchIndices[endIdx + 1];
        const nextDocPos = charMap[nextJ];
        if (nextDocPos === null || nextDocPos <= prevDocPos) break;
        const nextDc = song.docStream[nextDocPos];
        if (
          !nextDc ||
          nextDc.rubyGroupId !== groupId ||
          nextDc.posInGroup !== prevGroupPos + 1
        ) {
          break;
        }
        endIdx += 1;
        prevGroupPos = nextDc.posInGroup;
        prevDocPos = nextDocPos;
      }

      const expectedSlice = group.baseFold.slice(dc.posInGroup, prevGroupPos + 1);
      const actualSlice = segMatchIndices
        .slice(idx, endIdx + 1)
        .map((mIdx) => lineChars[mIdx].fold)
        .join('');
      if (expectedSlice !== actualSlice) {
        return null;
      }

      const resolvedGroupRuby = slicePartialRubyGroup(group, dc.posInGroup, prevGroupPos);
      if (!resolvedGroupRuby) {
        return null;
      }
      nextRuby += resolvedGroupRuby;
      lastDocPos = prevDocPos;
      idx = endIdx + 1;
      continue;
    }

    // Plain char in UtaTen (no <rt>): unsafe if our segment character is kanji or digit
    if (KANJI_TEST.test(chInfo.origChar) || DIGIT_CHAR_TEST.test(chInfo.origChar)) {
      return null;
    }
    if (HIRAGANA_OR_CHOON_TEST.test(chInfo.fold)) {
      nextRuby += chInfo.fold;
    }
    lastDocPos = docPos;
    idx += 1;
  }

  const clean = toHiragana(nextRuby).replace(/[^\u3040-\u309Fー]/g, '');
  if (!clean || clean.length > Math.max(24, seg.jp.length * 6)) {
    return null;
  }
  return clean;
}

function getChipRubyKey(jp: string, fullOrStemRuby: string): string {
  const clean = toHiragana((fullOrStemRuby || '').trim());
  if (!clean) return '';
  const spans = alignFuriganaToKanji(jp, clean);
  return spans.length === 1 ? spans[0].ruby || clean : clean;
}

function rebuildAltReadingsWithWebPrimary(
  seg: LyricSegment,
  nextRuby: string,
  nextKoPron: string,
  longVowelMode: LongVowelMode
): Array<{ ruby: string; koPron: string }> | undefined {
  const byKey = new Map<string, { ruby: string; koPron: string }>();

  const pushCand = (rubyRaw: string, koPronRaw: string) => {
    const key = getChipRubyKey(seg.jp, rubyRaw);
    if (!key || byKey.has(key)) return;
    byKey.set(key, { ruby: key, koPron: koPronRaw.trim() });
  };

  // 1. Web furigana reading first
  pushCand(nextRuby, nextKoPron);

  // 2. Old Kuromoji reading if it existed
  if (seg.ruby && seg.koPron) {
    pushCand(seg.ruby, seg.koPron);
  }

  // 3. Existing altReadings preserved from Kuromoji/IPADIC
  for (const alt of seg.altReadings || []) {
    if (alt.ruby && alt.koPron) {
      pushCand(alt.ruby, alt.koPron);
    }
  }

  // 4. Curated candidates
  for (const cand of getReadingCandidatesForSegment(seg.jp, nextRuby, longVowelMode)) {
    pushCand(cand.ruby, cand.koPron);
  }

  const list = Array.from(byKey.values()).slice(0, 5);
  return list.length >= 2 ? list : undefined;
}

function buildCacheKeys(
  title: string,
  artist: string,
  lines: LyricLine[]
): { metaKey: string; lineKey: string } {
  const { cleanTitle, cleanArtist } = cleanSongQuery(title, artist);
  const nt = normalizeMetaForScore(cleanTitle);
  const na = normalizeMetaForScore(cleanArtist);
  const metaKey = nt ? `m:${nt}|${na}` : '';

  const firstJpLine = lines.find(
    (l) => toFoldString(l.jpText).replace(/[a-z0-9]/gi, '').length >= 6
  );
  const lineFold = firstJpLine ? toFoldString(firstJpLine.jpText) : '';
  const lineKey = lineFold.length >= 6 ? `l:${lineFold.slice(0, 14)}` : '';
  return { metaKey, lineKey };
}

function countJapaneseChars(s: string): number {
  let c = 0;
  for (const ch of Array.from(s || '')) {
    if (JAPANESE_CHAR_TEST.test(ch)) c += 1;
  }
  return c;
}

async function discoverAndFetchUtaTenSong(
  lines: LyricLine[],
  title: string,
  artist: string,
  deadlineMs: number
): Promise<{ song: ParsedRubySong; metaStrong: boolean } | null> {
  const { cleanTitle, cleanArtist } = cleanSongQuery(title, artist);
  const jpLines = lines
    .map((l) => (l.jpText || '').trim())
    .filter((t) => countJapaneseChars(t) >= 5);

  const openingSampleFold = toFoldString(jpLines.slice(0, 6).join(''));
  const seenHref = new Set<string>();
  const allCandidates: SearchCandidate[] = [];

  const collectFromHtml = (html: string | null) => {
    if (!html) return;
    for (const row of parseUtaTenSearchRows(html)) {
      if (seenHref.has(row.href)) continue;
      seenHref.add(row.href);
      allCandidates.push(scoreCandidate(row, openingSampleFold, cleanTitle, cleanArtist));
    }
  };

  // Tier 1: UtaTen search by opening lyrics (`beginning=`)
  const beginningPhrases: string[] = [];
  for (const l of jpLines.slice(0, 2)) {
    const p = pickSearchPhraseFromLine(l, 18);
    if (p && !beginningPhrases.includes(p)) {
      beginningPhrases.push(p);
    }
  }
  if (beginningPhrases.length > 0) {
    const q1 = beginningPhrases[0];
    const url1 = `https://utaten.com/search?sort=popular_sort_asc&beginning=${encodeURIComponent(q1)}`;
    collectFromHtml(await fetchHtmlSafe(url1, deadlineMs));

    if (allCandidates.length === 0 && Array.from(q1).length > 9 && Date.now() < deadlineMs - 1000) {
      const shorter = Array.from(q1).slice(0, 7).join('');
      const url1b = `https://utaten.com/search?sort=popular_sort_asc&beginning=${encodeURIComponent(shorter)}`;
      collectFromHtml(await fetchHtmlSafe(url1b, deadlineMs));
    }
  }

  const bestScoreAfterTier1 = allCandidates.reduce((m, c) => Math.max(m, c.score), -1);

  // Tier 2: Distinctive kanji phrase (`body=`) if Tier 1 didn't lock a strong match
  if (
    bestScoreAfterTier1 < 45 &&
    (jpLines.length >= 3 || Boolean(cleanTitle)) &&
    Date.now() < deadlineMs - 1200
  ) {
    const midStart = Math.min(jpLines.length - 1, Math.floor(jpLines.length * 0.25));
    const midLines = [...jpLines.slice(midStart), ...jpLines.slice(0, midStart)];
    const kanjiLine =
      midLines.find((t) => {
        const kCount = (t.match(/[\u4E00-\u9FFF々]/g) || []).length;
        return kCount >= 2 && pickSearchPhraseFromLine(t, 16).length >= 7;
      }) ||
      midLines.find((t) => {
        const kCount = (t.match(/[\u4E00-\u9FFF々]/g) || []).length;
        return kCount >= 1 && pickSearchPhraseFromLine(t, 16).length >= 5;
      });
    if (kanjiLine) {
      const bp = pickSearchPhraseFromLine(kanjiLine, 16);
      if (bp) {
        const bodyUrl = `https://utaten.com/search?sort=popular_sort_asc&body=${encodeURIComponent(bp)}`;
        collectFromHtml(await fetchHtmlSafe(bodyUrl, deadlineMs));
      }
    }
  }

  const bestScoreAfterTier2 = allCandidates.reduce((m, c) => Math.max(m, c.score), -1);

  // Tier 3: Artist catalog lookup (`artist_name=`, NEVER `title=`) when metadata is available
  if (bestScoreAfterTier2 < 35 && cleanArtist && Date.now() < deadlineMs - 1200) {
    const artistUrl = `https://utaten.com/search?sort=popular_sort_asc&artist_name=${encodeURIComponent(cleanArtist)}`;
    collectFromHtml(await fetchHtmlSafe(artistUrl, deadlineMs));
  }

  if (allCandidates.length === 0) return null;

  allCandidates.sort((a, b) => b.score - a.score);
  const topCandidates = allCandidates.filter((c) => c.score >= 15).slice(0, 2);
  if (topCandidates.length === 0) return null;

  for (const cand of topCandidates) {
    if (Date.now() >= deadlineMs - 400) break;
    const html = await fetchHtmlSafe(cand.url, deadlineMs);
    if (!html) continue;
    const parsed = parseUtaTenRubyPage(html, cand.url);
    if (parsed) {
      return { song: parsed, metaStrong: cand.metaStrong };
    }
  }

  return null;
}

export async function applyWebFuriganaToLines(
  lines: LyricLine[],
  opts: { title?: string; artist?: string; longVowelMode?: LongVowelMode } = {}
): Promise<{ lines: LyricLine[]; furiganaSource: WebFuriganaMatchInfo }> {
  const longVowelMode: LongVowelMode = opts.longVowelMode === 'dash' ? 'dash' : 'vowel';
  const rawTitle = (opts.title || '').trim();
  const title = rawTitle === '가라오케' ? '' : rawTitle;
  const artist = (opts.artist || '').trim();
  const totalLines = lines.length;

  const emptyInfo = (): WebFuriganaMatchInfo => ({
    matched: false,
    sourceLabel: 'UtaTen',
    matchedLines: 0,
    totalLines,
    overriddenSegments: 0,
    verifiedSegments: 0,
  });

  if (totalLines === 0 || !lines.some((l) => KANJI_TEST.test(l.jpText || ''))) {
    return { lines, furiganaSource: emptyInfo() };
  }

  const kanjiLineCount = lines.filter((l) => countJapaneseChars(l.jpText) >= 2).length;
  const { metaKey, lineKey } = buildCacheKeys(title, artist, lines);

  // Short/single-line lookups require either a strong title cache hit or title+artist metadata
  if (kanjiLineCount < 3 && !title) {
    return { lines, furiganaSource: emptyInfo() };
  }

  try {
    let song: ParsedRubySong | null = null;
    let fromCache = false;
    let metaStrong = false;

    const metaCached = metaKey ? getCacheEntry(metaKey) : { hit: false, song: null };
    if (metaCached.hit) {
      if (!metaCached.song) {
        return { lines, furiganaSource: emptyInfo() };
      }
      song = metaCached.song;
      fromCache = true;
      metaStrong = true;
    } else if (lineKey) {
      const lineCached = getCacheEntry(lineKey);
      if (lineCached.hit) {
        if (!lineCached.song) {
          return { lines, furiganaSource: emptyInfo() };
        }
        // Only trust line-only cache without title mismatch
        const cachedTitleSim = title ? metaMatchRatio(title, lineCached.song.songTitle) : 1;
        if (cachedTitleSim >= 0.5) {
          song = lineCached.song;
          fromCache = true;
          metaStrong = Boolean(title && cachedTitleSim >= 0.8);
        }
      }
    }

    if (!song) {
      const deadlineMs = Date.now() + OVERALL_BUDGET_MS;
      const fetched = await discoverAndFetchUtaTenSong(lines, title, artist, deadlineMs);
      if (!fetched) {
        if (metaKey) {
          touchCacheSet(metaKey, { song: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
        }
        return { lines, furiganaSource: emptyInfo() };
      }
      song = fetched.song;
      metaStrong = fetched.metaStrong;
    }

    // Align every target line monotonically onto the fetched UtaTen ruby stream
    let cursor = 0;
    let matchedLineCount = 0;
    const perLineAlignments: Array<{
      lineChars: LineMatchChar[];
      charMap: Array<number | null>;
    } | null> = new Array(lines.length).fill(null);

    for (let i = 0; i < lines.length; i++) {
      const lineChars = buildLineMatchChars(lines[i]);
      if (lineChars.length === 0) continue;
      const aligned = alignLineToRubyStream(lineChars, song, cursor);
      if (!aligned) continue;
      perLineAlignments[i] = { lineChars, charMap: aligned.charMap };
      matchedLineCount += 1;
      if (aligned.startDocPos >= cursor) {
        cursor = aligned.endDocPos + 1;
      }
    }

    // Verify this actually matches the target song before applying any overrides
    const requiredLines =
      kanjiLineCount >= 4 ? Math.max(2, Math.ceil(kanjiLineCount * 0.45)) : 1;
    const shortLineAllowed =
      kanjiLineCount >= 4 || fromCache || metaStrong;

    if (matchedLineCount < requiredLines || !shortLineAllowed) {
      if (!fromCache && metaKey) {
        touchCacheSet(metaKey, { song: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
      }
      return { lines, furiganaSource: emptyInfo() };
    }

    // Store successful song in LRU cache under both metaKey and lineKey
    const posEntry: CacheEntry = { song, expiresAt: Date.now() + POSITIVE_CACHE_TTL_MS };
    if (metaKey) touchCacheSet(metaKey, posEntry);
    if (lineKey && kanjiLineCount >= 4) touchCacheSet(lineKey, posEntry);

    let overriddenSegments = 0;
    let verifiedSegments = 0;
    const updatedLines: LyricLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const origLine = lines[i];
      const alignment = perLineAlignments[i];
      if (!alignment) {
        updatedLines.push(origLine);
        continue;
      }

      const { lineChars, charMap } = alignment;
      const segIndicesBySeg = new Map<number, number[]>();
      for (let j = 0; j < lineChars.length; j++) {
        const list = segIndicesBySeg.get(lineChars[j].segIdx);
        if (list) list.push(j);
        else segIndicesBySeg.set(lineChars[j].segIdx, [j]);
      }

      const updatedSegs: LyricSegment[] = [];
      for (let sIdx = 0; sIdx < origLine.segments.length; sIdx++) {
        const seg = origLine.segments[sIdx];
        if (!KANJI_OR_DIGIT_TEST.test(seg.jp)) {
          updatedSegs.push(seg);
          continue;
        }
        if (seg.rubySource === 'user') {
          verifiedSegments += 1;
          updatedSegs.push(seg);
          continue;
        }

        const segMatchIndices = segIndicesBySeg.get(sIdx) || [];
        const nextRuby = reconstructSegmentRubyFromAlignment(
          seg,
          segMatchIndices,
          lineChars,
          charMap,
          song
        );
        if (!nextRuby) {
          updatedSegs.push(seg);
          continue;
        }

        const oldRubyHira = toHiragana((seg.ruby || '').trim());
        const oldKanjiKey = getChipRubyKey(seg.jp, oldRubyHira);
        const nextKanjiKey = getChipRubyKey(seg.jp, nextRuby);
        const readingChanged =
          oldKanjiKey !== nextKanjiKey || oldRubyHira !== nextRuby || !seg.koPron.trim();

        if (readingChanged) {
          const nextKoPron = await computeKoPronWithParticles(
            seg.jp,
            nextRuby,
            longVowelMode
          );
          verifiedSegments += 1;
          overriddenSegments += 1;
          const altReadings = rebuildAltReadingsWithWebPrimary(
            seg,
            nextRuby,
            nextKoPron,
            longVowelMode
          );
          updatedSegs.push({
            ...seg,
            ruby: nextRuby,
            koPron: nextKoPron,
            rubySource: 'web',
            ...(altReadings ? { altReadings } : {}),
          });
        } else {
          verifiedSegments += 1;
          updatedSegs.push({
            ...seg,
            rubySource: 'web',
          });
        }
      }

      updatedLines.push({
        ...origLine,
        segments: updatedSegs,
      });
    }

    return {
      lines: updatedLines,
      furiganaSource: {
        matched: true,
        sourceLabel: song.sourceLabel,
        sourceUrl: song.sourceUrl,
        songTitle: song.songTitle,
        songArtist: song.songArtist,
        matchedLines: matchedLineCount,
        totalLines,
        overriddenSegments,
        verifiedSegments,
      },
    };
  } catch {
    return { lines, furiganaSource: emptyInfo() };
  }
}
