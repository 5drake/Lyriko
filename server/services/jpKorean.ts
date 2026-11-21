import { createRequire } from 'node:module';
import path from 'node:path';
import kuromoji, { type IpadicFeatures, type Tokenizer } from 'kuromoji';
import type { LyricLine, LyricSegment } from '../../shared/types.js';
import {
  alignFuriganaToKanji,
  redistributeSegmentTimings,
  toHiragana,
} from '../../shared/timing.js';
import {
  buildFullKanaFromSegment,
  buildKoPronFromSegment,
  getReadingCandidatesForSegment,
  katakanaToKorean,
  katakanaToMmsRomaji,
  toKatakana,
  type LongVowelMode,
  type ReadingCandidate,
} from '../../shared/jpPronunciation.js';

export {
  getReadingCandidatesForSegment,
  katakanaToKorean,
  katakanaToMmsRomaji,
  toKatakana,
  type LongVowelMode,
  type ReadingCandidate,
};

const require = createRequire(import.meta.url);

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;
let tokenizerReadyFlag = false;

export function isKuromojiReady(): boolean {
  return tokenizerReadyFlag;
}

export function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    const pkgPath = require.resolve('kuromoji/package.json');
    const dicPath = path.join(path.dirname(pkgPath), 'dict');
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err) {
          tokenizerPromise = null;
          reject(err);
        } else {
          tokenizerReadyFlag = true;
          resolve(tokenizer);
        }
      });
    });
  }
  return tokenizerPromise;
}

const KANJI_TEST = /[\u4E00-\u9FFF々]/;
const KANA_ONLY_TEST = /^[\u3040-\u309F\u30A0-\u30FFー]+$/;
const PUNCT_ONLY_TEST = /^[\s、。,.!?！？「」『』()（）・〜~…♪♡★\-]+$/;

function shouldMergeWithPrevious(
  prevTokens: IpadicFeatures[],
  curr: IpadicFeatures
): boolean {
  if (prevTokens.length === 0) return false;
  const prev = prevTokens[prevTokens.length - 1];

  // Never merge across pure whitespace separator
  if (prev.surface_form.trim() === '' || curr.surface_form.trim() === '') {
    return false;
  }
  // Punctuation attaches to previous segment regardless of POS
  if (PUNCT_ONLY_TEST.test(curr.surface_form)) {
    return true;
  }
  // Keep English apostrophe contractions (e.g. Don't, I'll) in one segment
  if ((curr.surface_form === "'" || curr.surface_form === '’') && /[a-zA-Z]$/.test(prev.surface_form)) {
    return true;
  }
  if ((prev.surface_form === "'" || prev.surface_form === '’') && /^[a-zA-Z]+$/.test(curr.surface_form)) {
    return true;
  }

  // Merge particles, auxiliary verbs, suffixes onto preceding word (bunsetsu grouping)
  if (curr.pos === '助詞' || curr.pos === '助動詞') {
    // Avoid giant 12+ character segments
    const prevLen = prevTokens.reduce((n, t) => n + t.surface_form.length, 0);
    if (prevLen <= 8) return true;
  }
  if (curr.pos_detail_1 === '接尾' || curr.pos_detail_1 === '非自立') {
    const prevLen = prevTokens.reduce((n, t) => n + t.surface_form.length, 0);
    if (prevLen <= 7) return true;
  }
  // Keep verb + conjunctive te/ta/nai smooth
  if (prev.pos === '動詞' && (curr.pos === '動詞' && curr.pos_detail_1 === '非自立')) {
    return true;
  }
  return false;
}

function tokenReadingKata(tok: IpadicFeatures): string {
  if (tok.reading && tok.reading !== '*') {
    return tok.reading;
  }
  if (KANA_ONLY_TEST.test(tok.surface_form)) {
    return toKatakana(tok.surface_form);
  }
  return '';
}

function tokenPronKata(tok: IpadicFeatures): string {
  // Handle particles explicitly for accurate singing pronunciation
  if (tok.pos === '助詞') {
    if (tok.surface_form === 'は') return 'ワ';
    if (tok.surface_form === 'へ') return 'エ';
    if (tok.surface_form === 'を') return 'オ';
  }
  if (tok.pronunciation && tok.pronunciation !== '*') {
    return tok.pronunciation;
  }
  return tokenReadingKata(tok);
}

function toHalfWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

function isDigitToken(surface: string): boolean {
  return /^[0-9０-９]+$/.test(surface);
}

const DIGIT_WORDS = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'];

function numberUnder10000Kata(n: number): string {
  if (n <= 0) return '';
  let out = '';
  const thousands = Math.floor(n / 1000);
  const rem1000 = n % 1000;
  if (thousands > 0) {
    if (thousands === 1) out += 'セン';
    else if (thousands === 3) out += 'サンゼン';
    else if (thousands === 8) out += 'ハッセン';
    else out += DIGIT_WORDS[thousands] + 'セン';
  }
  const hundreds = Math.floor(rem1000 / 100);
  const rem100 = rem1000 % 100;
  if (hundreds > 0) {
    if (hundreds === 1) out += 'ヒャク';
    else if (hundreds === 3) out += 'サンビャク';
    else if (hundreds === 6) out += 'ロッピャク';
    else if (hundreds === 8) out += 'ハッピャク';
    else out += DIGIT_WORDS[hundreds] + 'ヒャク';
  }
  const tens = Math.floor(rem100 / 10);
  const ones = rem100 % 10;
  if (tens > 0) {
    if (tens === 1) out += 'ジュウ';
    else out += DIGIT_WORDS[tens] + 'ジュウ';
  }
  if (ones > 0) {
    out += DIGIT_WORDS[ones];
  }
  return out;
}

function numberToJapaneseKata(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'ゼロ';
  const intVal = Math.floor(n);
  if (intVal >= 100000000) {
    const oku = Math.floor(intVal / 100000000);
    const rest = intVal % 100000000;
    return numberToJapaneseKata(oku) + 'オク' + (rest > 0 ? numberToJapaneseKata(rest) : '');
  }
  const man = Math.floor(intVal / 10000);
  const low = intVal % 10000;
  let out = '';
  if (man > 0) {
    out += numberUnder10000Kata(man) + 'マン';
  }
  if (low > 0) {
    out += numberUnder10000Kata(low);
  }
  return out;
}

function replaceLastNumericTail(baseKata: string, lastDigit: number, rep: string): string {
  if (lastDigit === 1 && baseKata.endsWith('イチ')) return baseKata.slice(0, -2) + rep;
  if (lastDigit === 3 && baseKata.endsWith('サン')) return baseKata.slice(0, -2) + rep;
  if (lastDigit === 4 && baseKata.endsWith('ヨン')) return baseKata.slice(0, -2) + rep;
  if (lastDigit === 6 && baseKata.endsWith('ロク')) return baseKata.slice(0, -2) + rep;
  if (lastDigit === 8 && baseKata.endsWith('ハチ')) return baseKata.slice(0, -2) + rep;
  return baseKata + rep;
}

function withEuphonicCounter(
  n: number,
  unit: string,
  opts: {
    on1?: string;
    on3?: string;
    on4?: string;
    on6?: string;
    on8?: string;
    on10?: string;
    on100?: string;
  }
): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (n > 0 && mod100 === 0 && opts.on100) {
    const base = numberToJapaneseKata(n);
    if (base.endsWith('ヒャク')) {
      return base.slice(0, -3) + opts.on100;
    }
  }
  if (mod10 === 0 && n > 0 && opts.on10) {
    const base = numberToJapaneseKata(n);
    if (base.endsWith('ジュウ')) {
      return base.slice(0, -3) + opts.on10;
    }
  }
  const map: Record<number, string | undefined> = {
    1: opts.on1,
    3: opts.on3,
    4: opts.on4,
    6: opts.on6,
    8: opts.on8,
  };
  const custom = map[mod10];
  if (custom) {
    return replaceLastNumericTail(numberToJapaneseKata(n), mod10, custom);
  }
  return numberToJapaneseKata(n) + unit;
}

function resolveNumberCounterKata(numStr: string, counter: string): string | null {
  const digits = toHalfWidthDigits(numStr);
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0 || n > 999999999) return null;

  switch (counter) {
    case '人': {
      if (n === 1) return 'ヒトリ';
      if (n === 2) return 'フタリ';
      if (n === 4) return 'ヨニン';
      if (n === 7) return 'ナナニン';
      return numberToJapaneseKata(n) + 'ニン';
    }
    case 'つ': {
      const kunTsu: Record<number, string> = {
        1: 'ヒトツ',
        2: 'フタツ',
        3: 'ミッツ',
        4: 'ヨッツ',
        5: 'イツツ',
        6: 'ムッツ',
        7: 'ナナツ',
        8: 'ヤッツ',
        9: 'ココノツ',
      };
      return kunTsu[n] ?? null;
    }
    case '日': {
      const specialDays: Record<number, string> = {
        1: 'イチニチ',
        2: 'フツカ',
        3: 'ミッカ',
        4: 'ヨッカ',
        5: 'イツカ',
        6: 'ムイカ',
        7: 'ナノカ',
        8: 'ヨウカ',
        9: 'ココノカ',
        10: 'トオカ',
        14: 'ジュウヨッカ',
        20: 'ハツカ',
        24: 'ニジュウヨッカ',
      };
      return specialDays[n] ?? `${numberToJapaneseKata(n)}ニチ`;
    }
    case '回':
      return withEuphonicCounter(n, 'カイ', {
        on1: 'イッカイ',
        on6: 'ロッカイ',
        on8: 'ハッカイ',
        on10: 'ジッカイ',
        on100: 'ヒャッカイ',
      });
    case '分':
      return withEuphonicCounter(n, 'フン', {
        on1: 'イップン',
        on3: 'サンプン',
        on4: 'ヨンプン',
        on6: 'ロップン',
        on8: 'ハップン',
        on10: 'ジュップン',
        on100: 'ヒャップン',
      });
    case '歩':
      return withEuphonicCounter(n, 'ホ', {
        on1: 'イッポ',
        on3: 'サンポ',
        on4: 'ヨンホ',
        on6: 'ロッポ',
        on8: 'ハッポ',
        on10: 'ジュッポ',
        on100: 'ヒャッポ',
      });
    case '本':
      return withEuphonicCounter(n, 'ホン', {
        on1: 'イッポン',
        on3: 'サンボン',
        on6: 'ロッポン',
        on8: 'ハッポン',
        on10: 'ジュッポン',
        on100: 'ヒャッポン',
      });
    case '個':
      return withEuphonicCounter(n, 'コ', {
        on1: 'イッコ',
        on6: 'ロッコ',
        on8: 'ハッコ',
        on10: 'ジッコ',
        on100: 'ヒャッコ',
      });
    case '歳':
    case '才':
      if (n === 20) return 'ハタチ';
      return withEuphonicCounter(n, 'サイ', {
        on1: 'イッサイ',
        on8: 'ハッサイ',
        on10: 'ジッサイ',
        on100: 'ヒャッサイ',
      });
    case '度':
      return `${numberToJapaneseKata(n)}ド`;
    case '番':
      return `${numberToJapaneseKata(n)}バン`;
    case '秒':
      return `${numberToJapaneseKata(n)}ビョウ`;
    case '時': {
      if (n === 4) return 'ヨジ';
      if (n === 7) return 'シチジ';
      if (n === 9) return 'クジ';
      return `${numberToJapaneseKata(n)}ジ`;
    }
    case '時間': {
      if (n === 4) return 'ヨジカン';
      if (n === 7) return 'ナナジカン';
      if (n === 9) return 'クジカン';
      return `${numberToJapaneseKata(n)}ジカン`;
    }
    case '年': {
      if (n === 4) return 'ヨネン';
      if (n === 7) return 'ナナネン';
      if (n === 9) return 'キュウネン';
      return `${numberToJapaneseKata(n)}ネン`;
    }
    case '枚':
      return `${numberToJapaneseKata(n)}マイ`;
    case '万':
      return `${numberToJapaneseKata(n)}マン`;
    case '億':
      return `${numberToJapaneseKata(n)}オク`;
    case '千':
      if (n === 1) return 'セン';
      if (n === 3) return 'サンゼン';
      if (n === 8) return 'ハッセン';
      return `${numberToJapaneseKata(n)}セン`;
    case '百':
      if (n === 1) return 'ヒャク';
      if (n === 3) return 'サンビャク';
      if (n === 6) return 'ロッピャク';
      if (n === 8) return 'ハッピャク';
      return `${numberToJapaneseKata(n)}ヒャク`;
    case '%':
    case '％':
      return `${numberToJapaneseKata(n)}パーセント`;
    default:
      return null;
  }
}

const SCALE_MULT: Record<string, number> = {
  万: 10000,
  億: 100000000,
  千: 1000,
  百: 100,
};

function fuseNumberCounterTokens(tokens: IpadicFeatures[]): IpadicFeatures[] {
  const fused: IpadicFeatures[] = [];
  let i = 0;

  while (i < tokens.length) {
    const cur = tokens[i];
    if (isDigitToken(cur.surface_form) && i + 1 < tokens.length) {
      const t1 = tokens[i + 1];
      const t2 = i + 2 < tokens.length ? tokens[i + 2] : null;

      // Compound: <digits> + ("時" + "間") e.g. "2時間"
      if (t1.surface_form === '時' && t2 && t2.surface_form === '間') {
        const kata = resolveNumberCounterKata(cur.surface_form, '時間');
        if (kata) {
          fused.push({
            ...cur,
            surface_form: `${cur.surface_form}時間`,
            pos: '名詞',
            pos_detail_1: '一般',
            reading: kata,
            pronunciation: kata,
          });
          i += 3;
          continue;
        }
      }

      // Compound scale + counter: <digits> + ("万"|"億"|"千"|"百") + <counter> e.g. "1万回"
      const scaleMult = SCALE_MULT[t1.surface_form];
      if (scaleMult && t2) {
        const scaledVal = Number(toHalfWidthDigits(cur.surface_form)) * scaleMult;
        if (Number.isFinite(scaledVal) && scaledVal > 0) {
          const kata = resolveNumberCounterKata(String(scaledVal), t2.surface_form);
          if (kata) {
            fused.push({
              ...cur,
              surface_form: `${cur.surface_form}${t1.surface_form}${t2.surface_form}`,
              pos: '名詞',
              pos_detail_1: '一般',
              reading: kata,
              pronunciation: kata,
            });
            i += 3;
            continue;
          }
        }
      }

      // Simple: <digits> + <counter>
      const kata = resolveNumberCounterKata(cur.surface_form, t1.surface_form);
      if (kata) {
        fused.push({
          ...cur,
          surface_form: `${cur.surface_form}${t1.surface_form}`,
          pos: '名詞',
          pos_detail_1: '一般',
          reading: kata,
          pronunciation: kata,
        });
        i += 2;
        continue;
      }
    }

    fused.push(cur);
    i += 1;
  }

  return fused;
}

const UNKNOWN_KANJI_STEM_OVERRIDES: Record<string, string> = {
  違: 'チガ',
  彷徨: 'サマヨ',
  煌: 'キラ',
  儚: 'ハカナ',
  眩: 'マブ',
  滲: 'ニジ',
  零: 'コボ',
  繋: 'ツナ',
};

const STEM_SUFFIX_PROBES: Array<[string, string]> = [
  ['う', 'ウ'],
  ['る', 'ル'],
  ['く', 'ク'],
  ['す', 'ス'],
  ['む', 'ム'],
  ['つ', 'ツ'],
  ['ぶ', 'ブ'],
  ['ぐ', 'グ'],
  ['ぬ', 'ヌ'],
  ['い', 'イ'],
  ['めく', 'メク'],
  ['やか', 'ヤカ'],
];

function resolveUnknownKanjiReading(
  tokenizer: Tokenizer<IpadicFeatures>,
  surface: string,
  depth = 0
): string {
  const clean = surface.trim();
  if (!clean || depth > 1) return '';
  if (UNKNOWN_KANJI_STEM_OVERRIDES[clean]) {
    return UNKNOWN_KANJI_STEM_OVERRIDES[clean];
  }

  let fallbackMatch = '';
  for (const [hiraSuf, kataSuf] of STEM_SUFFIX_PROBES) {
    const res = tokenizer.tokenize(clean + hiraSuf);
    if (
      res.length === 1 &&
      res[0].reading &&
      res[0].reading !== '*' &&
      res[0].reading.endsWith(kataSuf)
    ) {
      const stem = res[0].reading.slice(0, -kataSuf.length);
      if (stem) {
        if (res[0].pos === '動詞' || res[0].pos === '形容詞') {
          return stem;
        }
        if (!fallbackMatch) {
          fallbackMatch = stem;
        }
      }
    }
  }
  if (fallbackMatch) return fallbackMatch;

  const chars = Array.from(clean);
  if (chars.length > 1) {
    let combined = '';
    for (const ch of chars) {
      if (!KANJI_TEST.test(ch)) {
        if (/^[\u3040-\u309F]$/.test(ch)) {
          combined += toKatakana(ch);
        } else if (/^[\u30A0-\u30FFー]$/.test(ch)) {
          combined += ch;
        }
        continue;
      }
      const single = tokenizer.tokenize(ch);
      if (
        single.length === 1 &&
        single[0].reading &&
        single[0].reading !== '*'
      ) {
        combined += single[0].reading;
      } else {
        const sub = resolveUnknownKanjiReading(tokenizer, ch, depth + 1);
        if (!sub) return '';
        combined += sub;
      }
    }
    return combined;
  }

  return '';
}

function enrichUnknownKanjiTokens(
  tokenizer: Tokenizer<IpadicFeatures>,
  tokens: IpadicFeatures[]
): IpadicFeatures[] {
  return tokens.map((tok) => {
    // Kuromoji IPADIC defaults standalone 傍 to archaic ハタ instead of common J-POP ソバ
    if (
      tok.surface_form === '傍' &&
      tok.pos === '名詞' &&
      tok.reading === 'ハタ'
    ) {
      return {
        ...tok,
        reading: 'ソバ',
        pronunciation: 'ソバ',
      };
    }
    if (
      KANJI_TEST.test(tok.surface_form) &&
      (!tok.reading || tok.reading === '*')
    ) {
      const resolved = resolveUnknownKanjiReading(tokenizer, tok.surface_form);
      if (resolved) {
        return {
          ...tok,
          reading: resolved,
          pronunciation: resolved,
        };
      }
    }
    return tok;
  });
}

function lookupIpadicTokenReadings(
  tokenizer: Tokenizer<IpadicFeatures>,
  tok: IpadicFeatures
): string[] {
  const viterbi = (
    tokenizer as unknown as {
      viterbi_builder?: {
        trie?: { commonPrefixSearch: (k: string) => Array<{ k: string; v: number }> };
        token_info_dictionary?: {
          target_map?: Record<number, number[]>;
          getFeatures: (id: number) => string | undefined;
        };
      };
    }
  ).viterbi_builder;
  const trie = viterbi?.trie;
  const dict = viterbi?.token_info_dictionary;
  if (!trie || !dict?.target_map) return [];

  const hits = trie
    .commonPrefixSearch(tok.surface_form)
    .filter((h) => h.k === tok.surface_form);
  const readings = new Set<string>();
  for (const h of hits) {
    const ids = dict.target_map[h.v] || [];
    for (const tid of ids) {
      const feat = dict.getFeatures(tid);
      if (!feat) continue;
      const p = feat.split(',');
      if (p[1] !== tok.pos) continue;
      if (
        p[2] === '固有名詞' ||
        p[2] === '接尾' ||
        p[2] === '接頭詞' ||
        p[2] === '数'
      ) {
        continue;
      }
      if ((tok.pos === '動詞' || tok.pos === '形容詞') && p[6] !== tok.conjugated_form) {
        continue;
      }
      const r = p[8];
      if (r && r !== '*') {
        readings.add(toHiragana(r));
      }
    }
  }
  return Array.from(readings);
}

function getServerCandidatesForSegment(
  tokenizer: Tokenizer<IpadicFeatures>,
  jp: string,
  currentRuby: string,
  options: { longVowelMode?: LongVowelMode } = {}
): ReadingCandidate[] {
  const curated = getReadingCandidatesForSegment(jp, currentRuby, options.longVowelMode);
  const byRuby = new Map<string, ReadingCandidate>();
  for (const c of curated) {
    byRuby.set(c.ruby, c);
  }

  const segTokens = enrichUnknownKanjiTokens(
    tokenizer,
    fuseNumberCounterTokens(tokenizer.tokenize(jp || ''))
  );
  const kanjiTokens = segTokens.filter((t) => KANJI_TEST.test(t.surface_form));
  if (kanjiTokens.length === 1) {
    const kTok = kanjiTokens[0];
    const dictReadings = lookupIpadicTokenReadings(tokenizer, kTok);
    if (dictReadings.length >= 2) {
      for (const dr of dictReadings) {
        const fullSegHira = segTokens
          .map((t) =>
            t === kTok ? dr : toHiragana(tokenReadingKata(t) || t.surface_form)
          )
          .join('');
        const cleanRuby = alignFuriganaToKanji(jp, fullSegHira)[0]?.ruby || dr;
        if (!cleanRuby || byRuby.has(cleanRuby)) continue;
        const fullKana = buildFullKanaFromSegment(jp, cleanRuby);
        byRuby.set(cleanRuby, {
          ruby: cleanRuby,
          koPron: buildKoPronFromSegment(jp, cleanRuby, options.longVowelMode),
          alignRomaji: katakanaToMmsRomaji(fullKana),
        });
      }
    }
  }

  if (byRuby.size < 2) return [];

  const normCur =
    toHiragana(alignFuriganaToKanji(jp, currentRuby)[0]?.ruby || '').trim() ||
    toHiragana((currentRuby || '').trim());
  const list = Array.from(byRuby.values());
  if (normCur) {
    const curIdx = list.findIndex((c) => c.ruby === normCur);
    if (curIdx > 0) {
      const [curItem] = list.splice(curIdx, 1);
      list.unshift(curItem);
    }
  }
  return list.slice(0, 5);
}

export async function analyzeLineToSegments(
  jpText: string,
  startTime: number,
  endTime: number,
  options: { longVowelMode?: LongVowelMode } = {}
): Promise<LyricSegment[]> {
  const cleaned = jpText.trim();
  if (!cleaned) return [];

  const tokenizer = await getTokenizer();
  const rawTokens = enrichUnknownKanjiTokens(
    tokenizer,
    fuseNumberCounterTokens(tokenizer.tokenize(cleaned))
  );

  // Split out pure spaces cleanly, group bunsetsu chunks
  const groups: IpadicFeatures[][] = [];
  for (const tok of rawTokens) {
    if (/^\s+$/.test(tok.surface_form)) {
      continue;
    }
    if (groups.length > 0 && shouldMergeWithPrevious(groups[groups.length - 1], tok)) {
      groups[groups.length - 1].push(tok);
    } else {
      groups.push([tok]);
    }
  }

  // Filter out leading/trailing orphan punctuation groups by attaching to neighbors
  const segments: LyricSegment[] = groups.map((group, idx) => {
    const jp = group.map((t) => t.surface_form).join('');
    const hasUnresolvedKanji = group.some(
      (t) => KANJI_TEST.test(t.surface_form) && !tokenReadingKata(t)
    );
    const hasRubyBase =
      KANJI_TEST.test(jp) ||
      (/[0-9０-９]/.test(jp) &&
        group.some((t) =>
          Boolean(t.reading && t.reading !== '*' && /^[0-9０-９]/.test(t.surface_form))
        ));

    const readingKata = group
      .map((t) => tokenReadingKata(t) || t.surface_form)
      .join('');
    const ruby =
      !hasUnresolvedKanji && hasRubyBase && !PUNCT_ONLY_TEST.test(readingKata)
        ? toHiragana(readingKata).replace(/[^\u3040-\u309Fー]/g, '')
        : '';

    const pronParts = group.map((t) => {
      if (PUNCT_ONLY_TEST.test(t.surface_form)) {
        return '';
      }
      const pk = tokenPronKata(t);
      if (pk) {
        return katakanaToKorean(pk, options);
      }
      if (/^[a-zA-Z0-9'’]+$/.test(t.surface_form)) {
        return t.surface_form === '’' ? "'" : t.surface_form.replace(/’/g, "'");
      }
      return '';
    });

    const koPron = pronParts.join('').trim();
    const serverCands = getServerCandidatesForSegment(tokenizer, jp, ruby, options);

    return {
      id: `seg_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      jp,
      ruby,
      koPron,
      startTime,
      endTime,
      ...(serverCands.length >= 2
        ? {
            altReadings: serverCands.map(({ ruby: r, koPron: k }) => ({
              ruby: r,
              koPron: k,
            })),
          }
        : {}),
    };
  });

  const dummyLine: LyricLine = {
    id: 'tmp',
    startTime,
    endTime,
    jpText: cleaned,
    koTranslation: '',
    segments,
  };
  return redistributeSegmentTimings(dummyLine).segments;
}

export interface ParsedTimedLine {
  startTime: number;
  endTime: number;
  jpText: string;
}

export function parseLrcOrText(rawInput: string, totalDuration = 240): ParsedTimedLine[] {
  const lines = rawInput.replace(/\r\n/g, '\n').split('\n');
  const lrcTagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  // Detect SRT format first
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(rawInput)) {
    return parseSrt(rawInput);
  }

  const timedEntries: { time: number; text: string }[] = [];
  const plainLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Skip LRC metadata tags like [ti:...], [ar:...], [al:...], [by:...], [offset:...]
    if (/^\[(ti|ar|al|au|by|offset|length|re|ve):/i.test(trimmed)) continue;

    const matches = [...trimmed.matchAll(lrcTagRe)];
    if (matches.length > 0) {
      const lyricText = trimmed.replace(lrcTagRe, '').trim();
      if (!lyricText) continue;
      for (const m of matches) {
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        const fracRaw = m[3] ?? '0';
        const frac =
          fracRaw.length === 3
            ? parseInt(fracRaw, 10) / 1000
            : fracRaw.length === 2
            ? parseInt(fracRaw, 10) / 100
            : parseInt(fracRaw, 10) / 10;
        timedEntries.push({
          time: Number((mins * 60 + secs + frac).toFixed(3)),
          text: lyricText,
        });
      }
    } else {
      plainLines.push(trimmed);
    }
  }

  if (timedEntries.length > 0) {
    timedEntries.sort((a, b) => a.time - b.time);
    return timedEntries.map((entry, idx) => {
      const next = timedEntries[idx + 1];
      // Estimate realistic vocal duration: cap at 7.5s or gap before next line - 0.15s
      const maxEnd = next ? Math.max(entry.time + 0.6, next.time - 0.15) : Math.min(totalDuration, entry.time + 5.0);
      const estEnd = Math.min(maxEnd, entry.time + Math.max(2.0, Math.min(6.8, entry.text.length * 0.28)));
      return {
        startTime: entry.time,
        endTime: Number(estEnd.toFixed(3)),
        jpText: entry.text,
      };
    });
  }

  // Plain untimed lyrics: distribute evenly starting at 5s
  const startOffset = 5;
  const usable = Math.max(20, totalDuration - startOffset - 5);
  const step = plainLines.length > 0 ? Math.min(5.5, usable / plainLines.length) : 4;
  return plainLines.map((text, idx) => {
    const startTime = Number((startOffset + idx * step).toFixed(3));
    const endTime = Number((startTime + Math.max(1.5, step - 0.4)).toFixed(3));
    return { startTime, endTime, jpText: text };
  });
}

function parseSrtTime(s: string): number {
  const m = s.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4], 10) / 1000
  );
}

export function parseSrt(rawSrt: string): ParsedTimedLine[] {
  const blocks = rawSrt.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const result: ParsedTimedLine[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;
    const [left, right] = lines[timeLineIdx].split('-->').map((s) => s.trim());
    const text = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (!text) continue;
    const startTime = Number(parseSrtTime(left).toFixed(3));
    const endTime = Number(Math.max(startTime + 0.5, parseSrtTime(right)).toFixed(3));
    result.push({ startTime, endTime, jpText: text });
  }
  return result;
}

export async function convertLinesToKaraoke(
  items: { id?: string; startTime: number; endTime: number; jpText: string; koTranslation?: string; slot?: 0 | 1 | 2 }[],
  options: { longVowelMode?: LongVowelMode } = {}
): Promise<LyricLine[]> {
  const results: LyricLine[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const start = Number(item.startTime.toFixed(3));
    const end = Number(Math.max(start + 0.4, item.endTime).toFixed(3));
    const segments = await analyzeLineToSegments(item.jpText, start, end, options);
    results.push({
      id: item.id || `line_${Date.now().toString(36)}_${i}`,
      startTime: start,
      endTime: end,
      slot: item.slot,
      jpText: item.jpText.trim(),
      koTranslation: item.koTranslation ?? '',
      segments,
    });
  }
  return results;
}

export interface LyricMora {
  kana: string;
  romaji: string;
}

const SMALL_COMBINE_HIRA = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゎ']);

export function splitReadingToMoras(readingKata: string, fallbackJp = ''): LyricMora[] {
  const hira = toHiragana(readingKata || '');
  const moras: LyricMora[] = [];
  let pendingSokuon = '';
  let asciiBuf = '';

  const flushAscii = () => {
    const clean = asciiBuf.toLowerCase().replace(/[^a-z']/g, '');
    asciiBuf = '';
    if (!clean) return;
    // Split ASCII words into rough vowel-nucleus syllable chunks so pitch bars match beats
    const parts = clean.match(/[^aeiouy']*[aeiouy]+(?:[^aeiouy']*(?=[^aeiouy']*[aeiouy]))*|[^aeiouy']+$/g);
    if (parts && parts.length > 0) {
      for (const p of parts) {
        if (p) moras.push({ kana: p, romaji: p });
      }
    } else {
      moras.push({ kana: clean, romaji: clean });
    }
  };

  for (const ch of Array.from(hira)) {
    if (/^[a-zA-Z']$/.test(ch)) {
      if (pendingSokuon && moras.length > 0) {
        moras[moras.length - 1].kana += pendingSokuon;
        pendingSokuon = '';
      }
      asciiBuf += ch;
      continue;
    }
    flushAscii();

    if (ch === 'っ') {
      pendingSokuon += ch;
      continue;
    }

    if (ch === 'ー' || SMALL_COMBINE_HIRA.has(ch)) {
      if (moras.length > 0 && !/^[a-z']+$/.test(moras[moras.length - 1].kana)) {
        moras[moras.length - 1].kana += pendingSokuon + ch;
        pendingSokuon = '';
        moras[moras.length - 1].romaji =
          katakanaToMmsRomaji(moras[moras.length - 1].kana) || moras[moras.length - 1].romaji;
      } else if (ch === 'ー') {
        pendingSokuon = '';
      } else {
        const kana = pendingSokuon + ch;
        pendingSokuon = '';
        const romaji = katakanaToMmsRomaji(kana);
        if (romaji) moras.push({ kana, romaji });
      }
      continue;
    }

    if (/^[\u3040-\u309F]$/.test(ch)) {
      const kana = pendingSokuon + ch;
      pendingSokuon = '';
      const romaji = katakanaToMmsRomaji(kana);
      if (romaji) {
        moras.push({ kana, romaji });
      } else if (moras.length > 0) {
        moras[moras.length - 1].kana += kana;
      }
    }
  }
  flushAscii();

  if (pendingSokuon && moras.length > 0) {
    moras[moras.length - 1].kana += pendingSokuon;
  }

  if (moras.length === 0 && fallbackJp.trim()) {
    const ascii = fallbackJp.toLowerCase().replace(/[^a-z']/g, '');
    if (ascii) {
      return [{ kana: fallbackJp.trim(), romaji: ascii }];
    }
  }
  return moras;
}

function resolveSegmentPronKata(
  tokenizer: Tokenizer<IpadicFeatures>,
  seg: LyricSegment
): { pronKata: string; alignRomaji: string } {
  const tokens = enrichUnknownKanjiTokens(
    tokenizer,
    fuseNumberCounterTokens(tokenizer.tokenize(seg.jp || ''))
  );
  let pronKata = '';
  let readingKata = '';

  for (const tok of tokens) {
    if (PUNCT_ONLY_TEST.test(tok.surface_form)) {
      continue;
    }
    const pk = tokenPronKata(tok);
    const rk = tokenReadingKata(tok);
    pronKata += (pk || tok.surface_form).replace(/’/g, "'");
    readingKata += (rk || tok.surface_form).replace(/’/g, "'");
  }

  const kuromojiHira = toHiragana(readingKata).replace(/[^\u3040-\u309Fー]/g, '');
  const cleanRuby = toHiragana((seg.ruby || '').trim()).replace(/[^\u3040-\u309Fー]/g, '');

  // Prefer user/AI-corrected seg.ruby only if it genuinely differs from Kuromoji reading
  if (cleanRuby && (KANJI_TEST.test(seg.jp || '') || /[0-9０-９]/.test(seg.jp || ''))) {
    const matchesExact = cleanRuby === kuromojiHira;
    const matchesPrefix =
      kuromojiHira.length > cleanRuby.length && kuromojiHira.startsWith(cleanRuby);
    if (!matchesExact && !matchesPrefix) {
      const tailMatch = (seg.jp || '').match(
        /([\u3040-\u309F\u30A0-\u30FFー]+)[、。,.!?！？\s]*$/
      );
      const tailKana = tailMatch ? tailMatch[1] : '';
      const tailHira = toHiragana(tailKana);
      if (tailKana && !cleanRuby.endsWith(tailHira)) {
        const tailPronKata = tokenizer
          .tokenize(tailKana)
          .map((t) => tokenPronKata(t) || t.surface_form)
          .join('');
        pronKata = toKatakana(cleanRuby) + tailPronKata;
      } else {
        pronKata = toKatakana(cleanRuby);
      }
    }
  }

  const alignRomaji =
    katakanaToMmsRomaji(pronKata) ||
    katakanaToMmsRomaji(seg.ruby || '') ||
    (seg.jp || '').toLowerCase().replace(/[^a-z']/g, '');

  return { pronKata, alignRomaji };
}

export async function enrichLinesWithAlignRomaji(
  lines: LyricLine[]
): Promise<
  Array<
    LyricLine & {
      segments: Array<
        LyricSegment & {
          alignRomaji: string;
          readingCandidates?: ReadingCandidate[];
        }
      >;
    }
  >
> {
  const tokenizer = await getTokenizer();

  return lines.map((line) => ({
    ...line,
    segments: (line.segments || []).map((seg) => {
      const { alignRomaji } = resolveSegmentPronKata(tokenizer, seg);
      const readingCandidates = getServerCandidatesForSegment(tokenizer, seg.jp, seg.ruby);
      return {
        ...seg,
        alignRomaji,
        ...(readingCandidates.length >= 2 ? { readingCandidates } : {}),
      };
    }),
  }));
}

export async function enrichLinesWithMoras(
  lines: LyricLine[]
): Promise<
  Array<
    LyricLine & {
      segments: Array<LyricSegment & { alignRomaji: string; moras: LyricMora[] }>;
    }
  >
> {
  const tokenizer = await getTokenizer();

  return lines.map((line) => ({
    ...line,
    segments: (line.segments || []).map((seg) => {
      const { pronKata, alignRomaji } = resolveSegmentPronKata(tokenizer, seg);
      const moras = splitReadingToMoras(pronKata || toKatakana(seg.ruby || ''), seg.jp || '');
      return {
        ...seg,
        alignRomaji,
        moras,
      };
    }),
  }));
}
