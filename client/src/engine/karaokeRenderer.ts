import type {
  KaraokeProject,
  LyricLine,
  LyricSegment,
  RenderSettings,
  SpectrumData,
  VisualizerStyle,
} from '@shared/types';
import { alignFuriganaToKanji } from '@shared/timing';
import { sampleSpectrumAtTime } from './spectrumAnalyzer';

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

const FONT_STACK = `'M PLUS Rounded 1c', 'Noto Sans KR', 'Malgun Gothic', 'Meiryo', sans-serif`;

export interface RenderResources {
  spectrum?: SpectrumData;
  bgImage?: HTMLImageElement | null;
  bgVideo?: HTMLVideoElement | null;
}

interface BokehSeed {
  xFrac: number;
  yFrac: number;
  radius: number;
  speedX: number;
  speedY: number;
  phase: number;
  alpha: number;
  isStar: boolean;
}

const BOKEH_SEEDS: BokehSeed[] = Array.from({ length: 34 }, (_, i) => {
  const s1 = Math.sin(i * 12.9898) * 43758.5453;
  const s2 = Math.sin(i * 78.233 + 1.7) * 24634.6345;
  const s3 = Math.sin(i * 39.425 + 4.1) * 19582.123;
  const r1 = s1 - Math.floor(s1);
  const r2 = s2 - Math.floor(s2);
  const r3 = s3 - Math.floor(s3);
  return {
    xFrac: r1,
    yFrac: r2,
    radius: i < 16 ? 26 + r3 * 88 : 2.5 + r3 * 4.5,
    speedX: (r1 - 0.5) * 0.025,
    speedY: -0.01 - r2 * 0.02,
    phase: r3 * Math.PI * 2,
    alpha: i < 16 ? 0.05 + r3 * 0.09 : 0.28 + r3 * 0.45,
    isStar: i >= 16,
  };
});

export interface PlannedLine {
  line: LyricLine;
  index: number;
  slot: 0 | 1 | 2;
  totalSlots: 2 | 3;
  appearTime: number;
  disappearTime: number;
  hasCountdownBefore: boolean;
  gapBefore: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function parseHexRgb(
  hex: string | undefined,
  fallback: [number, number, number]
): [number, number, number] {
  if (!hex) return fallback;
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function hexToRgba(hex: string | undefined, alpha: number, fallback: string): string {
  if (!hex) return fallback;
  const clean = hex.trim().replace(/^#/, '');
  if (
    !/^[0-9a-fA-F]{3}$/.test(clean) &&
    !/^[0-9a-fA-F]{6}$/.test(clean)
  ) {
    return fallback;
  }
  const [r, g, b] = parseHexRgb(hex, [56, 189, 248]);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lerpColorRgba(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number,
  alpha: number
): string {
  const k = clamp(t, 0, 1);
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * k);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * k);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * k);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function computeLineLayoutPlan(
  lines: LyricLine[],
  settings: RenderSettings
): PlannedLine[] {
  if (!lines.length) return [];

  const leadIn = clamp(settings.leadInSeconds, 1.0, 8.0);
  const forcedSlots = settings.layoutMode === '3-line' ? 3 : settings.layoutMode === '2-line' ? 2 : null;

  // Determine per-line slot density when layoutMode === 'auto'
  const lineSlotCounts: Array<2 | 3> = lines.map((line, i) => {
    if (forcedSlots) return forcedSlots;
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const twoBack = lines[i - 2];
    // Use 3-line staggered mode in dense passages where 2 lines don't leave breathing room
    const densePrev = prev && line.startTime - prev.endTime < 1.35;
    const denseNext = next && next.startTime - line.endTime < 1.35;
    const overlapTwo = twoBack && line.startTime - leadIn < twoBack.endTime + 0.3;
    return (densePrev && denseNext) || overlapTwo ? 3 : 2;
  });

  // Unify slot count across contiguous singing phrases (split at >= 2.8s breaks) so
  // mixed 2-line/3-line templates never collide vertically on centered lyrics.
  if (!forcedSlots) {
    let phraseStart = 0;
    for (let i = 0; i <= lines.length; i++) {
      const atEnd = i === lines.length;
      const gap = !atEnd && i > 0 ? lines[i].startTime - lines[i - 1].endTime : 999;
      if (atEnd || (i > phraseStart && gap >= 2.8)) {
        const hasThree = lineSlotCounts
          .slice(phraseStart, i)
          .some((cnt) => cnt === 3);
        if (hasThree) {
          for (let k = phraseStart; k < i; k++) {
            lineSlotCounts[k] = 3;
          }
        }
        phraseStart = i;
      }
    }
  }

  const slotBusyUntil: [number, number, number] = [-10, -10, -10];
  const plans: PlannedLine[] = [];
  let slotCursor = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const totalSlots = lineSlotCounts[i];
    const prevLine = lines[i - 1];
    const gapBefore = prevLine ? line.startTime - prevLine.endTime : line.startTime;
    const hasCountdownBefore = i === 0 || gapBefore >= settings.countdownThreshold;

    let chosenSlot: 0 | 1 | 2;
    if (line.slot !== undefined && line.slot >= 0 && line.slot < totalSlots) {
      chosenSlot = line.slot;
    } else {
      // Reset to top slot after a long instrumental break
      if (gapBefore >= 5.0) {
        slotCursor = 0;
      }
      chosenSlot = (slotCursor % totalSlots) as 0 | 1 | 2;
      slotCursor = (slotCursor + 1) % totalSlots;
    }

    const effectiveLead = hasCountdownBefore ? Math.max(leadIn, 3.25) : leadIn;
    const desiredAppear = Math.max(0, line.startTime - effectiveLead);
    const minSwapAppear = slotBusyUntil[chosenSlot] + 0.28;
    const appearTime = line.appearTime !== undefined
      ? line.appearTime
      : Math.min(line.startTime - 0.15, Math.max(desiredAppear, minSwapAppear));

    const nextSameSlotHold = 0.55;
    const nextLine = lines[i + 1];
    const disappearTime = nextLine && nextLine.startTime - line.endTime < 0.4
      ? line.endTime + 0.45
      : line.endTime + nextSameSlotHold;

    slotBusyUntil[chosenSlot] = disappearTime;

    plans.push({
      line,
      index: i,
      slot: chosenSlot,
      totalSlots,
      appearTime,
      disappearTime,
      hasCountdownBefore,
      gapBefore,
    });
  }

  return plans;
}

function drawCoverMedia(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement,
  naturalW: number,
  naturalH: number,
  blurPx: number,
  dimAlpha: number
): void {
  if (!naturalW || !naturalH) return;
  const scale = Math.max(STAGE_WIDTH / naturalW, STAGE_HEIGHT / naturalH);
  const drawW = naturalW * scale;
  const drawH = naturalH * scale;
  const dx = (STAGE_WIDTH - drawW) / 2;
  const dy = (STAGE_HEIGHT - drawH) / 2;

  ctx.save();
  if (blurPx > 0) {
    ctx.filter = `blur(${blurPx}px)`;
    // Slight overscan so blurred edges never show dark border
    ctx.drawImage(media, dx - blurPx * 2, dy - blurPx * 2, drawW + blurPx * 4, drawH + blurPx * 4);
  } else {
    ctx.drawImage(media, dx, dy, drawW, drawH);
  }
  ctx.restore();

  if (dimAlpha > 0) {
    ctx.fillStyle = `rgba(5, 8, 18, ${clamp(dimAlpha, 0, 0.9)})`;
    ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  }

  // Subtle top/bottom vignette for lyrics legibility
  const vig = ctx.createLinearGradient(0, 0, 0, STAGE_HEIGHT);
  vig.addColorStop(0, 'rgba(4, 8, 18, 0.48)');
  vig.addColorStop(0.25, 'rgba(4, 8, 18, 0.08)');
  vig.addColorStop(0.75, 'rgba(4, 8, 18, 0.10)');
  vig.addColorStop(1, 'rgba(4, 8, 18, 0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
}

function drawSpinningCdLoop(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  resources: RenderResources
): void {
  const cx = STAGE_WIDTH / 2;
  const cy = STAGE_HEIGHT / 2;
  const outerR = 326;
  const labelR = 206;
  const hubR = 46;
  const holeR = 17;
  const angle = time * 0.55;

  // Optional soft blurred album cover atmosphere in the background
  const hasImg = Boolean(
    resources.bgImage &&
      resources.bgImage.complete &&
      resources.bgImage.naturalWidth > 0
  );
  if (hasImg && resources.bgImage) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    drawCoverMedia(
      ctx,
      resources.bgImage,
      resources.bgImage.naturalWidth,
      resources.bgImage.naturalHeight,
      14,
      0.35
    );
    ctx.restore();
  }

  // Audio-reactive outer halo pulse
  const specVals = sampleSpectrumAtTime(resources.spectrum, time, 24);
  let avgEnergy = 0;
  for (let i = 0; i < specVals.length; i++) avgEnergy += specVals[i];
  avgEnergy /= Math.max(1, specVals.length);

  ctx.save();
  const haloR = outerR + 34 + avgEnergy * 42;
  const halo = ctx.createRadialGradient(cx, cy, outerR * 0.82, cx, cy, haloR);
  halo.addColorStop(
    0,
    hexToRgba(settings.highlightStrokeColor, 0.26 + avgEnergy * 0.18, 'rgba(56,189,248,0.28)')
  );
  halo.addColorStop(
    0.55,
    hexToRgba(settings.koPronHighlightColor, 0.11, 'rgba(250,204,21,0.10)')
  );
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fill();

  // Outer vinyl / CD platter base
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  const discGrad = ctx.createRadialGradient(cx - 60, cy - 60, 30, cx, cy, outerR);
  discGrad.addColorStop(0, '#1e293b');
  discGrad.addColorStop(0.55, '#0b1120');
  discGrad.addColorStop(1, '#040711');
  ctx.fillStyle = discGrad;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexToRgba(
    settings.highlightStrokeColor,
    0.45,
    'rgba(125, 211, 252, 0.45)'
  );
  ctx.stroke();

  // Concentric vinyl micro-grooves
  for (let r = labelR + 14; r <= outerR - 10; r += 11) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle =
      r % 22 === 0 ? 'rgba(255, 255, 255, 0.08)' : 'rgba(148, 163, 184, 0.04)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Iridescent rotating CD optical sheen wedges on the vinyl rim
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  for (const offsetAngle of [0, Math.PI]) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, outerR - 3, offsetAngle - 0.34, offsetAngle + 0.34);
    ctx.closePath();
    const sheen = ctx.createRadialGradient(0, 0, labelR * 0.5, 0, 0, outerR);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(
      0.55,
      hexToRgba(settings.highlightStrokeColor, 0.16, 'rgba(56, 189, 248, 0.16)')
    );
    sheen.addColorStop(
      0.82,
      hexToRgba(settings.koPronHighlightColor, 0.14, 'rgba(244, 114, 182, 0.14)')
    );
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = sheen;
    ctx.fill();
  }
  ctx.restore();

  // Rotating circular album cover / procedural disc art
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, labelR, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  if (hasImg && resources.bgImage) {
    const img = resources.bgImage;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max((labelR * 2) / iw, (labelR * 2) / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else {
    // Rich procedural record art when no image is loaded
    const [c1, c2, c3] = settings.gradientStops;
    const artGrad = ctx.createLinearGradient(-labelR, -labelR, labelR, labelR);
    artGrad.addColorStop(0, c1);
    artGrad.addColorStop(0.5, settings.highlightStrokeColor);
    artGrad.addColorStop(1, c3 || c2);
    ctx.fillStyle = artGrad;
    ctx.fillRect(-labelR, -labelR, labelR * 2, labelR * 2);

    // Decorative vinyl label rings & crosshairs
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    for (const rr of [labelR * 0.82, labelR * 0.58, labelR * 0.36]) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(-labelR, -2, labelR * 2, 4);
  }
  ctx.restore();

  // Crisp inner label border ring
  ctx.beginPath();
  ctx.arc(cx, cy, labelR, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.stroke();

  // Center acrylic hub ring & dark spindle hole
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
  ctx.fillStyle = '#030712';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.stroke();

  // Soft dark radial scrim over the disc so foreground lyrics always pop
  const scrim = ctx.createRadialGradient(cx, cy, 30, cx, cy, outerR + 40);
  scrim.addColorStop(0, 'rgba(4, 8, 18, 0.44)');
  scrim.addColorStop(0.75, 'rgba(4, 8, 18, 0.34)');
  scrim.addColorStop(1, 'rgba(4, 8, 18, 0)');
  ctx.fillStyle = scrim;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAuroraWaveLoop(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number
): void {
  ctx.save();
  const colors = [
    hexToRgba(settings.highlightStrokeColor, 0.22, 'rgba(56, 189, 248, 0.22)'),
    hexToRgba(settings.koPronHighlightColor, 0.16, 'rgba(250, 204, 21, 0.16)'),
    hexToRgba(settings.highlightTextColor, 0.18, 'rgba(52, 211, 153, 0.18)'),
  ];

  for (let w = 0; w < 3; w++) {
    const baseY = STAGE_HEIGHT * (0.36 + w * 0.16);
    const amp1 = 55 + w * 18;
    const amp2 = 28 + w * 12;
    const speed = (0.55 + w * 0.22) * (w % 2 === 0 ? 1 : -1);

    ctx.beginPath();
    ctx.moveTo(0, STAGE_HEIGHT);
    for (let x = 0; x <= STAGE_WIDTH; x += 32) {
      const nx = x / STAGE_WIDTH;
      const y =
        baseY +
        Math.sin(nx * Math.PI * 2.4 + time * speed) * amp1 +
        Math.cos(nx * Math.PI * 4.2 - time * speed * 0.7) * amp2;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(STAGE_WIDTH, STAGE_HEIGHT);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, baseY - 120, 0, STAGE_HEIGHT);
    grad.addColorStop(0, colors[w]);
    grad.addColorStop(0.65, 'rgba(15, 23, 42, 0.05)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();
}

function drawNeonRingsLoop(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  resources: RenderResources
): void {
  const cx = STAGE_WIDTH / 2;
  const cy = STAGE_HEIGHT / 2;
  const spec = sampleSpectrumAtTime(resources.spectrum, time, 48);

  ctx.save();
  ctx.translate(cx, cy);

  // Concentric rotating cyber rings
  const radii = [210, 285, 365];
  radii.forEach((r, idx) => {
    ctx.save();
    ctx.rotate(time * (idx % 2 === 0 ? 0.22 : -0.18) + idx);
    ctx.setLineDash(idx === 1 ? [18, 14] : [36, 18]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle =
      idx % 2 === 0
        ? hexToRgba(settings.highlightStrokeColor, 0.34, 'rgba(56, 189, 248, 0.34)')
        : hexToRgba(settings.koPronHighlightColor, 0.28, 'rgba(244, 114, 182, 0.28)');
    ctx.lineWidth = idx === 0 ? 3 : 2;
    ctx.stroke();
    ctx.restore();
  });

  // Radial spectrum rays around the inner ring
  const nRays = 48;
  for (let i = 0; i < nRays; i++) {
    const a = (i / nRays) * Math.PI * 2 + time * 0.12;
    const v = spec[i] ?? 0.15;
    const r0 = 222;
    const r1 = r0 + 14 + v * 72;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.strokeStyle = hexToRgba(
      settings.highlightStrokeColor,
      0.28 + v * 0.45,
      'rgba(56, 189, 248, 0.45)'
    );
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  ctx.restore();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  resources: RenderResources
): void {
  if (settings.bgType === 'image' && resources.bgImage && resources.bgImage.complete) {
    drawCoverMedia(
      ctx,
      resources.bgImage,
      resources.bgImage.naturalWidth,
      resources.bgImage.naturalHeight,
      settings.bgBlur,
      settings.bgDim
    );
    return;
  }

  if (
    settings.bgType === 'video' &&
    resources.bgVideo &&
    resources.bgVideo.readyState >= 2 &&
    resources.bgVideo.videoWidth > 0
  ) {
    drawCoverMedia(
      ctx,
      resources.bgVideo,
      resources.bgVideo.videoWidth,
      resources.bgVideo.videoHeight,
      settings.bgBlur,
      settings.bgDim
    );
    return;
  }

  // Base animated 3-stop karaoke gradient
  const [c1, c2, c3] = settings.gradientStops;
  const shift = Math.sin(time * 0.18) * 140;
  const grad = ctx.createLinearGradient(shift, 0, STAGE_WIDTH - shift, STAGE_HEIGHT);
  grad.addColorStop(0, c1);
  grad.addColorStop(0.52, c2);
  grad.addColorStop(1, c3);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  // Subtle ambient radial sheen tinted to active theme accent
  const sheenX = STAGE_WIDTH * (0.5 + 0.18 * Math.sin(time * 0.25));
  const sheenY = STAGE_HEIGHT * (0.45 + 0.12 * Math.cos(time * 0.2));
  const rad = ctx.createRadialGradient(sheenX, sheenY, 40, sheenX, sheenY, 820);
  rad.addColorStop(
    0,
    hexToRgba(settings.highlightStrokeColor, 0.13, 'rgba(56, 189, 248, 0.12)')
  );
  rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  // Animated background loop visual style
  const loopStyle = settings.bgLoopStyle ?? 'cd-spin';
  if (loopStyle === 'cd-spin') {
    drawSpinningCdLoop(ctx, settings, time, resources);
  } else if (loopStyle === 'aurora-wave') {
    drawAuroraWaveLoop(ctx, settings, time);
  } else if (loopStyle === 'neon-rings') {
    drawNeonRingsLoop(ctx, settings, time, resources);
  }

  // Deterministic drifting bokeh + starlight particles
  if (settings.showParticles !== false) {
    ctx.save();
    for (const b of BOKEH_SEEDS) {
      const x = (((b.xFrac + time * b.speedX) % 1) + 1) % 1 * STAGE_WIDTH;
      const y = (((b.yFrac + time * b.speedY) % 1) + 1) % 1 * STAGE_HEIGHT;
      const pulse = 0.72 + 0.28 * Math.sin(time * 1.4 + b.phase);
      const alpha = b.alpha * pulse;

      if (!b.isStar) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, b.radius);
        g.addColorStop(0, `rgba(186, 230, 253, ${alpha})`);
        g.addColorStop(0.65, `rgba(125, 211, 252, ${alpha * 0.35})`);
        g.addColorStop(1, 'rgba(125, 211, 252, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, b.radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, b.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function getVisualizerPalette(settings: RenderSettings) {
  const accentHex1 =
    settings.wipeStyle === 'fill-wipe'
      ? settings.highlightTextColor || '#38BDF8'
      : settings.highlightStrokeColor || '#38BDF8';
  const accentHex2 = settings.koPronHighlightColor || '#FFD54F';
  return {
    accentHex1,
    accentHex2,
    rgb1: parseHexRgb(accentHex1, [56, 189, 248]),
    rgb2: parseHexRgb(accentHex2, [255, 213, 79]),
  };
}

function drawRadialCdVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const halfBands = 48;
  const raw = sampleSpectrumAtTime(spectrum, time, halfBands);
  const totalBars = halfBands * 2; // 96 mirrored symmetrical radial rays
  const cx = STAGE_WIDTH / 2;
  const cy = STAGE_HEIGHT / 2;
  const r0 = 336;
  const rot = time * 0.08;
  const { rgb1, rgb2 } = getVisualizerPalette(settings);

  ctx.save();
  ctx.translate(cx, cy);

  // Subtle base ring hugging the CD rim
  ctx.beginPath();
  ctx.arc(0, 0, r0 - 4, 0, Math.PI * 2);
  ctx.strokeStyle = lerpColorRgba(rgb1, rgb2, 0.25, 0.28);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.lineCap = 'round';
  for (let i = 0; i < totalBars; i++) {
    const mirrorIdx = i < halfBands ? i : totalBars - 1 - i;
    const v = raw[mirrorIdx] ?? 0;
    const t = mirrorIdx / Math.max(1, halfBands - 1);
    const angle = (i / totalBars) * Math.PI * 2 - Math.PI / 2 + rot;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const barLen = 10 + v * 124;
    const r1 = r0 + barLen;

    ctx.strokeStyle = lerpColorRgba(rgb1, rgb2, t, 0.36 + v * 0.56);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cos * r0, sin * r0);
    ctx.lineTo(cos * r1, sin * r1);
    ctx.stroke();

    if (v > 0.18) {
      const dotR = r1 + 10;
      ctx.fillStyle = lerpColorRgba(rgb1, rgb2, t, 0.55 + v * 0.4);
      ctx.beginPath();
      ctx.arc(cos * dotR, sin * dotR, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBottomBarsVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const bands = 64;
  const values = sampleSpectrumAtTime(spectrum, time, bands);
  const marginX = 72;
  const usableW = STAGE_WIDTH - marginX * 2;
  const slotW = usableW / bands;
  const barW = Math.max(8, slotW * 0.64);
  const baseY = STAGE_HEIGHT - 8;
  const maxH = 92;
  const { rgb1, rgb2 } = getVisualizerPalette(settings);

  ctx.save();
  for (let i = 0; i < bands; i++) {
    const v = values[i];
    const t = i / Math.max(1, bands - 1);
    const h = 4 + v * maxH;
    const x = marginX + i * slotW + (slotW - barW) / 2;
    const y = baseY - h;

    ctx.fillStyle = lerpColorRgba(rgb1, rgb2, t, 0.32 + v * 0.48);
    roundRectPath(ctx, x, y, barW, h, 4);
    ctx.fill();

    ctx.fillStyle = lerpColorRgba(rgb1, rgb2, t, 0.65 + v * 0.35);
    ctx.fillRect(x, y, barW, 3);
  }
  ctx.restore();
}

function drawMirrorWaveVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const halfBands = 36;
  const raw = sampleSpectrumAtTime(spectrum, time, halfBands);
  const totalCols = halfBands * 2;
  const marginX = 110;
  const usableW = STAGE_WIDTH - marginX * 2;
  const slotW = usableW / totalCols;
  const barW = Math.max(6, slotW * 0.62);
  const centerY = STAGE_HEIGHT - 62;
  const { rgb1, rgb2 } = getVisualizerPalette(settings);

  ctx.save();
  // Hairline horizon baseline
  ctx.fillStyle = lerpColorRgba(rgb1, rgb2, 0.5, 0.22);
  ctx.fillRect(marginX, centerY - 0.5, usableW, 1);

  for (let i = 0; i < totalCols; i++) {
    // Low frequencies punch in the center and taper outward symmetrically
    const distFromCenter =
      i < halfBands ? halfBands - 1 - i : i - halfBands;
    const v = raw[distFromCenter] ?? 0;
    const t = distFromCenter / Math.max(1, halfBands - 1);
    const upH = 4 + v * 54;
    const downH = 3 + v * 28;
    const x = marginX + i * slotW + (slotW - barW) / 2;

    ctx.fillStyle = lerpColorRgba(rgb1, rgb2, t, 0.42 + v * 0.48);
    roundRectPath(ctx, x, centerY - upH, barW, upH, 3);
    ctx.fill();

    ctx.fillStyle = lerpColorRgba(rgb1, rgb2, t, 0.16 + v * 0.22);
    roundRectPath(ctx, x, centerY + 2, barW, downH, 3);
    ctx.fill();
  }
  ctx.restore();
}

function drawSilkRibbonVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const bands = 40;
  const raw = sampleSpectrumAtTime(spectrum, time, bands);
  const baseY = STAGE_HEIGHT - 6;
  const marginX = 48;
  const spanW = STAGE_WIDTH - marginX * 2;
  const { accentHex1, accentHex2, rgb1, rgb2 } = getVisualizerPalette(settings);

  const layers = [
    { amp: 135, freq: 0.9, phase: 0, fillAlpha: 0.16, strokeAlpha: 0.55, mix: 0.1 },
    { amp: 105, freq: 1.35, phase: 1.9, fillAlpha: 0.14, strokeAlpha: 0.5, mix: 0.55 },
    { amp: 76, freq: 1.85, phase: 3.7, fillAlpha: 0.12, strokeAlpha: 0.65, mix: 0.9 },
  ];

  ctx.save();
  for (let l = 0; l < layers.length; l++) {
    const cfg = layers[l];
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= bands; i++) {
      const idx = Math.min(bands - 1, i);
      const prev = raw[Math.max(0, idx - 1)] ?? 0;
      const cur = raw[idx] ?? 0;
      const nxt = raw[Math.min(bands - 1, idx + 1)] ?? 0;
      const smoothed = prev * 0.25 + cur * 0.5 + nxt * 0.25;
      const nx = i / bands;
      const ripple = 0.72 + 0.28 * Math.sin(nx * Math.PI * 3.5 * cfg.freq + time * 2.2 + cfg.phase);
      const h = 10 + smoothed * cfg.amp * ripple;
      pts.push({ x: marginX + nx * spanW, y: baseY - h });
    }

    // Stroke path
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) * 0.5;
      const my = (pts[i].y + pts[i + 1].y) * 0.5;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const lastPt = pts[pts.length - 1];
    ctx.lineTo(lastPt.x, lastPt.y);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle =
      l === 2
        ? 'rgba(224, 242, 254, 0.65)'
        : lerpColorRgba(rgb1, rgb2, cfg.mix, cfg.strokeAlpha);
    ctx.stroke();

    // Fill area down to baseY
    ctx.lineTo(lastPt.x, baseY);
    ctx.lineTo(pts[0].x, baseY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, baseY - cfg.amp, 0, baseY);
    grad.addColorStop(
      0,
      l === 2
        ? hexToRgba(accentHex2, cfg.fillAlpha, 'rgba(255,213,79,0.14)')
        : hexToRgba(accentHex1, cfg.fillAlpha, 'rgba(56,189,248,0.16)')
    );
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();
}

function drawDotMatrixVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const cols = 48;
  const rows = 10;
  const raw = sampleSpectrumAtTime(spectrum, time, cols);
  const marginX = 76;
  const usableW = STAGE_WIDTH - marginX * 2;
  const slotW = usableW / cols;
  const cellW = Math.max(10, slotW * 0.66);
  const cellH = 6;
  const gapY = 4;
  const baseY = STAGE_HEIGHT - 12;
  const { rgb1, rgb2 } = getVisualizerPalette(settings);

  ctx.save();
  for (let i = 0; i < cols; i++) {
    const v = raw[i] ?? 0;
    const t = i / Math.max(1, cols - 1);
    const activeRows = Math.max(1, Math.round(v * rows));
    const x = marginX + i * slotW + (slotW - cellW) / 2;

    for (let r = 0; r < activeRows; r++) {
      const y = baseY - (r + 1) * (cellH + gapY);
      const isPeak = r === activeRows - 1;
      const rowAlpha = isPeak ? 0.92 : 0.22 + (r / rows) * 0.45;
      ctx.fillStyle = isPeak
        ? lerpColorRgba(rgb1, [255, 255, 255], 0.45, rowAlpha)
        : lerpColorRgba(rgb1, rgb2, t, rowAlpha);
      roundRectPath(ctx, x, y, cellW, cellH, 3);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawDualRingVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const samples = 72;
  const half = samples / 2;
  const raw = sampleSpectrumAtTime(spectrum, time, half);
  const cx = STAGE_WIDTH / 2;
  const cy = STAGE_HEIGHT / 2;
  const baseR = 342;
  const { rgb1, rgb2 } = getVisualizerPalette(settings);

  const ringConfigs = [
    { radiusOffset: 0, amp: 88, rot: time * 0.14, color: rgb1, alpha: 0.72, lw: 3.5 },
    { radiusOffset: -8, amp: 58, rot: -time * 0.18 + 0.5, color: rgb2, alpha: 0.58, lw: 2.5 },
  ];

  ctx.save();
  ctx.translate(cx, cy);

  for (const cfg of ringConfigs) {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < samples; i++) {
      const m = i < half ? i : samples - 1 - i;
      const prev = raw[Math.max(0, m - 1)] ?? 0;
      const cur = raw[m] ?? 0;
      const nxt = raw[Math.min(half - 1, m + 1)] ?? 0;
      const smoothV = prev * 0.25 + cur * 0.5 + nxt * 0.25;
      const a = (i / samples) * Math.PI * 2 + cfg.rot;
      const harmonic = Math.sin(a * 6 + time * 2.4) * 5;
      const r = baseR + cfg.radiusOffset + smoothV * cfg.amp + harmonic;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }

    ctx.beginPath();
    const last = pts[pts.length - 1];
    const startMidX = (last.x + pts[0].x) * 0.5;
    const startMidY = (last.y + pts[0].y) * 0.5;
    ctx.moveTo(startMidX, startMidY);
    for (let i = 0; i < pts.length; i++) {
      const curPt = pts[i];
      const nextPt = pts[(i + 1) % pts.length];
      ctx.quadraticCurveTo(
        curPt.x,
        curPt.y,
        (curPt.x + nextPt.x) * 0.5,
        (curPt.y + nextPt.y) * 0.5
      );
    }
    ctx.closePath();

    ctx.shadowColor = lerpColorRgba(cfg.color, cfg.color, 0, 0.55);
    ctx.shadowBlur = 14;
    ctx.strokeStyle = lerpColorRgba(cfg.color, cfg.color, 0, cfg.alpha);
    ctx.lineWidth = cfg.lw;
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = lerpColorRgba(cfg.color, cfg.color, 0, 0.045);
    ctx.fill();
  }

  ctx.restore();
}

function drawVisualizer(
  ctx: CanvasRenderingContext2D,
  settings: RenderSettings,
  time: number,
  spectrum?: SpectrumData
): void {
  const style: VisualizerStyle = settings.visualizerStyle ?? 'cd-radial';
  if (style === 'cd-radial') {
    drawRadialCdVisualizer(ctx, settings, time, spectrum);
  } else if (style === 'mirror-wave') {
    drawMirrorWaveVisualizer(ctx, settings, time, spectrum);
  } else if (style === 'silk-ribbon') {
    drawSilkRibbonVisualizer(ctx, settings, time, spectrum);
  } else if (style === 'floating-dots') {
    drawDotMatrixVisualizer(ctx, settings, time, spectrum);
  } else if (style === 'dual-ring') {
    drawDualRingVisualizer(ctx, settings, time, spectrum);
  } else {
    drawBottomBarsVisualizer(ctx, settings, time, spectrum);
  }
}

interface MeasuredSegmentLayout {
  seg: LyricSegment;
  colX: number;
  colW: number;
  jpX: number;
  jpW: number;
  koX: number;
  koW: number;
  rubyItems: Array<{ text: string; centerX: number }>;
}

interface MeasuredLineLayout {
  segments: MeasuredSegmentLayout[];
  totalW: number;
  scale: number;
  jpFontPx: number;
  rubyFontPx: number;
  koPronFontPx: number;
  transFontPx: number;
  rubyOffsetY: number;
  koOffsetY: number;
  transOffsetY: number;
}

function measureLineLayout(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  settings: RenderSettings,
  maxWidth: number
): MeasuredLineLayout {
  const fScale = clamp(settings.fontScale, 0.72, 1.35);
  const baseJpPx = Math.round(58 * fScale);
  const baseRubyPx = Math.round(24 * fScale);
  const baseKoPx = Math.round(37 * fScale);
  const baseTransPx = Math.round(28 * fScale);
  const segGap = Math.round(22 * fScale);

  const measureAtScale = (fitScale: number) => {
    const jpFontPx = Math.round(baseJpPx * fitScale);
    const rubyFontPx = Math.round(baseRubyPx * fitScale);
    const koPronFontPx = Math.round(baseKoPx * fitScale);
    const transFontPx = Math.round(baseTransPx * fitScale);
    const gap = Math.round(segGap * fitScale);

    const items: MeasuredSegmentLayout[] = [];
    let cursorX = 0;

    for (let idx = 0; idx < line.segments.length; idx++) {
      const seg = line.segments[idx];
      ctx.font = `900 ${jpFontPx}px ${FONT_STACK}`;
      const jpW = ctx.measureText(seg.jp).width;

      let koW = 0;
      if (settings.showKoPron && seg.koPron) {
        ctx.font = `800 ${koPronFontPx}px ${FONT_STACK}`;
        koW = ctx.measureText(seg.koPron).width;
      }

      const colW = Math.max(jpW, koW);
      const jpX = cursorX + (colW - jpW) / 2;
      const koX = cursorX + (colW - koW) / 2;

      const rubyItems: Array<{ text: string; centerX: number }> = [];
      if (settings.showFurigana && seg.ruby) {
        const spans = alignFuriganaToKanji(seg.jp, seg.ruby);
        const chars = Array.from(seg.jp);
        ctx.font = `900 ${jpFontPx}px ${FONT_STACK}`;
        for (const sp of spans) {
          const pre = chars.slice(0, sp.startIndex).join('');
          const mid = chars.slice(sp.startIndex, sp.endIndex).join('');
          const preW = ctx.measureText(pre).width;
          const midW = ctx.measureText(mid).width;
          rubyItems.push({
            text: sp.ruby,
            centerX: jpX + preW + midW / 2,
          });
        }
      }

      items.push({
        seg,
        colX: cursorX,
        colW,
        jpX,
        jpW,
        koX,
        koW,
        rubyItems,
      });

      cursorX += colW + (idx < line.segments.length - 1 ? gap : 0);
    }

    const koAbove = settings.showKoPron && settings.koPronPosition === 'above';
    const rubyOffsetY = koAbove
      ? -(jpFontPx * 0.72 + rubyFontPx * 0.75)
      : -(jpFontPx * 0.68 + rubyFontPx * 0.52);

    const koOffsetY = !settings.showKoPron
      ? 0
      : koAbove
      ? -(jpFontPx * 0.82 + (settings.showFurigana ? rubyFontPx * 1.15 : 0) + koPronFontPx * 0.78)
      : jpFontPx * 0.8 + koPronFontPx * 0.5;

    const transOffsetY =
      jpFontPx * 0.78 +
      (settings.showKoPron && !koAbove ? koPronFontPx * 1.42 : 0) +
      transFontPx * 0.95;

    return {
      segments: items,
      totalW: cursorX,
      scale: fitScale,
      jpFontPx,
      rubyFontPx,
      koPronFontPx,
      transFontPx,
      rubyOffsetY,
      koOffsetY,
      transOffsetY,
    };
  };

  const firstPass = measureAtScale(1);
  if (firstPass.totalW <= maxWidth || firstPass.totalW === 0) {
    return firstPass;
  }
  const fit = clamp(maxWidth / firstPass.totalW, 0.54, 1);
  return measureAtScale(fit);
}

function drawStrokedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  stroke: string,
  lineWidth: number,
  glowColor?: string
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (glowColor) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 14;
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.strokeText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawLyricPass(
  ctx: CanvasRenderingContext2D,
  layout: MeasuredLineLayout,
  startX: number,
  baseY: number,
  settings: RenderSettings,
  highlighted: boolean
): void {
  const jpFill = highlighted ? settings.highlightTextColor : settings.baseTextColor;
  const jpStroke = highlighted ? settings.highlightStrokeColor : settings.baseStrokeColor;
  const jpGlow =
    highlighted && settings.wipeStyle === 'stroke-glow'
      ? settings.highlightStrokeColor
      : undefined;

  const koFill = highlighted ? settings.koPronHighlightColor : settings.koPronBaseColor;
  const koStroke = highlighted ? 'rgba(5, 10, 24, 0.98)' : settings.baseStrokeColor;

  ctx.textBaseline = 'middle';

  for (const item of layout.segments) {
    // 1. Original Japanese
    ctx.font = `900 ${layout.jpFontPx}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    drawStrokedText(
      ctx,
      item.seg.jp,
      startX + item.jpX,
      baseY,
      jpFill,
      jpStroke,
      Math.max(7, layout.jpFontPx * 0.2),
      jpGlow
    );

    // 2. Furigana (ruby) over kanji only
    if (settings.showFurigana && item.rubyItems.length > 0) {
      ctx.font = `800 ${layout.rubyFontPx}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      for (const r of item.rubyItems) {
        drawStrokedText(
          ctx,
          r.text,
          startX + r.centerX,
          baseY + layout.rubyOffsetY,
          jpFill,
          jpStroke,
          Math.max(4, layout.rubyFontPx * 0.24),
          jpGlow
        );
      }
    }

    // 3. Korean pronunciation aligned per segment
    if (settings.showKoPron && item.seg.koPron) {
      ctx.font = `800 ${layout.koPronFontPx}px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      drawStrokedText(
        ctx,
        item.seg.koPron,
        startX + item.koX,
        baseY + layout.koOffsetY,
        koFill,
        koStroke,
        Math.max(4.5, layout.koPronFontPx * 0.24),
        highlighted ? settings.koPronHighlightColor : undefined
      );
    }
  }
}

function computeLineWipeX(
  layout: MeasuredLineLayout,
  startX: number,
  time: number,
  line: LyricLine
): number {
  if (time <= line.startTime) return startX - 20;
  if (time >= line.endTime) return startX + layout.totalW + 40;

  for (let i = 0; i < layout.segments.length; i++) {
    const item = layout.segments[i];
    const seg = item.seg;
    const segLeft = startX + item.colX;
    const segRight = segLeft + item.colW;

    if (time < seg.startTime) {
      return i === 0 ? startX - 10 : startX + layout.segments[i - 1].colX + layout.segments[i - 1].colW;
    }
    if (time <= seg.endTime) {
      const p = clamp(
        (time - seg.startTime) / Math.max(0.05, seg.endTime - seg.startTime),
        0,
        1
      );
      return segLeft + item.colW * p;
    }
    if (i === layout.segments.length - 1) {
      return segRight + 20;
    }
  }
  return startX + layout.totalW + 20;
}

function drawCountdownIndicator(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  secondsLeft: number
): void {
  if (secondsLeft < -0.2 || secondsLeft > 3.05) return;

  const isZeroBeat = secondsLeft <= 0;
  const beatCount = isZeroBeat ? 0 : Math.min(3, Math.max(1, Math.ceil(secondsLeft)));
  const label = String(beatCount);
  const remainingFrac = clamp(secondsLeft / 3.0, 0, 1);
  const fadeAlpha = isZeroBeat ? clamp((secondsLeft + 0.2) / 0.2, 0, 1) : 1;

  // Gentle pulse right when each 3, 2, 1 beat triggers
  const beatFrac = isZeroBeat ? 1 - fadeAlpha : 1 - (secondsLeft - Math.floor(secondsLeft));
  const beatPop = beatFrac < 0.22 ? 1 + (0.22 - beatFrac) * 0.75 : 1;

  const dotCount = 3;
  const spacing = 24;
  const pillW = dotCount * spacing + 54;
  const pillH = 34;

  ctx.save();
  ctx.globalAlpha *= fadeAlpha;
  ctx.fillStyle = isZeroBeat ? 'rgba(14, 116, 144, 0.85)' : 'rgba(8, 15, 34, 0.78)';
  roundRectPath(ctx, anchorX, anchorY - pillH / 2, pillW, pillH, 17);
  ctx.fill();
  ctx.strokeStyle = isZeroBeat ? 'rgba(56, 189, 248, 0.85)' : 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 3 dots counting down right-to-left (3 lit -> 2 lit -> 1 lit -> 0)
  for (let i = 0; i < dotCount; i++) {
    const dx = anchorX + 20 + i * spacing;
    const dy = anchorY;
    const lit = i < beatCount;
    ctx.beginPath();
    ctx.arc(dx, dy, lit ? 6.5 * (i === beatCount - 1 ? beatPop : 1) : 4.5, 0, Math.PI * 2);
    if (lit) {
      const isLastDot = beatCount === 1 && i === 0;
      ctx.fillStyle = isLastDot ? '#FF4D94' : '#38BDF8';
      ctx.shadowColor = isLastDot ? '#FF4D94' : '#38BDF8';
      ctx.shadowBlur = 11;
    } else {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.30)';
      ctx.shadowBlur = 0;
    }
    ctx.fill();
  }

  // Exact 3 -> 2 -> 1 -> 0 counter
  ctx.shadowBlur = isZeroBeat ? 12 : 0;
  ctx.shadowColor = '#38BDF8';
  ctx.font = `900 ${Math.round(19 * beatPop)}px ${FONT_STACK}`;
  ctx.fillStyle = isZeroBeat ? '#67E8F9' : beatCount === 1 ? '#FF80B5' : '#F8FAFC';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, anchorX + pillW - 14, anchorY + 1);

  // Depleting 3s->0s bar (hits 0 width at exact line.startTime)
  ctx.shadowBlur = 0;
  ctx.fillStyle = beatCount === 1 ? 'rgba(255, 77, 148, 0.92)' : 'rgba(56, 189, 248, 0.92)';
  ctx.fillRect(anchorX + 10, anchorY + pillH / 2 - 3.5, (pillW - 20) * remainingFrac, 2.5);
  ctx.restore();
}

function drawLyricsStage(
  ctx: CanvasRenderingContext2D,
  project: KaraokeProject,
  time: number
): void {
  const { lines, settings } = project;
  if (!lines.length) return;

  const plans = computeLineLayoutPlan(lines, settings);

  // Check long instrumental interlude badge (only when no line is actively singing)
  const isAnyLineSinging = plans.some(
    (p) => time >= p.line.startTime - 0.1 && time <= p.line.endTime + 0.1
  );
  const nextLine = plans.find((p) => p.line.startTime > time);
  const prevLine = [...plans].reverse().find((p) => p.line.endTime <= time);
  if (!isAnyLineSinging && nextLine && settings.showCountdown) {
    const gap = prevLine ? nextLine.line.startTime - prevLine.line.endTime : nextLine.line.startTime;
    const rem = nextLine.line.startTime - time;
    if (gap >= 8.5 && rem > 3.1 && (!prevLine || time - prevLine.line.endTime > 1.3)) {
      ctx.save();
      const pillW = 420;
      const pillH = 52;
      const px = (STAGE_WIDTH - pillW) / 2;
      const py = 540;
      ctx.fillStyle = 'rgba(7, 13, 30, 0.65)';
      roundRectPath(ctx, px, py, pillW, pillH, 26);
      ctx.fill();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = `700 24px ${FONT_STACK}`;
      ctx.fillStyle = '#E0F2FE';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`♪ 간주 중 · 다음 가사까지 ${Math.ceil(rem)}초`, STAGE_WIDTH / 2, py + pillH / 2);
      ctx.restore();
    }
  }

  for (const plan of plans) {
    if (time < plan.appearTime || time > plan.disappearTime) continue;

    // Fade in / out envelope
    const fadeIn = clamp((time - plan.appearTime) / 0.26, 0, 1);
    const fadeOut = clamp((plan.disappearTime - time) / 0.28, 0, 1);
    const alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0.01) continue;

    const slotMaxWidth = plan.totalSlots === 2 ? 1420 : 1340;
    const layout = measureLineLayout(ctx, plan.line, settings, slotMaxWidth);

    // Slot vertical & horizontal placement (clean full stage without top pitch guide)
    let baseY: number;
    let startX: number;

    if (plan.totalSlots === 2) {
      baseY = plan.slot === 0 ? 375 : 675;
      if (settings.lyricAlign === 'center') {
        startX = Math.max(80, (STAGE_WIDTH - layout.totalW) / 2);
      } else if (plan.slot === 0) {
        startX = 160; // Left-aligned top line
      } else {
        startX = Math.max(180, 1760 - layout.totalW); // Right-aligned bottom line
      }
    } else {
      baseY = plan.slot === 0 ? 255 : plan.slot === 1 ? 525 : 795;
      if (settings.lyricAlign === 'center' || plan.slot === 1) {
        startX = Math.max(80, (STAGE_WIDTH - layout.totalW) / 2);
      } else if (plan.slot === 0) {
        startX = 140;
      } else {
        startX = Math.max(180, 1780 - layout.totalW);
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // 0. Optional soft frosted lyric backdrop pill for busy MV backgrounds
    if (settings.lyricBackdrop) {
      let transW = 0;
      if (settings.showTranslation && plan.line.koTranslation) {
        ctx.font = `700 ${layout.transFontPx}px ${FONT_STACK}`;
        transW = ctx.measureText(plan.line.koTranslation).width;
      }
      const boxLeft = Math.min(startX, startX + layout.totalW / 2 - transW / 2) - 30;
      const boxRight =
        Math.max(startX + layout.totalW, startX + layout.totalW / 2 + transW / 2) + 30;
      const koAbove = settings.showKoPron && settings.koPronPosition === 'above';
      const boxTop =
        baseY +
        Math.min(
          -layout.jpFontPx * 0.65,
          settings.showFurigana ? layout.rubyOffsetY - layout.rubyFontPx * 0.6 : 0,
          koAbove ? layout.koOffsetY - layout.koPronFontPx * 0.65 : 0
        ) -
        14;
      const boxBottom =
        baseY +
        Math.max(
          layout.jpFontPx * 0.65,
          settings.showKoPron && !koAbove ? layout.koOffsetY + layout.koPronFontPx * 0.65 : 0,
          settings.showTranslation && plan.line.koTranslation
            ? layout.transOffsetY + layout.transFontPx * 0.65
            : 0
        ) +
        14;

      ctx.save();
      ctx.fillStyle = 'rgba(6, 10, 22, 0.56)';
      roundRectPath(ctx, boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, 22);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // 1. Unhighlighted base pass
    drawLyricPass(ctx, layout, startX, baseY, settings, false);

    // 2. Highlighted horizontal wipe pass
    const wipeX = computeLineWipeX(layout, startX, time, plan.line);
    if (wipeX > startX - 15) {
      ctx.save();
      const clipTop = baseY - layout.jpFontPx - layout.rubyFontPx - layout.koPronFontPx - 45;
      const clipHeight =
        layout.jpFontPx * 2.2 + layout.rubyFontPx + layout.koPronFontPx + 110;
      ctx.beginPath();
      ctx.rect(startX - 36, clipTop, Math.max(0, wipeX - (startX - 36)), clipHeight);
      ctx.clip();
      drawLyricPass(ctx, layout, startX, baseY, settings, true);
      ctx.restore();
    }

    // 3. Toggleable Korean Translation line
    if (settings.showTranslation && plan.line.koTranslation) {
      const isSinging = time >= plan.line.startTime && time <= plan.line.endTime;
      const transCenterX = startX + layout.totalW / 2;
      ctx.save();
      ctx.globalAlpha = alpha * (isSinging ? 1.0 : 0.78);
      ctx.font = `700 ${layout.transFontPx}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawStrokedText(
        ctx,
        plan.line.koTranslation,
        transCenterX,
        baseY + layout.transOffsetY,
        settings.translationColor,
        'rgba(5, 8, 18, 0.92)',
        Math.max(4, layout.transFontPx * 0.2)
      );
      ctx.restore();
    }

    // 4. Exact 3 -> 2 -> 1 -> 0 countdown indicator before singing starts
    const secondsUntilLine = plan.line.startTime - time;
    if (
      settings.showCountdown &&
      plan.hasCountdownBefore &&
      secondsUntilLine <= 3.05 &&
      secondsUntilLine >= -0.2
    ) {
      const cdY = baseY + Math.min(layout.rubyOffsetY, layout.koOffsetY) - 44;
      drawCountdownIndicator(ctx, startX, Math.max(115, cdY), secondsUntilLine);
    }

    ctx.restore();
  }
}

function drawTitleCardAndOverlays(
  ctx: CanvasRenderingContext2D,
  project: KaraokeProject,
  time: number
): void {
  const { settings } = project;
  const hasProgressBar = settings.showProgressBar !== false;

  // Full-Song Video Progress Bar across top edge
  if (hasProgressBar) {
    const barX = 48;
    const barY = 14;
    const barW = STAGE_WIDTH - 96;
    const barH = 6;
    const dur = Math.max(1, project.duration || 60);
    const frac = clamp(time / dur, 0, 1);

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    roundRectPath(ctx, barX, barY, barW, barH, 3);
    ctx.fill();

    if (frac > 0.001) {
      const fillW = Math.max(6, barW * frac);
      const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      fillGrad.addColorStop(0, settings.highlightStrokeColor || '#38BDF8');
      fillGrad.addColorStop(1, settings.koPronHighlightColor || '#FFD54F');
      ctx.fillStyle = fillGrad;
      roundRectPath(ctx, barX, barY, fillW, barH, 3);
      ctx.fill();

      // Glowing tip dot
      const tipX = barX + fillW;
      const tipY = barY + barH / 2;
      ctx.shadowColor = settings.highlightStrokeColor || '#38BDF8';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function renderKaraokeFrame(
  ctx: CanvasRenderingContext2D,
  project: KaraokeProject,
  rawTime: number,
  resources: RenderResources = {}
): void {
  const time = Math.max(0, rawTime - (project.syncOffset || 0));
  const { settings } = project;

  ctx.save();
  ctx.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  drawBackground(ctx, settings, time, resources);

  if (settings.showVisualizer) {
    drawVisualizer(ctx, settings, time, resources.spectrum);
  }

  drawLyricsStage(ctx, project, time);
  drawTitleCardAndOverlays(ctx, project, time);

  ctx.restore();
}
