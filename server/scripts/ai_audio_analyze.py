import argparse
import json
import logging
import math
import os
import shutil
import sys
import tempfile

# Prepend isolated studio site-packages before importing installed libraries
_AI_SITE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ai-env", "Lib", "site-packages"))
if os.path.isdir(_AI_SITE) and _AI_SITE not in sys.path:
    sys.path.insert(0, _AI_SITE)

import numpy as np
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import torch
import torchaudio


def emit_progress(pct: int, message: str) -> None:
    print(f"PROGRESS:{pct}:{message}", flush=True)


def read_wav_stereo_44k(path: str) -> np.ndarray:
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        wav = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        wav = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        wav = (data.astype(np.float32) - 128.0) / 128.0
    else:
        wav = data.astype(np.float32)

    if wav.ndim == 1:
        wav = np.stack([wav, wav], axis=1)
    elif wav.shape[1] == 1:
        wav = np.repeat(wav, 2, axis=1)
    elif wav.shape[1] > 2:
        wav = wav[:, :2]

    wav = wav.T.copy()
    if sr != 44100:
        g = math.gcd(sr, 44100)
        wav = signal.resample_poly(wav, 44100 // g, sr // g, axis=1).astype(np.float32)
    return wav


def write_wav_stereo_44k(path: str, wav_2ch: np.ndarray) -> None:
    peak = float(np.max(np.abs(wav_2ch))) if wav_2ch.size > 0 else 0.0
    if peak > 0.98:
        wav_2ch = np.tanh(wav_2ch / max(0.98, peak) * 1.15) * 0.94
    pcm = np.clip(wav_2ch.T * 32767.0, -32767.0, 32767.0).astype(np.int16)
    wavfile.write(path, 44100, pcm)


def separate_with_bs_roformer(
    input_wav: str,
    mr_out: str,
    vocals_out: str,
    models_dir: str,
) -> tuple[np.ndarray, str, str]:
    from audio_separator.separator import Separator

    device = "cuda" if torch.cuda.is_available() else "cpu"
    sep_models_dir = os.path.join(models_dir, "audio-separator")
    os.makedirs(sep_models_dir, exist_ok=True)
    tmp_out_dir = tempfile.mkdtemp(prefix="utakana_bsr_")

    try:
        emit_progress(12, f"BS-Roformer 고음질 보컬 분리 모델 준비 중 ({device.upper()})...")
        sep = Separator(
            log_level=logging.WARNING,
            model_file_dir=sep_models_dir,
            output_dir=tmp_out_dir,
            output_format="WAV",
            normalization_threshold=0.95,
            use_autocast=(device == "cuda"),
        )
        sep.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")

        emit_progress(32, f"BS-Roformer AI 보컬·반주 분리 실행 중 ({device.upper()})...")
        outputs = sep.separate(input_wav)
        emit_progress(72, "분리된 보컬 및 고음질 MR 트랙 정리 중...")

        resolved_outputs = [
            p if os.path.isabs(p) else os.path.join(tmp_out_dir, p)
            for p in outputs
        ]

        vocal_path = None
        inst_path = None
        for p in resolved_outputs:
            low = os.path.basename(p).lower()
            if "(vocals)" in low or "vocal" in low:
                vocal_path = p
            elif "(instrumental)" in low or "inst" in low or "no_vocals" in low:
                inst_path = p

        if not vocal_path or not inst_path:
            if len(resolved_outputs) >= 2:
                inst_path = inst_path or resolved_outputs[0]
                vocal_path = vocal_path or resolved_outputs[1]
            else:
                raise RuntimeError(f"BS-Roformer 출력 파일을 찾을 수 없습니다: {resolved_outputs}")

        shutil.copyfile(inst_path, mr_out)
        shutil.copyfile(vocal_path, vocals_out)
        vocals_wav = read_wav_stereo_44k(vocals_out)

        del sep
        if device == "cuda":
            torch.cuda.empty_cache()

        return vocals_wav, device, "bs-roformer"
    finally:
        shutil.rmtree(tmp_out_dir, ignore_errors=True)


def separate_with_hdemucs_fallback(
    input_wav: str,
    mr_out: str,
    vocals_out: str,
) -> tuple[np.ndarray, str, str]:
    wav_2ch = read_wav_stereo_44k(input_wav)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit_progress(15, f"보조 AI 분리 모델(HDemucs) 실행 중 ({device.upper()})...")

    bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
    model = bundle.get_model().to(device).eval()
    sources = list(getattr(model, "sources", ["drums", "bass", "other", "vocals"]))
    vocal_idx = sources.index("vocals") if "vocals" in sources else 3

    sr = 44100
    total_len = wav_2ch.shape[1]
    seg_len = 10 * sr
    overlap = 1 * sr
    step = seg_len - overlap

    ref = wav_2ch.mean(axis=0)
    mean = float(ref.mean())
    std = float(ref.std()) + 1e-8
    norm_wav = (wav_2ch - mean) / std

    out_acc = np.zeros((len(sources), 2, total_len), dtype=np.float32)
    weight_acc = np.zeros(total_len, dtype=np.float32)
    starts = list(range(0, max(1, total_len - overlap), step)) or [0]

    with torch.inference_mode():
        for idx, start in enumerate(starts):
            end = min(total_len, start + seg_len)
            chunk_len = end - start
            chunk = norm_wav[:, start:end]
            if chunk_len < seg_len:
                pad = np.zeros((2, seg_len - chunk_len), dtype=np.float32)
                chunk_padded = np.concatenate([chunk, pad], axis=1)
            else:
                chunk_padded = chunk

            tensor_in = torch.from_numpy(chunk_padded).unsqueeze(0).to(device)
            stems = model(tensor_in)[0].detach().cpu().numpy()[:, :, :chunk_len]

            w = np.ones(chunk_len, dtype=np.float32)
            if idx > 0:
                fade_in = min(overlap, chunk_len)
                w[:fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
            if idx < len(starts) - 1 and end < total_len:
                fade_out = min(overlap, chunk_len)
                w[-fade_out:] *= np.linspace(1.0, 0.0, fade_out, dtype=np.float32)

            out_acc[:, :, start:end] += stems * w[None, None, :]
            weight_acc[start:end] += w
            emit_progress(18 + int(((idx + 1) / len(starts)) * 54), f"보조 AI 분리 중 ({idx + 1}/{len(starts)})...")

    weight_acc = np.maximum(weight_acc, 1e-6)
    stems_full = (out_acc / weight_acc[None, None, :]) * std + mean

    vocals = stems_full[vocal_idx]
    mr = stems_full.sum(axis=0) - vocals

    write_wav_stereo_44k(mr_out, mr)
    write_wav_stereo_44k(vocals_out, vocals)

    del model
    if device == "cuda":
        torch.cuda.empty_cache()

    return vocals, device, "hdemucs"


def extract_viterbi_melody(
    stem_2ch: np.ndarray,
    sensitivity: float = 0.25,
    lyric_intervals: list[tuple[float, float]] | None = None,
) -> tuple[list[dict], dict]:
    emit_progress(78, "분리된 보컬에서 정밀 멜로디(Viterbi) 분석 중...")

    mono = stem_2ch.mean(axis=0).astype(np.float32)
    sr = 16000
    mono_16k = signal.resample_poly(mono, 160, 441).astype(np.float32)

    sos = signal.butter(2, [85.0, 3400.0], btype="bandpass", fs=sr, output="sos")
    filtered = signal.sosfiltfilt(sos, mono_16k).astype(np.float32)

    win = 1024
    half = 512
    hop = 160  # 10ms
    n_fft = 2048
    if len(filtered) < win:
        return [], {"minMidi": 0, "maxMidi": 0}

    n_frames = 1 + (len(filtered) - win) // hop
    frames = np.lib.stride_tricks.sliding_window_view(filtered, win)[::hop][:n_frames]

    rms = np.sqrt(np.mean(frames[:, :half] ** 2, axis=1) + 1e-12)
    rms_db = 20.0 * np.log10(rms + 1e-9)
    active_dbs = rms_db[rms_db > -65.0]
    p90 = float(np.percentile(active_dbs, 90)) if active_dbs.size > 0 else -40.0
    rms_floor = max(-50.0, p90 - (24.0 + (sensitivity - 0.25) * 20.0))

    a = frames[:, :half]
    b = frames
    e0 = np.sum(a * a, axis=1, keepdims=True)
    b_sq_cum = np.concatenate(
        [np.zeros((n_frames, 1), dtype=np.float32), np.cumsum(b * b, axis=1)], axis=1
    )

    tau_min = 16
    tau_max = 195
    taus = np.arange(tau_min, tau_max + 1)

    fa = np.fft.rfft(a, n=n_fft, axis=1)
    fb = np.fft.rfft(b, n=n_fft, axis=1)

    all_taus = np.arange(1, tau_max + 1)
    e_all = b_sq_cum[:, all_taus + half] - b_sq_cum[:, all_taus]
    cross_all = np.fft.irfft(np.conj(fa) * fb, n=n_fft, axis=1)[:, all_taus]
    diff_all = np.maximum(0.0, e0 + e_all - 2.0 * cross_all)
    cum_diff = np.cumsum(diff_all, axis=1) + 1e-12
    cmndf_all = diff_all * all_taus[None, :] / cum_diff
    cmndf = cmndf_all[:, (tau_min - 1) :]

    hann = np.hanning(win).astype(np.float32)
    mag = np.abs(np.fft.rfft(frames * hann[None, :], n=n_fft, axis=1))
    df = sr / n_fft
    max_bin = mag.shape[1] - 1

    midi_min = 40
    midi_max = 84
    n_pitches = midi_max - midi_min + 1
    n_states = 1 + n_pitches

    yin_thresh = min(0.55, max(0.32, 0.38 + sensitivity * 0.25))
    emit_scores = np.full((n_frames, n_states), -6.0, dtype=np.float32)
    mid_grid = np.arange(midi_min, midi_max + 1, dtype=np.float32)

    for t in range(n_frames):
        if rms_db[t] < rms_floor:
            emit_scores[t, 0] = 2.6
            continue

        row = cmndf[t]
        is_min = (row[1:-1] < row[:-2]) & (row[1:-1] <= row[2:]) & (row[1:-1] < yin_thresh)
        cand_idxs = np.where(is_min)[0] + 1

        if cand_idxs.size == 0:
            best_idx = int(np.argmin(row))
            if row[best_idx] < yin_thresh + 0.08:
                cand_idxs = np.array([best_idx])

        if cand_idxs.size == 0:
            emit_scores[t, 0] = 2.2
            continue

        frame_mag = mag[t]
        spec_peak = float(np.max(frame_mag)) + 1e-9

        best_conf = 0.0
        pitch_score = np.full(n_pitches, -5.0, dtype=np.float32)

        for idx in cand_idxs:
            tau = float(taus[idx])
            if 0 < idx < len(row) - 1:
                s0, s1, s2 = float(row[idx - 1]), float(row[idx]), float(row[idx + 1])
                denom = 2.0 * s1 - s2 - s0
                if abs(denom) > 1e-6:
                    tau += (s2 - s0) / (2.0 * denom)
            freq = sr / max(8.0, tau)
            if freq < 80.0 or freq > 1050.0:
                continue

            yin_conf = max(0.0, 1.0 - float(row[idx]) / (yin_thresh + 0.08))

            def local_mag(f_hz: float) -> float:
                b0 = int(round(f_hz * 0.96 / df))
                b1 = int(round(f_hz * 1.04 / df))
                b0 = max(1, min(max_bin, b0))
                b1 = max(b0, min(max_bin, b1))
                return float(np.max(frame_mag[b0 : b1 + 1])) / spec_peak

            h1 = local_mag(freq)
            h2 = local_mag(freq * 2.0)
            h3 = local_mag(freq * 3.0)
            salience = min(1.0, (h1 * 0.9 + h2 * 0.55 + h3 * 0.3) / 1.1)
            sub_penalty = 0.35 if (h1 < 0.06 and h2 > 0.45) else 0.0
            conf = max(0.0, yin_conf * 0.72 + salience * 0.38 - sub_penalty)

            if conf > best_conf:
                best_conf = conf

            midi_float = 69.0 + 12.0 * math.log2(freq / 440.0)
            gauss = np.exp(-0.5 * ((mid_grid - midi_float) / 0.58) ** 2) * (conf * 4.5) - (1.0 - conf) * 2.0
            pitch_score = np.maximum(pitch_score, gauss.astype(np.float32))

        emit_scores[t, 1:] = pitch_score
        emit_scores[t, 0] = 2.0 - best_conf * 3.1

    trans = np.zeros((n_states, n_states), dtype=np.float32)
    trans[0, 1:] = -3.4
    trans[1:, 0] = -2.6
    trans[0, 0] = 0.0

    for i in range(n_pitches):
        for j in range(n_pitches):
            d = abs(i - j)
            if d == 0:
                trans[i + 1, j + 1] = 0.0
            elif d <= 2:
                trans[i + 1, j + 1] = -0.35 * d
            elif d <= 7:
                trans[i + 1, j + 1] = -0.85 * d
            else:
                trans[i + 1, j + 1] = -2.1 * d

    dp = np.zeros(n_states, dtype=np.float32)
    dp[:] = emit_scores[0]
    back = np.zeros((n_frames, n_states), dtype=np.int16)

    for t in range(1, n_frames):
        scores = dp[:, None] + trans
        best_prev = np.argmax(scores, axis=0)
        back[t] = best_prev
        dp = scores[best_prev, np.arange(n_states)] + emit_scores[t]

    path = np.zeros(n_frames, dtype=np.int16)
    path[-1] = int(np.argmax(dp))
    for t in range(n_frames - 1, 0, -1):
        path[t - 1] = back[t, path[t]]

    midi_seq = np.where(path > 0, path + (midi_min - 1), -1)

    for t in range(2, n_frames - 2):
        if midi_seq[t] > 0 and midi_seq[t - 1] > 0 and midi_seq[t + 1] > 0:
            if midi_seq[t] != midi_seq[t - 1] and midi_seq[t - 1] == midi_seq[t + 1]:
                midi_seq[t] = midi_seq[t - 1]

    hop_sec = hop / sr
    raw_runs: list[list] = []
    cur_m = int(midi_seq[0])
    cur_start = 0

    for t in range(1, n_frames):
        m = int(midi_seq[t])
        if m != cur_m:
            if cur_m > 0:
                raw_runs.append([cur_start, t, cur_m])
            cur_m = m
            cur_start = t
    if cur_m > 0:
        raw_runs.append([cur_start, n_frames, cur_m])

    split_runs: list[list] = []
    for s_idx, e_idx, m in raw_runs:
        dur_frames = e_idx - s_idx
        if dur_frames < 28:
            split_runs.append([s_idx, e_idx, m])
            continue
        seg_db = rms_db[s_idx:e_idx]
        kernel = np.ones(5, dtype=np.float32) / 5.0
        smooth_db = np.convolve(seg_db, kernel, mode="same")
        cut_points = [0]
        last_cut = 0
        for k in range(12, len(smooth_db) - 12):
            if k - last_cut < 14:
                continue
            left_peak = float(np.max(smooth_db[max(0, k - 12) : k]))
            right_peak = float(np.max(smooth_db[k + 1 : min(len(smooth_db), k + 13)]))
            val = float(smooth_db[k])
            if left_peak - val >= 6.5 and right_peak - val >= 4.5 and val == float(np.min(smooth_db[k - 3 : k + 4])):
                cut_points.append(k)
                last_cut = k
        cut_points.append(dur_frames)
        for c0, c1 in zip(cut_points[:-1], cut_points[1:]):
            if c1 - c0 >= 8:
                split_runs.append([s_idx + c0, s_idx + c1, m])

    notes: list[dict] = []
    for s_idx, e_idx, m in split_runs:
        st = round(s_idx * hop_sec, 3)
        en = round(e_idx * hop_sec, 3)
        if en - st < 0.085:
            continue
        if lyric_intervals:
            overlaps = any(en >= (ls - 0.5) and st <= (le + 0.5) for ls, le in lyric_intervals)
            if not overlaps:
                continue
        if notes and notes[-1]["midi"] == m and st - notes[-1]["endTime"] < 0.05:
            notes[-1]["endTime"] = en
        else:
            notes.append({
                "id": f"pn_ai_{len(notes)}",
                "startTime": st,
                "endTime": en,
                "midi": int(m),
            })

    stats = {
        "noteCount": len(notes),
        "minMidi": min((n["midi"] for n in notes), default=0),
        "maxMidi": max((n["midi"] for n in notes), default=0),
    }
    return notes, stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--mr-out", required=True)
    parser.add_argument("--vocals-out", required=True)
    parser.add_argument("--notes-out", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--lyrics-json", default="")
    parser.add_argument("--sensitivity", type=float, default=0.25)
    args = parser.parse_args()

    emit_progress(5, "오디오 확인 중...")

    try:
        vocals_wav, device, engine = separate_with_bs_roformer(
            args.input, args.mr_out, args.vocals_out, args.models_dir
        )
    except Exception as exc:
        print(f"[BS-Roformer fallback] {exc}", file=sys.stderr, flush=True)
        vocals_wav, device, engine = separate_with_hdemucs_fallback(
            args.input, args.mr_out, args.vocals_out
        )

    duration = round(vocals_wav.shape[1] / 44100.0, 2)

    lyric_intervals = None
    if args.lyrics_json and os.path.exists(args.lyrics_json):
        try:
            with open(args.lyrics_json, "r", encoding="utf-8") as f:
                raw_iv = json.load(f)
            if isinstance(raw_iv, list) and len(raw_iv) > 0:
                lyric_intervals = [(float(x[0]), float(x[1])) for x in raw_iv]
        except Exception:
            lyric_intervals = None

    vocal_peak99 = float(np.percentile(np.abs(vocals_wav), 99)) if vocals_wav.size > 0 else 0.0
    if vocal_peak99 < 0.01:
        # Instrumental-only file: analyze input mix directly
        selected_stem = read_wav_stereo_44k(args.input)
        source_stem = "mix"
    else:
        selected_stem = vocals_wav
        source_stem = "vocals"

    notes, note_stats = extract_viterbi_melody(
        selected_stem,
        sensitivity=args.sensitivity,
        lyric_intervals=lyric_intervals,
    )

    payload = {
        "notes": notes,
        "stats": {
            "device": device,
            "engine": engine,
            "sourceStem": source_stem,
            "duration": duration,
            **note_stats,
        },
    }
    with open(args.notes_out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    emit_progress(100, f"{engine.upper()} 분리 및 {len(notes)}개 멜로디 노트 추출 완료")


if __name__ == "__main__":
    main()
