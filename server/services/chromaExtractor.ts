import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  CHROMA_ALGO_VERSION,
  CHROMA_FPS,
  CHROMA_SR,
  encodeChromaToBase64,
  extractChromaFromPcm16k,
} from '../../shared/chromaSync.js';
import type { ChromaSourceKind, SongChromaFingerprint } from '../../shared/types.js';
import { getMediaFilePath } from './storage.js';

/**
 * Decodes any local audio file to mono 16 kHz Float32 PCM using ffmpeg-static.
 */
export async function decodeAudioFileToPcm16k(filePath: string): Promise<Float32Array> {
  if (!ffmpegPath) {
    throw new Error('FFmpeg 실행 파일을 찾을 수 없습니다.');
  }
  const bin = ffmpegPath;

  const rawBuf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn(
      bin,
      ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(CHROMA_SR), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'],
      { windowsHide: true }
    );
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        const msg = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(`FFmpeg decode failed (${code}): ${msg.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });

  const usableBytes = rawBuf.byteLength - (rawBuf.byteLength % 4);
  if (usableBytes <= 0) {
    return new Float32Array(0);
  }
  const aligned = Buffer.from(rawBuf.subarray(0, usableBytes));
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

/**
 * Extracts a compact 4 Hz 12-bin Chroma fingerprint from a decoded PCM buffer.
 */
export function buildFingerprintFromPcm16k(opts: {
  youtubeVideoId: string;
  pcm: Float32Array;
  sourceKind: ChromaSourceKind;
  alignOffsetSec?: number;
}): SongChromaFingerprint {
  const { frames, frameCount, subOffsetSec } = extractChromaFromPcm16k(
    opts.pcm,
    opts.alignOffsetSec ?? 0
  );
  if (frameCount < 20) {
    throw new Error('오디오 길이가 너무 짧아 Chroma 지문을 생성할 수 없습니다.');
  }
  const chromaB64 = encodeChromaToBase64(frames, frameCount);
  return {
    youtubeVideoId: opts.youtubeVideoId,
    algoVersion: CHROMA_ALGO_VERSION,
    sourceKind: opts.sourceKind,
    fps: CHROMA_FPS,
    frameCount,
    offsetSec: subOffsetSec,
    chromaB64,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Extracts Chroma fingerprint for a workspace track, preferring separated/linked MR
 * (aligned via `mrSyncOffset`) over Original when available.
 */
export async function extractSongFingerprint(opts: {
  youtubeVideoId: string;
  audioFileId?: string;
  mrAudioFileId?: string;
  mrSyncOffset?: number;
}): Promise<SongChromaFingerprint> {
  const mrMedia = opts.mrAudioFileId ? getMediaFilePath(opts.mrAudioFileId) : null;
  const origMedia = opts.audioFileId ? getMediaFilePath(opts.audioFileId) : null;

  const selected = mrMedia
    ? {
        filePath: mrMedia.filePath,
        sourceKind: 'mr' as ChromaSourceKind,
        alignOffsetSec: Number(opts.mrSyncOffset ?? 0),
      }
    : origMedia
      ? {
          filePath: origMedia.filePath,
          sourceKind: 'original' as ChromaSourceKind,
          alignOffsetSec: 0,
        }
      : null;

  if (!selected) {
    throw new Error('Chroma 지문을 추출할 음원 파일이 연결되어 있지 않습니다.');
  }

  const pcm = await decodeAudioFileToPcm16k(selected.filePath);
  return buildFingerprintFromPcm16k({
    youtubeVideoId: opts.youtubeVideoId,
    pcm,
    sourceKind: selected.sourceKind,
    alignOffsetSec: selected.alignOffsetSec,
  });
}
