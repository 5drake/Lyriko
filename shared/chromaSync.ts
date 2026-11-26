export const CHROMA_SR = 16000;
export const CHROMA_FFT_SIZE = 4096;
export const CHROMA_HOP = 4000; // 4 Hz = 0.25s/frame
export const CHROMA_FPS = CHROMA_SR / CHROMA_HOP; // 4
export const CHROMA_BINS = 12;
export const CHROMA_ALGO_VERSION = 'chroma_v2_4hz';

interface SoftProjEntry {
  bin: number;
  pc0: number;
  w0: number;
  pc1: number;
  w1: number;
}

// Precomputed Hann window (4096) & soft semitone projection entries (65..2093 Hz, sigma=0.35)
const HANN_WINDOW = (() => {
  const win = new Float32Array(CHROMA_FFT_SIZE);
  const denom = CHROMA_FFT_SIZE - 1;
  for (let i = 0; i < CHROMA_FFT_SIZE; i += 1) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return win;
})();

const SOFT_PROJ: SoftProjEntry[] = (() => {
  const entries: SoftProjEntry[] = [];
  const sigma = 0.35;
  const maxBin = CHROMA_FFT_SIZE / 2;
  for (let b = 1; b <= maxBin; b += 1) {
    const f = (b * CHROMA_SR) / CHROMA_FFT_SIZE;
    if (f < 65.0 || f > 2093.0) continue;
    const midi = 12.0 * Math.log2(f / 440.0) + 69.0;
    const m0 = Math.floor(midi);
    const m1 = m0 + 1;
    const d0 = (midi - m0) / sigma;
    const d1 = (midi - m1) / sigma;
    const rawW0 = Math.exp(-0.5 * d0 * d0);
    const rawW1 = Math.exp(-0.5 * d1 * d1);
    const wSum = rawW0 + rawW1 + 1e-12;
    const pc0 = ((m0 % 12) + 12) % 12;
    const pc1 = ((m1 % 12) + 12) % 12;
    entries.push({
      bin: b,
      pc0,
      w0: rawW0 / wSum,
      pc1,
      w1: rawW1 / wSum,
    });
  }
  return entries;
})();

// Precomputed bit-reversal and stage twiddle tables for 4096-point in-place radix-2 FFT
const BIT_REV_4096 = (() => {
  const rev = new Uint16Array(CHROMA_FFT_SIZE);
  const bits = 12; // log2(4096)
  for (let i = 0; i < CHROMA_FFT_SIZE; i += 1) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return rev;
})();

const TWIDDLE_TABLES = (() => {
  const tables: Array<{ cos: Float32Array; sin: Float32Array }> = [];
  for (let half = 1; half < CHROMA_FFT_SIZE; half <<= 1) {
    const cos = new Float32Array(half);
    const sin = new Float32Array(half);
    const angleStep = -Math.PI / half;
    for (let j = 0; j < half; j += 1) {
      const ang = j * angleStep;
      cos[j] = Math.cos(ang);
      sin[j] = Math.sin(ang);
    }
    tables.push({ cos, sin });
  }
  return tables;
})();

const WORK_RE = new Float32Array(CHROMA_FFT_SIZE);
const WORK_IM = new Float32Array(CHROMA_FFT_SIZE);

/**
 * Iterative in-place radix-2 Cooley-Tukey FFT (N = 4096).
 */
export function fft4096(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < CHROMA_FFT_SIZE; i += 1) {
    const j = BIT_REV_4096[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  let stageIdx = 0;
  for (let size = 2; size <= CHROMA_FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const { cos, sin } = TWIDDLE_TABLES[stageIdx++];
    for (let start = 0; start < CHROMA_FFT_SIZE; start += size) {
      for (let j = 0; j < half; j += 1) {
        const i1 = start + j;
        const i2 = i1 + half;
        const c = cos[j];
        const s = sin[j];
        const tr = re[i2] * c - im[i2] * s;
        const ti = re[i2] * s + im[i2] * c;
        re[i2] = re[i1] - tr;
        im[i2] = im[i1] - ti;
        re[i1] += tr;
        im[i1] += ti;
      }
    }
  }
}

/**
 * Computes raw 12-bin magnitude chroma + total energy for a single 4096-sample 16 kHz frame.
 */
export function computeRawChromaFrame(pcm4096: Float32Array): {
  raw: Float32Array;
  energy: number;
} {
  const len = Math.min(pcm4096.length, CHROMA_FFT_SIZE);
  for (let i = 0; i < len; i += 1) {
    WORK_RE[i] = pcm4096[i] * HANN_WINDOW[i];
    WORK_IM[i] = 0;
  }
  for (let i = len; i < CHROMA_FFT_SIZE; i += 1) {
    WORK_RE[i] = 0;
    WORK_IM[i] = 0;
  }

  fft4096(WORK_RE, WORK_IM);

  const raw = new Float32Array(CHROMA_BINS);
  for (let k = 0; k < SOFT_PROJ.length; k += 1) {
    const e = SOFT_PROJ[k];
    const mag = Math.hypot(WORK_RE[e.bin], WORK_IM[e.bin]);
    raw[e.pc0] += mag * e.w0;
    raw[e.pc1] += mag * e.w1;
  }

  let energy = 0;
  for (let p = 0; p < CHROMA_BINS; p += 1) {
    energy += raw[p];
  }
  return { raw, energy };
}

function percentile90(values: Float32Array, count: number): number {
  if (count <= 0) return 0;
  const copy = new Float32Array(count);
  copy.set(values.subarray(0, count));
  copy.sort();
  const idx = Math.min(count - 1, Math.floor(0.9 * (count - 1)));
  return copy[idx];
}

/**
 * Normalizes a sequence of raw 12-bin chroma frames using gain-invariant log compression,
 * 3-frame temporal smoothing, zero-mean L2-normalization, and silence gating.
 */
export function normalizeChromaSequence(
  rawFrames: Float32Array,
  energies: Float32Array,
  frameCount: number,
  silThresh: number,
  outNormed?: Float32Array,
  outActive?: Uint8Array
): { frames: Float32Array; active: Uint8Array } {
  const frames = outNormed ?? new Float32Array(frameCount * CHROMA_BINS);
  const active = outActive ?? new Uint8Array(frameCount);
  if (frameCount <= 0) return { frames, active };

  const logged = new Float32Array(frameCount * CHROMA_BINS);
  for (let i = 0; i < frameCount; i += 1) {
    const base = i * CHROMA_BINS;
    let sum = 0;
    for (let p = 0; p < CHROMA_BINS; p += 1) {
      sum += rawFrames[base + p];
    }
    const mean = Math.max(sum / CHROMA_BINS, 1e-12);
    for (let p = 0; p < CHROMA_BINS; p += 1) {
      logged[base + p] = Math.log1p(5.0 * (rawFrames[base + p] / mean));
    }
    active[i] = energies[i] >= silThresh ? 1 : 0;
  }

  for (let i = 0; i < frameCount; i += 1) {
    const outBase = i * CHROMA_BINS;
    if (!active[i]) {
      for (let p = 0; p < CHROMA_BINS; p += 1) {
        frames[outBase + p] = 0;
      }
      continue;
    }

    const prevBase = Math.max(0, i - 1) * CHROMA_BINS;
    const currBase = i * CHROMA_BINS;
    const nextBase = Math.min(frameCount - 1, i + 1) * CHROMA_BINS;

    let smMean = 0;
    for (let p = 0; p < CHROMA_BINS; p += 1) {
      const val = (logged[prevBase + p] + logged[currBase + p] + logged[nextBase + p]) / 3.0;
      frames[outBase + p] = val;
      smMean += val;
    }
    smMean /= CHROMA_BINS;

    let normSq = 0;
    for (let p = 0; p < CHROMA_BINS; p += 1) {
      const c = frames[outBase + p] - smMean;
      frames[outBase + p] = c;
      normSq += c * c;
    }
    const norm = Math.sqrt(normSq);
    if (norm > 1e-8) {
      const inv = 1.0 / norm;
      for (let p = 0; p < CHROMA_BINS; p += 1) {
        frames[outBase + p] *= inv;
      }
    } else {
      for (let p = 0; p < CHROMA_BINS; p += 1) {
        frames[outBase + p] = 0;
      }
      active[i] = 0;
    }
  }

  return { frames, active };
}

/**
 * Extracts normalized 4 Hz 12-bin Chroma frames from 16 kHz mono PCM, optionally
 * aligning the timeline by `alignOffsetSec` (t_orig = t_source + alignOffsetSec).
 */
export function extractChromaFromPcm16k(
  pcm: Float32Array,
  alignOffsetSec = 0
): { frames: Float32Array; frameCount: number; subOffsetSec: number } {
  const numFramesRaw =
    pcm.length >= CHROMA_FFT_SIZE
      ? Math.floor((pcm.length - CHROMA_FFT_SIZE) / CHROMA_HOP) + 1
      : 0;
  if (numFramesRaw <= 0) {
    return { frames: new Float32Array(0), frameCount: 0, subOffsetSec: 0 };
  }

  const rawSeq = new Float32Array(numFramesRaw * CHROMA_BINS);
  const energies = new Float32Array(numFramesRaw);
  for (let i = 0; i < numFramesRaw; i += 1) {
    const start = i * CHROMA_HOP;
    const { raw, energy } = computeRawChromaFrame(
      pcm.subarray(start, start + CHROMA_FFT_SIZE)
    );
    rawSeq.set(raw, i * CHROMA_BINS);
    energies[i] = energy;
  }

  const p90 = percentile90(energies, numFramesRaw);
  const silThresh = Math.max(1e-12, 0.01 * p90);
  const { frames: normRaw } = normalizeChromaSequence(
    rawSeq,
    energies,
    numFramesRaw,
    silThresh
  );

  const safeOffset = Number.isFinite(alignOffsetSec) ? alignOffsetSec : 0;
  const shiftFrames = Math.round(safeOffset * CHROMA_FPS);
  const subOffsetSec = Number((safeOffset - shiftFrames / CHROMA_FPS).toFixed(4));

  if (shiftFrames === 0) {
    return { frames: normRaw, frameCount: numFramesRaw, subOffsetSec };
  }

  if (shiftFrames > 0) {
    const outCount = numFramesRaw + shiftFrames;
    const out = new Float32Array(outCount * CHROMA_BINS);
    out.set(normRaw, shiftFrames * CHROMA_BINS);
    return { frames: out, frameCount: outCount, subOffsetSec };
  }

  const drop = Math.min(numFramesRaw, -shiftFrames);
  const outCount = Math.max(0, numFramesRaw - drop);
  const out = new Float32Array(outCount * CHROMA_BINS);
  if (outCount > 0) {
    out.set(normRaw.subarray(drop * CHROMA_BINS));
  }
  return { frames: out, frameCount: outCount, subOffsetSec };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Quantizes L2-normalized [-1, 1] frames into uint8 (`0 -> 128`) and encodes as Base64.
 */
export function encodeChromaToBase64(frames: Float32Array, frameCount: number): string {
  const total = frameCount * CHROMA_BINS;
  const u8 = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const q = Math.round(frames[i] * 127 + 128);
    u8[i] = q < 0 ? 0 : q > 255 ? 255 : q;
  }
  return bytesToBase64(u8);
}

/**
 * Decodes Base64 uint8 Chroma back into Float32Array and re-normalizes active frames.
 */
export function decodeChromaFromBase64(b64: string, frameCount: number): Float32Array {
  const bytes = base64ToBytes(b64);
  const count = Math.min(frameCount, Math.floor(bytes.length / CHROMA_BINS));
  const out = new Float32Array(count * CHROMA_BINS);
  for (let i = 0; i < count; i += 1) {
    const base = i * CHROMA_BINS;
    let normSq = 0;
    for (let p = 0; p < CHROMA_BINS; p += 1) {
      const v = (bytes[base + p] - 128) / 127.0;
      out[base + p] = v;
      normSq += v * v;
    }
    if (normSq > 1e-4) {
      const inv = 1.0 / Math.sqrt(normSq);
      for (let p = 0; p < CHROMA_BINS; p += 1) {
        out[base + p] *= inv;
      }
    } else {
      for (let p = 0; p < CHROMA_BINS; p += 1) {
        out[base + p] = 0;
      }
    }
  }
  return out;
}

export function signedSemitoneShift(shiftMod12: number): number {
  const m = ((shiftMod12 % 12) + 12) % 12;
  return m > 6 ? m - 12 : m;
}

export interface ChromaTrackerUpdate {
  locked: boolean;
  justLocked: boolean;
  elapsedSec: number;
  confidence: number;
  peakVote: number;
  top1ToTop2Ratio: number;
  detectedKeyShift: number;
  predictedOrigTimeSec: number;
  lockWallMs: number;
  activeFrac: number;
}

/**
 * Streaming multi-hypothesis 2D offset-vote tracker matching incoming 4 Hz mic Chroma
 * against a reference fingerprint across all 12 circular pitch-class shifts.
 */
export class ChromaSyncTracker {
  private readonly refFrames: Float32Array;
  private readonly refFrameCount: number;
  private readonly fps: number;
  private readonly offsetSec: number;
  private readonly winFrames = 32; // 8.0s at 4 Hz
  private readonly stepFrames = 8; // scan every 2.0s
  private readonly maxRawFrames: number;

  private rawSeq: Float32Array;
  private energies: Float32Array;
  private frameCount = 0;
  private lastScanAtFrame = 0;
  private firstFrameMs: number | null = null;
  private lastFrameMs = 0;

  private readonly lagPad: number;
  private readonly nLags: number;
  private votes: Float32Array;
  private votesRead: Float32Array;
  private scoresAll: Float32Array = new Float32Array(0);
  private zMap: Float32Array = new Float32Array(0);

  private locked = false;
  private lockWallMs = 0;
  private lockedBestLag = 0;
  private lockedKeyShift = 0;
  private lastConfidence = 0;
  private lastPeakVote = 0;
  private lastTopRatio = 0;
  private lastActiveFrac = 0;

  constructor(opts: {
    refFrames: Float32Array;
    frameCount: number;
    fps?: number;
    offsetSec?: number;
    maxSessionFrames?: number;
  }) {
    this.refFrames = opts.refFrames;
    this.refFrameCount = opts.frameCount;
    this.fps = opts.fps && opts.fps > 0 ? opts.fps : CHROMA_FPS;
    this.offsetSec = Number.isFinite(opts.offsetSec) ? (opts.offsetSec as number) : 0;
    this.maxRawFrames = opts.maxSessionFrames ?? 2400; // up to 10 minutes at 4 Hz

    this.rawSeq = new Float32Array(this.maxRawFrames * CHROMA_BINS);
    this.energies = new Float32Array(this.maxRawFrames);
    this.lagPad = this.maxRawFrames + 16;
    this.nLags = this.lagPad + this.refFrameCount + 16;
    this.votes = new Float32Array(12 * this.nLags);
    this.votesRead = new Float32Array(12 * this.nLags);

    const m = Math.max(1, this.refFrameCount - this.winFrames + 1);
    this.scoresAll = new Float32Array(12 * m);
    this.zMap = new Float32Array(12 * m);
  }

  reset(): void {
    this.frameCount = 0;
    this.lastScanAtFrame = 0;
    this.firstFrameMs = null;
    this.lastFrameMs = 0;
    this.votes.fill(0);
    this.votesRead.fill(0);
    this.locked = false;
    this.lockWallMs = 0;
    this.lockedBestLag = 0;
    this.lockedKeyShift = 0;
    this.lastConfidence = 0;
    this.lastPeakVote = 0;
    this.lastTopRatio = 0;
    this.lastActiveFrac = 0;
  }

  pushRawFrame(raw12: Float32Array, energy: number, nowMs: number): ChromaTrackerUpdate {
    if (this.firstFrameMs === null) {
      this.firstFrameMs = nowMs;
    }
    this.lastFrameMs = nowMs;

    if (this.frameCount < this.maxRawFrames) {
      this.rawSeq.set(raw12, this.frameCount * CHROMA_BINS);
      this.energies[this.frameCount] = energy;
      this.frameCount += 1;
    }

    const elapsedSec = Math.max(0, (nowMs - this.firstFrameMs) / 1000);

    if (this.locked) {
      return {
        locked: true,
        justLocked: false,
        elapsedSec,
        confidence: this.lastConfidence,
        peakVote: this.lastPeakVote,
        top1ToTop2Ratio: this.lastTopRatio,
        detectedKeyShift: this.lockedKeyShift,
        predictedOrigTimeSec:
          (this.frameCount + this.lockedBestLag) / this.fps +
          this.offsetSec +
          Math.max(0, (nowMs - this.lockWallMs) / 1000),
        lockWallMs: this.lockWallMs,
        activeFrac: this.lastActiveFrac,
      };
    }

    const canScan =
      this.frameCount >= this.winFrames &&
      this.refFrameCount >= this.winFrames &&
      (this.lastScanAtFrame === 0 ||
        this.frameCount - this.lastScanAtFrame >= this.stepFrames);

    if (!canScan) {
      return {
        locked: false,
        justLocked: false,
        elapsedSec,
        confidence: this.lastConfidence,
        peakVote: this.lastPeakVote,
        top1ToTop2Ratio: this.lastTopRatio,
        detectedKeyShift: this.lockedKeyShift,
        predictedOrigTimeSec: 0,
        lockWallMs: 0,
        activeFrac: this.lastActiveFrac,
      };
    }

    this.lastScanAtFrame = this.frameCount;
    return this.runVoteStep(elapsedSec, nowMs);
  }

  private runVoteStep(elapsedSec: number, nowMs: number): ChromaTrackerUpdate {
    const p90 = percentile90(this.energies, this.frameCount);
    const silThresh = Math.max(1e-6, 0.015 * p90);
    const { frames: normSeq, active } = normalizeChromaSequence(
      this.rawSeq,
      this.energies,
      this.frameCount,
      silThresh
    );

    const kStart = this.frameCount - this.winFrames;
    let activeCount = 0;
    for (let u = 0; u < this.winFrames; u += 1) {
      if (active[kStart + u]) activeCount += 1;
    }
    const activeFrac = activeCount / this.winFrames;
    this.lastActiveFrac = activeFrac;

    const m = this.refFrameCount - this.winFrames + 1;
    if (activeFrac >= 0.5 && m > 0) {
      // Pearson similarity map (12 x m)
      const qSlice = normSeq.subarray(
        kStart * CHROMA_BINS,
        (kStart + this.winFrames) * CHROMA_BINS
      );
      const invW = 1.0 / this.winFrames;
      const totalCells = 12 * m;

      let sumScore = 0;
      for (let s = 0; s < 12; s += 1) {
        const sRowBase = s * m;
        for (let i = 0; i < m; i += 1) {
          let acc = 0;
          for (let u = 0; u < this.winFrames; u += 1) {
            const refBase = (i + u) * CHROMA_BINS;
            const qBase = u * CHROMA_BINS;
            for (let p = 0; p < CHROMA_BINS; p += 1) {
              acc += this.refFrames[refBase + p] * qSlice[qBase + ((p + s) % CHROMA_BINS)];
            }
          }
          const score = acc * invW;
          this.scoresAll[sRowBase + i] = score;
          sumScore += score;
        }
      }

      const mean = sumScore / totalCells;
      let varSum = 0;
      for (let idx = 0; idx < totalCells; idx += 1) {
        const d = this.scoresAll[idx] - mean;
        varSum += d * d;
      }
      const std = Math.sqrt(varSum / totalCells) + 1e-8;

      // Decay old votes
      for (let idx = 0; idx < this.votes.length; idx += 1) {
        this.votes[idx] *= 0.82;
      }

      // Accumulate z >= 2.0 evidence into lag = i - kStart
      const lagStart = this.lagPad - kStart;
      for (let s = 0; s < 12; s += 1) {
        const sRowBase = s * m;
        const vRowBase = s * this.nLags;
        for (let i = 0; i < m; i += 1) {
          const z = (this.scoresAll[sRowBase + i] - mean) / std;
          this.zMap[sRowBase + i] = z;
          if (z > 2.0) {
            const d = z - 2.0;
            const ev = d * Math.sqrt(d);
            const li = lagStart + i;
            if (li >= 0 && li < this.nLags) {
              this.votes[vRowBase + li] += ev;
            }
          }
        }
      }
    }

    // Read-only +-1 frame smoothing [0.25, 0.50, 0.25] along lag
    this.votesRead.set(this.votes);
    if (this.nLags >= 3) {
      for (let s = 0; s < 12; s += 1) {
        const rowBase = s * this.nLags;
        for (let li = 1; li < this.nLags - 1; li += 1) {
          this.votesRead[rowBase + li] =
            0.25 * this.votes[rowBase + li - 1] +
            0.5 * this.votes[rowBase + li] +
            0.25 * this.votes[rowBase + li + 1];
        }
      }
    }

    let bestS = 0;
    let bestLagIdx = this.lagPad;
    let bestVal = -1;
    for (let s = 0; s < 12; s += 1) {
      const rowBase = s * this.nLags;
      for (let li = 0; li < this.nLags; li += 1) {
        const val = this.votesRead[rowBase + li];
        if (val > bestVal) {
          bestVal = val;
          bestS = s;
          bestLagIdx = li;
        }
      }
    }

    // Second-best non-adjacent hypothesis (|lag - bestLag| > 8 frames OR shift !== bestS)
    let secondVal = 0;
    for (let s = 0; s < 12; s += 1) {
      const rowBase = s * this.nLags;
      for (let li = 0; li < this.nLags; li += 1) {
        if (s === bestS && Math.abs(li - bestLagIdx) <= 8) continue;
        const val = this.votesRead[rowBase + li];
        if (val > secondVal) {
          secondVal = val;
        }
      }
    }

    const ratio = bestVal / Math.max(secondVal, 1e-6);
    const bestLag = bestLagIdx - this.lagPad;
    const confidence = Math.max(0, Math.min(1, bestVal / 8.0));
    const keyShift = signedSemitoneShift(bestS);
    const predictedOrigTimeSec = (this.frameCount + bestLag) / this.fps + this.offsetSec;

    this.lastPeakVote = bestVal;
    this.lastTopRatio = ratio;
    this.lastConfidence = confidence;
    this.lockedKeyShift = keyShift;
    this.lockedBestLag = bestLag;

    const shouldLock =
      (elapsedSec >= 6.0 && bestVal >= 5.0 && ratio >= 1.25) ||
      (elapsedSec >= 14.0 && bestVal >= 3.2 && ratio >= 1.12) ||
      (elapsedSec >= 24.0 && bestVal >= 3.0);

    if (shouldLock) {
      this.locked = true;
      this.lockWallMs = nowMs;
    }

    return {
      locked: this.locked,
      justLocked: shouldLock,
      elapsedSec,
      confidence,
      peakVote: bestVal,
      top1ToTop2Ratio: ratio,
      detectedKeyShift: keyShift,
      predictedOrigTimeSec,
      lockWallMs: this.lockWallMs,
      activeFrac,
    };
  }
}
