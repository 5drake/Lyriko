import argparse
import json
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

# Prepend isolated studio site-packages & sibling script directory before imports
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

_AI_SITE = os.path.abspath(
    os.path.join(_SCRIPT_DIR, "..", "ai-env", "Lib", "site-packages")
)
if os.path.isdir(_AI_SITE) and _AI_SITE not in sys.path:
    sys.path.insert(0, _AI_SITE)

import numpy as np
import onnxruntime as ort
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import torch

from ai_align_lyrics import (
    TARGET_SR,
    compute_mms_fa_emissions,
    compute_vocal_db_envelope,
    detect_lrc_anchors_and_shift,
    distribute_line_proportionally,
    emit_progress,
    group_lines_into_sections,
    read_wav_mono_16k,
    vocal_db_at,
)


GAME_SR = 44100
GAME_MODEL_ZIP_URL = (
    "https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-medium-onnx.zip"
)
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_MASK = {0, 2, 4, 5, 7, 9, 11}


def run_ffmpeg_decode_mono(
    src_path: str, dst_wav: str, sample_rate: int, offset_sec: float = 0.0
) -> None:
    cmd = ["ffmpeg", "-y", "-i", src_path, "-vn"]
    filters: list[str] = []
    if offset_sec < -0.001:
        filters.append(f"atrim=start={abs(offset_sec):.4f},asetpts=PTS-STARTPTS")
    elif offset_sec > 0.001:
        delay_ms = int(round(offset_sec * 1000))
        filters.append(f"adelay={delay_ms}:all=1")
    if filters:
        cmd.extend(["-af", ",".join(filters)])
    cmd.extend(["-ar", str(sample_rate), "-ac", "1", "-c:a", "pcm_s16le", dst_wav])
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not os.path.exists(dst_wav):
        tail = proc.stderr.decode("utf-8", errors="ignore")[-400:]
        raise RuntimeError(f"FFmpeg 디코딩 실패: {tail}")


def read_wav_mono(path: str, expected_sr: int) -> np.ndarray:
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        wav = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        wav = data.astype(np.float32) / 2147483648.0
    else:
        wav = data.astype(np.float32)
    if wav.ndim > 1:
        wav = wav.mean(axis=1).astype(np.float32)
    if sr != expected_sr and len(wav) > 0:
        g = math.gcd(int(sr), expected_sr)
        wav = signal.resample_poly(wav, expected_sr // g, int(sr) // g).astype(np.float32)
    return wav


def separate_vocals_bs_roformer(
    src_audio_path: str, models_dir: str, device: str, progress_msg: str
) -> tuple[str, str]:
    """
    Runs BS-Roformer output_single_stem='Vocals' and returns (tmp_dir, separated_wav_path).
    Caller must clean up tmp_dir.
    """
    from audio_separator.separator import Separator

    emit_progress(14, f"{progress_msg} ({device.upper()})...")
    tmp_dir = tempfile.mkdtemp(prefix="utakana_pitch_sep_")
    tmp_in_wav = os.path.join(tmp_dir, "in_44k.wav")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            src_audio_path,
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
    emit_progress(28, "BS-Roformer 리드 트랙 고음질 분리 실행 중...")
    outputs = sep.separate(tmp_in_wav)
    resolved = [p if os.path.isabs(p) else os.path.join(tmp_dir, p) for p in outputs]
    vocal_out = None
    for p in resolved:
        low = os.path.basename(p).lower()
        if "(vocals)" in low or "vocal" in low:
            vocal_out = p
            break
    if not vocal_out and resolved:
        vocal_out = resolved[0]
    if not vocal_out or not os.path.exists(vocal_out):
        raise RuntimeError(f"보컬 분리 결과를 찾지 못했습니다: {resolved}")

    del sep
    if device == "cuda":
        torch.cuda.empty_cache()
    return tmp_dir, vocal_out


def ensure_vocal_stems(
    audio_path: str,
    vocal_16k_cache: str,
    vocal_44k_cache: str,
    existing_vocal_path: str,
    models_dir: str,
    device: str,
) -> bool:
    """
    Ensures both 44.1kHz (for GAME) and 16kHz (for MMS_FA alignment) clean vocal stems exist.
    Returns True if 44.1kHz stem was reused from disk/existing track without fresh BS-Roformer run.
    """
    has_44k = os.path.exists(vocal_44k_cache) and os.path.getsize(vocal_44k_cache) > 32000
    has_16k = os.path.exists(vocal_16k_cache) and os.path.getsize(vocal_16k_cache) > 16000
    if has_44k:
        if not has_16k:
            tmp16 = f"{vocal_16k_cache}.tmp_{os.getpid()}.wav"
            run_ffmpeg_decode_mono(vocal_44k_cache, tmp16, TARGET_SR)
            os.replace(tmp16, vocal_16k_cache)
        emit_progress(32, "캐시된 44.1kHz 보컬 스템 로드 중...")
        return True

    os.makedirs(os.path.dirname(os.path.abspath(vocal_44k_cache)), exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(vocal_16k_cache)), exist_ok=True)

    if existing_vocal_path and os.path.exists(existing_vocal_path):
        emit_progress(24, "기존 분리 보컬 트랙 44.1kHz·16kHz 변환 중...")
        tmp44 = f"{vocal_44k_cache}.tmp_{os.getpid()}.wav"
        run_ffmpeg_decode_mono(existing_vocal_path, tmp44, GAME_SR)
        os.replace(tmp44, vocal_44k_cache)
        if not has_16k:
            tmp16 = f"{vocal_16k_cache}.tmp_{os.getpid()}.wav"
            run_ffmpeg_decode_mono(vocal_44k_cache, tmp16, TARGET_SR)
            os.replace(tmp16, vocal_16k_cache)
        return True

    tmp_dir = None
    try:
        tmp_dir, vocal_out = separate_vocals_bs_roformer(
            audio_path, models_dir, device, "음정 채보용 보컬 스템(44.1kHz) 추출 중"
        )
        tmp44 = f"{vocal_44k_cache}.tmp_{os.getpid()}.wav"
        run_ffmpeg_decode_mono(vocal_out, tmp44, GAME_SR)
        os.replace(tmp44, vocal_44k_cache)
        if not has_16k:
            tmp16 = f"{vocal_16k_cache}.tmp_{os.getpid()}.wav"
            run_ffmpeg_decode_mono(vocal_44k_cache, tmp16, TARGET_SR)
            os.replace(tmp16, vocal_16k_cache)
        return False
    except Exception as exc:
        print(f"[pitch vocal sep fallback] {exc}", file=sys.stderr, flush=True)
        tmp44 = f"{vocal_44k_cache}.tmp_{os.getpid()}.wav"
        run_ffmpeg_decode_mono(audio_path, tmp44, GAME_SR)
        os.replace(tmp44, vocal_44k_cache)
        if not has_16k:
            tmp16 = f"{vocal_16k_cache}.tmp_{os.getpid()}.wav"
            run_ffmpeg_decode_mono(vocal_44k_cache, tmp16, TARGET_SR)
            os.replace(tmp16, vocal_16k_cache)
        return False
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def ensure_game_model_dir(models_dir: str) -> str:
    base = os.path.join(models_dir, "game-1.0.3-medium")
    candidates = [base, os.path.join(base, "GAME-1.0.3-medium-onnx")]
    required = ["config.json", "encoder.onnx", "dur2bd.onnx", "segmenter.onnx", "bd2dur.onnx", "estimator.onnx"]

    for c in candidates:
        if all(os.path.exists(os.path.join(c, f)) for f in required):
            return c

    emit_progress(35, "GAME 1.0.3 딥러닝 보컬 채보 모델 다운로드 중 (최초 1회)...")
    os.makedirs(base, exist_ok=True)
    zip_path = os.path.join(base, "GAME-1.0.3-medium-onnx.zip")
    urllib.request.urlretrieve(GAME_MODEL_ZIP_URL, zip_path)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(base)
    if os.path.exists(zip_path):
        os.unlink(zip_path)

    for c in candidates:
        if all(os.path.exists(os.path.join(c, f)) for f in required):
            return c
    raise RuntimeError("GAME 1.0.3 ONNX 모델 파일을 찾을 수 없습니다.")


def estimate_vocal_scale(
    samples_m_prob: list[tuple[float, float]]
) -> tuple[set[int] | None, str]:
    if len(samples_m_prob) < 16:
        return None, ""

    hist = np.zeros(12, dtype=np.float64)
    total_w = 0.0
    for m_float, prob in samples_m_prob:
        if not math.isfinite(m_float) or prob < 0.25:
            continue
        pc = int(round(m_float)) % 12
        w = float(prob)
        hist[pc] += w
        total_w += w

    if total_w <= 1e-6:
        return None, ""

    best_root = 0
    best_score = -1.0
    for root in range(12):
        pcs = {(root + off) % 12 for off in MAJOR_MASK}
        sc = sum(hist[pc] for pc in pcs)
        if sc > best_score:
            best_score = sc
            best_root = root

    if best_score / total_w < 0.78:
        return None, ""

    scale_pcs = {(best_root + off) % 12 for off in MAJOR_MASK}
    rel_minor = (best_root + 9) % 12
    maj_tonic_w = hist[best_root] + 0.6 * hist[(best_root + 7) % 12]
    min_tonic_w = hist[rel_minor] + 0.6 * hist[(rel_minor + 7) % 12]
    if min_tonic_w > maj_tonic_w * 1.05:
        key_label = f"{NOTE_NAMES[rel_minor]} Minor ({NOTE_NAMES[best_root]} Major)"
    else:
        key_label = f"{NOTE_NAMES[best_root]} Major"
    return scale_pcs, key_label


def quantize_midi_scale_aware(m_float: float, scale_pcs: set[int] | None) -> int:
    nearest = int(round(m_float))
    if not scale_pcs:
        return max(36, min(90, nearest))
    diff = abs(m_float - nearest)
    if diff <= 0.34:
        return max(36, min(90, nearest))
    lo = int(math.floor(m_float))
    hi = int(math.ceil(m_float))
    lo_in = (lo % 12) in scale_pcs
    hi_in = (hi % 12) in scale_pcs
    if lo_in and not hi_in:
        return max(36, min(90, lo))
    if hi_in and not lo_in:
        return max(36, min(90, hi))
    return max(36, min(90, nearest))


def align_lines_with_moras(
    wav_16k: np.ndarray,
    lines: list[dict],
    models_dir: str,
    device: str,
) -> tuple[list[dict], list[list[dict]]]:
    """
    Runs MMS_FA 20ms CTC forced alignment at segment & mora granularity.
    Returns (synced_lines, per_line_flat_moras).
    """
    duration = len(wav_16k) / float(TARGET_SR)
    vocal_db, sing_thresh = compute_vocal_db_envelope(wav_16k)
    has_lrc, global_shift = detect_lrc_anchors_and_shift(lines, vocal_db, sing_thresh)

    anchor_bounds: list[tuple[float, float]] = []
    for line in lines:
        s0 = max(0.0, float(line.get("startTime", 0.0)) + global_shift)
        e0 = max(s0 + 0.3, min(duration, float(line.get("endTime", s0 + 2.0)) + global_shift))
        anchor_bounds.append((s0, e0))

    emit_progress(42, f"가사 음절(모라) 타이밍 연계 정렬 중 ({device.upper()})...")
    full_emission, tokenizer, aligner, valid_chars = compute_mms_fa_emissions(
        wav_16k, models_dir, device
    )
    total_frames = int(full_emission.shape[0])
    frame_sec = duration / max(1, total_frames)

    sections = group_lines_into_sections(anchor_bounds, has_lrc)
    raw_seg_mora_spans: dict[int, list[list[tuple[str, float, float]]]] = {}
    raw_seg_times: dict[int, list[tuple[float, float]]] = {}

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
            w_start = max(0.0, max(prev_limit - 0.5, anchor_bounds[first_idx][0] - 3.5))
            w_end = min(duration, min(next_limit + 0.5, anchor_bounds[last_idx][1] + 3.5))
            if sec_idx == 0:
                w_start = max(0.0, anchor_bounds[first_idx][0] - 4.0)
            if sec_idx == len(sections) - 1:
                w_end = min(duration, max(w_end, anchor_bounds[last_idx][1] + 4.5))
        else:
            w_start = 0.0
            w_end = duration

        f_start = max(0, min(total_frames - 1, int(math.floor(w_start / frame_sec))))
        f_end = max(f_start + 1, min(total_frames, int(math.ceil(w_end / frame_sec))))

        words: list[str] = ["*"]
        word_slots: list[tuple[int, int, list[tuple[str, str]]]] = []
        sec_seg_romajis: dict[int, list[str]] = {}
        sec_seg_moras: dict[int, list[list[tuple[str, str]]]] = {}

        for li in sec_indices:
            segs = lines[li].get("segments") or []
            romajis_for_line: list[str] = []
            moras_for_line: list[list[tuple[str, str]]] = []
            for sj, seg in enumerate(segs):
                raw_moras = seg.get("moras") or []
                clean_moras: list[tuple[str, str]] = []
                for m in raw_moras:
                    kana = str(m.get("kana") or "").strip()
                    rm = "".join(
                        ch for ch in str(m.get("romaji") or "").lower() if ch in valid_chars
                    )
                    if rm:
                        clean_moras.append((kana or rm, rm))
                if not clean_moras:
                    raw_r = str(seg.get("alignRomaji") or "").lower()
                    clean_r = "".join(ch for ch in raw_r if ch in valid_chars) or "a"
                    clean_moras = [(str(seg.get("jp") or clean_r), clean_r)]

                word_r = "".join(rm for _, rm in clean_moras)
                romajis_for_line.append(word_r)
                moras_for_line.append(clean_moras)
                word_slots.append((li, sj, clean_moras))
                words.append(word_r)
            words.append("*")
            sec_seg_romajis[li] = romajis_for_line
            sec_seg_moras[li] = moras_for_line

        flat_tok_len = sum(len(w) for w in words)
        if f_end - f_start < flat_tok_len * 2 + 4:
            f_start = max(0, f_start - int(round(2.5 / frame_sec)))
            f_end = min(total_frames, f_end + int(round(2.5 / frame_sec)))

        aligned_ok = False
        if f_end - f_start >= flat_tok_len + 2 and word_slots:
            try:
                tokens = tokenizer(words)
                sub_em = full_emission[f_start:f_end].to(dtype=torch.float32)
                spans_per_word = aligner(sub_em, tokens)

                slot_ptr = 0
                per_line_spans: dict[int, list[tuple[float, float]]] = {li: [] for li in sec_indices}
                per_line_moras: dict[int, list[list[tuple[str, float, float]]]] = {
                    li: [] for li in sec_indices
                }

                for w_idx, w_text in enumerate(words):
                    if w_text == "*":
                        continue
                    li, _sj, clean_moras = word_slots[slot_ptr]
                    slot_ptr += 1
                    sp = spans_per_word[w_idx]
                    if not sp:
                        continue

                    seg_st = (f_start + sp[0].start) * frame_sec
                    seg_et = max(seg_st + 0.06, (f_start + sp[-1].end) * frame_sec)
                    per_line_spans[li].append((seg_st, seg_et))

                    total_r_chars = sum(len(rm) for _, rm in clean_moras)
                    m_tuples: list[tuple[str, float, float]] = []
                    if len(sp) == total_r_chars and total_r_chars > 0:
                        cursor = 0
                        for kana, rm in clean_moras:
                            sub_sp = sp[cursor : cursor + len(rm)]
                            cursor += len(rm)
                            ms = (f_start + sub_sp[0].start) * frame_sec
                            me = max(ms + 0.04, (f_start + sub_sp[-1].end) * frame_sec)
                            m_tuples.append((kana, ms, me))
                    else:
                        w_dur = max(0.05 * len(clean_moras), seg_et - seg_st)
                        weights = [max(1, len(rm)) for _, rm in clean_moras]
                        w_sum = max(1, sum(weights))
                        c_t = seg_st
                        for kana, w in zip((k for k, _ in clean_moras), weights):
                            slice_d = w_dur * (w / w_sum)
                            m_tuples.append((kana, c_t, max(c_t + 0.04, c_t + slice_d)))
                            c_t += slice_d
                    per_line_moras[li].append(m_tuples)

                if all(
                    len(per_line_spans[li]) == len(lines[li].get("segments") or [])
                    for li in sec_indices
                ):
                    for li in sec_indices:
                        raw_seg_times[li] = per_line_spans[li]
                        raw_seg_mora_spans[li] = per_line_moras[li]
                    aligned_ok = True
            except Exception as exc:
                print(f"[mora align fallback sec {sec_idx}] {exc}", file=sys.stderr, flush=True)

        if not aligned_ok:
            for li in sec_indices:
                a_s, a_e = anchor_bounds[li]
                segs = lines[li].get("segments") or []
                if segs:
                    raw_t = distribute_line_proportionally(
                        lines[li], sec_seg_romajis.get(li, ["a"] * len(segs)), a_s, a_e
                    )
                    raw_seg_times[li] = raw_t
                    line_moras: list[list[tuple[str, float, float]]] = []
                    for (ss, ee), clean_moras in zip(raw_t, sec_seg_moras[li]):
                        weights = [max(1, len(rm)) for _, rm in clean_moras]
                        w_sum = max(1, sum(weights))
                        span = max(0.08, ee - ss)
                        c_t = ss
                        m_tuples = []
                        for (kana, _), w in zip(clean_moras, weights):
                            sd = span * (w / w_sum)
                            m_tuples.append((kana, c_t, max(c_t + 0.04, c_t + sd)))
                            c_t += sd
                        line_moras.append(m_tuples)
                    raw_seg_mora_spans[li] = line_moras

    synced_lines: list[dict] = []
    per_line_flat_moras: list[list[dict]] = []
    n_lines = len(lines)

    for idx, line in enumerate(lines):
        segs = line.get("segments") or []
        if not segs:
            synced_lines.append(line)
            per_line_flat_moras.append([])
            continue

        seg_spans = raw_seg_times.get(idx) or [
            (float(s.get("startTime", 0.0)), float(s.get("endTime", 0.2))) for s in segs
        ]
        mora_groups = raw_seg_mora_spans.get(idx) or [
            [(str(s.get("jp") or ""), ss, ee)] for s, (ss, ee) in zip(segs, seg_spans)
        ]

        prev_end_limit = synced_lines[-1]["endTime"] + 0.02 if synced_lines else 0.0
        next_start_est = (
            raw_seg_times[idx + 1][0][0]
            if idx + 1 < n_lines and raw_seg_times.get(idx + 1)
            else duration
        )

        line_start = max(prev_end_limit, seg_spans[0][0])
        for step_t in [0.04, 0.03, 0.02, 0.01]:
            cand_t = line_start - step_t
            if cand_t >= prev_end_limit and vocal_db_at(vocal_db, cand_t) >= sing_thresh + 2.0:
                line_start = cand_t
                break

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
                }
            )

        last_seg = refined_segs[-1]
        raw_last_end = max(last_seg["startTime"] + 0.08, seg_spans[-1][1])
        hard_cap = max(
            last_seg["startTime"] + 0.12,
            min(duration, next_start_est - 0.08, raw_last_end + 2.6),
        )
        scan_end = min(hard_cap, raw_last_end)
        last_voiced_t = scan_end
        if vocal_db_at(vocal_db, scan_end) >= sing_thresh:
            t_cur = scan_end
            silence_run = 0.0
            while t_cur + 0.01 <= hard_cap:
                t_cur += 0.01
                if vocal_db_at(vocal_db, t_cur) >= sing_thresh:
                    last_voiced_t = t_cur
                    silence_run = 0.0
                else:
                    silence_run += 0.01
                    if silence_run >= 0.14:
                        break
            trimmed_end = min(hard_cap, last_voiced_t + 0.05)
        else:
            trimmed_end = min(hard_cap, raw_last_end + 0.03)
        last_seg["endTime"] = round(max(last_seg["startTime"] + 0.08, trimmed_end), 3)

        for k in range(len(refined_segs)):
            if k > 0 and refined_segs[k]["startTime"] < refined_segs[k - 1]["endTime"]:
                refined_segs[k]["startTime"] = refined_segs[k - 1]["endTime"]
            if refined_segs[k]["endTime"] <= refined_segs[k]["startTime"] + 0.06:
                refined_segs[k]["endTime"] = round(refined_segs[k]["startTime"] + 0.08, 3)

        line_flat: list[dict] = []
        for r_seg, m_list in zip(refined_segs, mora_groups):
            seg_s = float(r_seg["startTime"])
            seg_e = float(r_seg["endTime"])
            if not m_list:
                continue
            m_items: list[dict] = []
            for m_idx, (kana, ms, me) in enumerate(m_list):
                st = max(seg_s, ms) if m_idx > 0 else seg_s
                if m_items and st < m_items[-1]["endTime"]:
                    st = m_items[-1]["endTime"]
                en = min(seg_e, max(st + 0.045, me))
                m_items.append({"kana": kana, "startTime": st, "endTime": en})
            for m_idx in range(len(m_items)):
                if m_idx < len(m_items) - 1:
                    nxt_st = max(m_items[m_idx]["startTime"] + 0.045, m_items[m_idx + 1]["startTime"])
                    gap = nxt_st - m_items[m_idx]["endTime"]
                    if gap < 0.0 or gap <= 0.35:
                        m_items[m_idx]["endTime"] = nxt_st
                else:
                    if seg_e - m_items[m_idx]["endTime"] <= 2.4:
                        m_items[m_idx]["endTime"] = max(m_items[m_idx]["startTime"] + 0.05, seg_e)
            line_flat.extend(m_items)

        line_s = refined_segs[0]["startTime"]
        line_e = max(line_s + 0.25, refined_segs[-1]["endTime"])
        synced_lines.append(
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
        per_line_flat_moras.append(line_flat)

    for idx in range(1, len(synced_lines)):
        prev = synced_lines[idx - 1]
        cur = synced_lines[idx]
        if cur["startTime"] < prev["endTime"]:
            if prev["endTime"] - cur["startTime"] < 0.8 and cur["startTime"] > prev["startTime"] + 0.35:
                prev["endTime"] = round(cur["startTime"] - 0.02, 3)
                if prev["segments"]:
                    prev["segments"][-1]["endTime"] = prev["endTime"]
            else:
                cur["startTime"] = round(prev["endTime"] + 0.02, 3)
                if cur["segments"] and cur["segments"][0]["startTime"] < cur["startTime"]:
                    cur["segments"][0]["startTime"] = cur["startTime"]

    return synced_lines, per_line_flat_moras


def attach_lyrics_softly(
    notes: list[dict],
    synced_lines: list[dict],
    per_line_moras: list[list[dict]],
) -> list[dict]:
    """
    Filters notes to lyric singing windows and attaches `lineId` and best-matching mora `lyric`
    WITHOUT altering the neural model's exact note boundaries or MIDI pitches.
    """
    if not synced_lines:
        return notes

    line_windows = [
        (float(ln["startTime"]) - 0.28, float(ln["endTime"]) + 0.28, str(ln["id"]), idx)
        for idx, ln in enumerate(synced_lines)
    ]

    used_moras_per_line: dict[int, set[int]] = {i: set() for i in range(len(synced_lines))}
    out: list[dict] = []

    for n in notes:
        st = float(n["startTime"])
        en = float(n["endTime"])

        best_li = -1
        best_cov = 0.0
        for ws, we, _lid, li in line_windows:
            ov = min(en, we) - max(st, ws)
            if ov > best_cov:
                best_cov = ov
                best_li = li

        if best_li < 0 or best_cov <= 0.0:
            continue

        line_id = str(synced_lines[best_li]["id"])
        moras = per_line_moras[best_li] if best_li < len(per_line_moras) else []
        matched_kana = ""

        if moras:
            # Prefer unused overlapping mora first; if note spans mid-mora continuation, label "ー"
            cands: list[tuple[float, int, str]] = []
            for m_idx, m in enumerate(moras):
                ms = float(m["startTime"])
                me = float(m["endTime"])
                ov = min(en, me + 0.05) - max(st, ms - 0.05)
                if ov > 0.0:
                    cands.append((ov, m_idx, str(m["kana"])))

            if cands:
                unused = [c for c in cands if c[1] not in used_moras_per_line[best_li]]
                if unused:
                    chosen = max(unused, key=lambda c: c[0])
                    used_moras_per_line[best_li].add(chosen[1])
                    matched_kana = chosen[2]
                else:
                    chosen = max(cands, key=lambda c: c[0])
                    # Continuation note (melisma) on the same mora
                    matched_kana = "ー" if out and out[-1].get("lineId") == line_id else chosen[2]
            else:
                n_mid = 0.5 * (st + en)
                nearest_idx = min(
                    range(len(moras)),
                    key=lambda k: abs(0.5 * (float(moras[k]["startTime"]) + float(moras[k]["endTime"])) - n_mid),
                )
                matched_kana = str(moras[nearest_idx]["kana"]) if nearest_idx not in used_moras_per_line[best_li] else "ー"
                used_moras_per_line[best_li].add(nearest_idx)

        item = {
            "id": f"pn_ai_{len(out)}",
            "startTime": round(st, 3),
            "endTime": round(en, 3),
            "midi": int(n["midi"]),
            "lineId": line_id,
        }
        if matched_kana:
            item["lyric"] = matched_kana
        out.append(item)

    return out


def polish_musical_notes(
    raw_notes: list[tuple[float, float, float]],
    preset: str = "balanced",
) -> tuple[list[dict], set[int] | None, str]:
    if not raw_notes:
        return [], None, ""

    samples = [(sc, 1.0) for _, _, sc in raw_notes]
    scale_pcs, detected_key = estimate_vocal_scale(samples)

    min_dur = {"precise": 0.050, "balanced": 0.065, "smooth": 0.090}.get(preset, 0.065)

    notes: list[dict] = []
    for st, en, sc in raw_notes:
        if en - st < min_dur:
            continue
        q_m = quantize_midi_scale_aware(sc, scale_pcs)
        notes.append({"startTime": st, "endTime": en, "midi": q_m})

    # For 'smooth' preset only, merge touching same-pitch micro-splits shorter than 0.14s
    if preset == "smooth":
        merged: list[dict] = []
        for n in notes:
            if (
                merged
                and merged[-1]["midi"] == n["midi"]
                and n["startTime"] - merged[-1]["endTime"] <= 0.05
                and (n["endTime"] - n["startTime"] < 0.14 or merged[-1]["endTime"] - merged[-1]["startTime"] < 0.14)
            ):
                merged[-1]["endTime"] = n["endTime"]
            else:
                merged.append(n)
        notes = merged

    # Ensure crisp 18ms breathing gap between adjacent identical-MIDI articulated syllables
    for k in range(len(notes) - 1):
        cur = notes[k]
        nxt = notes[k + 1]
        if cur["midi"] == nxt["midi"] and nxt["startTime"] - cur["endTime"] < 0.018:
            if cur["endTime"] - cur["startTime"] >= 0.085 and nxt["endTime"] - nxt["startTime"] >= 0.060:
                cur["endTime"] = cur["endTime"] - 0.018

    for idx, n in enumerate(notes):
        n["id"] = f"pn_ai_{idx}"
        n["startTime"] = round(float(n["startTime"]), 3)
        n["endTime"] = round(max(float(n["startTime"]) + 0.04, float(n["endTime"])), 3)

    return notes, scale_pcs, detected_key


def build_active_chunks(
    wav_16k: np.ndarray,
    lines: list[dict],
    max_chunk_sec: float = 22.0,
) -> list[tuple[float, float]]:
    duration = len(wav_16k) / float(TARGET_SR)
    if lines:
        chunks: list[tuple[float, float]] = []
        cur_s = max(0.0, float(lines[0]["startTime"]) - 0.35)
        cur_e = min(duration, float(lines[0]["endTime"]) + 0.35)
        for ln in lines[1:]:
            ls = max(0.0, float(ln["startTime"]) - 0.35)
            le = min(duration, float(ln["endTime"]) + 0.35)
            if ls - cur_e <= 2.4 and le - cur_s <= max_chunk_sec:
                cur_e = max(cur_e, le)
            else:
                chunks.append((cur_s, cur_e))
                cur_s, cur_e = ls, le
        chunks.append((cur_s, cur_e))
        return chunks

    vocal_db, sing_thresh = compute_vocal_db_envelope(wav_16k)
    active = vocal_db >= (sing_thresh - 2.0)
    chunks = []
    in_seg = False
    seg_s = 0
    for i, flag in enumerate(active):
        if flag and not in_seg:
            seg_s = i
            in_seg = True
        elif not flag and in_seg:
            st = max(0.0, seg_s * 0.01 - 0.25)
            en = min(duration, i * 0.01 + 0.25)
            if en - st >= 0.25:
                if chunks and st - chunks[-1][1] <= 1.5 and en - chunks[-1][0] <= max_chunk_sec:
                    chunks[-1] = (chunks[-1][0], en)
                else:
                    chunks.append((st, en))
            in_seg = False
    if in_seg:
        st = max(0.0, seg_s * 0.01 - 0.25)
        en = duration
        if en - st >= 0.25:
            chunks.append((st, en))
    return chunks or [(0.0, min(duration, max_chunk_sec))]


def run_game_onnx_transcription(
    wav_44k: np.ndarray,
    chunks: list[tuple[float, float]],
    models_dir: str,
    preset: str = "balanced",
) -> list[tuple[float, float, float]]:
    model_dir = ensure_game_model_dir(models_dir)
    with open(os.path.join(model_dir, "config.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)

    lang_map = cfg.get("languages") or {}
    lang_id = int(lang_map.get("ja", 0))

    preset_cfg = {
        "precise": {"n_steps": 8, "seg_th": 0.16, "est_th": 0.18, "rad": 2},
        "balanced": {"n_steps": 6, "seg_th": 0.22, "est_th": 0.22, "rad": 2},
        "smooth": {"n_steps": 4, "seg_th": 0.30, "est_th": 0.26, "rad": 3},
    }.get(preset, {"n_steps": 6, "seg_th": 0.22, "est_th": 0.22, "rad": 2})

    emit_progress(52, "GAME 1.0.3 딥러닝 가창 채보 모델 로딩 중...")
    so = ort.SessionOptions()
    so.intra_op_num_threads = min(8, max(2, os.cpu_count() or 4))
    enc = ort.InferenceSession(os.path.join(model_dir, "encoder.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    dur2bd = ort.InferenceSession(os.path.join(model_dir, "dur2bd.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    seg_sess = ort.InferenceSession(os.path.join(model_dir, "segmenter.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    bd2dur = ort.InferenceSession(os.path.join(model_dir, "bd2dur.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    est_sess = ort.InferenceSession(os.path.join(model_dir, "estimator.onnx"), sess_options=so, providers=["CPUExecutionProvider"])

    seg_input_names = {inp.name for inp in seg_sess.get_inputs()}
    est_input_names = {inp.name for inp in est_sess.get_inputs()}
    th_seg = np.array(preset_cfg["seg_th"], dtype=np.float32)
    th_est = np.array(preset_cfg["est_th"], dtype=np.float32)
    rad = np.array(preset_cfg["rad"], dtype=np.int64)
    lang_arr = np.array([lang_id], dtype=np.int64)
    ts_grid = np.linspace(0.0, 1.0, int(preset_cfg["n_steps"]), endpoint=False)

    raw_notes: list[tuple[float, float, float]] = []
    n_chunks = len(chunks)

    for ci, (cs, ce) in enumerate(chunks):
        i0 = max(0, int(round(cs * GAME_SR)))
        i1 = min(len(wav_44k), int(round(ce * GAME_SR)))
        if i1 - i0 < int(0.3 * GAME_SR):
            continue

        slice_w = wav_44k[i0:i1]
        peak = float(np.max(np.abs(slice_w)))
        if peak < 1e-4:
            continue
        norm_w = (slice_w / peak * 0.90).astype(np.float32)
        dur_sec = float(len(norm_w) / GAME_SR)
        dur_arr = np.array([dur_sec], dtype=np.float32)

        x_seg, x_est, mask_t = enc.run(None, {"waveform": norm_w[None, :], "duration": dur_arr})
        known_bd = dur2bd.run(None, {"durations": dur_arr[:, None], "maskT": mask_t})[0]
        bd = known_bd

        if cfg.get("loop", True):
            for tv in ts_grid:
                feed = {
                    "x_seg": x_seg,
                    "maskT": mask_t,
                    "threshold": th_seg,
                    "radius": rad,
                }
                if "known_boundaries" in seg_input_names:
                    feed["known_boundaries"] = known_bd
                if "prev_boundaries" in seg_input_names:
                    feed["prev_boundaries"] = bd
                if "language" in seg_input_names:
                    feed["language"] = lang_arr
                if "t" in seg_input_names:
                    feed["t"] = np.array([tv], dtype=np.float32)
                bd = seg_sess.run(None, feed)[0]
        else:
            feed = {"x_seg": x_seg, "maskT": mask_t, "threshold": th_seg, "radius": rad}
            if "known_boundaries" in seg_input_names:
                feed["known_boundaries"] = known_bd
            if "language" in seg_input_names:
                feed["language"] = lang_arr
            bd = seg_sess.run(None, feed)[0]

        durations, mask_n = bd2dur.run(None, {"boundaries": bd, "maskT": mask_t})
        est_feed = {
            "x_est": x_est,
            "boundaries": bd,
            "maskT": mask_t,
            "threshold": th_est,
        }
        if "maskN" in est_input_names:
            est_feed["maskN"] = mask_n
        presence, scores = est_sess.run(None, est_feed)

        cur_t = cs
        for d_val, pr, sc, mk in zip(durations[0], presence[0], scores[0], mask_n[0]):
            if not mk:
                continue
            nxt_t = cur_t + float(d_val)
            if pr and float(d_val) >= 0.04 and 32.0 <= float(sc) <= 95.0:
                raw_notes.append((cur_t, nxt_t, float(sc)))
            cur_t = nxt_t

        pct = 55 + int(35 * (ci + 1) / max(1, n_chunks))
        emit_progress(min(90, pct), f"GAME 딥러닝 보컬 채보 진행 중 ({ci + 1}/{n_chunks})...")

    return raw_notes


def isolate_karaoke_guide_synth(
    karaoke_path: str,
    karaoke_offset: float,
    mr_path: str,
    mr_offset: float,
    models_dir: str,
    device: str,
) -> tuple[np.ndarray, str]:
    """
    Returns (guide_16k_mono, method_tag).
    If an MR backing track from the same arrangement is present, applies STFT Wiener spectral
    subtraction to strip all accompaniment cleanly and isolate only the guide melody synth.
    Otherwise uses BS-Roformer Vocals stem on the karaoke track.
    """
    tmp_dir = tempfile.mkdtemp(prefix="utakana_karguide_")
    try:
        kar_wav = os.path.join(tmp_dir, "kar_16k.wav")
        emit_progress(15, "노래방 트랙 싱크 오프셋 적용 및 디코딩 중...")
        run_ffmpeg_decode_mono(karaoke_path, kar_wav, TARGET_SR, offset_sec=karaoke_offset)
        y_kar = read_wav_mono_16k(kar_wav)

        if mr_path and os.path.exists(mr_path):
            mr_wav = os.path.join(tmp_dir, "mr_16k.wav")
            run_ffmpeg_decode_mono(mr_path, mr_wav, TARGET_SR, offset_sec=mr_offset)
            y_mr = read_wav_mono_16k(mr_wav)

            n_len = min(len(y_kar), len(y_mr))
            if n_len >= TARGET_SR * 2:
                k_seg = y_kar[:n_len]
                m_seg = y_mr[:n_len]
                _, _, Z_k = signal.stft(k_seg, fs=TARGET_SR, nperseg=1024, noverlap=768)
                _, _, Z_m = signal.stft(m_seg, fs=TARGET_SR, nperseg=1024, noverlap=768)
                M_k = np.abs(Z_k)
                M_m = np.abs(Z_m)
                band_mid = M_k[4:180, :]   # ~62Hz .. 2800Hz
                band_mid_m = M_m[4:180, :]
                band_low = M_k[2:35, :]    # ~31Hz .. 546Hz (accompaniment bass/chords)
                band_low_m = M_m[2:35, :]
                frame_e = np.sqrt(np.mean(band_mid ** 2, axis=0))
                active_cols = frame_e > float(np.percentile(frame_e, 35))
                if int(np.sum(active_cols)) >= 8:
                    v1 = band_mid[:, active_cols].ravel()
                    v2 = band_mid_m[:, active_cols].ravel()
                    corr_mid = float(np.dot(v1, v2) / ((np.linalg.norm(v1) * np.linalg.norm(v2)) + 1e-9))
                    l1 = band_low[:, active_cols].ravel()
                    l2 = band_low_m[:, active_cols].ravel()
                    corr_low = float(np.dot(l1, l2) / ((np.linalg.norm(l1) * np.linalg.norm(l2)) + 1e-9))
                    corr = max(corr_mid, corr_low)
                else:
                    corr = 0.0

                if corr >= 0.45:
                    emit_progress(35, f"MR 반주 감산(Wiener 필터)으로 가이드 신스만 분리 중 (유사도 {corr:.2f})...")
                    # Scale MR to match karaoke backing loudness in low accompaniment bins
                    ratio = float(np.median(M_k[2:20, active_cols]) / (np.median(M_m[2:20, active_cols]) + 1e-6))
                    ratio = max(0.3, min(3.0, ratio))
                    power_k = M_k ** 2
                    power_m = (M_m * ratio) ** 2
                    wiener_mask = np.clip((power_k - 1.35 * power_m) / (power_k + 1e-9), 0.0, 1.0)
                    _, y_guide = signal.istft(Z_k * wiener_mask, fs=TARGET_SR, nperseg=1024, noverlap=768)
                    return y_guide.astype(np.float32), "MR 차감 가이드 분리"

        # Fallback: BS-Roformer separates centered lead synth / guide melody cleanly too
        aligned_kar_44k = os.path.join(tmp_dir, "kar_44k.wav")
        run_ffmpeg_decode_mono(karaoke_path, aligned_kar_44k, GAME_SR, offset_sec=karaoke_offset)
        sep_tmp, stem_path = separate_vocals_bs_roformer(
            aligned_kar_44k, models_dir, device, "노래방 가이드 멜로디 리드 분리 중"
        )
        try:
            guide_16k_wav = os.path.join(tmp_dir, "guide_16k.wav")
            run_ffmpeg_decode_mono(stem_path, guide_16k_wav, TARGET_SR, offset_sec=0.0)
            return read_wav_mono_16k(guide_16k_wav), "BS-Roformer 가이드 분리"
        finally:
            shutil.rmtree(sep_tmp, ignore_errors=True)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def run_fcpe_guide_transcription(
    guide_16k: np.ndarray,
    chunks: list[tuple[float, float]],
    device: str,
    preset: str = "balanced",
) -> list[tuple[float, float, float]]:
    from torchfcpe import spawn_bundled_infer_model

    emit_progress(52, f"torchfcpe 신경망 음정 트래커 실행 중 ({device.upper()})...")
    fcpe = spawn_bundled_infer_model(device=device)

    all_voiced: list[tuple[float, float]] = []
    frame_times: list[float] = []
    frame_midis: list[float] = []
    frame_dbs: list[float] = []

    song_ref_amp = max(float(np.percentile(np.abs(guide_16k), 99.5)), 1e-4) if len(guide_16k) > 0 else 1e-4
    rms_gate = song_ref_amp * 0.045
    hop_sec = 160.0 / float(TARGET_SR)  # 10ms

    for ci, (cs, ce) in enumerate(chunks):
        i0 = max(0, int(round(cs * TARGET_SR)))
        i1 = min(len(guide_16k), int(round(ce * TARGET_SR)))
        if i1 - i0 < 512:
            continue
        seg = guide_16k[i0:i1]
        peak = float(np.max(np.abs(seg)))
        if peak < rms_gate:
            continue
        seg_norm = (seg / peak * 0.90).astype(np.float32)

        with torch.inference_mode():
            t_in = torch.from_numpy(seg_norm).to(device).unsqueeze(0).unsqueeze(-1)
            f0 = fcpe.infer(
                t_in,
                sr=TARGET_SR,
                decoder_mode="local_argmax",
                threshold=0.006,
                f0_min=95.0,
                f0_max=1050.0,
            )
            hz_arr = f0[0, :, 0].detach().cpu().numpy()

        # 20ms local RMS energy for same-pitch synth articulation split & noise gate
        n_frames = len(hz_arr)
        for fi in range(n_frames):
            t_sec = cs + fi * hop_sec
            s0 = max(0, fi * 160 - 160)
            s1 = min(len(seg_norm), fi * 160 + 160)
            raw_rms = float(np.sqrt(np.mean(seg[s0:s1] ** 2) + 1e-12))
            rms = float(np.sqrt(np.mean(seg_norm[s0:s1] ** 2) + 1e-12))
            db = 20.0 * math.log10(rms + 1e-9)
            hz = float(hz_arr[fi])
            if hz > 10.0 and raw_rms >= rms_gate:
                m_val = 69.0 + 12.0 * math.log2(hz / 440.0)
                all_voiced.append((m_val, 1.0))
                frame_times.append(t_sec)
                frame_midis.append(m_val)
                frame_dbs.append(db)
            else:
                frame_times.append(t_sec)
                frame_midis.append(-1.0)
                frame_dbs.append(db)

        pct = 55 + int(32 * (ci + 1) / max(1, len(chunks)))
        emit_progress(min(87, pct), f"가이드 멜로디 FCPE 추출 중 ({ci + 1}/{len(chunks)})...")

    del fcpe
    if device == "cuda":
        torch.cuda.empty_cache()

    if not frame_times:
        return []

    scale_pcs, _ = estimate_vocal_scale(all_voiced)
    q_arr = np.array(
        [quantize_midi_scale_aware(m, scale_pcs) if m > 0 else -1 for m in frame_midis],
        dtype=np.int32,
    )
    med_w = 5 if preset == "smooth" else 3
    half_w = med_w // 2
    sm = q_arr.copy()
    for k in range(len(q_arr)):
        if q_arr[k] > 0:
            vals = q_arr[max(0, k - half_w) : min(len(q_arr), k + half_w + 1)]
            vals = vals[vals > 0]
            if len(vals) > 0:
                sm[k] = int(np.median(vals))

    # Run-length segmentation + energy dip split for clean repeated synth notes
    runs: list[tuple[int, int, int]] = []
    cur_m = int(sm[0])
    cur_s = 0
    for k in range(1, len(sm)):
        m = int(sm[k])
        gap = frame_times[k] - frame_times[k - 1]
        if m != cur_m or gap > 0.05:
            if cur_m > 0:
                runs.append((cur_s, k - 1, cur_m))
            cur_m = m
            cur_s = k
    if cur_m > 0:
        runs.append((cur_s, len(sm) - 1, cur_m))

    db_arr = np.array(frame_dbs, dtype=np.float32)
    raw_notes: list[tuple[float, float, float]] = []
    for s_idx, e_idx, midi_val in runs:
        if e_idx - s_idx < 4:
            continue
        if e_idx - s_idx < 24:
            raw_notes.append((frame_times[s_idx], frame_times[e_idx] + hop_sec, float(midi_val)))
            continue
        seg_db = db_arr[s_idx : e_idx + 1]
        cuts = [0]
        last_c = 0
        for k in range(8, len(seg_db) - 8):
            if k - last_c < 10:
                continue
            lp = float(np.max(seg_db[max(0, k - 8) : k]))
            rp = float(np.max(seg_db[k + 1 : min(len(seg_db), k + 9)]))
            val = float(seg_db[k])
            if lp - val >= 5.0 and rp - val >= 4.0 and val == float(np.min(seg_db[k - 2 : k + 3])):
                cuts.append(k)
                last_c = k
        cuts.append(len(seg_db))
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            if c1 - c0 >= 5:
                st = frame_times[s_idx + c0]
                en = frame_times[min(e_idx, s_idx + c1 - 1)] + hop_sec
                raw_notes.append((st, en, float(midi_val)))

    return raw_notes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default="")
    parser.add_argument("--vocal-cache", required=True)
    parser.add_argument("--existing-vocal", default="")
    parser.add_argument("--karaoke-audio", default="")
    parser.add_argument("--karaoke-offset", type=float, default=0.0)
    parser.add_argument("--mr-audio", default="")
    parser.add_argument("--mr-offset", type=float, default=0.0)
    parser.add_argument("--source", default="vocal")
    parser.add_argument("--lines-in", default="")
    parser.add_argument("--notes-out", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--preset", default="balanced")
    parser.add_argument("--restrict-to-lyrics", default="1")
    parser.add_argument("--lyric-linked", default="1")
    parser.add_argument("--sync-lyrics", default="1")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit_progress(4, f"AI 보컬 채보 엔진 초기화 중 ({device.upper()})...")

    lines: list[dict] = []
    if args.lines_in and os.path.exists(args.lines_in):
        with open(args.lines_in, "r", encoding="utf-8") as f:
            lines = json.load(f)

    want_karaoke = (
        str(args.source).strip().lower() == "karaoke"
        and args.karaoke_audio
        and os.path.exists(args.karaoke_audio)
    )
    want_lyric_linked = (
        str(args.lyric_linked).strip() not in ("0", "false", "False", "no")
        and len(lines) > 0
    )
    want_sync_lyrics = (
        str(args.sync_lyrics).strip() not in ("0", "false", "False", "no")
        and want_lyric_linked
    )

    root_cache, _ext = os.path.splitext(args.vocal_cache)
    if root_cache.endswith("_align_vocals_16k"):
        vocal_44k_cache = root_cache[: -len("_align_vocals_16k")] + "_vocals_44k.wav"
    else:
        vocal_44k_cache = root_cache + "_44k.wav"

    has_orig_audio = bool(args.audio and os.path.exists(args.audio))
    cached_vocal = False
    synced_lines_out: list[dict] | None = None
    per_line_moras: list[list[dict]] = []

    if want_karaoke:
        guide_16k, guide_method = isolate_karaoke_guide_synth(
            args.karaoke_audio,
            float(args.karaoke_offset),
            args.mr_audio,
            float(args.mr_offset),
            args.models_dir,
            device,
        )
        # Align moras from original vocal stem if original exists & lyric linking enabled
        synced_for_attach = lines
        if want_lyric_linked and has_orig_audio:
            ensure_vocal_stems(
                args.audio, args.vocal_cache, vocal_44k_cache, args.existing_vocal, args.models_dir, device
            )
            wav_16k = read_wav_mono_16k(args.vocal_cache)
            synced_for_attach, per_line_moras = align_lines_with_moras(
                wav_16k, lines, args.models_dir, device
            )
            if want_sync_lyrics:
                synced_lines_out = synced_for_attach

        chunks = build_active_chunks(guide_16k, synced_for_attach)
        raw_notes = run_fcpe_guide_transcription(guide_16k, chunks, device, preset=args.preset)
        engine_name = f"{guide_method} + FCPE ({device.upper()})"
        source_used = "karaoke"
    else:
        if not has_orig_audio and not (args.existing_vocal and os.path.exists(args.existing_vocal)):
            raise RuntimeError("음정을 추출할 원곡 음원 파일을 찾을 수 없습니다.")
        cached_vocal = ensure_vocal_stems(
            args.audio or args.existing_vocal,
            args.vocal_cache,
            vocal_44k_cache,
            args.existing_vocal,
            args.models_dir,
            device,
        )
        emit_progress(38, "44.1kHz 보컬 및 16kHz 정렬 파형 로드 중...")
        wav_44k = read_wav_mono(vocal_44k_cache, GAME_SR)
        wav_16k = read_wav_mono_16k(args.vocal_cache)

        synced_for_attach = lines
        if want_lyric_linked:
            synced_for_attach, per_line_moras = align_lines_with_moras(
                wav_16k, lines, args.models_dir, device
            )
            if want_sync_lyrics:
                synced_lines_out = synced_for_attach

        chunks = build_active_chunks(wav_16k, synced_for_attach)
        raw_notes = run_game_onnx_transcription(wav_44k, chunks, args.models_dir, preset=args.preset)
        engine_name = "GAME-1.0.3-medium (D3PM Neural MIDI)"
        source_used = "vocal"

    emit_progress(92, "음계 보정 및 가사 음절 라벨 연계 중...")
    notes, _scale_pcs, detected_key = polish_musical_notes(raw_notes, preset=args.preset)

    if synced_for_attach and per_line_moras:
        notes = attach_lyrics_softly(notes, synced_for_attach, per_line_moras)
    elif lines and str(args.restrict_to_lyrics).strip() not in ("0", "false", "False", "no"):
        notes = [
            n
            for n in notes
            if any(
                n["endTime"] >= float(l["startTime"]) - 0.25
                and n["startTime"] <= float(l["endTime"]) + 0.25
                for l in lines
            )
        ]

    midis = [n["midi"] for n in notes]
    stats_out = {
        "device": device,
        "engine": engine_name,
        "source": source_used,
        "cachedVocal": cached_vocal,
        "preset": args.preset,
        "lyricLinked": bool(per_line_moras),
        "detectedKey": detected_key,
        "noteCount": len(notes),
        "minMidi": min(midis, default=0),
        "maxMidi": max(midis, default=0),
        "medianMidi": int(round(float(np.median(midis)))) if midis else 0,
    }

    payload: dict = {"pitchNotes": notes, "stats": stats_out}
    if synced_lines_out is not None:
        payload["syncedLines"] = synced_lines_out

    with open(args.notes_out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    emit_progress(100, f"{engine_name} 완료 ({len(notes)}개 음정 바)")


if __name__ == "__main__":
    main()
