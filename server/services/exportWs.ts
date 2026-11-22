import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AudioPlayMode,
  ExportQualityPreset,
  PitchNote,
} from '../../shared/types.js';
import {
  prepareProcessedAudio,
  prepareVocalTrack,
  synthesizeGuideMelodyWav,
} from './audioProcessor.js';
import { isAllowedWorkerOrigin } from './originGuard.js';
import { ensureDataDirs, EXPORTS_DIR } from './storage.js';

interface StartMessage {
  type: 'start';
  mode: 'h264' | 'mjpeg';
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  quality?: ExportQualityPreset;
  audioFileId?: string;
  mrAudioFileId?: string;
  karaokeAudioFileId?: string;
  vocalFileId?: string;
  audioMode?: AudioPlayMode;
  keyShift?: number;
  mrSyncOffset?: number;
  karaokeSyncOffset?: number;
  guideVocalVolume?: number;
  guideMelodyVolume?: number;
  pitchNotes?: PitchNote[];
  duration?: number;
  projectTitle?: string;
}

interface ControlMessage {
  type: 'finish' | 'cancel';
}

const EXPORT_QUALITY_PROFILES: Record<
  ExportQualityPreset,
  {
    crf: number;
    preset: string;
    maxrate: string;
    bufsize: string;
    gopSec: number;
    audioBitrate: string;
  }
> = {
  compact: {
    crf: 28,
    preset: 'fast',
    maxrate: '2500k',
    bufsize: '5000k',
    gopSec: 4,
    audioBitrate: '160k',
  },
  balanced: {
    crf: 25,
    preset: 'fast',
    maxrate: '4500k',
    bufsize: '9000k',
    gopSec: 4,
    audioBitrate: '160k',
  },
  high: {
    crf: 21,
    preset: 'fast',
    maxrate: '8000k',
    bufsize: '16000k',
    gopSec: 2,
    audioBitrate: '256k',
  },
};

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return cleaned || 'utakana_karaoke';
}

export function attachExportWebSocket(server: Server): void {
  ensureDataDirs();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedWorkerOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const reqUrl = new URL(request.url || '/', 'http://localhost');
    if (reqUrl.pathname === '/ws/export') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    let ffmpegProc: ChildProcessWithoutNullStreams | null = null;
    let outputPath = '';
    let outputFileName = '';
    let tempGuideWavPath = '';
    let framesReceived = 0;
    let totalFrames = 0;
    let cancelled = false;
    let finishing = false;
    let stderrTail = '';

    const cleanupTempGuide = () => {
      if (tempGuideWavPath && fs.existsSync(tempGuideWavPath)) {
        try {
          fs.unlinkSync(tempGuideWavPath);
        } catch {
          // ignore
        }
      }
      tempGuideWavPath = '';
    };

    const cleanupPartial = () => {
      if (ffmpegProc && !ffmpegProc.killed) {
        try {
          ffmpegProc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      ffmpegProc = null;
      cleanupTempGuide();
      if (outputPath && fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch {
          // ignore
        }
      }
    };

    const safeSend = (obj: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    };

    ws.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        let msg: StartMessage | ControlMessage;
        try {
          msg = JSON.parse(data.toString('utf-8')) as StartMessage | ControlMessage;
        } catch {
          safeSend({ type: 'error', message: '잘못된 제어 메시지입니다.' });
          return;
        }

        if (msg.type === 'start') {
          if (!ffmpegPath) {
            safeSend({ type: 'error', message: 'FFmpeg 실행 파일이 없습니다.' });
            return;
          }

          try {
            ensureDataDirs();
            const fps = Math.max(15, Math.min(60, Number(msg.fps) || 60));
            const quality: ExportQualityPreset =
              msg.quality === 'balanced' || msg.quality === 'high' ? msg.quality : 'compact';
            const profile = EXPORT_QUALITY_PROFILES[quality];
            const gop = Math.max(fps * 2, Math.round(fps * profile.gopSec));
            totalFrames = Math.max(1, Number(msg.totalFrames) || 1);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            outputFileName = `${sanitizeFileName(msg.projectTitle || 'karaoke')}_${stamp}.mp4`;
            outputPath = path.join(EXPORTS_DIR, outputFileName);

            const audioMode: AudioPlayMode = msg.audioMode || 'original';
            const keyShift = Number(msg.keyShift) || 0;
            const processed = await prepareProcessedAudio({
              audioFileId: msg.audioFileId,
              mrAudioFileId: msg.mrAudioFileId,
              karaokeAudioFileId: msg.karaokeAudioFileId,
              mode: audioMode,
              keyShift,
              mrSyncOffset: Number(msg.mrSyncOffset) || 0,
              karaokeSyncOffset: Number(msg.karaokeSyncOffset) || 0,
            });

            let audioArgs: string[];
            if (processed?.filePath) {
              audioArgs = ['-i', processed.filePath, '-map', '0:v:0', '-map', '1:a:0'];
            } else {
              audioArgs = [
                '-f',
                'lavfi',
                '-i',
                'anullsrc=channel_layout=stereo:sample_rate=48000',
                '-map',
                '0:v:0',
                '-map',
                '1:a:0',
              ];
            }

            const videoInputArgs =
              msg.mode === 'h264'
                ? ['-f', 'h264', '-r', String(fps), '-i', 'pipe:0']
                : ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0'];

            const videoCodecArgs = [
              '-c:v',
              'libx264',
              '-preset',
              profile.preset,
              '-crf',
              String(profile.crf),
              '-maxrate',
              profile.maxrate,
              '-bufsize',
              profile.bufsize,
              '-g',
              String(gop),
              '-r',
              String(fps),
              '-profile:v',
              'high',
              '-pix_fmt',
              'yuv420p',
            ];

            const args = [
              '-y',
              ...videoInputArgs,
              ...audioArgs,
              ...videoCodecArgs,
              '-c:a',
              'aac',
              '-b:a',
              profile.audioBitrate,
              '-ar',
              '48000',
              '-shortest',
              '-movflags',
              '+faststart',
              outputPath,
            ];

            ffmpegProc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            ffmpegProc.stderr.on('data', (chunk: Buffer) => {
              stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-2500);
            });

            ffmpegProc.stdin.on('error', (err) => {
              if (!cancelled && !finishing) {
                safeSend({ type: 'error', message: `FFmpeg 입력 오류: ${err.message}` });
              }
            });

            ffmpegProc.on('close', (code) => {
              cleanupTempGuide();
              if (cancelled) return;
              if (code === 0 && fs.existsSync(outputPath)) {
                const stat = fs.statSync(outputPath);
                if (stat.size > 0) {
                  safeSend({
                    type: 'done',
                    fileName: outputFileName,
                    filePath: outputPath,
                    downloadUrl: `/api/exports/${encodeURIComponent(outputFileName)}`,
                    fileSize: stat.size,
                  });
                  return;
                }
              }
              cleanupPartial();
              safeSend({
                type: 'error',
                message: `FFmpeg 인코딩 실패 (code ${code}): ${stderrTail.slice(-400)}`,
              });
            });

            safeSend({ type: 'ready' });
          } catch (err) {
            cleanupPartial();
            safeSend({
              type: 'error',
              message: `오디오 준비 실패: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }

        if (msg.type === 'finish') {
          finishing = true;
          if (ffmpegProc && ffmpegProc.stdin.writable) {
            ffmpegProc.stdin.end();
          }
          return;
        }

        if (msg.type === 'cancel') {
          cancelled = true;
          cleanupPartial();
          ws.close();
          return;
        }
        return;
      }

      // Binary video frame chunk
      if (!ffmpegProc || !ffmpegProc.stdin.writable || cancelled) {
        return;
      }

      framesReceived += 1;
      const ok = ffmpegProc.stdin.write(data);
      if (!ok) {
        ws.pause();
        ffmpegProc.stdin.once('drain', () => {
          if (ws.readyState === ws.OPEN && !cancelled) {
            ws.resume();
          }
        });
      }

      if (framesReceived % 15 === 0 || framesReceived === totalFrames) {
        safeSend({
          type: 'progress',
          frame: framesReceived,
          totalFrames,
          percent: Math.min(99, Math.round((framesReceived / totalFrames) * 100)),
        });
      }
    });

    ws.on('close', () => {
      if (!finishing) {
        cancelled = true;
        cleanupPartial();
      }
    });
  });
}
