import type { WorkerHealthResponse } from '@shared/types';

export const DEFAULT_LOCAL_WORKER_URL = 'http://127.0.0.1:3840';
const STORAGE_KEY = 'utakana_worker_url';

export function isLocalHostOrigin(): boolean {
  if (typeof window === 'undefined') return true;
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function getWorkerBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)?.trim() || '';
    if (saved) {
      return saved.replace(/\/+$/, '');
    }
  } catch {
    // ignore storage errors
  }
  return isLocalHostOrigin() ? '' : DEFAULT_LOCAL_WORKER_URL;
}

export function getSavedWorkerOverrideUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function setWorkerBaseUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const normalized = url.trim().replace(/\/+$/, '');
  try {
    if (!normalized) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    }
  } catch {
    // ignore storage errors
  }
}

export function workerUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return pathOrUrl;
  if (
    /^https?:\/\//i.test(pathOrUrl) ||
    pathOrUrl.startsWith('blob:') ||
    pathOrUrl.startsWith('data:')
  ) {
    return pathOrUrl;
  }
  const normalizedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  const base = getWorkerBaseUrl();
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

export function workerWsUrl(wsPath: string): string {
  const normalizedPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
  const base = getWorkerBaseUrl();
  if (base) {
    const wsBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    return `${wsBase}${normalizedPath}`;
  }
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${window.location.host}${normalizedPath}`;
}

export async function probeWorkerHealth(
  timeoutMs = 3000
): Promise<WorkerHealthResponse | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(workerUrl('/api/health'), {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WorkerHealthResponse;
    return data && data.ok ? data : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
