import argparse
import json
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile

# Prepend isolated studio site-packages before importing torch/audio_separator
_AI_SITE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "ai-env", "Lib", "site-packages")
)
if os.path.isdir(_AI_SITE) and _AI_SITE not in sys.path:
    sys.path.insert(0, _AI_SITE)

import numpy as np
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import torch
import torch.nn.functional as F
import torchaudio


TARGET_SR = 16000


def emit_progress(pct: int, message: str) -> None:
    print(f"PROGRESS:{pct}:{message}", flush=True)


def run_ffmpeg_decode_16k_mono(src_path: str, dst_wav: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        src_path,
        "-vn",
        "-ar",
        str(TARGET_SR),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        dst_wav,
    ]
    proc = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if proc.returncode != 0 or not os.path.exists(dst_wav):
        tail = proc.stderr.decode("utf-8", errors="ignore")[-400:]
        raise RuntimeError(f"FFmpeg 디코딩 실패: {tail}")


def ensure_vocal_stem_16k(
    audio_path: str,
    vocal_cache_path: str,
    existing_vocal_path: str,
    models_dir: str,
    device: str,
) -> None:
    if os.path.exists(vocal_cache_path) and os.path.getsize(vocal_cache_path) > 16000:
        emit_progress(30, "캐시된 보컬 트랙 로드 중...")
        return

    os.makedirs(os.path.dirname(os.path.abspath(vocal_cache_path)), exist_ok=True)
    tmp_cache = f"{vocal_cache_path}.tmp_{os.getpid()}.wav"

    if existing_vocal_path and os.path.exists(existing_vocal_path):
        emit_progress(22, "기존 분리 보컬 트랙 16kHz 변환 중...")
        run_ffmpeg_decode_16k_mono(existing_vocal_path, tmp_cache)
        os.replace(tmp_cache, vocal_cache_path)
        return

    emit_progress(12, f"싱크 정밀 분석용 보컬 목소리 추출 중 ({device.upper()})...")
    tmp_dir = tempfile.mkdtemp(prefix="utakana_align_vox_")
    try:
        from audio_separator.separator import Separator

        tmp_in_wav = os.path.join(tmp_dir, "in_44k.wav")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                audio_path,
                "-vn",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                tmp_in_wav,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

        sep_models_dir = os.path.join(models_dir, "audio-separator")
        os.makedirs(sep_models_dir, exist_ok=True)

        sep = Separator(
            log_level=logging.WARNING,
            model_file_dir=sep_models_dir,
            output_dir=tmp_dir,
            output_format="WAV",
            output_single_stem="Vocals",
            normalization_threshold=0.95,
            use_autocast=(device == "cuda"),
        )
        sep.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
        outputs = sep.separate(tmp_in_wav)
        resolved = [
            p if os.path.isabs(p) else os.path.join(tmp_dir, p) for p in outputs
        ]
        vocal_out = None
        for p in resolved:
            if "(vocals)" in os.path.basename(p).lower() or "vocal" in os.path.basename(p).lower():
                vocal_out = p
                break
        if not vocal_out and resolved:
            vocal_out = resolved[0]
        if not vocal_out or not os.path.exists(vocal_out):
            raise RuntimeError(f"보컬 분리 결과를 찾지 못했습니다: {resolved}")

        run_ffmpeg_decode_16k_mono(vocal_out, tmp_cache)
        os.replace(tmp_cache, vocal_cache_path)

        del sep
        if device == "cuda":
            torch.cuda.empty_cache()
    except Exception as exc:
        print(f"[align vocal fallback] {exc}", file=sys.stderr, flush=True)
        run_ffmpeg_decode_16k_mono(audio_path, tmp_cache)
        os.replace(tmp_cache, vocal_cache_path)
    finally:
        if os.path.exists(tmp_cache):
            try:
                os.unlink(tmp_cache)
            except OSError:
                pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


def read_wav_mono_16k(path: str) -> np.ndarray:
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        wav = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        wav = data.astype(np.float32) / 2147483648.0
    else:
        wav = data.astype(np.float32)
    if wav.ndim > 1:
        wav = wav.mean(axis=1).astype(np.float32)
    if sr != TARGET_SR and len(wav) > 0:
        g = math.gcd(int(sr), TARGET_SR)
        wav = signal.resample_poly(wav, TARGET_SR // g, int(sr) // g).astype(np.float32)
    return wav


def compute_vocal_db_envelope(wav: np.ndarray) -> tuple[np.ndarray, float]:
    if len(wav) < 600:
        return np.zeros(1, dtype=np.float32), -40.0

    sos = signal.butter(4, [120.0, 4000.0], btype="bandpass", fs=TARGET_SR, output="sos")
    filtered = signal.sosfiltfilt(sos, wav).astype(np.float32)

    hop = 160  # 10ms = 100 Hz
    win = 480  # 30ms RMS window
    if len(filtered) < win:
        filtered = np.pad(filtered, (0, win - len(filtered)))

    frames = np.lib.stride_tricks.sliding_window_view(filtered, win)[::hop]
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    vocal_db = (20.0 * np.log10(rms + 1e-9)).astype(np.float32)

    active = vocal_db[vocal_db > -60.0]
    p90 = float(np.percentile(active, 90)) if active.size > 0 else -35.0
    sing_thresh = max(-48.0, p90 - 22.0)
    return vocal_db, float(sing_thresh)


def detect_lrc_anchors_and_shift(
    lines: list[dict], vocal_db: np.ndarray, sing_thresh: float
) -> tuple[bool, float]:
    if len(lines) < 3 or float(lines[-1].get("endTime", 0.0)) <= 15.0:
        return False, 0.0

    gaps = [
        float(lines[i].get("startTime", 0.0)) - float(lines[i - 1].get("startTime", 0.0))
        for i in range(1, len(lines))
    ]
    has_lrc = float(lines[0].get("startTime", 0.0)) >= 1.5 or (
        len(gaps) > 1 and float(np.std(gaps)) > 0.35
    )
    if not has_lrc:
        return False, 0.0

    n_frames = len(vocal_db)
    active = vocal_db[vocal_db > -60.0]
    p90 = float(np.percentile(active, 90)) if active.size > 0 else -35.0
    onset_th = max(-45.0, p90 - 15.0)

    clip_db = np.clip(vocal_db, onset_th - 10.0, onset_th + 18.0)
    win_pre = 35  # 0.35s pre-onset baseline
    padded_pre = np.pad(clip_db, (win_pre, 0), mode="edge")[:-1]
    pre_min = np.lib.stride_tricks.sliding_window_view(padded_pre, win_pre).min(axis=1)
    onset_env = np.maximum(0.0, clip_db - pre_min) * (vocal_db >= onset_th)

    vocal_active = (vocal_db >= sing_thresh - 2.0).astype(np.float32)

    lrc_mask = np.zeros(n_frames, dtype=np.float32)
    lrc_span_mask = np.zeros(n_frames, dtype=np.float32)
    for line in lines:
        s_val = float(line.get("startTime", 0.0))
        e_val = max(s_val + 0.3, float(line.get("endTime", s_val + 2.0)))
        s_idx = max(0, min(n_frames - 1, int(round(s_val * 100.0))))
        e_idx = max(s_idx + 1, min(n_frames, int(round(e_val * 100.0))))
        lrc_mask[s_idx : min(n_frames, s_idx + 25)] += 1.0
        lrc_span_mask[s_idx:e_idx] = 1.0

    if float(np.max(lrc_span_mask)) <= 0.0 or float(np.max(vocal_active)) <= 0.0:
        return True, 0.0

    max_lag = min(3500, n_frames // 2)  # +-35.0s
    if max_lag < 10:
        return True, 0.0

    n_fft = 1 << int(2 * n_frames - 1).bit_length()
    lags = np.arange(-max_lag, max_lag + 1, dtype=np.int64)
    idx = np.where(lags >= 0, lags, n_fft + lags)

    va_norm = vocal_active - float(vocal_active.mean())
    sp_norm = lrc_span_mask - float(lrc_span_mask.mean())
    span_corr = np.fft.irfft(
        np.fft.rfft(va_norm.astype(np.float64), n=n_fft)
        * np.conj(np.fft.rfft(sp_norm.astype(np.float64), n=n_fft)),
        n=n_fft,
    )[idx]

    if float(np.max(lrc_mask)) > 0.0 and float(np.max(onset_env)) > 0.0:
        s_norm = onset_env - float(onset_env.mean())
        m_norm = lrc_mask - float(lrc_mask.mean())
        onset_corr = np.fft.irfft(
            np.fft.rfft(s_norm.astype(np.float64), n=n_fft)
            * np.conj(np.fft.rfft(m_norm.astype(np.float64), n=n_fft)),
            n=n_fft,
        )[idx]
    else:
        onset_corr = np.zeros_like(span_corr)

    span_z = (span_corr - float(np.mean(span_corr))) / (float(np.std(span_corr)) + 1e-9)
    onset_z = (onset_corr - float(np.mean(onset_corr))) / (float(np.std(onset_corr)) + 1e-9)
    combined = 0.65 * span_z + 0.35 * onset_z

    p = int(np.argmax(combined))
    peak = float(combined[p])
    bg = combined[np.abs(np.arange(len(combined)) - p) > 50]
    if bg.size >= 10:
        med = float(np.median(bg))
        std = float(np.std(bg)) + 1e-9
        z = (peak - med) / std
    else:
        z = 0.0

    if z >= 2.2 or peak >= 2.0:
        cand_shift = float(lags[p]) / 100.0
        global_shift = cand_shift if abs(cand_shift) >= 0.35 else 0.0
    else:
        global_shift = 0.0

    return True, global_shift


def compute_mms_fa_emissions(wav: np.ndarray, models_dir: str, device: str):
    torch.hub.set_dir(os.path.join(models_dir, "torch_hub"))
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=True).to(device).eval()
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    valid_chars = set(bundle.get_dict().keys()) - {"-", "*"}

    chunk_step = 30 * TARGET_SR  # 30s
    pad_samples = 2 * TARGET_SR  # 2s left/right context
    chunks = []
    total_len = len(wav)

    with torch.inference_mode():
        for s0 in range(0, total_len, chunk_step):
            s1 = min(total_len, s0 + chunk_step)
            c0 = max(0, s0 - pad_samples)
            c1 = min(total_len, s1 + pad_samples)

            seg_t = torch.from_numpy(wav[c0:c1]).unsqueeze(0).to(device)
            em, _ = model(seg_t)
            em = em[0]  # (T_chunk, 29)
            t_chunk = em.shape[0]
            if c1 > c0 and t_chunk > 0:
                f0 = int(round(t_chunk * (s0 - c0) / (c1 - c0)))
                f1 = int(round(t_chunk * (s1 - c0) / (c1 - c0)))
                f0 = max(0, min(t_chunk, f0))
                f1 = max(f0, min(t_chunk, f1))
                chunks.append(em[f0:f1].detach().cpu())

    full_emission = torch.cat(chunks, dim=0) if chunks else torch.zeros((1, 29))

    del model
    if device == "cuda":
        torch.cuda.empty_cache()

    return full_emission, tokenizer, aligner, valid_chars


def group_lines_into_sections(
    anchor_bounds: list[tuple[float, float]], has_lrc: bool
) -> list[list[int]]:
    n = len(anchor_bounds)
    if n == 0:
        return []
    if not has_lrc:
        return [list(range(n))]

    sections: list[list[int]] = [[0]]
    for i in range(1, n):
        cur = sections[-1]
        prev_end = anchor_bounds[cur[-1]][1]
        cur_start = anchor_bounds[i][0]
        cur_end = anchor_bounds[i][1]
        sec_start = anchor_bounds[cur[0]][0]

        if (
            cur_start - prev_end >= 2.8
            or len(cur) >= 10
            or (cur_end - sec_start) >= 35.0
        ):
            sections.append([i])
        else:
            cur.append(i)
    return sections


def distribute_line_proportionally(
    line: dict, seg_romajis: list[str], start_t: float, end_t: float
) -> list[tuple[float, float]]:
    weights = [max(1, len(r)) for r in seg_romajis]
    total_w = max(1, sum(weights))
    span = max(0.3, end_t - start_t)
    cur = start_t
    out = []
    for idx, w in enumerate(weights):
        if idx == len(weights) - 1:
            nxt = end_t
        else:
            nxt = cur + span * (w / total_w)
        out.append((cur, max(cur + 0.08, nxt)))
        cur = nxt
    return out


def vocal_db_at(vocal_db: np.ndarray, t: float) -> float:
    idx = max(0, min(len(vocal_db) - 1, int(round(t * 100.0))))
    return float(vocal_db[idx])


def _clean_align_word(raw_r: str, valid_chars: set[str]) -> str:
    clean = "".join(ch for ch in str(raw_r or "").lower() if ch in valid_chars)
    clean = clean.strip("'")
    if not any("a" <= ch <= "z" for ch in clean):
        return ""
    return clean


def run_mms_fa_window(
    full_emission: torch.Tensor,
    tokenizer,
    aligner,
    valid_chars: set[str],
    lines: list[dict],
    sec_indices: list[int],
    f_start: int,
    f_end: int,
    frame_sec: float,
) -> tuple[dict[int, list[tuple[float, float]]], int, float, bool]:
    words: list[str] = ["*"]
    word_slots: list[tuple[int, int, str]] = []
    for li in sec_indices:
        segs = lines[li].get("segments") or []
        for sj, seg in enumerate(segs):
            clean_r = _clean_align_word(seg.get("alignRomaji") or "", valid_chars)
            if clean_r:
                word_slots.append((li, sj, clean_r))
                words.append(clean_r)
        words.append("*")

    flat_tok_len = sum(len(w) for w in words)
    total_frames = int(full_emission.shape[0])
    if f_end - f_start < flat_tok_len * 2 + 4:
        f_start = max(0, f_start - int(round(2.5 / max(1e-6, frame_sec))))
        f_end = min(total_frames, f_end + int(round(2.5 / max(1e-6, frame_sec))))

    if f_end - f_start < flat_tok_len + 2 or not word_slots:
        return {}, 0, 0.0, False

    try:
        tokens = tokenizer(words)
        sub_em = full_emission[f_start:f_end].to(dtype=torch.float32)
        spans_per_word = aligner(sub_em, tokens)

        slot_ptr = 0
        matched_map: dict[int, dict[int, tuple[float, float]]] = {
            li: {} for li in sec_indices
        }
        scores: list[float] = []
        matched = 0

        for w_idx, w_text in enumerate(words):
            if w_text == "*":
                continue
            li, sj, _ = word_slots[slot_ptr]
            slot_ptr += 1
            sp = spans_per_word[w_idx]
            if sp:
                st = (f_start + sp[0].start) * frame_sec
                et = (f_start + sp[-1].end) * frame_sec
                matched_map[li][sj] = (st, max(st + 0.06, et))
                matched += 1
                for tok_span in sp:
                    sc = getattr(tok_span, "score", None)
                    if sc is not None and math.isfinite(float(sc)):
                        scores.append(float(sc))

        if matched != len(word_slots):
            return {}, 0, 0.0, False

        per_line_spans: dict[int, list[tuple[float, float]]] = {}
        w_min_t = f_start * frame_sec
        w_max_t = f_end * frame_sec
        last_line_end = w_min_t

        for pos, li in enumerate(sec_indices):
            segs = lines[li].get("segments") or []
            l_map = matched_map[li]
            spans_out: list[tuple[float, float]] = []

            if not segs:
                per_line_spans[li] = []
                continue

            if not l_map:
                # Empty / symbol-only line: anchor gently between neighboring aligned lines
                next_aligned_s = w_max_t
                for nxt_li in sec_indices[pos + 1 :]:
                    if matched_map[nxt_li]:
                        first_k = min(matched_map[nxt_li].keys())
                        next_aligned_s = matched_map[nxt_li][first_k][0]
                        break
                st = min(max(w_min_t, float(lines[li].get("startTime", last_line_end))), max(w_min_t, next_aligned_s - 0.12))
                st = max(last_line_end, st)
                et = min(next_aligned_s, st + 0.25)
                if et <= st:
                    et = st + 0.08
                step = (et - st) / len(segs)
                for j in range(len(segs)):
                    spans_out.append((st + j * step, st + (j + 1) * step))
                per_line_spans[li] = spans_out
                last_line_end = spans_out[-1][1]
                continue

            cur_prev_e: float | None = None
            for sj in range(len(segs)):
                if sj in l_map:
                    sp_s, sp_e = l_map[sj]
                    spans_out.append((sp_s, sp_e))
                    cur_prev_e = sp_e
                else:
                    next_s: float | None = None
                    for k in range(sj + 1, len(segs)):
                        if k in l_map:
                            next_s = l_map[k][0]
                            break
                    if cur_prev_e is not None:
                        st = cur_prev_e
                        et = min(next_s, st + 0.02) if (next_s is not None and next_s > st + 0.005) else st + 0.02
                        if et <= st:
                            et = st + 0.01
                        spans_out.append((st, et))
                        cur_prev_e = et
                    elif next_s is not None:
                        et = next_s
                        st = max(last_line_end, et - 0.02)
                        if st >= et:
                            st = max(0.0, et - 0.01)
                        spans_out.append((st, max(st + 0.01, et)))
                        cur_prev_e = max(st + 0.01, et)

            per_line_spans[li] = spans_out
            last_line_end = spans_out[-1][1]

        if all(len(per_line_spans[li]) == len(lines[li].get("segments") or []) for li in sec_indices):
            mean_score = float(np.mean(scores)) if scores else 0.0
            return per_line_spans, matched, mean_score, True
    except Exception as exc:
        print(f"[mms_fa window fallback] {exc}", file=sys.stderr, flush=True)

    return {}, 0, 0.0, False


def score_alignment(
    raw_seg_times: dict[int, list[tuple[float, float]]],
    lines: list[dict],
    vocal_db: np.ndarray,
    sing_thresh: float,
    mean_ctc_score: float,
) -> tuple[float, float, float]:
    n = len(lines)
    if n == 0 or not raw_seg_times:
        return 0.0, 0.0, 0.0

    vocal_hits = 0
    sane_durs = 0
    n_frames = len(vocal_db)
    for li in range(n):
        spans = raw_seg_times.get(li) or []
        if not spans:
            continue
        line_s = spans[0][0]
        line_e = spans[-1][1]
        dur = line_e - line_s
        if 0.25 <= dur <= 15.0:
            sane_durs += 1

        i0 = max(0, min(n_frames - 1, int(round(line_s * 100.0))))
        i1 = max(i0 + 1, min(n_frames, int(round(line_e * 100.0))))
        seg_db = vocal_db[i0:i1]
        if seg_db.size > 0:
            voiced_frac = float(np.mean(seg_db >= sing_thresh - 3.0))
            med_db = float(np.median(seg_db))
            if voiced_frac >= 0.35 or med_db >= sing_thresh - 3.0:
                vocal_hits += 1

    vocal_hit_ratio = vocal_hits / float(n)
    sane_dur_ratio = sane_durs / float(n)
    composite = (
        vocal_hit_ratio * 0.55
        + sane_dur_ratio * 0.30
        + min(1.0, max(0.0, mean_ctc_score)) * 0.15
    )
    return composite, vocal_hit_ratio, sane_dur_ratio


def resolve_ambiguous_readings(
    full_emission: torch.Tensor,
    tokenizer,
    aligner,
    valid_chars: set[str],
    lines: list[dict],
    raw_seg_times: dict[int, list[tuple[float, float]]],
    frame_sec: float,
) -> int:
    # Drop column 28 ('*' wildcard) so constant 0.0 log-prob does not distort F.ctc_loss
    em_real = full_emission[:, :-1].to(dtype=torch.float32)
    total_frames = int(em_real.shape[0])
    n_lines = len(lines)
    if total_frames < 4 or n_lines == 0:
        return 0

    def _ctc_nll(sub_em: torch.Tensor, words_list: list[str]) -> float:
        tok_lists = tokenizer(words_list)
        flat = [t for w in tok_lists for t in w]
        if not flat or int(sub_em.shape[0]) < len(flat) + 2:
            return float("inf")
        targets = torch.tensor(flat, dtype=torch.long)
        input_lengths = torch.tensor([int(sub_em.shape[0])], dtype=torch.long)
        target_lengths = torch.tensor([len(flat)], dtype=torch.long)
        loss = F.ctc_loss(
            sub_em.unsqueeze(1),
            targets,
            input_lengths,
            target_lengths,
            blank=0,
            reduction="none",
            zero_infinity=True,
        )
        val = float(loss.item())
        return val if math.isfinite(val) else float("inf")

    disambiguated_count = 0
    for li, line in enumerate(lines):
        segs = line.get("segments") or []
        spans = raw_seg_times.get(li)
        if not segs or not spans or len(spans) != len(segs):
            continue
        if not any(len(s.get("readingCandidates") or []) >= 2 for s in segs):
            continue

        l_start = float(spans[0][0])
        l_end = float(spans[-1][1])
        prev_end = (
            float(raw_seg_times[li - 1][-1][1])
            if li > 0 and raw_seg_times.get(li - 1)
            else 0.0
        )
        next_start = (
            float(raw_seg_times[li + 1][0][0])
            if li + 1 < n_lines and raw_seg_times.get(li + 1)
            else total_frames * frame_sec
        )
        w_s = max(0.0, max((prev_end + l_start) * 0.5, l_start - 0.14))
        w_e = min(
            total_frames * frame_sec, min((l_end + next_start) * 0.5, l_end + 0.14)
        )
        f0 = max(0, min(total_frames - 1, int(math.floor(w_s / frame_sec))))
        f1 = max(f0 + 1, min(total_frames, int(math.ceil(w_e / frame_sec))))
        sub_em = em_real[f0:f1]

        line_changed = False
        sj_to_widx: dict[int, int] = {}
        cur_words: list[str] = []
        for sj, s in enumerate(segs):
            w = _clean_align_word(s.get("alignRomaji") or "", valid_chars)
            if w:
                sj_to_widx[sj] = len(cur_words)
                cur_words.append(w)

        if not cur_words:
            continue

        for sj, seg in enumerate(segs):
            cands = seg.get("readingCandidates") or []
            if len(cands) < 2 or sj not in sj_to_widx:
                continue
            widx = sj_to_widx[sj]

            default_nll = _ctc_nll(sub_em, cur_words)
            if not math.isfinite(default_nll):
                continue

            best_cand = None
            best_r = cur_words[widx]
            best_nll = default_nll
            for cand in cands:
                cand_r = _clean_align_word(cand.get("alignRomaji") or "", valid_chars)
                if not cand_r or cand_r == cur_words[widx]:
                    continue
                trial_words = list(cur_words)
                trial_words[widx] = cand_r
                cand_nll = _ctc_nll(sub_em, trial_words)
                if cand_nll < best_nll:
                    best_nll = cand_nll
                    best_cand = cand
                    best_r = cand_r

            if best_cand is not None and best_nll <= default_nll - 3.5:
                seg["ruby"] = str(best_cand.get("ruby") or seg.get("ruby") or "")
                seg["koPron"] = str(best_cand.get("koPron") or seg.get("koPron") or "")
                seg["alignRomaji"] = str(
                    best_cand.get("alignRomaji") or seg.get("alignRomaji") or ""
                )
                cur_words[widx] = best_r
                line_changed = True
                disambiguated_count += 1

        if line_changed:
            pad_frames = int(round(0.25 / max(1e-6, frame_sec)))
            min_f = max(0, int(math.floor(prev_end / max(1e-6, frame_sec))))
            max_f = min(total_frames, int(math.ceil(next_start / max(1e-6, frame_sec))))
            re_f0 = max(min_f, f0 - pad_frames)
            re_f1 = min(max_f, f1 + pad_frames)
            if re_f1 <= re_f0:
                re_f0, re_f1 = f0, f1
            new_spans, _, _, ok = run_mms_fa_window(
                full_emission,
                tokenizer,
                aligner,
                valid_chars,
                lines,
                [li],
                re_f0,
                re_f1,
                frame_sec,
            )
            if ok and li in new_spans:
                raw_seg_times[li] = new_spans[li]

    return disambiguated_count


def repair_anomalous_clusters(
    full_emission: torch.Tensor,
    tokenizer,
    aligner,
    valid_chars: set[str],
    lines: list[dict],
    raw_seg_times: dict[int, list[tuple[float, float]]],
    vocal_db: np.ndarray,
    sing_thresh: float,
    has_lrc: bool,
    frame_sec: float,
    duration: float,
) -> int:
    n = len(lines)
    if n == 0 or not raw_seg_times:
        return 0

    total_frames = int(full_emission.shape[0])
    n_vdb = len(vocal_db)
    active_db = vocal_db[vocal_db > -60.0]
    p85_db = (
        float(np.percentile(active_db, 85))
        if active_db.size > 0
        else sing_thresh + 10.0
    )
    lead_thresh = max(sing_thresh, p85_db - 6.0)
    anchor_vocal_thresh = max(sing_thresh + 3.0, p85_db - 12.0)

    def interval_p75_db(s_t: float, e_t: float) -> float:
        if n_vdb == 0:
            return -80.0
        i0 = max(0, min(n_vdb - 1, int(math.floor(s_t * 100.0))))
        i1 = max(i0 + 1, min(n_vdb, int(math.ceil(e_t * 100.0))))
        sl = vocal_db[i0:i1]
        return float(np.percentile(sl, 75)) if sl.size > 0 else -80.0

    def pron_seg_info(li: int, spans: list[tuple[float, float]]) -> list[tuple[float, int]]:
        segs = lines[li].get("segments") or []
        out: list[tuple[float, int]] = []
        for sj, seg in enumerate(segs):
            if sj >= len(spans):
                break
            cw = _clean_align_word(seg.get("alignRomaji") or "", valid_chars)
            if cw:
                out.append((spans[sj][1] - spans[sj][0], len(cw)))
        return out

    lrc_trusted = False
    shifted_anchors: list[tuple[float, float]] = []
    if has_lrc:
        deltas = [
            raw_seg_times[i][0][0] - float(lines[i].get("startTime", 0.0))
            for i in range(n)
            if raw_seg_times.get(i)
        ]
        robust_shift = float(np.median(deltas)) if deltas else 0.0
        inliers = 0
        for i in range(n):
            a_s = max(0.0, float(lines[i].get("startTime", 0.0)) + robust_shift)
            a_e = max(
                a_s + 0.3,
                min(duration, float(lines[i].get("endTime", a_s + 2.0)) + robust_shift),
            )
            shifted_anchors.append((a_s, a_e))
            sp = raw_seg_times.get(i)
            if sp and abs(sp[0][0] - a_s) <= 2.2:
                inliers += 1
        lrc_trusted = (inliers / float(n)) >= 0.50

    anomalous: set[int] = set()
    for li in range(n):
        segs = lines[li].get("segments") or []
        spans = raw_seg_times.get(li)
        if not spans or len(spans) != len(segs):
            anomalous.add(li)
            continue

        line_s, line_e = spans[0][0], spans[-1][1]
        line_dur = line_e - line_s
        p_info = pron_seg_info(li, spans)
        total_chars = sum(c for _, c in p_info)

        # (a) Stretched pronounceable segment
        if any(d > max(3.6, 0.45 * c + 1.8) for d, c in p_info):
            anomalous.add(li)
            continue

        # (b) Stretched line
        if p_info and line_dur > max(10.5, 0.50 * total_chars + 4.5):
            anomalous.add(li)
            continue

        # (c) Bridge-collapse signature
        if (
            len(p_info) >= 4
            and max(d for d, _ in p_info) >= 2.6
            and sum(1 for d, _ in p_info if d <= 0.12) >= 4
        ):
            anomalous.add(li)
            continue

        # (d) LRC divergence guarded by vocal presence at shifted anchor
        if lrc_trusted:
            a_s, a_e = shifted_anchors[li]
            if interval_p75_db(a_s, a_e) >= anchor_vocal_thresh:
                if abs(line_s - a_s) > 2.0 or abs(line_e - a_e) > 3.0:
                    anomalous.add(li)

    if not anomalous:
        return 0

    sorted_bad = sorted(anomalous)
    raw_clusters: list[list[int]] = []
    for li in sorted_bad:
        if not raw_clusters or li > raw_clusters[-1][1] + 2:
            raw_clusters.append([li, li])
        else:
            raw_clusters[-1][1] = li

    # Expand 1 neighbor when previous line bled into anomalous start or next line encroached
    expanded: list[list[int]] = []
    for c0, c1 in raw_clusters:
        if c0 > 0:
            left_sp = raw_seg_times.get(c0 - 1) or []
            cur_sp = raw_seg_times.get(c0) or []
            left_bled_lrc = (
                lrc_trusted
                and left_sp
                and left_sp[-1][1] > shifted_anchors[c0][0] + 0.4
            )
            left_stretched_touch = (
                left_sp
                and cur_sp
                and any(e - s > 2.4 for s, e in left_sp)
                and (cur_sp[0][0] - left_sp[-1][1]) < 0.8
            )
            if left_bled_lrc or left_stretched_touch:
                c0 -= 1

        if c1 + 1 < n:
            right_sp = raw_seg_times.get(c1 + 1) or []
            cur_sp_end = (raw_seg_times.get(c1) or [(0.0, 0.0)])[-1][1]
            if (
                lrc_trusted
                and right_sp
                and right_sp[0][0] < shifted_anchors[c1][1] - 0.4
                and (right_sp[0][0] - cur_sp_end) < 0.8
            ):
                c1 += 1

        if expanded and c0 <= expanded[-1][1] + 1:
            expanded[-1][1] = max(expanded[-1][1], c1)
        else:
            expanded.append([c0, c1])

    emit_progress(77, f"싱크 이상 구간 {len(expanded)}개 정밀 보정 중...")
    repaired_lines = 0

    for c0, c1 in expanded:
        cluster_indices = list(range(c0, c1 + 1))
        prev_good_end = (
            raw_seg_times[c0 - 1][-1][1]
            if c0 > 0 and raw_seg_times.get(c0 - 1)
            else 0.0
        )
        next_good_start = (
            raw_seg_times[c1 + 1][0][0]
            if c1 + 1 < n and raw_seg_times.get(c1 + 1)
            else duration
        )

        if lrc_trusted:
            start_anchor_ok = (
                interval_p75_db(*shifted_anchors[c0]) >= anchor_vocal_thresh
            )
            end_anchor_ok = (
                interval_p75_db(*shifted_anchors[c1]) >= anchor_vocal_thresh
            )
            start_bound = (
                shifted_anchors[c0][0] - 2.0 if start_anchor_ok else prev_good_end
            )
            end_bound = (
                shifted_anchors[c1][1] + 2.5 if end_anchor_ok else next_good_start
            )
            w_start = max(0.0, max(prev_good_end - 0.10, start_bound))
            w_end = min(duration, min(next_good_start + 0.10, end_bound))
            if w_end < w_start + 1.5:
                w_start = max(0.0, prev_good_end - 0.10)
                w_end = min(duration, max(w_start + 1.5, next_good_start + 0.10))
        else:
            w_start = max(0.0, prev_good_end - 0.10)
            w_end = min(duration, next_good_start + 0.10)
            k0 = max(0, int(round(max(w_start, prev_good_end) * 100.0)))
            k1 = min(n_vdb, int(round(min(w_end, next_good_start - 0.15) * 100.0)))
            if k1 - k0 > 150:
                sub_vdb = vocal_db[k0:k1]
                kernel = np.ones(41, dtype=np.float32) / 41.0
                smooth_vdb = np.convolve(
                    np.pad(sub_vdb, (20, 20), mode="edge"), kernel, mode="valid"
                )
                chop_thresh = max(sing_thresh, p85_db - 6.0)
                idx_hit = np.where(smooth_vdb >= chop_thresh)[0]
                if idx_hit.size >= 40:
                    splits = np.where(np.diff(idx_hit) > 150)[0] + 1
                    blocks = [b for b in np.split(idx_hit, splits) if b.size >= 25]
                    if blocks:
                        trim_s = (k0 + int(blocks[0][0])) / 100.0 - 0.35
                        trim_e = (k0 + int(blocks[-1][-1])) / 100.0 + 0.35
                        if trim_e - trim_s >= 1.5:
                            w_start = max(w_start, trim_s)
                            w_end = min(w_end, trim_e)

        f_start = max(0, min(total_frames - 1, int(math.floor(w_start / frame_sec))))
        f_end = max(f_start + 1, min(total_frames, int(math.ceil(w_end / frame_sec))))

        cand_spans, _, _, cand_ok = run_mms_fa_window(
            full_emission,
            tokenizer,
            aligner,
            valid_chars,
            lines,
            cluster_indices,
            f_start,
            f_end,
            frame_sec,
        )
        if not cand_ok:
            continue

        def score_cluster(spans_by_li: dict[int, list[tuple[float, float]]]) -> float:
            total = 0.0
            for li in cluster_indices:
                sp = spans_by_li.get(li) or []
                segs = lines[li].get("segments") or []
                if not sp or len(sp) != len(segs):
                    total -= 3.0
                    continue
                ls, le = sp[0][0], sp[-1][1]
                ldur = le - ls
                p_info = pron_seg_info(li, sp)
                for d, c in p_info:
                    if d > max(3.4, 0.45 * c + 1.6):
                        total -= 1.2
                tot_c = sum(c for _, c in p_info)
                if (p_info and ldur > max(10.5, 0.50 * tot_c + 4.5)) or ldur < 0.25:
                    total -= 1.5
                if (
                    len(p_info) >= 4
                    and max(d for d, _ in p_info) >= 2.5
                    and sum(1 for d, _ in p_info if d <= 0.12) >= 4
                ):
                    total -= 1.5
                if interval_p75_db(ls, le) >= lead_thresh:
                    total += 1.0
                if lrc_trusted:
                    a_s, a_e = shifted_anchors[li]
                    if interval_p75_db(a_s, a_e) >= anchor_vocal_thresh:
                        total -= 0.40 * min(6.0, abs(ls - a_s)) + 0.20 * min(
                            6.0, abs(le - a_e)
                        )
            return total

        old_cluster = {li: raw_seg_times.get(li, []) for li in cluster_indices}
        old_score = score_cluster(old_cluster)
        cand_score = score_cluster(cand_spans)
        if cand_score > old_score + 0.15:
            for li in cluster_indices:
                if li in cand_spans:
                    raw_seg_times[li] = cand_spans[li]
            repaired_lines += len(cluster_indices)

    return repaired_lines


def align_lines(
    audio_path: str,
    vocal_cache_path: str,
    existing_vocal_path: str,
    lines: list[dict],
    models_dir: str,
) -> tuple[list[dict], dict]:
    device = "cuda" if torch.cuda.is_available() else "cpu"

    ensure_vocal_stem_16k(
        audio_path, vocal_cache_path, existing_vocal_path, models_dir, device
    )

    emit_progress(42, "보컬 성량 엔벨로프 및 기준 타이밍 분석 중...")
    wav = read_wav_mono_16k(vocal_cache_path)
    duration = len(wav) / float(TARGET_SR)
    vocal_db, sing_thresh = compute_vocal_db_envelope(wav)
    has_lrc, global_shift = detect_lrc_anchors_and_shift(lines, vocal_db, sing_thresh)

    anchor_bounds: list[tuple[float, float]] = []
    for line in lines:
        s0 = max(0.0, float(line.get("startTime", 0.0)) + global_shift)
        e0 = max(s0 + 0.3, min(duration, float(line.get("endTime", s0 + 2.0)) + global_shift))
        anchor_bounds.append((s0, e0))

    emit_progress(58, f"일본어 음소 CTC 강제 정렬 모델 실행 중 ({device.upper()})...")
    full_emission, tokenizer, aligner, valid_chars = compute_mms_fa_emissions(
        wav, models_dir, device
    )
    total_frames = int(full_emission.shape[0])
    frame_sec = duration / max(1, total_frames)
    total_segs = sum(len(line.get("segments") or []) for line in lines)

    emit_progress(66, "전곡 보컬 음소 글로벌 정밀 정렬 중...")
    all_indices = list(range(len(lines)))
    raw_seg_times, matched_segs, global_tok_score, global_ok = run_mms_fa_window(
        full_emission,
        tokenizer,
        aligner,
        valid_chars,
        lines,
        all_indices,
        0,
        total_frames,
        frame_sec,
    )
    used_model = "mms-fa-global-ctc"

    if global_ok:
        global_comp, global_vhit, global_sane = score_alignment(
            raw_seg_times, lines, vocal_db, sing_thresh, global_tok_score
        )
    else:
        global_comp, global_vhit, global_sane = 0.0, 0.0, 0.0

    # Fallback to LRC-windowed sectioned CTC alignment only if global alignment struggled on LRC lyrics
    if not global_ok or (has_lrc and (global_vhit < 0.62 or global_sane < 0.72)):
        emit_progress(74, "LRC 기준 구간 보컬 정밀 재매칭 중...")
        sections = group_lines_into_sections(anchor_bounds, has_lrc)
        lrc_seg_times: dict[int, list[tuple[float, float]]] = {}
        lrc_matched = 0
        lrc_scores: list[float] = []

        for sec_idx, sec_indices in enumerate(sections):
            first_idx = sec_indices[0]
            last_idx = sec_indices[-1]

            if has_lrc:
                prev_limit = (
                    (anchor_bounds[first_idx - 1][1] + anchor_bounds[first_idx][0]) * 0.5
                    if first_idx > 0
                    else 0.0
                )
                next_limit = (
                    (anchor_bounds[last_idx][1] + anchor_bounds[last_idx + 1][0]) * 0.5
                    if last_idx + 1 < len(anchor_bounds)
                    else duration
                )
                w_start = max(
                    0.0,
                    max(prev_limit - 1.0, anchor_bounds[first_idx][0] - 5.5),
                )
                w_end = min(
                    duration,
                    min(next_limit + 1.0, anchor_bounds[last_idx][1] + 5.5),
                )
                if sec_idx == 0:
                    w_start = max(0.0, anchor_bounds[first_idx][0] - 6.0)
                if sec_idx == len(sections) - 1:
                    w_end = min(duration, max(w_end, anchor_bounds[last_idx][1] + 6.0))
            else:
                w_start = 0.0
                w_end = duration

            f_start = max(0, min(total_frames - 1, int(math.floor(w_start / frame_sec))))
            f_end = max(f_start + 1, min(total_frames, int(math.ceil(w_end / frame_sec))))

            win_spans, win_matched, win_score, win_ok = run_mms_fa_window(
                full_emission,
                tokenizer,
                aligner,
                valid_chars,
                lines,
                sec_indices,
                f_start,
                f_end,
                frame_sec,
            )
            if win_ok:
                lrc_seg_times.update(win_spans)
                lrc_matched += win_matched
                lrc_scores.append(win_score)
            else:
                for li in sec_indices:
                    a_s, a_e = anchor_bounds[li]
                    segs = lines[li].get("segments") or []
                    if segs:
                        rom_list = [
                            "".join(
                                ch
                                for ch in str(s.get("alignRomaji") or "").lower()
                                if ch in valid_chars
                            )
                            or "a"
                            for s in segs
                        ]
                        lrc_seg_times[li] = distribute_line_proportionally(
                            lines[li], rom_list, a_s, a_e
                        )

        lrc_mean_score = float(np.mean(lrc_scores)) if lrc_scores else 0.0
        lrc_comp, _, _ = score_alignment(
            lrc_seg_times, lines, vocal_db, sing_thresh, lrc_mean_score
        )

        if not global_ok or lrc_comp > global_comp + 0.03:
            raw_seg_times = lrc_seg_times
            matched_segs = lrc_matched
            used_model = "mms-fa-lrc-ctc"

    repaired_lines = repair_anomalous_clusters(
        full_emission,
        tokenizer,
        aligner,
        valid_chars,
        lines,
        raw_seg_times,
        vocal_db,
        sing_thresh,
        has_lrc,
        frame_sec,
        duration,
    )
    if repaired_lines > 0:
        used_model = f"{used_model}+hybrid-repair"

    if has_lrc and raw_seg_times:
        deltas = [
            raw_seg_times[i][0][0] - float(lines[i].get("startTime", 0.0))
            for i in range(len(lines))
            if raw_seg_times.get(i)
        ]
        reported_shift = float(np.median(deltas)) if deltas else global_shift
    else:
        reported_shift = 0.0

    # Disambiguate multi-reading kanji (e.g. 明日 -> あした vs あす) against vocal CTC likelihood
    emit_progress(79, "다중 독음 한자 오디오 발음 자동 판별 중...")
    disambiguated_count = resolve_ambiguous_readings(
        full_emission,
        tokenizer,
        aligner,
        valid_chars,
        lines,
        raw_seg_times,
        frame_sec,
    )

    # Stage 4: Singing-Grade Boundary Refinement (Vocal Sustain + Interlude Silence Trimming)
    emit_progress(82, "보컬 발성 시작·끝 경계 정밀 다듬는 중...")
    aligned_lines: list[dict] = []
    n_lines = len(lines)

    for idx, line in enumerate(lines):
        segs = line.get("segments") or []
        if not segs:
            aligned_lines.append(line)
            continue

        seg_spans = raw_seg_times.get(idx) or [
            (float(s.get("startTime", 0.0)), float(s.get("endTime", 0.2)))
            for s in segs
        ]

        prev_end_limit = aligned_lines[-1]["endTime"] + 0.02 if aligned_lines else 0.0
        next_start_est = (
            raw_seg_times[idx + 1][0][0]
            if idx + 1 < n_lines and raw_seg_times.get(idx + 1)
            else duration
        )

        # 4.1 Leading-silence trim + vocal-attack snap
        line_start = max(prev_end_limit, seg_spans[0][0])
        if (
            vocal_db_at(vocal_db, line_start) < sing_thresh - 2.5
            and seg_spans[0][1] - line_start > 0.35
        ):
            scan_max = min(seg_spans[0][1] - 0.12, line_start + 2.5)
            t_scan = line_start
            while t_scan + 0.01 <= scan_max:
                t_scan += 0.01
                if vocal_db_at(vocal_db, t_scan) >= sing_thresh - 1.0:
                    line_start = max(prev_end_limit, t_scan - 0.03)
                    break
        else:
            for step_t in [0.04, 0.03, 0.02, 0.01]:
                cand_t = line_start - step_t
                if cand_t >= prev_end_limit and vocal_db_at(vocal_db, cand_t) >= sing_thresh + 2.0:
                    line_start = cand_t
                    break

        # 4.2 Intra-line segment boundaries
        refined_segs: list[dict] = []
        n_segs = len(segs)
        for j, seg in enumerate(segs):
            raw_s, raw_e = seg_spans[j]
            s_t = line_start if j == 0 else max(refined_segs[-1]["endTime"], raw_s)
            e_t = max(s_t + 0.08, raw_e)

            if j + 1 < n_segs:
                nxt_s = max(s_t + 0.09, seg_spans[j + 1][0])
                gap = nxt_s - e_t
                if 0.0 <= gap <= 0.45:
                    g0 = max(0, int(round(e_t * 100.0)))
                    g1 = min(len(vocal_db), int(round(nxt_s * 100.0)) + 1)
                    med_gap = float(np.median(vocal_db[g0:g1])) if g1 > g0 else -80.0
                    if med_gap >= sing_thresh - 3.0:
                        e_t = nxt_s
                    else:
                        scan_t = e_t
                        while scan_t + 0.01 <= nxt_s - 0.03:
                            if vocal_db_at(vocal_db, scan_t + 0.01) >= sing_thresh:
                                scan_t += 0.01
                            else:
                                break
                        e_t = max(e_t, scan_t)
                elif gap < 0.0:
                    e_t = nxt_s

            refined_segs.append(
                {
                    "id": seg["id"],
                    "jp": seg["jp"],
                    "ruby": seg["ruby"],
                    "koPron": seg["koPron"],
                    "startTime": round(s_t, 3),
                    "endTime": round(max(s_t + 0.08, e_t), 3),
                    **({"altReadings": seg["altReadings"]} if seg.get("altReadings") else {}),
                }
            )

        # 4.3 Line End / Interlude Silence Trimming & Backward Trim on Last Segment
        last_seg = refined_segs[-1]
        raw_last_end = max(last_seg["startTime"] + 0.08, seg_spans[-1][1])
        hard_cap = min(duration, next_start_est - 0.08, raw_last_end + 1.6)
        hard_cap = max(last_seg["startTime"] + 0.12, hard_cap)

        li0 = max(0, min(len(vocal_db) - 1, int(round(line_start * 100.0))))
        li1 = max(li0 + 1, min(len(vocal_db), int(round(raw_last_end * 100.0))))
        line_p75 = (
            float(np.percentile(vocal_db[li0:li1], 75))
            if li1 > li0
            else sing_thresh
        )
        sustain_thresh = max(sing_thresh, line_p75 - 6.5)

        scan_end = min(hard_cap, raw_last_end)
        if (
            vocal_db_at(vocal_db, scan_end) < sing_thresh - 4.0
            and scan_end - last_seg["startTime"] > 0.6
        ):
            t_back = scan_end
            min_back = last_seg["startTime"] + 0.15
            found_back = None
            while t_back >= min_back:
                if vocal_db_at(vocal_db, t_back) >= sing_thresh - 2.0:
                    found_back = t_back
                    break
                t_back -= 0.01
            if found_back is not None:
                trimmed_end = min(scan_end, found_back + 0.06)
            else:
                trimmed_end = min(hard_cap, raw_last_end + 0.03)
        elif vocal_db_at(vocal_db, scan_end) >= sustain_thresh:
            last_voiced_t = scan_end
            t_cur = scan_end
            silence_run = 0.0
            while t_cur + 0.01 <= hard_cap:
                t_cur += 0.01
                if vocal_db_at(vocal_db, t_cur) >= sustain_thresh:
                    last_voiced_t = t_cur
                    silence_run = 0.0
                else:
                    silence_run += 0.01
                    if silence_run >= 0.14:
                        break
            trimmed_end = min(hard_cap, last_voiced_t + 0.05)
        else:
            trimmed_end = min(hard_cap, raw_last_end + 0.03)

        trimmed_end = max(last_seg["startTime"] + 0.08, trimmed_end)
        last_seg["endTime"] = round(trimmed_end, 3)

        # Enforce strictly monotonic segments inside the line
        for k in range(len(refined_segs)):
            if k > 0 and refined_segs[k]["startTime"] < refined_segs[k - 1]["endTime"]:
                refined_segs[k]["startTime"] = refined_segs[k - 1]["endTime"]
            if refined_segs[k]["endTime"] <= refined_segs[k]["startTime"] + 0.06:
                refined_segs[k]["endTime"] = round(refined_segs[k]["startTime"] + 0.08, 3)

        line_s = refined_segs[0]["startTime"]
        line_e = max(line_s + 0.25, refined_segs[-1]["endTime"])

        aligned_lines.append(
            {
                "id": line["id"],
                "startTime": round(line_s, 3),
                "endTime": round(line_e, 3),
                **({"appearTime": line["appearTime"]} if "appearTime" in line else {}),
                **({"slot": line["slot"]} if "slot" in line else {}),
                "jpText": line["jpText"],
                "koTranslation": line.get("koTranslation", ""),
                "segments": refined_segs,
            }
        )

    # Final pass ensuring consecutive lines never overlap backwards
    for idx in range(1, len(aligned_lines)):
        prev = aligned_lines[idx - 1]
        cur = aligned_lines[idx]
        if cur["startTime"] < prev["endTime"]:
            if (
                prev["endTime"] - cur["startTime"] < 0.8
                and cur["startTime"] > prev["startTime"] + 0.35
            ):
                prev["endTime"] = round(cur["startTime"] - 0.04, 3)
                if prev["segments"]:
                    prev["segments"][-1]["endTime"] = round(
                        min(prev["segments"][-1]["endTime"], prev["endTime"]), 3
                    )
            else:
                shift = prev["endTime"] + 0.04 - cur["startTime"]
                cur["startTime"] = round(cur["startTime"] + shift, 3)
                cur["endTime"] = round(cur["endTime"] + shift, 3)
                for s in cur.get("segments", []):
                    s["startTime"] = round(s["startTime"] + shift, 3)
                    s["endTime"] = round(s["endTime"] + shift, 3)

    stats = {
        "device": device,
        "model": used_model,
        "globalShiftSec": round(reported_shift, 3),
        "alignedLines": len(aligned_lines),
        "alignedSegments": matched_segs,
        "totalSegments": total_segs,
        "disambiguatedCount": disambiguated_count,
    }
    return aligned_lines, stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--vocal-cache", required=True)
    parser.add_argument("--existing-vocal", default="")
    parser.add_argument("--lines-in", required=True)
    parser.add_argument("--lines-out", required=True)
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    emit_progress(4, "가사 발음(히라가나) 데이터 읽는 중...")
    with open(args.lines_in, "r", encoding="utf-8") as f:
        lines = json.load(f)

    aligned, stats = align_lines(
        args.audio,
        args.vocal_cache,
        args.existing_vocal,
        lines,
        args.models_dir,
    )

    with open(args.lines_out, "w", encoding="utf-8") as f:
        json.dump({"lines": aligned, "stats": stats}, f, ensure_ascii=False)

    disambig_note = (
        f" · 다중독음 {stats['disambiguatedCount']}건 보정"
        if stats.get("disambiguatedCount", 0) > 0
        else ""
    )
    emit_progress(
        100,
        f"보컬 음소 정밀 싱크 완료 ({stats['alignedLines']}소절 · 전체보정 {stats['globalShiftSec']:+.2f}초{disambig_note})",
    )


if __name__ == "__main__":
    main()
