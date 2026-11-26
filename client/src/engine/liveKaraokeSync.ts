import {
  CHROMA_FFT_SIZE,
  CHROMA_FPS,
  CHROMA_SR,
  ChromaSyncTracker,
  computeRawChromaFrame,
  decodeChromaFromBase64,
} from '@shared/chromaSync';
import type { SongChromaFingerprint } from '@shared/types';

export type LiveSyncStatus = 'idle' | 'loading' | 'listening' | 'locked' | 'error';

export interface LiveSyncSnapshot {
  status: LiveSyncStatus;
  micLevel: number;
  elapsedSec: number;
  confidence: number;
  detectedKeyShift: number;
  lockedSongTimeSec: number;
  lockWallMs: number;
  message: string;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
}

const INITIAL_SNAPSHOT: LiveSyncSnapshot = {
  status: 'idle',
  micLevel: 0,
  elapsedSec: 0,
  confidence: 0,
  detectedKeyShift: 0,
  lockedSongTimeSec: 0,
  lockWallMs: 0,
  message: '',
};

/**
 * Real-time microphone listener that extracts 4 Hz 12-bin Chroma frames on mobile/desktop
 * and locks onto a pre-computed SongChromaFingerprint, immediately releasing the microphone
 * upon lock so Bluetooth headphones switch back from call (HFP) to clean stereo playback.
 */
export class LiveKaraokeSyncEngine {
  private onState: (snap: LiveSyncSnapshot) => void;
  private onLocked?: (snap: LiveSyncSnapshot) => void;

  private fingerprint: SongChromaFingerprint | null = null;
  private tracker: ChromaSyncTracker | null = null;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pollTimer: number | null = null;
  private timeBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0));
  private pcm4096 = new Float32Array(CHROMA_FFT_SIZE);

  private wakeLock: WakeLockSentinelLike | null = null;
  private sessionActive = false;
  private snapshot: LiveSyncSnapshot = { ...INITIAL_SNAPSHOT };

  constructor(opts: {
    onState: (snap: LiveSyncSnapshot) => void;
    onLocked?: (snap: LiveSyncSnapshot) => void;
  }) {
    this.onState = opts.onState;
    this.onLocked = opts.onLocked;
  }

  getSnapshot(): LiveSyncSnapshot {
    return this.snapshot;
  }

  private emit(patch: Partial<LiveSyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onState(this.snapshot);
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined') return;
    const wl = (navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    }).wakeLock;
    if (!wl || this.wakeLock) return;
    try {
      this.wakeLock = await wl.request('screen');
    } catch {
      // ignore if unsupported or battery saver blocks it
    }
  }

  private releaseWakeLock(): void {
    const cur = this.wakeLock;
    this.wakeLock = null;
    if (cur) {
      cur.release().catch(() => {});
    }
  }

  private stopAudioCapture(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.stream = null;
    }
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      ctx.close().catch(() => {});
    }
  }

  async start(fingerprint: SongChromaFingerprint): Promise<void> {
    this.stopAudioCapture();
    this.fingerprint = fingerprint;
    this.sessionActive = true;

    const refFrames = decodeChromaFromBase64(fingerprint.chromaB64, fingerprint.frameCount);
    this.tracker = new ChromaSyncTracker({
      refFrames,
      frameCount: fingerprint.frameCount,
      fps: fingerprint.fps || CHROMA_FPS,
      offsetSec: fingerprint.offsetSec || 0,
    });

    this.emit({
      status: 'loading',
      micLevel: 0,
      elapsedSec: 0,
      confidence: 0,
      detectedKeyShift: 0,
      lockedSongTimeSec: 0,
      lockWallMs: 0,
      message: '마이크 권한을 확인하는 중...',
    });

    await this.acquireWakeLock();
    await this.startMicCapture();
  }

  async resync(): Promise<void> {
    if (!this.fingerprint) return;
    await this.start(this.fingerprint);
  }

  stop(): void {
    this.sessionActive = false;
    this.stopAudioCapture();
    this.releaseWakeLock();
    this.tracker = null;
    this.emit({ ...INITIAL_SNAPSHOT });
  }

  private async startMicCapture(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.sessionActive = false;
      this.emit({
        status: 'error',
        message: '이 브라우저는 마이크 캡처를 지원하지 않습니다.',
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        this.sessionActive = false;
        this.releaseWakeLock();
        const msg =
          err instanceof Error && err.name === 'NotAllowedError'
            ? '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용해 주세요.'
            : '마이크를 열 수 없습니다. 연결 상태를 확인해 주세요.';
        this.emit({ status: 'error', message: msg });
        return;
      }
    }

    if (!this.sessionActive) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      for (const t of stream.getTracks()) t.stop();
      this.sessionActive = false;
      this.releaseWakeLock();
      this.emit({ status: 'error', message: 'AudioContext를 초기화할 수 없습니다.' });
      return;
    }

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const sr = ctx.sampleRate || 48000;
    const neededInSamples = Math.max(CHROMA_FFT_SIZE, Math.round((CHROMA_FFT_SIZE * sr) / CHROMA_SR));
    const fftSize = neededInSamples > 16384 ? 32768 : 16384;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    this.stream = stream;
    this.audioCtx = ctx;
    this.sourceNode = source;
    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(fftSize * 4));

    this.emit({
      status: 'listening',
      micLevel: 0,
      elapsedSec: 0,
      confidence: 0,
      message: '전주/반주를 폰 마이크에 들려주세요 · 잠금 후 마이크 자동 종료',
    });

    const tailStart = fftSize - neededInSamples;
    const ratio = neededInSamples / CHROMA_FFT_SIZE;

    this.pollTimer = window.setInterval(() => {
      if (!this.sessionActive || !this.analyser || !this.tracker) return;
      this.analyser.getFloatTimeDomainData(this.timeBuf);

      let sumSq = 0;
      for (let i = 0; i < CHROMA_FFT_SIZE; i += 1) {
        const s0 = tailStart + Math.floor(i * ratio);
        const s1 = Math.max(s0 + 1, Math.min(fftSize, tailStart + Math.floor((i + 1) * ratio)));
        let acc = 0;
        for (let k = s0; k < s1; k += 1) {
          acc += this.timeBuf[k];
        }
        const v = acc / (s1 - s0);
        this.pcm4096[i] = v;
        sumSq += v * v;
      }

      const rms = Math.sqrt(sumSq / CHROMA_FFT_SIZE);
      const micLevel = Math.min(1, Math.sqrt(rms) * 2.6);
      const { raw, energy } = computeRawChromaFrame(this.pcm4096);
      const update = this.tracker.pushRawFrame(raw, energy, performance.now());

      if (update.justLocked) {
        // Immediately stop microphone tracks so iOS/Android Bluetooth restores clean stereo output
        this.stopAudioCapture();
        const lockedSnap: LiveSyncSnapshot = {
          status: 'locked',
          micLevel: 0,
          elapsedSec: update.elapsedSec,
          confidence: update.confidence,
          detectedKeyShift: update.detectedKeyShift,
          lockedSongTimeSec: Math.max(0, update.predictedOrigTimeSec),
          lockWallMs: update.lockWallMs || performance.now(),
          message: '싱크 잠금됨 · 마이크 자동 종료',
        };
        this.snapshot = lockedSnap;
        this.onState(lockedSnap);
        this.onLocked?.(lockedSnap);
        return;
      }

      this.emit({
        status: 'listening',
        micLevel,
        elapsedSec: update.elapsedSec,
        confidence: update.confidence,
        detectedKeyShift: update.detectedKeyShift,
        message:
          update.elapsedSec < 8
            ? '반주 듣는 중 · 잠시만 기다려 주세요 (초반 8~15초)'
            : update.activeFrac < 0.5
              ? '주변 소리가 너무 작습니다 · 스피커 가까이 대주세요'
              : '화음 패턴 대조 중...',
      });
    }, 250);
  }
}
