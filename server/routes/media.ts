import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import {
  ensureDataDirs,
  getMediaFilePath,
  saveMediaMeta,
  UPLOADS_DIR,
} from '../services/storage.js';

ensureDataDirs();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureDataDirs();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const id = `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // up to 1GB for MV backgrounds
});

export const mediaRouter = Router();

mediaRouter.post('/upload/:kind', upload.single('file'), (req, res) => {
  const kind = req.params.kind === 'background' ? 'background' : 'audio';
  if (!req.file) {
    res.status(400).json({ error: '업로드할 파일이 없습니다.' });
    return;
  }

  const id = path.parse(req.file.filename).name;
  const decodedOriginalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const meta = {
    id,
    kind,
    originalName: decodedOriginalName,
    storedName: req.file.filename,
    mimeType: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    createdAt: new Date().toISOString(),
  } as const;

  saveMediaMeta(meta);
  res.json({
    id: meta.id,
    kind: meta.kind,
    originalName: meta.originalName,
    mimeType: meta.mimeType,
    size: meta.size,
    url: `/api/media/${meta.id}`,
  });
});

mediaRouter.get('/media/:id', (req, res) => {
  const found = getMediaFilePath(req.params.id);
  if (!found) {
    res.status(404).json({ error: '미디어 파일을 찾을 수 없습니다.' });
    return;
  }

  const { meta, filePath } = found;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', meta.mimeType);

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
      'Content-Type': meta.mimeType,
    });
    fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': meta.mimeType,
    });
    fs.createReadStream(filePath).pipe(res);
  }
});
