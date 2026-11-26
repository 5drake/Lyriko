import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AudioPlayMode, LyricLine } from '../../shared/types.js';
import {
  getAiAudioJob,
  startAiAlignLyricsJob,
  startAiAudioAnalyzeJob,
} from '../services/aiAudio.js';
import {
  computeMrAutoSyncOffset,
  prepareProcessedAudio,
} from '../services/audioProcessor.js';
import { extractSongFingerprint } from '../services/chromaExtractor.js';
import { CACHE_DIR } from '../services/storage.js';

export const audioRouter = Router();

audioRouter.post('/audio/ai-analyze', (req, res) => {
  try {
    const body = req.body as {
      audioFileId?: string;
      lines?: LyricLine[];
      sensitivity?: number;
      force?: boolean;
    };
    if (!body.audioFileId) {
      res.status(400).json({ error: '먼저 음원 파일을 업로드하거나 YouTube에서 불러오세요.' });
      return;
    }
    const job = startAiAudioAnalyzeJob({
      audioFileId: body.audioFileId,
      lines: body.lines,
      sensitivity: body.sensitivity,
      force: body.force,
    });
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

audioRouter.post('/audio/ai-align-lyrics', (req, res) => {
  try {
    const body = req.body as {
      audioFileId?: string;
      vocalFileId?: string;
      lines?: LyricLine[];
      model?: string;
    };
    if (!body.audioFileId && !body.vocalFileId) {
      res.status(400).json({ error: '먼저 음원을 불러오세요.' });
      return;
    }
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.status(400).json({ error: '정렬할 가사가 없습니다.' });
      return;
    }
    const job = startAiAlignLyricsJob({
      audioFileId: body.audioFileId || '',
      vocalFileId: body.vocalFileId,
      lines: body.lines,
      model: body.model,
    });
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

audioRouter.get('/audio/ai-jobs/:jobId', (req, res) => {
  const job = getAiAudioJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'AI 오디오 분석 작업을 찾을 수 없습니다.' });
    return;
  }
  res.json(job);
});

audioRouter.post('/audio/sync-mr', async (req, res) => {
  try {
    const body = req.body as {
      audioFileId?: string;
      mrAudioFileId?: string;
    };
    if (!body.audioFileId || !body.mrAudioFileId) {
      res.status(400).json({ error: '원곡과 별도 MR 음원이 모두 연결되어 있어야 합니다.' });
      return;
    }
    const result = await computeMrAutoSyncOffset(body.audioFileId, body.mrAudioFileId);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: `MR 자동 싱크 분석 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

audioRouter.post('/audio/extract-chroma', async (req, res) => {
  try {
    const body = req.body as {
      youtubeVideoId?: string;
      audioFileId?: string;
      mrAudioFileId?: string;
      mrSyncOffset?: number;
    };
    const youtubeVideoId = String(body.youtubeVideoId || '').trim();
    if (!youtubeVideoId) {
      res.status(400).json({ error: 'youtubeVideoId가 필요합니다.' });
      return;
    }
    const fingerprint = await extractSongFingerprint({
      youtubeVideoId,
      audioFileId: body.audioFileId,
      mrAudioFileId: body.mrAudioFileId,
      mrSyncOffset: Number(body.mrSyncOffset ?? 0),
    });
    res.json({ ok: true, fingerprint });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

audioRouter.post('/audio/prepare', async (req, res) => {
  try {
    const body = req.body as {
      audioFileId?: string;
      mrAudioFileId?: string;
      karaokeAudioFileId?: string;
      vocalFileId?: string;
      mode?: AudioPlayMode;
      keyShift?: number;
      mrSyncOffset?: number;
      karaokeSyncOffset?: number;
      monitorOriginal?: boolean;
    };
    const mode: AudioPlayMode =
      body.mode === 'mr' ||
      body.mode === 'karaoke' ||
      body.mode === 'mr-vocal' ||
      body.mode === 'mr-melody'
        ? body.mode
        : 'original';
    const keyShift = Number(body.keyShift) || 0;
    const mrSyncOffset = Number(body.mrSyncOffset) || 0;
    const karaokeSyncOffset = Number(body.karaokeSyncOffset) || 0;

    const prepared = await prepareProcessedAudio({
      audioFileId: body.audioFileId,
      mrAudioFileId: body.mrAudioFileId,
      karaokeAudioFileId: body.karaokeAudioFileId,
      mode,
      keyShift,
      mrSyncOffset,
      karaokeSyncOffset,
      monitorOriginal: Boolean(body.monitorOriginal),
    });

    if (!prepared) {
      res.status(404).json({ error: '처리할 음원 파일이 없습니다.' });
      return;
    }

    res.json({
      url: prepared.url,
      cacheKey: prepared.cacheKey,
      usedAutoMr: prepared.usedAutoMr,
    });
  } catch (err) {
    res.status(500).json({
      error: `오디오 키/MR 처리 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

audioRouter.get('/audio/cache/:cacheKey', (req, res) => {
  const safeKey = path.basename(req.params.cacheKey).replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(CACHE_DIR, `${safeKey}.mp3`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: '캐시된 오디오 파일을 찾을 수 없습니다.' });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const clampedEnd = Math.min(end, fileSize - 1);
    const chunkSize = clampedEnd - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${clampedEnd}/${fileSize}`,
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg',
    });
    fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});
