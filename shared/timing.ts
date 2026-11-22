import type { LyricLine, LyricSegment } from './types';

const SMALL_KANA = new Set([
  'ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゎ',
  'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ヮ',
]);

const KANJI_RE = /[\u4E00-\u9FFF々]/;
const DIGIT_RE = /[0-9０-９]/;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FFー]/;

export function toHiragana(input: string): string {
  return input.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

export function countJapaneseMora(text: string): number {
  let mora = 0;
  for (const ch of text) {
    if (KANA_RE.test(ch)) {
      if (!SMALL_KANA.has(ch)) {
        mora += 1;
      }
    } else if (KANJI_RE.test(ch)) {
      mora += 1.6;
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      mora += 1;
    }
  }
  return mora;
}

export function getSegmentMoraWeight(seg: Pick<LyricSegment, 'jp' | 'ruby' | 'koPron'>): number {
  if (seg.ruby && seg.ruby.trim().length > 0) {
    const jpChars = Array.from(seg.jp);
    const nonKanji = jpChars.filter((c) => !KANJI_RE.test(c)).join('');
    const rubyMora = countJapaneseMora(seg.ruby);
    const nonKanjiMora = countJapaneseMora(nonKanji);
    // If ruby already includes trailing okurigana, rubyMora >= nonKanjiMora; take max for safety
    return Math.max(0.5, rubyMora > 0 ? Math.max(rubyMora, nonKanjiMora) : countJapaneseMora(seg.jp));
  }
  const jpMora = countJapaneseMora(seg.jp);
  if (jpMora > 0) return jpMora;
  const koCount = seg.koPron.replace(/\s+/g, '').length;
  return Math.max(0.5, koCount);
}

export function redistributeSegmentTimings(line: LyricLine): LyricLine {
  if (!line.segments.length) return line;
  const start = line.startTime;
  const end = Math.max(start + 0.15, line.endTime);
  const totalDur = end - start;

  const weights = line.segments.map((seg) => Math.max(0.4, getSegmentMoraWeight(seg)));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || line.segments.length;

  let cursor = start;
  const updatedSegments: LyricSegment[] = line.segments.map((seg, idx) => {
    const isLast = idx === line.segments.length - 1;
    const slice = (totalDur * weights[idx]) / totalWeight;
    const segStart = Number(cursor.toFixed(3));
    const segEnd = isLast ? Number(end.toFixed(3)) : Number((cursor + slice).toFixed(3));
    cursor += slice;
    return {
      ...seg,
      startTime: segStart,
      endTime: Math.max(segStart + 0.05, segEnd),
    };
  });

  return {
    ...line,
    segments: updatedSegments,
  };
}

export interface FuriganaSpan {
  startIndex: number; // character index in jp
  endIndex: number;   // exclusive character index in jp
  ruby: string;
}

/**
 * Aligns a furigana reading (`ruby`) strictly above the kanji spans inside `jp`.
 * Handles both full readings (e.g. jp="許して", ruby="ゆるして" -> "ゆる" over "許")
 * and already-stripped kanji readings (e.g. jp="許して", ruby="ゆる" -> "ゆる" over "許"),
 * as well as multi-kanji words with internal okurigana (e.g. jp="飛び立つ", ruby="とびたつ").
 */
export function alignFuriganaToKanji(jp: string, ruby: string): FuriganaSpan[] {
  const cleanRuby = toHiragana((ruby || '').trim());
  if (!cleanRuby || !(KANJI_RE.test(jp) || DIGIT_RE.test(jp))) return [];

  const chars = Array.from(jp);
  // Tokenize jp into alternating kanji/digit-counter runs and kana runs
  interface Run {
    isKanji: boolean;
    start: number;
    end: number;
    text: string;
  }
  const runs: Run[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isPercentAfterDigit =
      (ch === '%' || ch === '％') && i > 0 && DIGIT_RE.test(chars[i - 1]);
    const isK = KANJI_RE.test(ch) || DIGIT_RE.test(ch) || isPercentAfterDigit;
    const prev = runs[runs.length - 1];
    if (prev && prev.isKanji === isK) {
      prev.end = i + 1;
      prev.text += ch;
    } else {
      runs.push({ isKanji: isK, start: i, end: i + 1, text: ch });
    }
  }

  const kanjiRuns = runs.filter((r) => r.isKanji);
  if (kanjiRuns.length === 0) return [];

  // Single kanji run case (most common: 心臓, 痛みの, 隙間風, 突破して, お願い)
  if (kanjiRuns.length === 1) {
    const kRun = kanjiRuns[0];
    const prefix = toHiragana(chars.slice(0, kRun.start).join('')).replace(/[^\u3040-\u309Fー]/g, '');
    const suffix = toHiragana(chars.slice(kRun.end).join('')).replace(/[^\u3040-\u309Fー]/g, '');
    let aligned = cleanRuby;
    if (prefix && aligned.startsWith(prefix) && aligned.length > prefix.length) {
      aligned = aligned.slice(prefix.length);
    }
    if (suffix && aligned.endsWith(suffix) && aligned.length > suffix.length) {
      aligned = aligned.slice(0, aligned.length - suffix.length);
    }
    return [{ startIndex: kRun.start, endIndex: kRun.end, ruby: aligned }];
  }

  // Multi-kanji run with internal kana (e.g. 飛び立つ + とびたつ, 受け取る + うけとる)
  let rCursor = 0;
  const spans: FuriganaSpan[] = [];
  let matchedAll = true;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.isKanji) {
      const hiraRun = toHiragana(run.text).replace(/[^\u3040-\u309Fー]/g, '');
      if (!hiraRun) continue;
      const idx = cleanRuby.indexOf(hiraRun, rCursor);
      if (idx === -1) {
        matchedAll = false;
        break;
      }
      if (spans.length > 0 && spans[spans.length - 1].ruby === '') {
        spans[spans.length - 1].ruby = cleanRuby.slice(rCursor, idx);
      }
      rCursor = idx + hiraRun.length;
    } else {
      spans.push({ startIndex: run.start, endIndex: run.end, ruby: '' });
    }
  }

  if (matchedAll) {
    if (spans.length > 0 && spans[spans.length - 1].ruby === '') {
      spans[spans.length - 1].ruby = cleanRuby.slice(rCursor);
    }
    if (spans.every((s) => s.ruby.length > 0)) {
      return spans;
    }
  }

  // Fallback: center whole ruby across first-to-last kanji span
  const firstK = kanjiRuns[0].start;
  const lastK = kanjiRuns[kanjiRuns.length - 1].end;
  return [{ startIndex: firstK, endIndex: lastK, ruby: cleanRuby }];
}

export function formatTime(seconds: number, showMs = false): string {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (!showMs) {
    const mins = Math.floor(clamped / 60);
    const secs = Math.floor(clamped % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  const totalCs = Math.round(clamped * 100);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
