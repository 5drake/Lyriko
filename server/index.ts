import cors from 'cors';
import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiRouter } from './routes/ai.js';
import { audioRouter } from './routes/audio.js';
import { libraryRouter } from './routes/library.js';
import { lyricsRouter } from './routes/lyrics.js';
import { mediaRouter } from './routes/media.js';
import { projectsRouter } from './routes/projects.js';
import { youtubeRouter } from './routes/youtube.js';
import { getWorkerGpuInfo, isAiAudioAvailable } from './services/aiAudio.js';
import { attachExportWebSocket } from './services/exportWs.js';
import { getTokenizer, isKuromojiReady } from './services/jpKorean.js';
import { DATA_DIR, ensureDataDirs, EXPORTS_DIR } from './services/storage.js';
import { isYtDlpAvailable } from './services/ytdlp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3840;

ensureDataDirs();

// Pre-warm kuromoji dictionary in background on server start
getTokenizer().catch((err) => {
  console.error('[kuromoji] preload failed:', err);
});

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', async (_req, res) => {
  if (!isKuromojiReady()) {
    try {
      await getTokenizer();
    } catch {
      // status reported below
    }
  }
  const gpu = await getWorkerGpuInfo();
  const isPortable =
    process.env.LYRIKO_PORTABLE === '1' || process.env.UTAKANA_PORTABLE === '1';
  res.json({
    ok: true,
    mode: isPortable ? 'portable-worker' : 'local-worker',
    portable: isPortable,
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    kuromojiReady: isKuromojiReady(),
    ytdlp: isYtDlpAvailable(),
    aiAudio: isAiAudioAvailable(),
    gpu,
    dataDir: DATA_DIR,
    version: '1.0.0',
  });
});

app.post('/api/worker/shutdown', (_req, res) => {
  const isPortable =
    process.env.LYRIKO_PORTABLE === '1' || process.env.UTAKANA_PORTABLE === '1';
  if (!isPortable) {
    res.status(403).json({ error: '포터블 워커 모드에서만 종료할 수 있습니다.' });
    return;
  }
  res.json({ ok: true });
  setTimeout(() => {
    process.exit(0);
  }, 250);
});

app.use('/api', lyricsRouter);
app.use('/api', libraryRouter);
app.use('/api', aiRouter);
app.use('/api', audioRouter);
app.use('/api', mediaRouter);
app.use('/api', projectsRouter);
app.use('/api', youtubeRouter);

app.get('/api/exports/:fileName', (req, res) => {
  const safeName = path.basename(req.params.fileName);
  const fullPath = path.join(EXPORTS_DIR, safeName);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: '내보낸 영상 파일을 찾을 수 없습니다.' });
    return;
  }
  res.download(fullPath, safeName);
});

// Serve built React app if present
const distClientDir = path.resolve(__dirname, '..', 'dist', 'client');
if (fs.existsSync(distClientDir)) {
  app.use(express.static(distClientDir));
  app.get('/{*splat}', (_req, res, next) => {
    const indexPath = path.join(distClientDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
}

const server = http.createServer(app);
attachExportWebSocket(server);

server.listen(PORT, () => {
  console.log(`[Lyriko Server] listening on http://localhost:${PORT}`);
});
