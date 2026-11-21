import { Router } from 'express';
import {
  getYoutubeImportJob,
  parseYoutubeVideoId,
  searchYoutubeTracksForSong,
  startYoutubeImportJob,
  suggestSongsForQuery,
  type ResolvedSongInfo,
} from '../services/ytdlp.js';

export const youtubeRouter = Router();

youtubeRouter.get('/youtube/song-suggest', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ query: '', tracks: [], keywords: [] });
    return;
  }
  try {
    const result = await suggestSongsForQuery(q);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

youtubeRouter.get('/youtube/search-tracks', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: '검색어(q)를 입력해 주세요.' });
    return;
  }
  try {
    const title = String(req.query.title ?? '').trim();
    const artist = String(req.query.artist ?? '').trim();
    const duration = Number(req.query.duration ?? 0);
    const artwork = String(req.query.artwork ?? '').trim();
    const hints: Partial<ResolvedSongInfo> | undefined = title
      ? {
          title,
          artist,
          duration: Number.isFinite(duration) ? duration : 0,
          artworkUrl: artwork || undefined,
          canonicalQuery: `${title} ${artist}`.trim(),
        }
      : undefined;
    const result = await searchYoutubeTracksForSong(q, hints);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

youtubeRouter.post('/youtube/import', (req, res) => {
  const body = req.body as { url?: string; mode?: 'audio' | 'video' };
  const url = String(body.url ?? '').trim();
  const mode: 'audio' | 'video' = body.mode === 'video' ? 'video' : 'audio';

  if (!url || !parseYoutubeVideoId(url)) {
    res.status(400).json({
      error: '유효한 YouTube 링크를 입력해 주세요. (예: https://www.youtube.com/watch?v=...)',
    });
    return;
  }

  try {
    const job = startYoutubeImportJob(url, mode);
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

youtubeRouter.get('/youtube/jobs/:jobId', (req, res) => {
  const job = getYoutubeImportJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: '가져오기 작업을 찾을 수 없습니다.' });
    return;
  }
  res.json(job);
});
