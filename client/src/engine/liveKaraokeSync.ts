import {
  CHROMA_FFT_SIZE,
  CHROMA_FPS,
  CHROMA_HOP,
  CHROMA_SR,
  ChromaSyncTracker,
  type ChromaTrackerUpdate,
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
  candidateSongTimeSec: number;
  canForceLock: boolean;
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
  candidateSongTimeSec: 0,
  canForceLock: false,
  lockedSongTimeSec: 0,
  lockWallMs: 0,
  message: '',
};

/**
 * Real-time microphone listener that captures anti-aliased audio (Biquad 130..2200 Hz)
 * with sample-accurate 16 kHz / 4 Hz framing (0% timer drift) and immediately releases
 * microphone tracks on lock so Bluetooth headphones switch back to stereo playback.
 */
export class LiveKaraokeSyncEngine {
  private onState: (snap: LiveSyncSnapshot) => void;
  private onLocked?: (snap: LiveSyncSnapshot) => void;

  private fingerprint: SongChromaFingerprint | null = null;
  private tracker: ChromaSyncTracker | null = null;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private hpFilter: BiquadFilterNode | null = null;
  private lpFilter: BiquadFilterNode | null = null;
  private scriptProc: ScriptProcessorNode | null = null;
  private zeroGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pollTimer: number | null = null;
  private timeBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0));
  private pcm4096 = new Float32Array(CHROMA_FFT_SIZE);

  // Sample-accurate decimation buffer (sr -> 16 kHz)
  private pcmRing = new Float32Array(16384);
  private pcmRingLen = 0;
  private resamplePhase = 0;
  private prevSample = 0;
  private hasPrevSample = false;

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

  private disconnectNode(node: AudioNode | null): void {
    if (!node) return;
    try {
      node.disconnect();
    } catch {
      // ignore
    }
  }

  private stopAudioCapture(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.scriptProc) {
      this.scriptProc.onaudioprocess = null;
    }
    this.disconnectNode(this.sourceNode);
    this.disconnectNode(this.hpFilter);
    this.disconnectNode(this.lpFilter);
    this.disconnectNode(this.scriptProc);
    this.disconnectNode(this.zeroGain);
    this.disconnectNode(this.analyser);
    this.sourceNode = null;
    this.hpFilter = null;
    this.lpFilter = null;
    this.scriptProc = null;
    this.zeroGain = null;
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
    this.pcmRingLen = 0;
    this.resamplePhase = 0;
    this.prevSample = 0;
    this.hasPrevSample = false;
  }

  private completeLock(update: ChromaTrackerUpdate): void {
    this.stopAudioCapture();
    const lockedSnap: LiveSyncSnapshot = {
      status: 'locked',
      micLevel: 0,
      elapsedSec: update.elapsedSec,
      confidence: update.confidence,
      detectedKeyShift: update.detectedKeyShift,
      candidateSongTimeSec: Math.max(0, update.predictedOrigTimeSec),
      canForceLock: false,
      lockedSongTimeSec: Math.max(0, update.predictedOrigTimeSec),
      lockWallMs: update.lockWallMs || performance.now(),
      message: '싱크 잠금됨 · 마이크 자동 종료',
    };
    this.snapshot = lockedSnap;
    this.onState(lockedSnap);
    this.onLocked?.(lockedSnap);
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
      candidateSongTimeSec: 0,
      canForceLock: false,
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

  forceLockNow(): void {
    if (!this.sessionActive || !this.tracker || this.snapshot.status !== 'listening') return;
    const locked = this.tracker.forceLock(performance.now());
    if (locked) {
      this.completeLock(locked);
    }
  }

  stop(): void {
    this.sessionActive = false;
    this.stopAudioCapture();
    this.releaseWakeLock();
    this.tracker = null;
    this.emit({ ...INITIAL_SNAPSHOT });
  }

  private processChromaFrame(frame4096: Float32Array, micLevel: number): boolean {
    if (!this.sessionActive || !this.tracker) return false;
    const { raw, energy } = computeRawChromaFrame(frame4096);
    const update = this.tracker.pushRawFrame(raw, energy, performance.now());

    if (update.justLocked) {
      this.completeLock(update);
      return true;
    }

    this.emit({
      status: 'listening',
      micLevel,
      elapsedSec: update.elapsedSec,
      confidence: update.confidence,
      detectedKeyShift: update.detectedKeyShift,
      candidateSongTimeSec: update.predictedOrigTimeSec,
      canForceLock: update.canForceLock,
      message:
        update.elapsedSec < 6
          ? '반주 듣는 중 · 잠시만 기다려 주세요 (초반 8~16초)'
          : update.activeFrac < 0.45
            ? '주변 소리가 너무 작습니다 · 스피커 가까이 대주세요'
            : update.canForceLock
              ? '화음 추적 중 · 예상 시점이 맞으면 지금 맞추기 가능'
              : '화음 패턴 대조 중...',
    });
    return false;
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

    const source = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 130;
    hp.Q.value = 0.707;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.Q.value = 0.707;

    source.connect(hp);
    hp.connect(lp);

    this.stream = stream;
    this.audioCtx = ctx;
    this.sourceNode = source;
    this.hpFilter = hp;
    this.lpFilter = lp;

    this.emit({
      status: 'listening',
      micLevel: 0,
      elapsedSec: 0,
      confidence: 0,
      candidateSongTimeSec: 0,
      canForceLock: false,
      message: '전주/반주를 폰 마이크에 들려주세요 · 잠금 후 마이크 자동 종료',
    });

    const sr = ctx.sampleRate || 48000;
    const step = sr / CHROMA_SR;

    if (typeof ctx.createScriptProcessor === 'function') {
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;

      lp.connect(proc);
      proc.connect(zeroGain);
      zeroGain.connect(ctx.destination);

      this.scriptProc = proc;
      this.zeroGain = zeroGain;
      this.pcmRingLen = 0;
      this.resamplePhase = 0;
      this.prevSample = 0;
      this.hasPrevSample = false;

      proc.onaudioprocess = (ev) => {
        if (!this.sessionActive || !this.tracker) return;
        const input = ev.inputBuffer.getChannelData(0);
        if (!input || input.length === 0) return;

        if (!this.hasPrevSample) {
          this.prevSample = input[0];
          this.hasPrevSample = true;
        }

        // Fractional phase accumulator linear interpolation from sr -> 16 kHz
        let phase = this.resamplePhase;
        const nIn = input.length;
        while (phase < nIn) {
          const i0 = Math.floor(phase);
          const frac = phase - i0;
          const s0 = i0 < 0 ? this.prevSample : input[i0];
          const i1 = i0 + 1;
          const s1 = i1 >= nIn ? input[nIn - 1] : i1 < 0 ? this.prevSample : input[i1];
          const sample = s0 + (s1 - s0) * frac;

          if (this.pcmRingLen >= this.pcmRing.length) {
            const nextBuf = new Float32Array(this.pcmRing.length * 2);
            nextBuf.set(this.pcmRing.subarray(0, this.pcmRingLen));
            this.pcmRing = nextBuf;
          }
          this.pcmRing[this.pcmRingLen] = sample;
          this.pcmRingLen += 1;
          phase += step;
        }
        this.resamplePhase = phase - nIn;
        this.prevSample = input[nIn - 1];

        while (this.pcmRingLen >= CHROMA_FFT_SIZE) {
          let sumSq = 0;
          for (let i = 0; i < CHROMA_FFT_SIZE; i += 1) {
            const v = this.pcmRing[i];
            this.pcm4096[i] = v;
            sumSq += v * v;
          }
          const remaining = this.pcmRingLen - CHROMA_HOP;
          if (remaining > 0) {
            this.pcmRing.copyWithin(0, CHROMA_HOP, this.pcmRingLen);
          }
          this.pcmRingLen = Math.max(0, remaining);

          const micLevel = Math.min(1, Math.sqrt(sumSq / CHROMA_FFT_SIZE) * 2.8);
          if (this.processChromaFrame(this.pcm4096, micLevel)) {
            return;
          }
        }
      };
      return;
    }

    // Fallback for browsers without ScriptProcessorNode
    const neededInSamples = Math.max(
      CHROMA_FFT_SIZE,
      Math.round((CHROMA_FFT_SIZE * sr) / CHROMA_SR)
    );
    const fftSize = neededInSamples > 16384 ? 32768 : 16384;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    lp.connect(analyser);

    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(fftSize * 4));
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

      const micLevel = Math.min(1, Math.sqrt(sumSq / CHROMA_FFT_SIZE) * 2.8);
      this.processChromaFrame(this.pcm4096, micLevel);
    }, 250);
  }
}
