# Intent: 노래방 실시간 반주 싱크 모드 (Karaoke Live Sync)

## Confirmed Statement of Intent

- **목표 (Outcome)**: 실제 노래방에서 반주가 나올 때, Lyriko 공개 웹에서 곡을 열고 마이크 싱크를 켜면 유튜브 원곡(가수 보컬 포함)과 가사를 반주 시점에 실시간 동기화해 한쪽 이어폰 등으로 들으며 따라 부를 수 있게 한다.
- **대상 (User)**: 안드로이드·아이폰을 사용하는 본인 및 Lyriko 공개 웹(GitHub Pages) 전체 사용자.
- **왜 지금 (Why now)**: 노래방 반주만으로 부르기 어려운 일본어 곡을 원곡 보컬 가이드 + 한국어 발음 가사와 함께 부르고 싶고, PoC v2에서 MR 기반 12-bin Chroma + 2D 누적 투표로 실전 수준(88.7~92.9%, 중앙 오차 ~0.05s)이 검증되었다.
- **완료 기준 (Success)**:
  1. 공개 웹(안드로이드 Chrome / 아이폰 Safari)에서 곡 선택 후 **"노래방 싱크"** 실행 시 초반 10~20초 내 원곡 시점을 자동 잠금하고, **잠금 완료 후 마이크를 자동 종료**해 블루투스/이어폰(HFP 전환) 음질 저하를 막는다.
  2. 실행 중 **수동 미세 지연 조절(±50ms / ±100ms 등)**과 **재싱크 버튼**, 노래방 키 불일치 시 안내(무음 가사 모드 권장)가 동작한다.
  3. 기존 공개 라이브러리 **133곡 전체**에 Chroma 지문이 일괄 반영되고, 로컬 워커(서버 분석 파이프라인 + Portable ZIP 릴리즈)도 신규 공유 곡에 지문을 자동 포함하도록 업데이트된다.
- **제약 조건 (Constraint)**:
  - 별도 유료 API나 음원 호스팅 서버 없이 **GitHub Pages + Supabase + YouTube IFrame** 정적 웹 구조를 유지한다.
  - 안드로이드 Chrome · 아이폰 Safari + 블루투스 이어폰 환경에서 오차·지연을 최소화한다 (`getUserMedia` 시 `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false` 필수; YouTube `seekTo` 지연 보상 + 수동 오프셋 보정; 잠금 후 마이크 트랙 즉시 `stop()`).
- **하지 않을 것 (Out of scope)**:
  - 노래 제목을 고르지 않고 반주만 듣고 곡을 자동 판별하는 기능(Shazam형 곡 검색).
  - 보컬 전용 음원 파일 외부 호스팅/스트리밍 및 유튜브 원곡의 실시간 키(±음정) 변경.
  - 노래방 기기(TJ/금영)와의 직접 하드웨어/블루투스 연동 및 오프라인 전용 앱 패키징.

---

## PoC v2 Technical Reference (Next-Session Handoff)

- **Chroma Fingerprint Format** (verified in `poc_chroma_sync_v2.py`):
  - `16 kHz` mono audio, `4096`-pt Hann FFT, `4 Hz` hop (`0.25s/frame`, `hop=4000`).
  - Soft semitone projection (`65..2093 Hz`, Gaussian `sigma=0.35`) over magnitude `|Zxx|`.
  - Gain-invariant per-frame compression: `log1p(5.0 * raw / mean)`, 3-frame moving average (`0.75s`), zero-mean L2-normalized 12-bin vector.
  - Silence gate: `< 1%` of 90th-percentile frame energy zeroed out so count-in silence does not trigger false locks.
  - Compact storage: quantized `uint8` (`~11.4–14.2 KB` raw / `~10.1–12.7 KB` gzip per 4-min song).
- **Reference Source Preference**: Prefer AI-separated MR/instrumental stem when available (fallback to original track).
- **Online Tracker**:
  - 2D offset × pitch-shift accumulator (`12 × n_lags`) with exponential decay (`0.82`) and positive z-score voting (`max(0, z - 2.0)^1.5`).
  - Readout applies `±1` frame (`[0.25, 0.5, 0.25]`) smoothing along lag; average scan cost ~`1.7–2.2 ms`.
- **Empirical PoC v2 Results (4 real song pairs, zero-leakage verified)**:
  - MR reference, `Vote2D` steady-state (`t >= 16s`): Clean `93.0%` (`MedErr 0.05s`), Noraebang room (`+2st + reverb + bandpass + 6dB noise`) `89.7%` (`MedErr 0.05s`), Worst (`-3st + 0dB loud vocal bleed`) `56.2%` (`MedErr 0.27s`).
  - Confirms locking during intro/interlude and immediately stopping the microphone track after lock (plus manual ±offset trim and resync trigger).
