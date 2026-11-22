export function isAllowedWorkerOrigin(origin?: string): boolean {
  if (!origin) return true;
  const clean = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (
    clean === 'https://5drake.github.io' ||
    /^https?:\/\/localhost(?::\d+)?$/.test(clean) ||
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(clean) ||
    /^https?:\/\/\[::1\](?::\d+)?$/.test(clean)
  ) {
    return true;
  }
  const extra = (process.env.LYRIKO_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  return extra.includes(clean);
}
