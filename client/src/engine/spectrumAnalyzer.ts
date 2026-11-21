import type { SpectrumData } from '@shared/types';

function hannWindow(n: number, N: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
}

/**
 * In-place Radix-2 Cooley-Tukey FFT on real/imag Float32Arrays of power-of-two length N.
 */
function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const idx1 = i + k;
        const idx2 = idx1 + half;
        const tr = wr * real[idx2] - wi * imag[idx2];
        const ti = wr * imag[idx2] + wi * real[idx2];
        real[idx2] = real[idx1] - tr;
        imag[idx2] = imag[idx1] - ti;
        real[idx1] += tr;
        imag[idx1] += ti;
      }
    }
  }
}

export async function analyzeAudioSpectrum(
  audioBuffer: AudioBuffer,
  fps = 60,
  bands = 64,
  onProgress?: (pct: number) => void
): Promise<SpectrumData> {
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const length = audioBuffer.length;

  // Mix down to mono
  const mono = new Float32Array(length);
  const channels = audioBuffer.numberOfChannels;
  for (let ch = 0; ch < channels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += chData[i] / channels;
    }
  }

  const N = 2048;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = hannWindow(i, N);

  // Precompute logarithmic frequency bin ranges (40Hz -> 16000Hz)
  const minFreq = 40;
  const maxFreq = Math.min(16000, sampleRate * 0.48);
  const bandBins: Array<[number, number]> = [];
  for (let b = 0; b < bands; b++) {
    const f0 = minFreq * Math.pow(maxFreq / minFreq, b / bands);
    const f1 = minFreq * Math.pow(maxFreq / minFreq, (b + 1) / bands);
    const bin0 = Math.max(1, Math.floor((f0 * N) / sampleRate));
    const bin1 = Math.min(N / 2 - 1, Math.max(bin0 + 1, Math.ceil((f1 * N) / sampleRate)));
    bandBins.push([bin0, bin1]);
  }

  const data = new Uint8Array(totalFrames * bands);
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  const smoothed = new Float32Array(bands);

  for (let frame = 0; frame < totalFrames; frame++) {
    const centerSample = Math.floor((frame / fps) * sampleRate);
    const startSample = centerSample - (N >> 1);

    for (let i = 0; i < N; i++) {
      const idx = startSample + i;
      real[i] = idx >= 0 && idx < length ? mono[idx] * win[i] : 0;
      imag[i] = 0;
    }

    fftRadix2(real, imag);

    const frameOffset = frame * bands;
    for (let b = 0; b < bands; b++) {
      const [bin0, bin1] = bandBins[b];
      let peakMag = 0;
      for (let k = bin0; k <= bin1; k++) {
        const mag = Math.hypot(real[k], imag[k]) / (N * 0.5);
        if (mag > peakMag) peakMag = mag;
      }
      const db = 20 * Math.log10(peakMag + 1e-6);
      // Map [-68dB, -8dB] -> [0, 1]
      const norm = Math.max(0, Math.min(1, (db + 68) / 60));
      const shaped = Math.pow(norm, 1.15);

      // Fast attack, smooth decay
      if (shaped > smoothed[b]) {
        smoothed[b] = smoothed[b] * 0.35 + shaped * 0.65;
      } else {
        smoothed[b] = smoothed[b] * 0.84 + shaped * 0.16;
      }
      data[frameOffset + b] = Math.round(smoothed[b] * 255);
    }

    if (frame % 360 === 0) {
      onProgress?.(Math.round((frame / totalFrames) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress?.(100);
  return { fps, bands, totalFrames, data };
}

export function sampleSpectrumAtTime(
  spectrum: SpectrumData | undefined,
  time: number,
  bands = 64
): Float32Array {
  const out = new Float32Array(bands);
  if (spectrum && spectrum.data.length > 0) {
    const frame = Math.max(
      0,
      Math.min(spectrum.totalFrames - 1, Math.floor(Math.max(0, time) * spectrum.fps))
    );
    const offset = frame * spectrum.bands;
    const count = Math.min(bands, spectrum.bands);
    for (let i = 0; i < count; i++) {
      out[i] = spectrum.data[offset + i] / 255;
    }
    return out;
  }

  // Deterministic ambient wave fallback for preview before audio upload
  for (let i = 0; i < bands; i++) {
    const n = i / bands;
    const w1 = Math.sin(time * 3.1 + n * 7.5) * 0.5 + 0.5;
    const w2 = Math.cos(time * 5.4 - n * 12.0) * 0.5 + 0.5;
    const envelope = Math.sin(n * Math.PI) * 0.6 + 0.4;
    out[i] = (0.12 + 0.35 * w1 * w2) * envelope;
  }
  return out;
}
