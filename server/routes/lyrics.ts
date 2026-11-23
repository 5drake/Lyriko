import { Router } from 'express';
import type { LrcSearchResult, LyricLine } from '../../shared/types.js';
import {
  convertLinesToKaraoke,
  parseLrcOrText,
  type LongVowelMode,
} from '../services/jpKorean.js';
import { applyWebFuriganaToLines } from '../services/webFurigana.js';

export const lyricsRouter = Router();

const VARIANT_KEYWORDS = [
  'instrumental',
  'off vocal',
  'karaoke',
  'tv size',
  'short ver',
  'live',
  'cover',
  'remix',
  'nightcore',
  'sped up',
  'slowed',
  'acoustic',
  'piano ver',
];

function countSyncedLines(syncedLyrics: string): number {
  let count = 0;
  for (const line of syncedLyrics.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[\d+:\d+(?:\.\d+)?\]\s*\S+/.test(trimmed)) {
      count += 1;
    }
  }
  return count;
}

function scoreLrcResult(
  item: LrcSearchResult,
  query: string,
  targetDuration: number
): number {
  let score = 0;
  if (item.hasSynced) score += 50;

  const qLower = query.toLowerCase();
  const title = item.trackName || '';
  const album = item.albumName || '';
  const combinedMeta = `${title} ${album}`.toLowerCase();

  if (/\s-\s/.test(title)) {
    score -= 28;
  }

  for (const kw of VARIANT_KEYWORDS) {
    if (combinedMeta.includes(kw) && !qLower.includes(kw)) {
      score -= 35;
      break;
    }
  }

  if (/\(full\)|\bfull ver\b/i.test(title) && !qLower.includes('full')) {
    score -= 6;
  }

  if (targetDuration > 15 && item.duration > 15) {
    const diff = Math.abs(item.duration - targetDuration);
    if (diff <= 3.5) score += 22;
    else if (diff <= 7.5) score += 14;
    else if (diff <= 15) score += 5;
    else if (diff > 30) score -= 25;
  }

  const qTokens = qLower
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (qTokens.length > 0) {
    const targetNorm = `${item.trackName} ${item.artistName}`.toLowerCase();
    let hits = 0;
    for (const tok of qTokens) {
      if (targetNorm.includes(tok)) hits += 1;
    }
    score += Math.round((hits / qTokens.length) * 15);
  }

  if (item.hasSynced) {
    const lineCount = countSyncedLines(item.syncedLyrics);
    if (lineCount >= 12 && lineCount <= 140) score += 8;
    else if (lineCount < 8) score -= 15;
  }

  return score;
}

lyricsRouter.get('/lyrics/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const targetDuration = Number(req.query.duration ?? 0);
  if (!q) {
    res.status(400).json({ error: '검색어(q)를 입력해 주세요.' });
    return;
  }

  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'UtaKanaStudio/1.0 (https://localhost)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      res.status(502).json({ error: `가사 검색 API 오류 (${response.status})` });
      return;
    }

    const raw = (await response.json()) as Array<{
      id: number;
      trackName?: string;
      artistName?: string;
      albumName?: string;
      duration?: number;
      syncedLyrics?: string | null;
      plainLyrics?: string | null;
    }>;

    const results: LrcSearchResult[] = raw
      .map((item) => ({
        id: item.id,
        trackName: item.trackName ?? '',
        artistName: item.artistName ?? '',
        albumName: item.albumName ?? '',
        duration: Number(item.duration ?? 0),
        hasSynced: Boolean(item.syncedLyrics && item.syncedLyrics.trim().length > 0),
        syncedLyrics: item.syncedLyrics ?? '',
        plainLyrics: item.plainLyrics ?? '',
      }))
      .filter((r) => r.syncedLyrics || r.plainLyrics)
      .map((item) => ({
        item,
        score: scoreLrcResult(item, q, targetDuration),
        durDiff:
          targetDuration > 15 && item.duration > 15
            ? Math.abs(item.duration - targetDuration)
            : 9999,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.item.hasSynced !== b.item.hasSynced) {
          return Number(b.item.hasSynced) - Number(a.item.hasSynced);
        }
        return a.durDiff - b.durDiff;
      })
      .map((entry) => entry.item)
      .slice(0, 20);

    res.json({ results });
  } catch (err) {
    res.status(502).json({
      error: `인터넷 가사 검색에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

lyricsRouter.post('/jp/convert', async (req, res) => {
  try {
    const body = req.body as {
      rawText?: string;
      duration?: number;
      longVowelMode?: LongVowelMode;
      title?: string;
      artist?: string;
      useWebFurigana?: boolean;
      lines?: Array<{
        id?: string;
        startTime: number;
        endTime: number;
        jpText: string;
        koTranslation?: string;
        slot?: 0 | 1 | 2;
      }>;
    };

    const longVowelMode: LongVowelMode = body.longVowelMode === 'dash' ? 'dash' : 'vowel';
    const duration = Number(body.duration) > 0 ? Number(body.duration) : 240;

    let items = body.lines;
    if (!items && typeof body.rawText === 'string') {
      const parsed = parseLrcOrText(body.rawText, duration);
      items = parsed.map((p) => ({
        startTime: p.startTime,
        endTime: p.endTime,
        jpText: p.jpText,
      }));
    }

    if (!items || items.length === 0) {
      res.status(400).json({ error: '변환할 가사 데이터가 없습니다.' });
      return;
    }

    const rawLines = await convertLinesToKaraoke(items, { longVowelMode });
    const hasKanji = rawLines.some((l) => /[\u4E00-\u9FFF々]/.test(l.jpText || ''));
    if (body.useWebFurigana !== false && hasKanji) {
      const enriched = await applyWebFuriganaToLines(rawLines, {
        title: typeof body.title === 'string' ? body.title : undefined,
        artist: typeof body.artist === 'string' ? body.artist : undefined,
        longVowelMode,
      });
      res.json({ lines: enriched.lines, furiganaSource: enriched.furiganaSource });
      return;
    }

    res.json({ lines: rawLines });
  } catch (err) {
    res.status(500).json({
      error: `일본어 가사 변환 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

lyricsRouter.post('/jp/web-furigana', async (req, res) => {
  try {
    const body = req.body as {
      lines?: LyricLine[];
      title?: string;
      artist?: string;
      longVowelMode?: LongVowelMode;
    };

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.status(400).json({ error: '후리가나를 매칭할 가사 데이터가 없습니다.' });
      return;
    }

    const longVowelMode: LongVowelMode = body.longVowelMode === 'dash' ? 'dash' : 'vowel';
    const enriched = await applyWebFuriganaToLines(body.lines, {
      title: typeof body.title === 'string' ? body.title : undefined,
      artist: typeof body.artist === 'string' ? body.artist : undefined,
      longVowelMode,
    });
    res.json({ lines: enriched.lines, furiganaSource: enriched.furiganaSource });
  } catch (err) {
    res.status(500).json({
      error: `웹 후리가나 매칭 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});
