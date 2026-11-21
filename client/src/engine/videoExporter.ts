import type { ExportProgressMessage, ExportQualityPreset, KaraokeProject } from '@shared/types';
import { workerUrl, workerWsUrl } from '../workerClient';
import {
  renderKaraokeFrame,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  type RenderResources,
} from './karaokeRenderer';

export interface ExportOptions {
  project: KaraokeProject;
  resources: RenderResources;
  fps: 60 | 30;
  quality?: ExportQualityPreset;
  preferWebCodecs: boolean;
  onProgress: (info: {
    frame: number;
    totalFrames: number;
    percent: number;
    fps: number;
    etaSeconds: number;
    encoderUsed: string;
  }) => void;
  signal: AbortSignal;
}

export interface ExportResult {
  fileName: string;
  filePath: string;
  downloadUrl: string;
  fileSize: number;
}

const CODEC_CANDIDATES = ['avc1.640032', 'avc1.64002a', 'avc1.4d0032'];

async function selectSupportedWebCodecsConfig(fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  for (const codec of CODEC_CANDIDATES) {
    const cfg: VideoEncoderConfig = {
      codec,
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      bitrate: fps >= 60 ? 8_000_000 : 5_500_000,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'annexb' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) {
        return cfg;
      }
    } catch {
      // try next codec
    }
  }
  return null;
}

async function seekVideoDeterministically(
  video: HTMLVideoElement,
  targetSeconds: number
): Promise<void> {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  const wrapped = ((targetSeconds % video.duration) + video.duration) % video.duration;
  if (Math.abs(video.currentTime - wrapped) < 0.008) return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, 500);
    const onSeeked = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = wrapped;
  });
}

export async function exportProjectToMp4(options: ExportOptions): Promise<ExportResult> {
  const { project, resources, fps, quality = 'compact', preferWebCodecs, onProgress, signal } = options;

  await document.fonts.ready;

  const lastLineEnd = project.lines.reduce((m, l) => Math.max(m, l.endTime), 0);
  const duration = Math.max(4, project.duration || lastLineEnd + 3);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  const encoderCfg = preferWebCodecs ? await selectSupportedWebCodecsConfig(fps) : null;
  const mode: 'h264' | 'mjpeg' = encoderCfg ? 'h264' : 'mjpeg';
  const encoderLabel = encoderCfg
    ? `GPU 캡처 + x264 압축 (${encoderCfg.codec})`
    : 'FFmpeg libx264 (호환 모드)';

  const canvas = document.createElement('canvas');
  canvas.width = STAGE_WIDTH;
  canvas.height = STAGE_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');
  }

  // Clone video element for deterministic seeking without interrupting UI
  let exportVideo: HTMLVideoElement | null = null;
  if (project.settings.bgType === 'video' && resources.bgVideo && resources.bgVideo.src) {
    exportVideo = document.createElement('video');
    exportVideo.crossOrigin = 'anonymous';
    exportVideo.src = resources.bgVideo.src;
    exportVideo.muted = true;
    exportVideo.playsInline = true;
    exportVideo.preload = 'auto';
    await new Promise<void>((resolve) => {
      if (!exportVideo) return resolve();
      if (exportVideo.readyState >= 2) return resolve();
      exportVideo.addEventListener('loadeddata', () => resolve(), { once: true });
      exportVideo.addEventListener('error', () => resolve(), { once: true });
    });
  }

  const exportResources: RenderResources = {
    spectrum: resources.spectrum,
    bgImage: resources.bgImage,
    bgVideo: exportVideo ?? resources.bgVideo,
  };

  const wsUrl = workerWsUrl('/ws/export');
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let encoder: VideoEncoder | null = null;
  let encoderError: Error | null = null;

  const donePromise = new Promise<ExportResult>((resolve, reject) => {
    const abortHandler = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel' }));
        ws.close();
      }
      reject(new Error('내보내기가 취소되었습니다.'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    ws.onerror = () => {
      reject(new Error('서버 WebSocket 연결 오류가 발생했습니다.'));
    };

    ws.onclose = () => {
      signal.removeEventListener('abort', abortHandler);
    };

    ws.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      const msg = JSON.parse(event.data) as ExportProgressMessage;

      if (msg.type === 'error') {
        reject(new Error(msg.message || '서버 인코딩 오류가 발생했습니다.'));
        ws.close();
        return;
      }

      if (msg.type === 'done') {
        ws.close();
        resolve({
          fileName: msg.fileName || 'karaoke.mp4',
          filePath: msg.filePath || '',
          downloadUrl: msg.downloadUrl ? workerUrl(msg.downloadUrl) : '',
          fileSize: msg.fileSize || 0,
        });
        return;
      }

      if (msg.type === 'ready') {
        try {
          if (mode === 'h264' && encoderCfg) {
            encoder = new VideoEncoder({
              output: (chunk) => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(buf.buffer);
                }
              },
              error: (err) => {
                encoderError = err;
              },
            });
            encoder.configure(encoderCfg);
          }

          const startedAt = performance.now();

          for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            if (signal.aborted) break;
            if (encoderError) throw encoderError;

            const t = frameIdx / fps;
            if (exportVideo && exportVideo.readyState >= 2) {
              await seekVideoDeterministically(exportVideo, t);
            }

            renderKaraokeFrame(ctx, project, t, exportResources);

            if (mode === 'h264' && encoder) {
              while (encoder.encodeQueueSize > 8 || ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 4 * 1024 * 1024) {
                if (signal.aborted) break;
                await new Promise((r) => setTimeout(r, 8));
              }
              const vf = new VideoFrame(canvas, {
                timestamp: Math.round((frameIdx * 1_000_000) / fps),
                duration: Math.round(1_000_000 / fps),
              });
              encoder.encode(vf, { keyFrame: frameIdx % (fps * 2) === 0 });
              vf.close();
            } else {
              while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 4 * 1024 * 1024) {
                if (signal.aborted) break;
                await new Promise((r) => setTimeout(r, 8));
              }
              const blob = await new Promise<Blob | null>((resBlob) =>
                canvas.toBlob((b) => resBlob(b), 'image/jpeg', 0.95)
              );
              if (blob && ws.readyState === WebSocket.OPEN) {
                const ab = await blob.arrayBuffer();
                ws.send(ab);
              }
            }

            if (frameIdx % 10 === 0 || frameIdx === totalFrames - 1) {
              const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
              const curFps = (frameIdx + 1) / elapsedSec;
              const remainingFrames = totalFrames - (frameIdx + 1);
              const etaSeconds = remainingFrames / Math.max(1, curFps);
              onProgress({
                frame: frameIdx + 1,
                totalFrames,
                percent: Math.min(99, Math.round(((frameIdx + 1) / totalFrames) * 100)),
                fps: Math.round(curFps),
                etaSeconds: Math.max(0, Math.round(etaSeconds)),
                encoderUsed: encoderLabel,
              });
              // Yield periodically for UI responsiveness
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          if (!signal.aborted) {
            if (encoder) {
              await encoder.flush();
              encoder.close();
              encoder = null;
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'finish' }));
            }
          }
        } catch (err) {
          if (encoder) {
            try {
              encoder.close();
            } catch {
              // ignore
            }
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'cancel' }));
            ws.close();
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'start',
          mode,
          quality,
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
          fps,
          totalFrames,
          audioFileId: project.audioFileId,
          mrAudioFileId: project.mrAudioFileId,
          karaokeAudioFileId: project.karaokeAudioFileId,
          vocalFileId: project.vocalFileId,
          audioMode: project.audioMode ?? 'original',
          keyShift:
            project.audioMode !== 'mr' && project.audioMode !== 'karaoke'
              ? 0
              : (project.keyShift ?? 0),
          mrSyncOffset: project.mrSyncOffset ?? 0,
          karaokeSyncOffset: project.karaokeSyncOffset ?? 0,
          guideVocalVolume: project.guideVocalVolume ?? 0.28,
          guideMelodyVolume: project.guideMelodyVolume ?? 0.75,
          pitchNotes: project.pitchNotes,
          duration,
          projectTitle: project.title,
        })
      );
    };
  });

  return donePromise;
}
