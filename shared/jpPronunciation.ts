import { alignFuriganaToKanji, toHiragana } from './timing.js';

export type LongVowelMode = 'vowel' | 'dash';

const COMPOUND_KANA: Record<string, string> = {
  キャ: '캬', キュ: '큐', キョ: '쿄',
  ギャ: '갸', ギュ: '규', ギョ: '교',
  シャ: '샤', シュ: '슈', シェ: '셰', ショ: '쇼',
  ジャ: '쟈', ジュ: '쥬', ジェ: '졔', ジョ: '죠',
  チャ: '챠', チュ: '츄', チェ: '쳬', チョ: '쵸',
  ヂャ: '쟈', ヂュ: '쥬', ヂョ: '죠',
  ニャ: '냐', ニュ: '뉴', ニョ: '뇨',
  ヒャ: '햐', ヒュ: '휴', ヒョ: '효',
  ビャ: '뱌', ビュ: '뷰', ビョ: '뵤',
  ピャ: '퍄', ピュ: '퓨', ピョ: '표',
  ミャ: '먀', ミュ: '뮤', ミョ: '묘',
  リャ: '랴', リュ: '류', リョ: '료',
  ティ: '티', ディ: '디',
  トゥ: '투', ドゥ: '두',
  テュ: '튜', デュ: '듀',
  ファ: '파', フィ: '피', フェ: '페', フォ: '포', フュ: '퓨',
  ヴァ: '바', ヴィ: '비', ヴ: '부', ヴェ: '베', ヴォ: '보',
  ウィ: '위', ウェ: '웨', ウォ: '워',
  ツァ: '차', ツィ: '치', ツェ: '체', ツォ: '초',
  クァ: '콰', クィ: '퀴', クェ: '퀘', クォ: '쿼',
  グァ: '과',
  スィ: '시', ズィ: '지',
  イェ: '예',
};

const SINGLE_KANA: Record<string, string> = {
  ア: '아', イ: '이', ウ: '우', エ: '에', オ: '오',
  カ: '카', キ: '키', ク: '쿠', ケ: '케', コ: '코',
  ガ: '가', ギ: '기', グ: '구', ゲ: '게', ゴ: '고',
  サ: '사', シ: '시', ス: '스', セ: '세', ソ: '소',
  ザ: '자', ジ: '지', ズ: '즈', ゼ: '제', ゾ: '조',
  タ: '타', チ: '치', ツ: '츠', テ: '테', ト: '토',
  ダ: '다', ヂ: '지', ヅ: '즈', デ: '데', ド: '도',
  ナ: '나', ニ: '니', ヌ: '누', ネ: '네', ノ: '노',
  ハ: '하', ヒ: '히', フ: '후', ヘ: '헤', ホ: '호',
  バ: '바', ビ: '비', ブ: '부', ベ: '베', ボ: '보',
  パ: '파', ピ: '피', プ: '푸', ペ: '페', ポ: '포',
  マ: '마', ミ: '미', ム: '무', メ: '메', モ: '모',
  ヤ: '야', ユ: '유', ヨ: '요',
  ラ: '라', リ: '리', ル: '루', レ: '레', ロ: '로',
  ワ: '와', ヲ: '오', ヰ: '이', ヱ: '에',
  ァ: '아', ィ: '이', ゥ: '우', ェ: '에', ォ: '오',
  ャ: '야', ュ: '유', ョ: '요', ヮ: '와',
  ヴ: '부', ヵ: '카', ヶ: '케',
};

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

function attachJongseong(hangulStr: string, jongseongIdx: number): string | null {
  if (!hangulStr) return null;
  const lastCode = hangulStr.charCodeAt(hangulStr.length - 1);
  if (lastCode < HANGUL_START || lastCode > HANGUL_END) return null;
  const offset = lastCode - HANGUL_START;
  if (offset % 28 !== 0) return null; // already has a final consonant
  const fused = String.fromCharCode(lastCode + jongseongIdx);
  return hangulStr.slice(0, -1) + fused;
}

function getVowelEcho(hangulStr: string): string {
  if (!hangulStr) return '';
  const lastCode = hangulStr.charCodeAt(hangulStr.length - 1);
  if (lastCode < HANGUL_START || lastCode > HANGUL_END) return '';
  const v = Math.floor(((lastCode - HANGUL_START) % 588) / 28);
  // 0:ㅏ 1:ㅐ 2:ㅑ 3:ㅒ 4:ㅓ 5:ㅔ 6:ㅕ 7:ㅖ 8:ㅗ 9:ㅘ 10:ㅙ 11:ㅚ 12:ㅛ 13:ㅜ 14:ㅝ 15:ㅞ 16:ㅟ 17:ㅠ 18:ㅡ 19:ㅢ 20:ㅣ
  switch (v) {
    case 0: case 2: case 9: return '아';
    case 4: case 6: case 14: return '어';
    case 8: case 12: return '오';
    case 13: case 17: return '우';
    case 18: return '으';
    case 16: case 19: case 20: return '이';
    default: return '에';
  }
}

export function toKatakana(input: string): string {
  return input.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

export function katakanaToKorean(
  input: string,
  options: { longVowelMode?: LongVowelMode } = {}
): string {
  const longVowelMode = options.longVowelMode ?? 'vowel';
  const kata = toKatakana(input);
  let out = '';
  let i = 0;

  while (i < kata.length) {
    const ch = kata[i];

    // Sokuon (small tsu): standard Korean Japanese transcription / karaoke style uses ㅅ final consonant
    if (ch === 'ッ') {
      const fused = attachJongseong(out, 19); // ㅅ
      out = fused ?? out + '읏';
      i += 1;
      continue;
    }

    // Nasal N: fuse onto preceding vowel-final syllable
    if (ch === 'ン') {
      const next = kata[i + 1] ?? '';
      const isBilabial =
        next.length > 0 &&
        'マミムメモパピプペポバビブベボミャミュミョピャピュピョビャビュビョ'.includes(next);
      const jongIdx = isBilabial ? 16 : 4; // ㅁ vs ㄴ
      const fused = attachJongseong(out, jongIdx);
      out = fused ?? out + (isBilabial ? '음' : '응');
      i += 1;
      continue;
    }

    // Long vowel mark
    if (ch === 'ー') {
      if (longVowelMode === 'dash') {
        out += '-';
      } else {
        const echo = getVowelEcho(out);
        out += echo || '-';
      }
      i += 1;
      continue;
    }

    // Check 2-char compound kana first
    if (i + 1 < kata.length) {
      const pair = kata.slice(i, i + 2);
      if (COMPOUND_KANA[pair]) {
        out += COMPOUND_KANA[pair];
        i += 2;
        continue;
      }
    }

    // Single kana
    if (SINGLE_KANA[ch]) {
      out += SINGLE_KANA[ch];
      i += 1;
      continue;
    }

    // Pass through non-kana characters (ASCII, punctuation, spaces)
    out += ch;
    i += 1;
  }

  return out;
}

const COMPOUND_ROMAJI: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo',
  ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo',
  シャ: 'sha', シュ: 'shu', シェ: 'she', ショ: 'sho',
  ジャ: 'ja', ジュ: 'ju', ジェ: 'je', ジョ: 'jo',
  チャ: 'cha', チュ: 'chu', チェ: 'che', チョ: 'cho',
  ヂャ: 'ja', ヂュ: 'ju', ヂョ: 'jo',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo',
  ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo',
  ビャ: 'bya', ビュ: 'byu', ビョ: 'byo',
  ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo',
  ミャ: 'mya', ミュ: 'myu', ミョ: 'myo',
  リャ: 'rya', リュ: 'ryu', リョ: 'ryo',
  ティ: 'ti', ディ: 'di',
  トゥ: 'tu', ドゥ: 'du',
  テュ: 'tyu', デュ: 'dyu',
  ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', フュ: 'fyu',
  ヴァ: 'va', ヴィ: 'vi', ヴ: 'vu', ヴェ: 've', ヴォ: 'vo',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo',
  ツァ: 'tsa', ツィ: 'tsi', ツェ: 'tse', ツォ: 'tso',
  クァ: 'kwa', クィ: 'kwi', クェ: 'kwe', クォ: 'kwo',
  グァ: 'gwa',
  スィ: 'si', ズィ: 'zi',
  イェ: 'ye',
};

const SINGLE_ROMAJI: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヲ: 'o', ン: 'n', ヰ: 'i', ヱ: 'e',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o',
  ャ: 'ya', ュ: 'yu', ョ: 'yo', ヮ: 'wa',
  ヴ: 'vu', ヵ: 'ka', ヶ: 'ke',
};

export function katakanaToMmsRomaji(input: string): string {
  const kata = toKatakana(input);
  let out = '';
  let i = 0;

  while (i < kata.length) {
    const ch = kata[i];
    if (ch === 'ー' || ch === 'ッ') {
      i += 1;
      continue;
    }
    if (i + 1 < kata.length) {
      const pair = kata.slice(i, i + 2);
      if (COMPOUND_ROMAJI[pair]) {
        out += COMPOUND_ROMAJI[pair];
        i += 2;
        continue;
      }
    }
    if (SINGLE_ROMAJI[ch]) {
      out += SINGLE_ROMAJI[ch];
      i += 1;
      continue;
    }
    const lower = ch.toLowerCase();
    if (/^[a-z']$/.test(lower)) {
      out += lower;
    }
    i += 1;
  }

  return out.replace(/(.)\1+/g, '$1');
}

const KANJI_OR_DIGIT_RE = /[\u4E00-\u9FFF々0-9０-９]/;
const PUNCT_STRIP_RE = /[、。,.!?！？「」『』()（）・〜~…♪♡★]/g;

/**
 * Reconstructs the full kana reading of a segment from its surface `jp` and furigana `ruby`,
 * preserving trailing okurigana/particles and normalizing `は`/`へ` particles after kanji.
 */
export function buildFullKanaFromSegment(jp: string, ruby: string): string {
  const cleanRuby = toHiragana((ruby || '').trim());
  if (!cleanRuby) return jp;

  const spans = alignFuriganaToKanji(jp, cleanRuby);
  if (spans.length === 0) {
    return KANJI_OR_DIGIT_RE.test(jp) ? cleanRuby : jp;
  }

  const chars = Array.from(jp);
  let reconstructed = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.startIndex > cursor) {
      reconstructed += toHiragana(chars.slice(cursor, span.startIndex).join(''));
    }
    reconstructed += span.ruby || cleanRuby;
    cursor = span.endIndex;
  }
  if (cursor < chars.length) {
    reconstructed += toHiragana(chars.slice(cursor).join(''));
  }

  if (
    /[\u4E00-\u9FFF々]は[、。,.!?！？\s]*$/.test(jp) &&
    /は[、。,.!?！？\s]*$/.test(reconstructed)
  ) {
    reconstructed = reconstructed.replace(/は([、。,.!?！？\s]*)$/, 'わ$1');
  } else if (
    /[\u4E00-\u9FFF々]へ[、。,.!?！？\s]*$/.test(jp) &&
    /へ[、。,.!?！？\s]*$/.test(reconstructed)
  ) {
    reconstructed = reconstructed.replace(/へ([、。,.!?！？\s]*)$/, 'え$1');
  }

  return reconstructed;
}

export function buildKoPronFromSegment(
  jp: string,
  ruby: string,
  longVowelMode: LongVowelMode = 'vowel'
): string {
  const fullKana = buildFullKanaFromSegment(jp, ruby);
  const cleaned = fullKana.replace(PUNCT_STRIP_RE, '');
  return katakanaToKorean(cleaned, { longVowelMode });
}

export interface ReadingCandidate {
  ruby: string;
  koPron: string;
  alignRomaji: string;
}

interface AmbiguousKanjiEntry {
  kanji: string;
  readings: string[];
  followRegex?: RegExp;
}

const AMBIGUOUS_KANJI_READINGS: AmbiguousKanjiEntry[] = [
  // Nouns / compounds / pronouns common in J-POP lyrics
  { kanji: '明日', readings: ['あした', 'あす', 'みょうにち'] },
  { kanji: '今日', readings: ['きょう', 'いま', 'こんにち'] },
  { kanji: '昨日', readings: ['きのう', 'さくじつ'] },
  { kanji: '未来', readings: ['みらい', 'あす'] },
  { kanji: '永遠', readings: ['えいえん', 'とわ'] },
  { kanji: '永久', readings: ['えいきゅう', 'とわ'] },
  { kanji: '運命', readings: ['うんめい', 'さだめ'] },
  { kanji: '宿命', readings: ['しゅくめい', 'さだめ'] },
  { kanji: '時間', readings: ['じかん', 'とき'] },
  { kanji: '瞬間', readings: ['しゅんかん', 'とき'] },
  { kanji: '季節', readings: ['きせつ', 'とき'] },
  { kanji: '時代', readings: ['じだい', 'とき'] },
  { kanji: '現在', readings: ['げんざい', 'いま'] },
  { kanji: '刹那', readings: ['せつな', 'とき'] },
  { kanji: '世界', readings: ['せかい', 'よ'] },
  { kanji: '宇宙', readings: ['うちゅう', 'そら'] },
  { kanji: '天空', readings: ['てんくう', 'そら'] },
  { kanji: '地球', readings: ['ちきゅう', 'ほし'] },
  { kanji: '本気', readings: ['ほんき', 'まじ'] },
  { kanji: '本当', readings: ['ほんとう', 'ほんと', 'まじ'] },
  { kanji: '真実', readings: ['しんじつ', 'ほんとう', 'まこと'] },
  { kanji: '理由', readings: ['りゆう', 'わけ'] },
  { kanji: '言葉', readings: ['ことば', 'ことのは'] },
  { kanji: '今夜', readings: ['こんや', 'こよい'] },
  { kanji: '何', readings: ['なに', 'なん'] },
  { kanji: '何時', readings: ['いつ', 'なんじ'] },
  { kanji: '何処', readings: ['どこ', 'いずこ'] },
  { kanji: '何故', readings: ['なぜ', 'なにゆえ'] },
  { kanji: '誰', readings: ['だれ', 'たれ'] },
  { kanji: '僕等', readings: ['ぼくら', 'ぼくたち'] },
  { kanji: '私', readings: ['わたし', 'あたし', 'わたくし'] },
  { kanji: '一人', readings: ['ひとり', 'いちにん'] },
  { kanji: '二人', readings: ['ふたり', 'ににん'] },
  { kanji: '頬', readings: ['ほほ', 'ほお'] },
  { kanji: '瞬', readings: ['まばた', 'またた'], followRegex: /^[きくけこ]/ },
  { kanji: '日本', readings: ['にほん', 'にっぽん'] },
  { kanji: '空', readings: ['そら', 'から'] },
  { kanji: '風', readings: ['かぜ', 'ふう'] },
  { kanji: '音', readings: ['おと', 'ね'] },
  { kanji: '方', readings: ['ほう', 'かた'] },
  { kanji: '後', readings: ['あと', 'うしろ', 'のち'] },
  { kanji: '下', readings: ['した', 'もと'] },
  { kanji: '側', readings: ['そば', 'がわ'] },
  { kanji: '傍', readings: ['そば', 'はた', 'かたわら'] },
  { kanji: '中', readings: ['なか', 'ちゅう', 'じゅう'] },
  { kanji: '間', readings: ['あいだ', 'ま', 'かん'] },
  { kanji: '所', readings: ['ところ', 'とこ'] },
  { kanji: '月日', readings: ['つきひ', 'がっぴ'] },
  { kanji: '一日', readings: ['いちにち', 'ついたち', 'ひとひ'] },
  { kanji: '一年', readings: ['いちねん', 'ひととせ'] },
  { kanji: '金色', readings: ['きんいろ', 'こんじき'] },
  // Verb / adjective stems paired with okurigana guards
  { kanji: '行', readings: ['い', 'ゆ'], followRegex: /^[くっかきけこ]/ },
  { kanji: '開', readings: ['ひら', 'あ'], followRegex: /^[くいけかこ]/ },
  { kanji: '通', readings: ['とお', 'かよ'], followRegex: /^[るっわいえお]/ },
  { kanji: '止', readings: ['と', 'や'], followRegex: /^[まめむみん]/ },
  { kanji: '愛', readings: ['あい', 'いと'], followRegex: /^し/ },
  { kanji: '寂', readings: ['さび', 'さみ'], followRegex: /^し/ },
  { kanji: '辛', readings: ['つら', 'から'], followRegex: /^[いくさか]/ },
];

export function getReadingCandidatesForSegment(
  jp: string,
  currentRuby: string,
  longVowelMode: LongVowelMode = 'vowel'
): ReadingCandidate[] {
  const chars = Array.from(jp || '');
  const kanjiRuns: Array<{ text: string; start: number; end: number }> = [];

  for (let i = 0; i < chars.length; i++) {
    if (/[\u4E00-\u9FFF々]/.test(chars[i])) {
      const prev = kanjiRuns[kanjiRuns.length - 1];
      if (prev && prev.end === i) {
        prev.text += chars[i];
        prev.end = i + 1;
      } else {
        kanjiRuns.push({ text: chars[i], start: i, end: i + 1 });
      }
    }
  }

  if (kanjiRuns.length !== 1) return [];
  const run = kanjiRuns[0];
  const trailing = toHiragana(chars.slice(run.end).join(''));

  const entry = AMBIGUOUS_KANJI_READINGS.find(
    (item) =>
      item.kanji === run.text &&
      (!item.followRegex || item.followRegex.test(trailing))
  );
  if (!entry) return [];

  const aligned = alignFuriganaToKanji(jp, currentRuby);
  const currentKanjiRuby = toHiragana((aligned[0]?.ruby || '').trim());

  const uniqueRubies: string[] = [];
  if (currentKanjiRuby && !uniqueRubies.includes(currentKanjiRuby)) {
    uniqueRubies.push(currentKanjiRuby);
  }
  for (const r of entry.readings) {
    if (r && !uniqueRubies.includes(r)) {
      uniqueRubies.push(r);
    }
  }

  if (uniqueRubies.length < 2) return [];

  return uniqueRubies.map((ruby) => {
    const fullKana = buildFullKanaFromSegment(jp, ruby);
    return {
      ruby,
      koPron: buildKoPronFromSegment(jp, ruby, longVowelMode),
      alignRomaji: katakanaToMmsRomaji(fullKana),
    };
  });
}
