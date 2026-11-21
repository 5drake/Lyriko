import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  Globe,
  Sparkles,
  X,
} from 'lucide-react';

export const TOUR_STORAGE_KEY = 'utakana_tour_done_v1';

type WorkerRequirement = 'none' | 'worker' | 'mixed';

interface TourPoint {
  label: string;
  text: string;
  worker?: WorkerRequirement;
}

interface TourStep {
  id: string;
  target: string | null;
  title: string;
  subtitle?: string;
  overviewComparison?: {
    webOnly: string[];
    withWorker: string[];
  };
  points: TourPoint[];
  shortcuts?: Array<{ keyLabel: string; action: string }>;
}

const WORKER_TAG_META: Record<
  WorkerRequirement,
  { label: string; className: string }
> = {
  none: {
    label: '워커 불필요',
    className:
      'border-emerald-400/35 bg-emerald-500/10 text-emerald-300',
  },
  worker: {
    label: '워커 필요',
    className: 'border-sky-400/35 bg-sky-500/15 text-sky-300',
  },
  mixed: {
    label: '음원 연결 시 필요',
    className: 'border-violet-400/35 bg-violet-500/15 text-violet-300',
  },
};

const TOUR_STEPS: TourStep[] = [
  {
    id: 'overview',
    target: null,
    title: '1. Lyriko 한눈에 보기',
    subtitle:
      '일본어 노래의 후리가나·한국어 발음·해석·AI 싱크를 한 화면에서 완성하고 Full HD 가라오케 영상(MP4)으로 만드는 스튜디오입니다.',
    overviewComparison: {
      webOnly: [
        '공유 라이브러리 곡 열람 · 좋아요',
        '가사 · 후리가나 · 발음 · 해석 편집',
        '테마 프리셋 · 컬러 · 가사 배치 꾸미기',
      ],
      withWorker: [
        'YouTube 원곡 · MR · 노래방 검색 및 재생',
        'AI 보컬 분리 & 음소 단위 정밀 싱크',
        '키(±6) · 배속 변환 및 1080p MP4 저장',
      ],
    },
    points: [
      {
        label: '추천 시작 순서',
        text: '곡 검색·불러오기 → 발음·단어 싱크 확인 → 스타일 꾸미기 → MP4 내보내기',
      },
    ],
  },
  {
    id: 'worker',
    target: '[data-tour="worker-btn"]',
    title: '2. 로컬 워커 상태 & 역할 구분',
    points: [
      {
        label: '웹 단독 모드',
        text: '별도 프로그램 없이도 공유 곡 감상·가사 교정·스타일 디자인을 바로 이용할 수 있습니다.',
        worker: 'none',
      },
      {
        label: '로컬 GPU 워커',
        text: '새 곡 유튜브 다운로드·AI 보컬 분리·음소 싱크·MP4 인코딩은 내 PC 자원을 쓰는 워커 연결이 필요합니다.',
        worker: 'worker',
      },
      {
        label: '무설치 & 100% 삭제',
        text: '포터블 ZIP(Lyriko-Worker.bat)으로 폴더 안에서만 실행되며, 폴더를 지우면 흔적 없이 삭제됩니다.',
      },
    ],
  },
  {
    id: 'search',
    target: '[data-tour="topbar-song-search"]',
    title: '3. 곡 검색 · 공유 라이브러리',
    points: [
      {
        label: '새 곡 검색',
        text: '원곡·MR·노래방 트랙을 비교해 가져오면 AI 싱크 완료 후 공유 라이브러리에 자동 등록됩니다.',
        worker: 'worker',
      },
      {
        label: '공유 라이브러리',
        text: '다른 사용자가 맞춘 가사·발음·싱크를 즉시 불러옵니다. 실제 유튜브 음원 재생까지 연결하려면 워커가 필요합니다.',
        worker: 'mixed',
      },
    ],
    shortcuts: [{ keyLabel: 'Ctrl + K', action: '검색 · 라이브러리 열기' }],
  },
  {
    id: 'preview',
    target: '[data-tour="stage-preview"]',
    title: '4. 미리보기 · 재생 · 정밀 스크럽',
    points: [
      {
        label: '트랙 · 키 · 싱크',
        text: '원곡·MR·노래방 전환 및 키(±6)·MR 자동 싱크 맞추기는 음원 처리 워커와 함께 동작합니다.',
        worker: 'worker',
      },
      {
        label: '타임라인 · 1프레임',
        text: '타임라인은 마우스 휠로 좌우 이동(Ctrl+휠 확대)하며, , / . 키로 1프레임씩 소리를 들으며 맞출 수 있습니다.',
        worker: 'none',
      },
    ],
    shortcuts: [
      { keyLabel: '화면 클릭 / Space', action: '재생·정지' },
      { keyLabel: '← / →', action: '5초 (Shift 1초)' },
      { keyLabel: ', / .', action: '1프레임 (+소리)' },
      { keyLabel: 'Ctrl + Z / Y', action: '실행 취소' },
    ],
  },
  {
    id: 'inspector',
    target: '[data-tour="lyric-inspector"]',
    title: '5. 가사 · 발음 · 단어 싱크 편집',
    points: [
      {
        label: '발음 · 다중독음',
        text: '독음 후보 칩을 클릭해 1초 만에 바꾸고, 후리가나를 고치면 한국어 발음이 즉시 다시 계산됩니다.',
        worker: 'none',
      },
      {
        label: '소절 · 단어 싱크',
        text: '소절 ±0.1s 버튼과 단어 청크의 ▶ 이동 · ⏱ 현재 시각 스탬프로 세밀하게 교정합니다.',
        worker: 'none',
      },
      {
        label: 'AI 싱크 재정렬',
        text: '상단 [싱크] 메뉴의 AI 다시 맞추기는 음원 분석 워커가 연결된 상태에서 동작합니다.',
        worker: 'worker',
      },
    ],
  },
  {
    id: 'export',
    target: '[data-tour="sidebar-style"]',
    title: '6. 스타일 꾸미기 & MP4 저장',
    points: [
      {
        label: '스타일 (테마·가사·배경)',
        text: '6종 테마 프리셋·와이프 효과·4색 컬러·배경 루프·비주얼라이저를 브라우저에서 즉시 꾸밀 수 있습니다.',
        worker: 'none',
      },
      {
        label: 'Full HD MP4 저장',
        text: '우상단 [MP4 내보내기] 버튼으로 1080p 초경량(약 40~50MB) 또는 60fps 고화질 영상을 생성합니다.',
        worker: 'worker',
      },
    ],
  },
];

interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
}

interface SpotlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function OnboardingTour({ open, onClose }: OnboardingTourProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [spot, setSpot] = useState<SpotlightRect | null>(null);

  useEffect(() => {
    if (open) {
      setStepIdx(0);
    }
  }, [open]);

  const finishTour = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, '1');
    } catch {
      // ignore storage errors
    }
    onClose();
  }, [onClose]);

  const step = TOUR_STEPS[stepIdx] ?? TOUR_STEPS[0];

  const measureTarget = useCallback(() => {
    if (!step.target) {
      setSpot(null);
      return;
    }
    const el = document.querySelector(step.target);
    if (!el) {
      setSpot(null);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      setSpot(null);
      return;
    }
    const pad = 6;
    setSpot({
      left: Math.max(4, r.left - pad),
      top: Math.max(4, r.top - pad),
      width: Math.min(window.innerWidth - 8, r.width + pad * 2),
      height: Math.min(window.innerHeight - 8, r.height + pad * 2),
    });
  }, [step.target]);

  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => measureTarget());
    const t = window.setTimeout(() => measureTarget(), 80);
    const t2 = window.setTimeout(() => measureTarget(), 260);
    window.addEventListener('resize', measureTarget);
    let ro: ResizeObserver | null = null;
    const targetEl = step.target ? document.querySelector(step.target) : null;
    if (typeof ResizeObserver !== 'undefined' && targetEl) {
      ro = new ResizeObserver(() => measureTarget());
      ro.observe(targetEl);
      if (targetEl.parentElement) ro.observe(targetEl.parentElement);
    }
    void document.fonts?.ready.then(() => measureTarget());
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.clearTimeout(t2);
      window.removeEventListener('resize', measureTarget);
      ro?.disconnect();
    };
  }, [open, step.target, measureTarget]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishTour();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        if (stepIdx < TOUR_STEPS.length - 1) {
          setStepIdx((i) => i + 1);
        } else {
          finishTour();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (stepIdx > 0) {
          setStepIdx((i) => i - 1);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, stepIdx, finishTour]);

  if (!open) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1366;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 820;
  const cardW = Math.min(step.overviewComparison ? 492 : 356, vw - 24);
  const estCardH = step.overviewComparison
    ? 370
    : step.shortcuts && step.shortcuts.length > 2
    ? 305
    : 265;

  let cardLeft = clamp((vw - cardW) / 2, 12, vw - cardW - 12);
  let cardTop = clamp((vh - estCardH) / 2, 12, vh - estCardH - 12);

  if (spot) {
    const rightEdge = spot.left + spot.width;
    const bottomEdge = spot.top + spot.height;
    const isTopBarTarget = spot.top < 72;
    if (isTopBarTarget && bottomEdge + 14 + estCardH <= vh - 12) {
      cardLeft = clamp(spot.left, 12, vw - cardW - 12);
      cardTop = bottomEdge + 14;
    } else if (rightEdge + 16 + cardW <= vw - 12) {
      cardLeft = rightEdge + 16;
      cardTop = clamp(spot.top, 12, vh - estCardH - 12);
    } else if (spot.left - 16 - cardW >= 12) {
      cardLeft = spot.left - 16 - cardW;
      cardTop = clamp(spot.top, 12, vh - estCardH - 12);
    } else if (bottomEdge + 14 + estCardH <= vh - 12) {
      cardLeft = clamp(spot.left, 12, vw - cardW - 12);
      cardTop = bottomEdge + 14;
    } else if (spot.top - 14 - estCardH >= 12) {
      cardLeft = clamp(spot.left, 12, vw - cardW - 12);
      cardTop = spot.top - 14 - estCardH;
    } else {
      cardLeft = clamp((vw - cardW) / 2, 12, vw - cardW - 12);
      cardTop = clamp(vh - estCardH - 18, 12, vh - estCardH - 12);
    }
  }

  const isLast = stepIdx === TOUR_STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-[70]"
      role="dialog"
      aria-modal="true"
      aria-label="Lyriko 사용법 튜토리얼"
    >
      {/* Dimmed backdrop when target isn't spotlighted */}
      {!spot && (
        <div
          className="fixed inset-0 bg-[#040812]/75 backdrop-blur-[1px]"
          onClick={finishTour}
        />
      )}

      {/* Spotlight Ring Cutout */}
      {spot && (
        <>
          <div
            className="fixed inset-0 bg-transparent"
            onClick={finishTour}
          />
          <div
            className="fixed pointer-events-none rounded-xl border-2 border-sky-400/90"
            style={{
              left: spot.left,
              top: spot.top,
              width: spot.width,
              height: spot.height,
              boxShadow:
                '0 0 0 9999px rgba(4, 8, 18, 0.74), 0 0 28px rgba(56, 189, 248, 0.35)',
            }}
          />
        </>
      )}

      {/* Floating Guide Card */}
      <div
        className="fixed z-10 rounded-2xl border border-sky-400/35 bg-[#0d1424] p-4 text-xs shadow-2xl"
        style={{
          left: cardLeft,
          top: cardTop,
          width: cardW,
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/15 px-2.5 py-0.5 text-[10.5px] font-semibold text-sky-300">
            <Sparkles className="h-3 w-3" />
            STEP {stepIdx + 1} / {TOUR_STEPS.length}
          </span>
          <button
            type="button"
            onClick={finishTour}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/[0.08] hover:text-white transition"
            title="튜토리얼 닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <h3 className="text-sm font-bold text-white mb-1.5">{step.title}</h3>
        {step.subtitle && (
          <p className="text-[11.5px] leading-relaxed text-slate-300 mb-3">
            {step.subtitle}
          </p>
        )}

        {step.overviewComparison && (
          <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-300">
                <Globe className="h-3.5 w-3.5 shrink-0" />
                <span>워커 없이 바로 가능</span>
              </div>
              <ul className="space-y-1 text-[11px] text-slate-200 leading-snug">
                {step.overviewComparison.webOnly.map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <span className="mt-1.5 h-1 w-1 rounded-full bg-emerald-400 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-sky-400/30 bg-sky-500/[0.07] p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-sky-300">
                <Cpu className="h-3.5 w-3.5 shrink-0" />
                <span>로컬 워커 연결 시</span>
              </div>
              <ul className="space-y-1 text-[11px] text-slate-200 leading-snug">
                {step.overviewComparison.withWorker.map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <span className="mt-1.5 h-1 w-1 rounded-full bg-sky-400 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <ul className="space-y-2 text-[11.5px] leading-snug text-slate-300">
          {step.points.map((pt) => {
            const tag = pt.worker ? WORKER_TAG_META[pt.worker] : null;
            return (
              <li key={pt.label} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-sky-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="font-semibold text-white">{pt.label}</strong>
                    {tag && (
                      <span
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9.5px] font-semibold leading-none ${tag.className}`}
                      >
                        {tag.label}
                      </span>
                    )}
                  </div>
                  <div className="text-slate-300 mt-0.5 leading-relaxed">{pt.text}</div>
                </div>
              </li>
            );
          })}
        </ul>

        {step.shortcuts && step.shortcuts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {step.shortcuts.map((sc) => (
              <span
                key={sc.keyLabel}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.09] bg-black/40 px-2 py-0.5 text-[10.5px]"
              >
                <kbd className="font-mono font-semibold text-sky-300">{sc.keyLabel}</kbd>
                <span className="text-slate-400">{sc.action}</span>
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2 pt-2.5 border-t border-white/[0.07]">
          <div className="flex items-center gap-1.5">
            {TOUR_STEPS.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStepIdx(idx)}
                className={`h-2 rounded-full transition-all ${
                  idx === stepIdx
                    ? 'w-5 bg-sky-400'
                    : idx < stepIdx
                    ? 'w-2 bg-sky-400/45 hover:bg-sky-400/75'
                    : 'w-2 bg-white/15 hover:bg-white/30'
                }`}
                title={s.title}
                aria-label={s.title}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
            {!isLast && (
              <button
                type="button"
                onClick={finishTour}
                className="rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200 transition whitespace-nowrap"
              >
                건너뛰기
              </button>
            )}

            {stepIdx > 0 && (
              <button
                type="button"
                onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/[0.1] transition whitespace-nowrap"
              >
                <ArrowLeft className="h-3 w-3 shrink-0" />
                이전
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (isLast) {
                  finishTour();
                } else {
                  setStepIdx((i) => i + 1);
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-sky-400 transition whitespace-nowrap"
            >
              {isLast ? (
                <>
                  <Check className="h-3 w-3 shrink-0" />
                  시작하기
                </>
              ) : (
                <>
                  다음
                  <ArrowRight className="h-3 w-3 shrink-0" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
