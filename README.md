# Lyriko

> 일본어 노래의 **후리가나 · 한국어 발음(촉음/다중독음 자동 판별) · 한국어 해석 · AI 음소 정밀 싱크 · 1080p MP4 가라오케 영상**을 한곳에서 만드는 스튜디오

- **GitHub**: https://github.com/5drake/Lyriko
- **Portable Worker Releases**: https://github.com/5drake/Lyriko/releases

---

## 주요 특징

- **원클릭 YouTube 곡 검색 & 4트랙 자동 매칭**: 원곡 + MR(반주) + 노래방 + 가사/싱크 후보를 한 번에 비교·선택하고, AI 싱크 완료 시 공유 라이브러리에 자동 등록됩니다.
- **정교한 일본어 → 한국어 발음 엔진**: Kuromoji 형태소 분석 기반으로 촉음(`っ` → `ㅅ` 받침), 장음, 요음, 한자 다중독음 후보 칩(1클릭 교정)을 제공합니다.
- **AI 보컬 분리 & 음소 정밀 싱크**: 로컬 GPU(BS-RoFormer + Meta MMS-FA Forced Alignment)로 보컬을 분리하고 단어 단위 와이프 타이밍을 맞춥니다.
- **프리미어 스타일 정밀 편집**: `,` / `.` 1프레임 이동 + 오디오 스크럽 재생, `Shift + , / .` ±5프레임 점프, `Ctrl+Z / Ctrl+Y` 실행 취소, 소절·단어 청크별 타이밍 스탬프.
- **초경량 1080p Full HD MP4 내보내기**: 6종 테마 프리셋, 4종 루프 배경, 6종 실시간 오디오 비주얼라이저, WebCodecs GPU 고속 캡처 + x264 압축.

---

## 웹 전용 vs 로컬 GPU 워커 기능 구분

Lyriko는 저작권·컴퓨팅 비용 보호를 위해 **음원 다운로드·AI 연산·영상 인코딩은 사용자의 로컬 PC에서만 처리**하며, 공용 DB에는 타이밍·가사·발음 JSON 메타데이터만 저장합니다.

| 구분 | 가능한 작업 | 비고 |
| --- | --- | --- |
| **로컬 워커 없이 가능 (웹 전용)** | 공유 라이브러리 곡 탐색·좋아요 및 **YouTube 스트리밍 바로 재생**<br>**원곡 · MR · 노래방 트랙 전환** 및 저장된 싱크 오프셋·배속 적용<br>가사 · 후리가나 · 발음 · 해석 · 타이밍 편집<br>스타일(`테마 · 가사 · 배경`) 프리셋 · 컬러 · 배치 꾸미기 | 별도 설치 없이 브라우저에서 즉시 사용·감상 |
| **로컬 워커 연결 시 가능 (내 PC GPU)** | YouTube 새 곡 검색 · 오디오/영상(`yt-dlp`) 다운로드<br>**실시간 키 조절(±6키)** · MR 자동 싱크 맞춤 · 겹쳐 듣기<br>AI 보컬 분리 및 음소 정밀 강제 정렬(Forced Alignment)<br>오디오 파형 · 스펙트럼 비주얼라이저 · `, / .` 1프레임 오디오 스크럽<br>**1080p / 60fps MP4 영상 파일 렌더링 및 저장** | [Lyriko-Worker-Portable](https://github.com/5drake/Lyriko/releases) 실행 (무설치·폴더 삭제 시 100% 제거) |

> **AI 작업 예상 시간 (4분 곡 보컬 분리 + 음소 정밀 싱크 기준)**: **RTX 3060** 약 `30~45초` · **RTX 5090** 약 `10~15초` *(최초 1회 AI 모델 다운로드 제외)*

---

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `Ctrl + K` | 곡 검색 · 공유 라이브러리 팝업 열기 |
| `Space` / 화면 클릭 | 재생 · 일시정지 |
| `←` / `→` | 5초 이동 (`Shift` 조합 시 1초) |
| `,` / `.` | 1프레임(1/30초) 이동 + 오디오 스크럽 (`Shift` 조합 시 ±5프레임, 한글 입력 상태 지원) |
| `Ctrl + Z` / `Ctrl + Y` | 실행 취소 / 다시 실행 (`Ctrl + Shift + Z` 지원) |
| `Esc` | 열린 팝업 닫기 |

---

## 로컬 개발 실행

### 사전 요구사항
- **Node.js** 20+ (`npm`)
- **Python** 3.11+ (AI 보컬 분리/정렬용, 포터블 워커 사용 시 자동 구성)
- **yt-dlp** (`server/bin/yt-dlp.exe` 또는 PATH)
- **NVIDIA GPU + CUDA** 권장 (CPU 폴백 지원)

### 설치 및 실행

```bash
npm install
cp .env.example .env   # 선택: Supabase 공용 DB 연결 시 입력
npm run dev
```

- 프론트엔드(Vite): `http://localhost:5173`
- 백엔드/워커(Express + WS): `http://localhost:3840`

---

## 무설치 포터블 워커 빌드 (Windows)

```bash
npm run build:worker
```

생성된 `dist/Lyriko-Worker-Portable.zip` 압축을 풀고 `Lyriko-Worker.bat`를 실행하면 레지스트리나 `AppData`에 흔적을 남기지 않고 폴더 내부(`.\python`, `.\data`)에서만 동작합니다. 폴더를 통째로 삭제하면 100% 제거됩니다.

---

## 배포 가이드 (Vercel + Supabase)

1. **웹 프론트엔드 (Vercel)**
   - [vercel.json](./vercel.json) 설정으로 `npm run build` → `dist/client` 정적 배포를 바로 지원합니다.
2. **공용 곡 라이브러리 DB (Supabase, 선택)**
   - [supabase/schema.sql](./supabase/schema.sql)을 Supabase SQL Editor에서 실행합니다.
   - Vercel 환경변수에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`를 설정합니다.
   - 환경변수가 비어 있으면 로컬 Express JSON DB 또는 브라우저 캐시 모드로 동작합니다.
3. **로컬 워커 관리자 인증 (선택)**
   - 운영자 라이브러리 검수·잠금·삭제 기능은 서버 환경변수 `LYRIKO_ADMIN_KEY` (미설정 시 `server/data/admin_key.txt` 자동 생성)를 통해 인증합니다.

---

## 기술 스택 & 크레딧

- **AI · 오디오 처리**: BS-RoFormer (`audio-separator`), Meta MMS-FA (`torchaudio`), `yt-dlp`, `ffmpeg-static`
- **일본어 형태소·발음**: `kuromoji` (IPADIC) + Lyriko 한국어 발음·촉음·다중독음 엔진
- **가사·메타데이터**: LRCLIB, iTunes Search API
- **웹 UI**: React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide Icons

---

## 라이선스

[MIT License](./LICENSE) © 2026 [5drake](https://github.com/5drake)
