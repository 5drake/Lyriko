import { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { KaraokeProject } from '@shared/types';
import { formatTime } from '@shared/timing';

interface TimelineProps {
  project: KaraokeProject;
  audioBuffer: AudioBuffer | null;
  currentTime: number;
  selectedLineId: string | null;
  uiTheme?: 'light' | 'dark';
  onSeek: (time: number) => void;
  onSelectLine: (id: string) => void;
}

export function Timeline({
  project,
  audioBuffer,
  currentTime,
  selectedLineId,
  uiTheme = 'light',
  onSeek,
  onSelectLine,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pxPerSec, setPxPerSec] = useState(42);
  const scrubbingRef = useRef(false);

  const duration = Math.max(15, project.duration || 60);
  const totalWidth = Math.max(800, Math.ceil(duration * pxPerSec));
  const canvasHeight = 144;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  // Precompute downsampled waveform peaks when audioBuffer changes
  const waveformPeaks = useMemo(() => {
    if (!audioBuffer) return null;
    const bins = Math.max(400, Math.ceil(duration * 30));
    const peaks = new Float32Array(bins);
    const ch = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / bins));
    for (let i = 0; i < bins; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(ch.length, start + step);
      for (let j = start; j < end; j += Math.max(1, Math.floor(step / 16))) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }, [audioBuffer, duration]);

  // Auto-keep playhead visible when playing
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const playX = currentTime * pxPerSec;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (playX > viewRight - 60 || playX < viewLeft + 20) {
      container.scrollLeft = Math.max(0, playX - container.clientWidth * 0.25);
    }
  }, [currentTime, pxPerSec]);

  // Draw timeline canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isLight = uiTheme === 'light';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, totalWidth, canvasHeight);

    // Background bands
    ctx.fillStyle = isLight ? '#ffffff' : '#080c16';
    ctx.fillRect(0, 0, totalWidth, canvasHeight);
    ctx.fillStyle = isLight ? '#f8fafc' : '#0c111d';
    ctx.fillRect(0, 0, totalWidth, 24); // Ruler
    ctx.fillStyle = isLight ? '#f1f5f9' : '#090e1a';
    ctx.fillRect(0, 24, totalWidth, 50); // Waveform strip

    ctx.strokeStyle = isLight ? '#cbd5e1' : 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 24);
    ctx.lineTo(totalWidth, 24);
    ctx.moveTo(0, 74);
    ctx.lineTo(totalWidth, 74);
    ctx.stroke();

    // Ruler ticks
    ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.2)' : 'rgba(255, 255, 255, 0.14)';
    ctx.fillStyle = isLight ? '#475569' : '#64748b';
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';
    const secStep = pxPerSec >= 60 ? 2 : pxPerSec >= 30 ? 5 : 10;
    for (let s = 0; s <= duration; s += 1) {
      const x = s * pxPerSec;
      const major = s % secStep === 0;
      ctx.beginPath();
      ctx.moveTo(x, major ? 4 : 15);
      ctx.lineTo(x, 24);
      ctx.stroke();
      if (major) {
        ctx.fillText(formatTime(s), x + 4, 5);
      }
    }

    // Waveform
    const waveMidY = 49;
    if (waveformPeaks) {
      ctx.fillStyle = isLight ? 'rgba(2, 132, 199, 0.55)' : 'rgba(56, 189, 248, 0.42)';
      for (let x = 0; x < totalWidth; x += 2) {
        const t = x / pxPerSec;
        const idx = Math.min(
          waveformPeaks.length - 1,
          Math.floor((t / duration) * waveformPeaks.length)
        );
        const h = Math.max(1, waveformPeaks[idx] * 21);
        ctx.fillRect(x, waveMidY - h, 1.5, h * 2);
      }
    } else {
      ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(0, waveMidY);
      ctx.lineTo(totalWidth, waveMidY);
      ctx.stroke();
    }

    // Lyric blocks (y = 95..136)
    for (const line of project.lines) {
      const bx = line.startTime * pxPerSec;
      const bw = Math.max(14, (line.endTime - line.startTime) * pxPerSec);
      const isSelected = line.id === selectedLineId;
      const isActive = currentTime >= line.startTime && currentTime <= line.endTime;

      ctx.fillStyle = isLight
        ? isSelected
          ? 'rgba(2, 132, 199, 0.16)'
          : isActive
          ? 'rgba(79, 70, 229, 0.16)'
          : '#f8fafc'
        : isSelected
        ? 'rgba(56, 189, 248, 0.24)'
        : isActive
        ? 'rgba(99, 102, 241, 0.28)'
        : 'rgba(255, 255, 255, 0.055)';
      ctx.strokeStyle = isLight
        ? isSelected
          ? '#0284c7'
          : isActive
          ? '#4f46e5'
          : '#cbd5e1'
        : isSelected
        ? '#38bdf8'
        : isActive
        ? '#818cf8'
        : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = isSelected ? 1.5 : 1;

      ctx.beginPath();
      ctx.roundRect(bx, 96, bw, 38, 6);
      ctx.fill();
      ctx.stroke();

      // Text inside block
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx + 7, 96, Math.max(0, bw - 14), 38);
      ctx.clip();
      ctx.fillStyle = isLight
        ? isSelected
          ? '#0c4a6e'
          : '#0f172a'
        : isSelected
        ? '#ffffff'
        : '#e2e8f0';
      ctx.font = '600 12px "Noto Sans KR", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(line.jpText, bx + 9, 113);
      ctx.restore();

      if ((isSelected || isActive) && line.segments.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(bx, 96, bw, 38, 6);
        ctx.clip();

        ctx.strokeStyle = isLight
          ? 'rgba(15, 23, 42, 0.16)'
          : 'rgba(255, 255, 255, 0.16)';
        ctx.lineWidth = 1;
        for (let sIdx = 1; sIdx < line.segments.length; sIdx++) {
          const sx = line.segments[sIdx].startTime * pxPerSec;
          ctx.beginPath();
          ctx.moveTo(sx, 126);
          ctx.lineTo(sx, 134);
          ctx.stroke();
        }

        const activeSeg = line.segments.find(
          (s) => currentTime >= s.startTime && currentTime <= s.endTime
        );
        if (activeSeg) {
          const sx = activeSeg.startTime * pxPerSec;
          const sw = Math.max(3, (activeSeg.endTime - activeSeg.startTime) * pxPerSec);
          ctx.fillStyle = isLight ? '#0284c7' : '#38bdf8';
          ctx.fillRect(sx, 131, sw, 3);
        }
        ctx.restore();
      }
    }

    // Playhead line
    const playX = currentTime * pxPerSec;
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, canvasHeight);
    ctx.stroke();

    ctx.fillStyle = '#e11d48';
    ctx.beginPath();
    ctx.moveTo(playX - 5, 0);
    ctx.lineTo(playX + 5, 0);
    ctx.lineTo(playX, 8);
    ctx.closePath();
    ctx.fill();
  }, [project.lines, waveformPeaks, totalWidth, pxPerSec, currentTime, selectedLineId, duration, uiTheme, dpr]);

  const getLocalCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getLocalCoords(e.clientX, e.clientY);
    const t = Math.max(0, Math.min(duration, x / pxPerSec));

    if (y >= 94) {
      // Hit test lyric blocks to focus line without modifying timing
      const hit = project.lines.find((l) => {
        const bx = l.startTime * pxPerSec;
        const bw = Math.max(14, (l.endTime - l.startTime) * pxPerSec);
        return x >= bx - 4 && x <= bx + bw + 4;
      });
      if (hit) {
        onSelectLine(hit.id);
      }
    }

    scrubbingRef.current = true;
    onSeek(t);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!scrubbingRef.current) return;
      const { x } = getLocalCoords(e.clientX, 0);
      onSeek(Math.max(0, Math.min(duration, x / pxPerSec)));
    };

    const onUp = () => {
      scrubbingRef.current = false;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [duration, onSeek, pxPerSec]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setPxPerSec((z) =>
          e.deltaY < 0
            ? Math.min(140, Math.round(z * 1.15))
            : Math.max(16, Math.round(z * 0.87))
        );
        return;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta !== 0) {
        e.preventDefault();
        container.scrollLeft += delta;
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0b101d] overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-200">타임라인</span>
          <span className="hidden xl:inline text-[11px] text-slate-500">
            휠 좌우 이동 · Ctrl+휠 확대 · 클릭 이동
          </span>
        </div>
        <div className="flex items-center gap-1 text-slate-400">
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.max(16, Math.round(z * 0.75)))}
            className="rounded-md p-1 hover:bg-white/[0.07] hover:text-slate-200 transition"
            title="축소"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center font-mono tabular-nums text-[11px] text-slate-300">
            {pxPerSec}px/s
          </span>
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.min(140, Math.round(z * 1.3)))}
            className="rounded-md p-1 hover:bg-white/[0.07] hover:text-slate-200 transition"
            title="확대"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto select-none">
        <canvas
          ref={canvasRef}
          width={Math.round(totalWidth * dpr)}
          height={Math.round(canvasHeight * dpr)}
          style={{ width: totalWidth, height: canvasHeight }}
          onMouseDown={handleMouseDown}
          className="block cursor-pointer"
        />
      </div>
    </div>
  );
}
