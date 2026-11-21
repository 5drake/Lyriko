import argparse
import json
import math
import os
import sys

import numpy as np
import scipy.io.wavfile as wavfile
import scipy.signal as signal


TARGET_SR = 16000
MAX_ANALYZE_SECONDS = 240.0
FLUX_HOP = 160  # 10ms at 16kHz -> 100 Hz frame rate
FLUX_FPS = TARGET_SR / FLUX_HOP  # 100.0
BANDS_HZ = [
    (60.0, 200.0),
    (200.0, 600.0),
    (600.0, 2200.0),
    (2200.0, 6000.0),
]


def read_wav_mono_16k(path: str) -> np.ndarray:
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        wav = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        wav = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        wav = (data.astype(np.float32) - 128.0) / 128.0
    else:
        wav = data.astype(np.float32)

    if wav.ndim > 1:
        wav = wav.mean(axis=1).astype(np.float32)

    max_in_samples = int(MAX_ANALYZE_SECONDS * sr)
    if len(wav) > max_in_samples:
        wav = wav[:max_in_samples]

    if sr != TARGET_SR and len(wav) > 0:
        g = math.gcd(int(sr), TARGET_SR)
        wav = signal.resample_poly(wav, TARGET_SR // g, int(sr) // g).astype(np.float32)

    max_target_samples = int(MAX_ANALYZE_SECONDS * TARGET_SR)
    if len(wav) > max_target_samples:
        wav = wav[:max_target_samples]

    return wav


def parabolic_delta(y_prev: float, y_curr: float, y_next: float) -> float:
    denom = 2.0 * (y_prev - 2.0 * y_curr + y_next)
    if abs(denom) < 1e-12:
        return 0.0
    delta = (y_prev - y_next) / denom
    return float(np.clip(delta, -0.5, 0.5))


def compute_multiband_flux(wav: np.ndarray) -> list[np.ndarray]:
    freqs, _, zxx = signal.stft(
        wav,
        fs=TARGET_SR,
        window="hann",
        nperseg=512,
        noverlap=512 - FLUX_HOP,
        boundary=None,
        padded=False,
    )
    mag = np.abs(zxx)
    band_fluxes: list[np.ndarray] = []

    for f_lo, f_hi in BANDS_HZ:
        mask = (freqs >= f_lo) & (freqs <= f_hi)
        if not np.any(mask):
            band_fluxes.append(np.zeros(max(1, mag.shape[1] - 1), dtype=np.float32))
            continue
        band_sum = mag[mask, :].sum(axis=0)
        log_energy = np.log1p(10.0 * band_sum)
        diff = np.maximum(0.0, np.diff(log_energy)).astype(np.float32)
        if diff.size > 0:
            mean = float(diff.mean())
            std = float(diff.std()) + 1e-8
            diff = (diff - mean) / std
        band_fluxes.append(diff)

    return band_fluxes


def stage1_coarse_sync(orig: np.ndarray, mr: np.ndarray, max_lag_sec: float) -> tuple[float, float]:
    orig_bands = compute_multiband_flux(orig)
    mr_bands = compute_multiband_flux(mr)

    len1 = orig_bands[0].shape[0]
    len2 = mr_bands[0].shape[0]
    if len1 < 120 or len2 < 120:
        return 0.0, 0.0

    max_lag_frames = min(int(round(max_lag_sec * FLUX_FPS)), int(min(len1, len2) * 0.55))
    if max_lag_frames < 5:
        return 0.0, 0.0

    n_fft = 1 << int(len1 + len2 - 1).bit_length()
    lags = np.arange(-max_lag_frames, max_lag_frames + 1, dtype=np.int64)
    fft_indices = np.where(lags >= 0, lags, n_fft + lags)
    overlap = np.minimum(len1, len2 + lags) - np.maximum(0, lags)
    valid_overlap = np.maximum(overlap.astype(np.float64), 100.0)

    score_sum = np.zeros(lags.shape[0], dtype=np.float64)
    for o_band, m_band in zip(orig_bands, mr_bands):
        c = np.fft.irfft(
            np.fft.rfft(o_band.astype(np.float64), n=n_fft)
            * np.conj(np.fft.rfft(m_band.astype(np.float64), n=n_fft)),
            n=n_fft,
        )
        score_sum += c[fft_indices] / valid_overlap

    peak_idx = int(np.argmax(score_sum))
    peak_val = float(score_sum[peak_idx])
    delta = 0.0
    if 0 < peak_idx < len(score_sum) - 1:
        delta = parabolic_delta(
            float(score_sum[peak_idx - 1]),
            peak_val,
            float(score_sum[peak_idx + 1]),
        )

    lag_coarse_sec = float(lags[peak_idx] + delta) / FLUX_FPS

    bg_mask = np.abs(np.arange(len(score_sum)) - peak_idx) > 50
    bg_vals = score_sum[bg_mask]
    if bg_vals.size >= 10:
        med = float(np.median(bg_vals))
        std = float(np.std(bg_vals)) + 1e-9
        coarse_z = (peak_val - med) / std
    else:
        coarse_z = 0.0

    return lag_coarse_sec, float(coarse_z)


def stage2_fine_gcc_phat(
    orig: np.ndarray, mr: np.ndarray, lag_coarse_sec: float
) -> tuple[float, float, bool]:
    if len(orig) < TARGET_SR * 2 or len(mr) < TARGET_SR * 2:
        return 0.0, 0.0, False

    sos = signal.butter(4, [70.0, 4500.0], btype="bandpass", fs=TARGET_SR, output="sos")
    orig_bp = signal.sosfiltfilt(sos, orig).astype(np.float32)
    mr_bp = signal.sosfiltfilt(sos, mr).astype(np.float32)

    shift0 = int(round(lag_coarse_sec * TARGET_SR))
    ov_start = max(0, shift0)
    ov_end = min(len(orig_bp), len(mr_bp) + shift0)
    ov_len = ov_end - ov_start
    if ov_len < TARGET_SR * 2:
        return 0.0, 0.0, False

    o_ov = orig_bp[ov_start:ov_end]
    m_ov = mr_bp[(ov_start - shift0) : (ov_end - shift0)]

    slice_len = int(60 * TARGET_SR)
    if ov_len > slice_len:
        step = TARGET_SR  # 1s sliding search
        csum = np.concatenate([[0.0], np.cumsum(m_ov.astype(np.float64) ** 2)])
        starts = np.arange(0, ov_len - slice_len + 1, step, dtype=np.int64)
        energies = csum[starts + slice_len] - csum[starts]
        best_start = int(starts[int(np.argmax(energies))])
        o_sl = o_ov[best_start : best_start + slice_len]
        m_sl = m_ov[best_start : best_start + slice_len]
    else:
        o_sl = o_ov
        m_sl = m_ov

    # Remove DC offset & check non-silent
    o_sl = o_sl - float(o_sl.mean())
    m_sl = m_sl - float(m_sl.mean())
    if float(o_sl.std()) < 1e-5 or float(m_sl.std()) < 1e-5:
        return 0.0, 0.0, False

    l_sig = len(o_sl)
    n_fft = 1 << int(2 * l_sig - 1).bit_length()
    prod = np.fft.rfft(o_sl.astype(np.float64), n=n_fft) * np.conj(
        np.fft.rfft(m_sl.astype(np.float64), n=n_fft)
    )
    gcc = np.fft.irfft(prod / (np.abs(prod) + 1e-8), n=n_fft)

    half_win = int(round(0.20 * TARGET_SR))  # +-3200 samples = +-0.20s
    d_samp = np.arange(-half_win, half_win + 1, dtype=np.int64)
    g_idx = np.where(d_samp >= 0, d_samp, n_fft + d_samp)
    g_vals = np.abs(gcc[g_idx])

    peak_idx = int(np.argmax(g_vals))
    peak_val = float(g_vals[peak_idx])
    delta = 0.0
    if 0 < peak_idx < len(g_vals) - 1:
        delta = parabolic_delta(
            float(g_vals[peak_idx - 1]),
            peak_val,
            float(g_vals[peak_idx + 1]),
        )

    bg_mask = np.abs(np.arange(len(g_vals)) - peak_idx) > 80
    bg_vals = g_vals[bg_mask]
    if bg_vals.size >= 20:
        mean_bg = float(np.mean(bg_vals))
        std_bg = float(np.std(bg_vals)) + 1e-9
        fine_z = (peak_val - mean_bg) / std_bg
    else:
        fine_z = 0.0

    fine_delta_sec = float(d_samp[peak_idx] + delta) / float(TARGET_SR)
    return fine_delta_sec, float(fine_z), fine_z >= 7.5


def analyze_sync(orig_path: str, mr_path: str, max_lag_sec: float) -> dict:
    orig = read_wav_mono_16k(orig_path)
    mr = read_wav_mono_16k(mr_path)

    lag_coarse_sec, coarse_z = stage1_coarse_sync(orig, mr, max_lag_sec)
    fine_delta_sec, fine_z, used_fine = stage2_fine_gcc_phat(orig, mr, lag_coarse_sec)

    if used_fine:
        offset_sec = lag_coarse_sec + fine_delta_sec
        method = "gcc-phat"
        confidence = int(
            round(min(100.0, max(60.0, 68.0 + min(32.0, (fine_z - 7.5) * 1.35))))
        )
    else:
        offset_sec = lag_coarse_sec
        method = "onset-flux"
        confidence = int(round(min(92.0, max(10.0, coarse_z * 9.0))))

    offset_sec = float(np.clip(offset_sec, -max_lag_sec, max_lag_sec))
    result: dict = {
        "offsetSec": round(offset_sec, 3),
        "confidence": confidence,
        "method": method,
        "coarseZ": round(coarse_z, 2),
        "fineZ": round(fine_z, 2),
    }

    if coarse_z < 4.5 and fine_z < 7.5:
        result["warning"] = (
            "원곡과 반주의 공통 구간 일치도가 낮습니다. 수동 보정이나 '원곡 겹쳐 듣기'로 확인해 주세요."
        )

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orig", required=True)
    parser.add_argument("--mr", required=True)
    parser.add_argument("--max-lag", type=float, default=45.0)
    args = parser.parse_args()

    res = analyze_sync(args.orig, args.mr, float(args.max_lag))
    print(json.dumps(res, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
