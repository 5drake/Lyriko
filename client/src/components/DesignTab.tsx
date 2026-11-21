import { useState } from 'react';
import {
  Activity,
  AudioWaveform,
  BarChart3,
  Check,
  CircleDashed,
  CircleDot,
  Disc,
  Grid3x3,
  Image as ImageIcon,
  Loader2,
  Palette,
  Radio,
  RotateCcw,
  Sparkles,
  Type,
  Upload,
  Waves,
  X,
} from 'lucide-react';
import {
  DEFAULT_RENDER_SETTINGS,
  THEME_PRESETS,
  type BackgroundLoopStyle,
  type BackgroundType,
  type KaraokeProject,
  type LayoutMode,
  type RenderSettings,
  type VisualizerStyle,
  type WipeStyle,
} from '@shared/types';
import { uploadMediaFile } from '../api';

interface DesignTabProps {
  project: KaraokeProject;
  onUpdateProject: (updater: (prev: KaraokeProject) => KaraokeProject) => void;
  onBackgroundLoaded: (
    kind: 'image' | 'video',
    fileId: string,
    originalName: string,
    url: string,
    keepBgType?: boolean
  ) => void;
}

type StyleTabKey = 'theme' | 'lyric' | 'bg';

const STYLE_TABS: Array<{ id: StyleTabKey; label: string; icon: typeof Palette }> = [
  { id: 'theme', label: '테마', icon: Palette },
  { id: 'lyric', label: '가사', icon: Type },
  { id: 'bg', label: '배경', icon: Sparkles },
];

const AMBIENT_GRADIENTS: Array<{
  id: string;
  label: string;
  stops: [string, string, string];
}> = [
  { id: 'deep-ocean', label: '딥 오션', stops: ['#0A343B', '#112A4A', '#1B193D'] },
  { id: 'sakura-night', label: '사쿠라 밤', stops: ['#3B132B', '#2A1843', '#151B3A'] },
  { id: 'aurora-mint', label: '오로라 민트', stops: ['#06202B', '#0D3B49', '#1B1642'] },
  { id: 'warm-amber', label: '웜 앰버', stops: ['#241712', '#2F2019', '#151A28'] },
];

function getHexLuminance(hex: string): number {
  const raw = (hex || '').trim().replace(/^#/, '');
  let r = 128;
  let g = 128;
  let b = 128;
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    r = parseInt(raw[0] + raw[0], 16);
    g = parseInt(raw[1] + raw[1], 16);
    b = parseInt(raw[2] + raw[2], 16);
  } else if (/^[0-9a-f]{6}$/i.test(raw)) {
    r = parseInt(raw.slice(0, 2), 16);
    g = parseInt(raw.slice(2, 4), 16);
    b = parseInt(raw.slice(4, 6), 16);
  } else {
    return 128;
  }
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const LOOP_STYLE_OPTIONS: Array<{
  id: BackgroundLoopStyle;
  label: string;
  desc: string;
  icon: typeof Disc;
}> = [
  { id: 'cd-spin', label: '회전 CD', desc: '회전하는 앨범 디스크', icon: Disc },
  { id: 'aurora-wave', label: '오로라 웨이브', desc: '물결치는 오로라 배경', icon: Waves },
  { id: 'neon-rings', label: '네온 링', desc: '박자에 반응하는 링', icon: CircleDot },
  { id: 'classic-bokeh', label: '보케 스타', desc: '은은한 빛망울 파티클', icon: Sparkles },
];

const VISUALIZER_STYLE_OPTIONS: Array<{
  id: VisualizerStyle;
  label: string;
  desc: string;
  icon: typeof Disc;
}> = [
  { id: 'cd-radial', label: 'CD 원형', desc: 'CD 둘레 방사형 파형', icon: Radio },
  { id: 'bottom-bars', label: '하단 바', desc: '깔끔한 하단 이퀄라이저', icon: BarChart3 },
  { id: 'mirror-wave', label: '미러 웨이브', desc: '중앙 대칭 반사 바', icon: AudioWaveform },
  { id: 'silk-ribbon', label: '실크 웨이브', desc: '부드러운 3중 네온 파동', icon: Activity },
  { id: 'floating-dots', label: 'LED 도트', desc: '도트 스튜디오 랙', icon: Grid3x3 },
  { id: 'dual-ring', label: '듀얼 링', desc: '유기적 원형 오실로스코프', icon: CircleDashed },
];

export function DesignTab({
  project,
  onUpdateProject,
  onBackgroundLoaded,
}: DesignTabProps) {
  const s = project.settings;
  const [activeTab, setActiveTab] = useState<StyleTabKey>('theme');
  const [uploadingBg, setUploadingBg] = useState(false);

  const patchSettings = (patch: Partial<RenderSettings>) => {
    onUpdateProject((prev) => ({
      ...prev,
      settings: { ...prev.settings, ...patch },
    }));
  };

  const handleResetDefaults = () => {
    patchSettings({
      ...DEFAULT_RENDER_SETTINGS,
      bgFileId: s.bgFileId,
      bgFileName: s.bgFileName,
      albumArtUrl: s.albumArtUrl,
    });
  };

  const updateGradientStop = (index: 0 | 1 | 2, color: string) => {
    const next: [string, string, string] = [...s.gradientStops];
    next[index] = color;
    patchSettings({ gradientStops: next });
  };

  const handleUploadMedia = async (
    e: React.ChangeEvent<HTMLInputElement>,
    forCdCover: boolean
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBg(true);
    try {
      const res = await uploadMediaFile('background', file);
      const isVideo =
        !forCdCover &&
        (res.mimeType.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(res.originalName));
      onBackgroundLoaded(
        isVideo ? 'video' : 'image',
        res.id,
        res.originalName,
        res.url,
        forCdCover
      );
    } finally {
      setUploadingBg(false);
      e.target.value = '';
    }
  };

  const resolveFillAccentColor = (): string => {
    const textLum = getHexLuminance(s.highlightTextColor);
    if (textLum < 230) return s.highlightTextColor;
    const strokeLum = getHexLuminance(s.highlightStrokeColor);
    if (strokeLum > 45 && strokeLum < 235) return s.highlightStrokeColor;
    return '#38BDF8';
  };

  const resolveGlowAccentColor = (): string => {
    const strokeLum = getHexLuminance(s.highlightStrokeColor);
    if (strokeLum > 45 && strokeLum < 235) return s.highlightStrokeColor;
    const textLum = getHexLuminance(s.highlightTextColor);
    if (textLum < 230) return s.highlightTextColor;
    return '#0068E8';
  };

  const handleSelectWipeStyle = (nextStyle: WipeStyle) => {
    if (nextStyle === 'fill-wipe') {
      const accent = resolveFillAccentColor();
      patchSettings({
        wipeStyle: 'fill-wipe',
        highlightTextColor: accent,
        highlightStrokeColor: s.baseStrokeColor || '#0A101D',
      });
    } else {
      const accent = resolveGlowAccentColor();
      patchSettings({
        wipeStyle: 'stroke-glow',
        highlightTextColor: '#FFFFFF',
        highlightStrokeColor: accent,
      });
    }
  };

  const glowPreviewColor = resolveGlowAccentColor();
  const fillPreviewColor = resolveFillAccentColor();
  const wipeColorKey: 'highlightStrokeColor' | 'highlightTextColor' =
    s.wipeStyle === 'fill-wipe' ? 'highlightTextColor' : 'highlightStrokeColor';
  const wipeColorLabel = s.wipeStyle === 'fill-wipe' ? '와이프 채움' : '와이프 글로우';
  const currentLoopStyle: BackgroundLoopStyle = s.bgLoopStyle ?? 'cd-spin';
  const currentVisualizerStyle: VisualizerStyle = s.visualizerStyle ?? 'cd-radial';

  const elementToggles: Array<{
    key: keyof RenderSettings;
    label: string;
    checked: boolean;
  }> = [
    { key: 'showFurigana', label: '후리가나', checked: s.showFurigana },
    { key: 'showKoPron', label: '한국어 발음', checked: s.showKoPron },
    { key: 'showTranslation', label: '한국어 해석', checked: s.showTranslation },
    { key: 'showCountdown', label: '카운트다운', checked: s.showCountdown },
    { key: 'showVisualizer', label: '비주얼라이저', checked: s.showVisualizer },
    { key: 'showProgressBar', label: '진행도 바', checked: s.showProgressBar !== false },
    { key: 'showParticles', label: '파티클', checked: s.showParticles !== false },
    { key: 'lyricBackdrop', label: '가사 배경', checked: Boolean(s.lyricBackdrop) },
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Sticky Compact Header & 3-Tab Switcher */}
      <div className="shrink-0 border-b border-white/[0.07] px-3 pt-2.5 pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
            <Palette className="h-4 w-4 text-sky-400 shrink-0" />
            <span>스타일</span>
          </div>
          <button
            type="button"
            onClick={handleResetDefaults}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-300 hover:bg-white/[0.09] hover:text-white transition"
            title="스타일 설정을 초기 기본값으로 되돌립니다"
          >
            <RotateCcw className="h-3 w-3" />
            초기화
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/[0.06] bg-black/35 p-0.5">
          {STYLE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center justify-center gap-1 rounded-md border py-1 text-[11px] font-semibold transition ${
                  active
                    ? 'border-sky-400/40 bg-sky-500/15 text-sky-200 shadow-sm'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content Area */}
      <div className="flex-1 overflow-y-auto p-2.5 text-xs">
        {activeTab === 'theme' && (
          <div className="space-y-2.5">
            {/* Compact 2x3 Visual Theme Presets */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 space-y-2">
              <div className="text-[11px] font-semibold text-slate-200">테마 프리셋</div>
              <div className="grid grid-cols-2 gap-1.5">
                {THEME_PRESETS.map((preset) => {
                  const active = s.presetId === preset.id;
                  const stops = preset.patch.gradientStops ?? DEFAULT_RENDER_SETTINGS.gradientStops;
                  const isCinema = preset.id === 'mv-cinema';
                  const glowColor =
                    preset.patch.highlightStrokeColor ?? DEFAULT_RENDER_SETTINGS.highlightStrokeColor;
                  const fillColor =
                    preset.patch.highlightTextColor ?? DEFAULT_RENDER_SETTINGS.highlightTextColor;
                  const pronColor =
                    preset.patch.koPronHighlightColor ??
                    DEFAULT_RENDER_SETTINGS.koPronHighlightColor;
                  const isFill = preset.patch.wipeStyle === 'fill-wipe';

                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => patchSettings(preset.patch)}
                      title={`${preset.name} — ${preset.description}`}
                      className={`group relative overflow-hidden rounded-xl border p-1 text-left transition ${
                        active
                          ? 'border-sky-400/60 bg-sky-500/15 ring-1 ring-sky-400/35 text-white'
                          : 'border-white/[0.08] bg-black/30 text-slate-300 hover:border-white/[0.16]'
                      }`}
                    >
                      <div
                        data-keep-dark="true"
                        className="relative h-10 w-full overflow-hidden rounded-lg border border-white/10 flex flex-col items-center justify-center"
                        style={{
                          background: isCinema
                            ? 'radial-gradient(circle at 30% 30%, #1e293b 0%, #090d16 55%, #020617 100%)'
                            : `linear-gradient(135deg, ${stops[0]} 0%, ${stops[1]} 52%, ${stops[2]} 100%)`,
                        }}
                      >
                        {isCinema && (
                          <div
                            className="pointer-events-none absolute inset-0 opacity-25"
                            style={{
                              backgroundImage:
                                'linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)',
                              backgroundSize: '12px 12px',
                            }}
                          />
                        )}
                        <div
                          className={`relative px-2 py-0.5 flex flex-col items-center leading-none ${
                            preset.patch.lyricBackdrop
                              ? 'rounded bg-slate-950/75 border border-white/15'
                              : ''
                          }`}
                        >
                          <span
                            className="text-[12px] font-black tracking-wide"
                            style={{
                              color: isFill ? fillColor : '#ffffff',
                              textShadow: isFill
                                ? '0 1px 3px rgba(0,0,0,0.85)'
                                : `0 0 8px ${glowColor}, 0 0 3px ${glowColor}`,
                            }}
                          >
                            歌詞
                          </span>
                          <span
                            className="text-[8.5px] font-bold mt-0.5"
                            style={{ color: pronColor }}
                          >
                            가사
                          </span>
                        </div>

                        {active && (
                          <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-400 text-slate-950 shadow">
                            <Check className="h-2.5 w-2.5 stroke-[3]" />
                          </span>
                        )}
                      </div>

                      <div className="pt-1 pb-0.5 text-center truncate font-semibold text-[10.5px] text-slate-100">
                        {preset.name}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Wipe Effect & 4-Swatch Color Strip */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-200">
                <span>와이프 · 가사 컬러</span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    ['stroke-glow', '외곽선 글로우'],
                    ['fill-wipe', '글자 색 채우기'],
                  ] as Array<[WipeStyle, string]>
                ).map(([val, label]) => {
                  const active = s.wipeStyle === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => handleSelectWipeStyle(val)}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border py-1.5 px-2 text-[10.5px] font-semibold whitespace-nowrap transition ${
                        active
                          ? 'border-sky-400/50 bg-sky-500/15 text-sky-100'
                          : 'border-white/[0.08] bg-black/30 text-slate-400 hover:border-white/[0.15] hover:text-slate-200'
                      }`}
                    >
                      {val === 'stroke-glow' ? (
                        <span
                          data-keep-dark="true"
                          className="inline-flex items-center justify-center rounded bg-slate-900 px-1.5 py-0.5 leading-none text-[11px] font-black text-white"
                          style={{
                            textShadow: `0 0 7px ${glowPreviewColor}, 0 0 2px ${glowPreviewColor}`,
                          }}
                        >
                          歌
                        </span>
                      ) : (
                        <span
                          data-keep-dark="true"
                          className="inline-flex items-center justify-center rounded bg-slate-900 px-1.5 py-0.5 leading-none text-[11px] font-black"
                        >
                          <span style={{ color: fillPreviewColor }}>歌</span>
                          <span className="text-slate-400">唱</span>
                        </span>
                      )}
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-4 gap-1.5 pt-0.5">
                {(
                  [
                    ['baseTextColor', '기본', s.baseTextColor],
                    [wipeColorKey, '와이프', s[wipeColorKey]],
                    ['koPronHighlightColor', '발음', s.koPronHighlightColor],
                    ['translationColor', '해석', s.translationColor],
                  ] as Array<[keyof RenderSettings, string, string]>
                ).map(([key, shortLabel, value]) => (
                  <label
                    key={key}
                    title={`${
                      key === wipeColorKey ? wipeColorLabel : shortLabel
                    } 색상 (${value.toUpperCase()})`}
                    className="flex flex-col items-center gap-1 rounded-lg border border-white/[0.08] bg-black/30 p-1.5 cursor-pointer hover:border-white/[0.18] transition"
                  >
                    <input
                      type="color"
                      value={value}
                      onChange={(e) => patchSettings({ [key]: e.target.value })}
                      className="h-4 w-full rounded border border-white/[0.15] bg-transparent cursor-pointer p-0"
                    />
                    <span className="text-[10px] font-medium text-slate-300 leading-none">
                      {shortLabel}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            {/* Compact 2x4 Visual Elements Toggle Grid */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 space-y-2">
              <div className="text-[11px] font-semibold text-slate-200">화면 요소</div>
              <div className="grid grid-cols-2 gap-1.5">
                {elementToggles.map(({ key, label, checked }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => patchSettings({ [key]: !checked })}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[10.5px] font-medium transition ${
                      checked
                        ? 'border-sky-400/40 bg-sky-500/10 text-slate-100'
                        : 'border-white/[0.07] bg-black/25 text-slate-400 hover:border-white/[0.14] hover:text-slate-200'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full shrink-0 transition ${
                        checked
                          ? 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.85)]'
                          : 'bg-white/15'
                      }`}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'lyric' && (
          <div className="space-y-2.5">
            {/* Layout & Alignment */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 space-y-2.5">
              <div className="text-[11px] font-semibold text-slate-200">배치 · 정렬</div>

              <div className="space-y-1">
                <div className="text-[10.5px] font-medium text-slate-400">줄 배치</div>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
                  {(
                    [
                      ['auto', '자동(2~3줄)'],
                      ['2-line', '2줄 교차'],
                      ['3-line', '3줄 교차'],
                    ] as Array<[LayoutMode, string]>
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => patchSettings({ layoutMode: val })}
                      className={`rounded-md py-1.5 text-[10.5px] font-semibold transition ${
                        s.layoutMode === val
                          ? 'bg-white/[0.11] text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[10.5px] font-medium text-slate-400">가로 정렬</div>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
                  {(
                    [
                      ['staggered', '가라오케 교차'],
                      ['center', '중앙 정렬'],
                    ] as Array<['staggered' | 'center', string]>
                  ).map(([val, label]) => {
                    const active = (s.lyricAlign ?? 'staggered') === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => patchSettings({ lyricAlign: val })}
                        className={`rounded-md py-1.5 text-[10.5px] font-semibold transition ${
                          active
                            ? 'bg-white/[0.11] text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-0.5">
                <span className="text-[10.5px] font-medium text-slate-400 whitespace-nowrap">
                  한국어 발음 위치
                </span>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06] w-44">
                  {(
                    [
                      ['below', '일본어 아래'],
                      ['above', '일본어 위'],
                    ] as Array<['below' | 'above', string]>
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => patchSettings({ koPronPosition: val })}
                      className={`rounded-md py-1 text-[10px] font-semibold transition ${
                        s.koPronPosition === val
                          ? 'bg-white/[0.11] text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Size & Lead-in Timing */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 space-y-3">
              <div className="text-[11px] font-semibold text-slate-200">크기 · 등장 타이밍</div>

              <div>
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="text-slate-400">글자 크기</span>
                  <span className="rounded-md border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[10px] text-sky-300">
                    {s.fontScale.toFixed(2)}x
                  </span>
                </div>
                <input
                  type="range"
                  min={0.75}
                  max={1.3}
                  step={0.05}
                  value={s.fontScale}
                  onChange={(e) => patchSettings({ fontScale: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="text-slate-400">미리 등장 시간</span>
                  <span className="rounded-md border border-white/[0.08] bg-black/35 px-1.5 py-0.5 font-mono tabular-nums text-[10px] text-sky-300">
                    {s.leadInSeconds.toFixed(1)}초 전
                  </span>
                </div>
                <input
                  type="range"
                  min={1.0}
                  max={6.0}
                  step={0.5}
                  value={s.leadInSeconds}
                  onChange={(e) => patchSettings({ leadInSeconds: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
            </section>
          </div>
        )}

        {activeTab === 'bg' && (
          <div className="space-y-2.5">
            {/* Background Mode, Loop & Palette */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5 text-sky-400" />
                  배경 설정
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
                {(
                  [
                    ['gradient', '루프 배경'],
                    ['image', '이미지'],
                    ['video', '영상(MV)'],
                  ] as Array<[BackgroundType, string]>
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => patchSettings({ bgType: val })}
                    className={`rounded-md py-1 text-[10.5px] font-semibold transition ${
                      s.bgType === val
                        ? 'bg-white/[0.11] text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {s.bgType === 'gradient' ? (
                <div className="space-y-2">
                  {/* Compact 2x2 Loop Style Tiles */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {LOOP_STYLE_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      const active = currentLoopStyle === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => patchSettings({ bgLoopStyle: opt.id })}
                          title={opt.desc}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
                            active
                              ? 'border-sky-400/50 bg-sky-500/15 text-sky-100'
                              : 'border-white/[0.07] bg-black/30 text-slate-300 hover:border-white/[0.14]'
                          }`}
                        >
                          <Icon
                            className={`h-3.5 w-3.5 shrink-0 ${
                              active ? 'text-sky-400' : 'text-slate-400'
                            }`}
                          />
                          <span className="truncate text-[10.5px] font-semibold">
                            {opt.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Slim CD Cover Upload Bar */}
                  {currentLoopStyle === 'cd-spin' && (
                    <div className="flex items-center gap-1.5">
                      <label className="flex-1 flex items-center justify-between rounded-lg border border-dashed border-white/[0.12] bg-black/30 px-2.5 py-1.5 cursor-pointer hover:border-sky-400/50 transition min-w-0">
                        <span className="text-[10.5px] text-slate-300 truncate pr-2">
                          {s.bgFileName
                            ? `커버: ${s.bgFileName}`
                            : s.albumArtUrl
                            ? '자동 앨범 커버 적용됨'
                            : 'CD 커버 이미지 (선택)'}
                        </span>
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-sky-300">
                          {uploadingBg ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Upload className="h-3 w-3" />
                          )}
                          선택
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => void handleUploadMedia(e, true)}
                          className="hidden"
                        />
                      </label>

                      {(s.bgFileId || s.albumArtUrl) && (
                        <button
                          type="button"
                          onClick={() =>
                            patchSettings({
                              bgFileId: undefined,
                              bgFileName: undefined,
                              albumArtUrl: undefined,
                            })
                          }
                          className="shrink-0 rounded-lg border border-white/[0.08] bg-black/30 p-1.5 text-slate-400 hover:text-rose-400 transition"
                          title="커버 이미지를 비우고 기본 레코드 라벨로 표시"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Gradient Strip + 3 Stops + Ambient Pills */}
                  <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
                    <div
                      className="h-2.5 w-full rounded-full border border-white/10"
                      style={{
                        background: `linear-gradient(90deg, ${s.gradientStops[0]} 0%, ${s.gradientStops[1]} 50%, ${s.gradientStops[2]} 100%)`,
                      }}
                    />

                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          [0, '시작'],
                          [1, '중간'],
                          [2, '끝'],
                        ] as Array<[0 | 1 | 2, string]>
                      ).map(([idx, lbl]) => (
                        <label
                          key={idx}
                          className="flex items-center justify-between gap-1.5 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 text-[10px] text-slate-300 cursor-pointer hover:border-white/[0.15]"
                        >
                          <span>{lbl}</span>
                          <input
                            type="color"
                            value={s.gradientStops[idx]}
                            onChange={(e) => updateGradientStop(idx, e.target.value)}
                            className="h-4 w-5 rounded border-0 bg-transparent cursor-pointer p-0"
                          />
                        </label>
                      ))}
                    </div>

                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {AMBIENT_GRADIENTS.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => patchSettings({ gradientStops: [...g.stops] })}
                          className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/30 px-2 py-0.5 text-[10px] text-slate-300 hover:border-white/[0.18] hover:text-white transition"
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{
                              background: `linear-gradient(135deg, ${g.stops[0]}, ${g.stops[2]})`,
                            }}
                          />
                          <span>{g.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <label className="flex items-center justify-between rounded-lg border border-dashed border-white/[0.12] bg-black/30 px-2.5 py-2 cursor-pointer hover:border-sky-400/50 transition">
                    <span className="text-[11px] text-slate-300 truncate pr-2">
                      {s.bgFileName ||
                        (s.bgType === 'video' ? '배경 영상(MV) 선택' : '배경 이미지 선택')}
                    </span>
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-sky-300">
                      {uploadingBg ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Upload className="h-3 w-3" />
                      )}
                      업로드
                    </span>
                    <input
                      type="file"
                      accept={s.bgType === 'video' ? 'video/*' : 'image/*'}
                      onChange={(e) => void handleUploadMedia(e, false)}
                      className="hidden"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="flex justify-between text-[10.5px] text-slate-400 mb-0.5">
                        <span>어둡기</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {Math.round(s.bgDim * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={0.85}
                        step={0.05}
                        value={s.bgDim}
                        onChange={(e) => patchSettings({ bgDim: Number(e.target.value) })}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10.5px] text-slate-400 mb-0.5">
                        <span>블러</span>
                        <span className="font-mono tabular-nums text-slate-200">{s.bgBlur}px</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={16}
                        step={1}
                        value={s.bgBlur}
                        onChange={(e) => patchSettings({ bgBlur: Number(e.target.value) })}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Compact 2x3 Audio Visualizer Selector */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
                  <AudioWaveform className="h-3.5 w-3.5 text-sky-400" />
                  비주얼라이저
                </span>
                <button
                  type="button"
                  onClick={() => patchSettings({ showVisualizer: !s.showVisualizer })}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                    s.showVisualizer
                      ? 'border-sky-400/45 bg-sky-500/15 text-sky-200'
                      : 'border-white/[0.08] bg-black/30 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      s.showVisualizer ? 'bg-sky-400' : 'bg-slate-500'
                    }`}
                  />
                  {s.showVisualizer ? '켜짐' : '꺼짐'}
                </button>
              </div>

              <div
                className={`grid grid-cols-2 gap-1.5 transition ${
                  s.showVisualizer ? '' : 'opacity-55'
                }`}
              >
                {VISUALIZER_STYLE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = currentVisualizerStyle === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() =>
                        patchSettings({
                          showVisualizer: true,
                          visualizerStyle: opt.id,
                        })
                      }
                      title={opt.desc}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
                        active
                          ? 'border-sky-400/50 bg-sky-500/15 text-sky-100'
                          : 'border-white/[0.07] bg-black/30 text-slate-300 hover:border-white/[0.14]'
                      }`}
                    >
                      <Icon
                        className={`h-3.5 w-3.5 shrink-0 ${
                          active ? 'text-sky-400' : 'text-slate-400'
                        }`}
                      />
                      <span className="truncate text-[10.5px] font-semibold">
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
