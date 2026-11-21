interface YtPlayerInstance {
  loadVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  cueVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
  setPlaybackRate: (suggestedRate: number) => void;
  getAvailablePlaybackRates: () => number[];
  destroy: () => void;
}

interface YtNamespace {
  Player: new (
    elementIdOrNode: string | HTMLElement,
    options: {
      height?: string | number;
      width?: string | number;
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: (event: { data: number }) => void;
      };
    }
  ) => YtPlayerInstance;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YtNamespace> | null = null;

export function loadYoutubeIframeApi(): Promise<YtNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('브라우저 환경에서만 YouTube 플레이어를 사용할 수 있습니다.'));
  }
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<YtNamespace>((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    const timeoutId = window.setTimeout(() => {
      ytApiPromise = null;
      reject(new Error('YouTube 플레이어 API 로드 시간이 초과되었습니다.'));
    }, 12000);

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeoutId);
      try {
        prevReady?.();
      } catch {
        // ignore previous hook errors
      }
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        ytApiPromise = null;
        reject(new Error('YouTube 플레이어 API 초기화에 실패했습니다.'));
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]'
    );
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        ytApiPromise = null;
        reject(new Error('YouTube 플레이어 스크립트를 불러오지 못했습니다.'));
      };
      document.head.appendChild(script);
    }
  });

  return ytApiPromise;
}

function formatYoutubeError(code: number): string {
  if (code === 101 || code === 150) {
    return '이 영상은 업로더가 외부 재생을 제한해 웹 스트리밍이 불가합니다. 로컬 워커를 연결하면 재생할 수 있습니다.';
  }
  if (code === 100) {
    return 'YouTube 영상을 찾을 수 없거나 삭제되었습니다.';
  }
  if (code === 2 || code === 5) {
    return 'YouTube 플레이어 재생 요청을 처리하지 못했습니다.';
  }
  return `YouTube 재생 오류가 발생했습니다 (코드 ${code}).`;
}

export interface YoutubeFallbackCallbacks {
  onReady?: () => void;
  onStateChange?: (state: number) => void;
  onError?: (code: number, message: string) => void;
}

export class YoutubeFallbackController {
  private callbacks: YoutubeFallbackCallbacks;
  private container: HTMLDivElement | null = null;
  private player: YtPlayerInstance | null = null;
  private ready = false;
  private destroyed = false;
  private targetVideoId = '';
  private desiredStartSec = 0;
  private desiredAutoplay = false;
  private desiredVolume = 0.25;
  private desiredRate = 1;
  private initPromise: Promise<void> | null = null;

  constructor(callbacks: YoutubeFallbackCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private ensureHostElement(): HTMLDivElement {
    if (this.container && document.body.contains(this.container)) {
      return this.container;
    }
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:220px;height:220px;opacity:0.01;pointer-events:none;overflow:hidden;';
    const target = document.createElement('div');
    host.appendChild(target);
    document.body.appendChild(host);
    this.container = host;
    return host;
  }

  private applyVolumeAndRate(player: YtPlayerInstance): void {
    try {
      const clampedVol = Math.max(0, Math.min(1, this.desiredVolume));
      if (clampedVol <= 0.001) {
        player.mute();
        player.setVolume(0);
      } else {
        player.unMute();
        player.setVolume(Math.round(clampedVol * 100));
      }
    } catch {
      // ignore if player not ready yet
    }
    try {
      const rates = player.getAvailablePlaybackRates?.() || [0.5, 0.75, 1, 1.25, 1.5];
      if (rates.length > 0) {
        const nearest = rates.reduce((best, cur) =>
          Math.abs(cur - this.desiredRate) < Math.abs(best - this.desiredRate) ? cur : best
        );
        player.setPlaybackRate(nearest);
      }
    } catch {
      // ignore if rate unavailable
    }
  }

  async load(
    videoId: string,
    startSec: number,
    autoplay: boolean,
    volume: number,
    rate: number
  ): Promise<void> {
    if (this.destroyed || !videoId) return;
    this.targetVideoId = videoId;
    this.desiredStartSec = Math.max(0, startSec);
    this.desiredAutoplay = autoplay;
    this.desiredVolume = volume;
    this.desiredRate = rate;

    if (this.player && this.ready) {
      this.applyVolumeAndRate(this.player);
      if (this.desiredAutoplay) {
        this.player.loadVideoById({ videoId, startSeconds: this.desiredStartSec });
      } else {
        this.player.cueVideoById({ videoId, startSeconds: this.desiredStartSec });
      }
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        const YT = await loadYoutubeIframeApi();
        if (this.destroyed) return;
        const host = this.ensureHostElement();
        const mountNode = host.firstElementChild as HTMLElement;
        await new Promise<void>((resolve) => {
          this.player = new YT.Player(mountNode, {
            width: 220,
            height: 220,
            videoId: this.targetVideoId,
            playerVars: {
              autoplay: this.desiredAutoplay ? 1 : 0,
              controls: 0,
              disablekb: 1,
              fs: 0,
              modestbranding: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: () => {
                if (this.destroyed || !this.player) {
                  resolve();
                  return;
                }
                this.ready = true;
                this.applyVolumeAndRate(this.player);
                if (this.targetVideoId) {
                  if (this.desiredAutoplay) {
                    this.player.loadVideoById({
                      videoId: this.targetVideoId,
                      startSeconds: this.desiredStartSec,
                    });
                  } else {
                    this.player.cueVideoById({
                      videoId: this.targetVideoId,
                      startSeconds: this.desiredStartSec,
                    });
                  }
                }
                this.callbacks.onReady?.();
                resolve();
              },
              onStateChange: (ev) => {
                if (!this.destroyed) {
                  this.callbacks.onStateChange?.(ev.data);
                }
              },
              onError: (ev) => {
                if (!this.destroyed) {
                  this.callbacks.onError?.(ev.data, formatYoutubeError(ev.data));
                }
                resolve();
              },
            },
          });
        });
      } catch (err) {
        if (!this.destroyed) {
          this.callbacks.onError?.(
            -1,
            err instanceof Error ? err.message : 'YouTube 플레이어 초기화 오류'
          );
        }
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  play(): void {
    this.desiredAutoplay = true;
    if (this.player && this.ready) {
      try {
        this.applyVolumeAndRate(this.player);
        this.player.playVideo();
      } catch {
        // ignore transient player error
      }
    }
  }

  pause(): void {
    this.desiredAutoplay = false;
    if (this.player && this.ready) {
      try {
        this.player.pauseVideo();
      } catch {
        // ignore transient player error
      }
    }
  }

  seekTo(seconds: number): void {
    const safeSec = Math.max(0, seconds);
    this.desiredStartSec = safeSec;
    if (this.player && this.ready) {
      try {
        this.player.seekTo(safeSec, true);
      } catch {
        // ignore
      }
    }
  }

  setVolume(vol01: number): void {
    this.desiredVolume = vol01;
    if (this.player && this.ready) {
      this.applyVolumeAndRate(this.player);
    }
  }

  setPlaybackRate(rate: number): void {
    this.desiredRate = rate;
    if (this.player && this.ready) {
      this.applyVolumeAndRate(this.player);
    }
  }

  getCurrentTime(): number {
    if (!this.player || !this.ready) return this.desiredStartSec;
    try {
      const t = this.player.getCurrentTime();
      return Number.isFinite(t) ? t : this.desiredStartSec;
    } catch {
      return this.desiredStartSec;
    }
  }

  getPlayerState(): number {
    if (!this.player || !this.ready) return -1;
    try {
      return this.player.getPlayerState();
    } catch {
      return -1;
    }
  }

  isPlayingState(): boolean {
    return this.getPlayerState() === 1;
  }

  destroy(): void {
    this.destroyed = true;
    this.ready = false;
    try {
      this.player?.destroy();
    } catch {
      // ignore destroy error
    }
    this.player = null;
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
