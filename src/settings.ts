/**
 * User-tunable runtime settings:
 *   - proxies: ordered list of CORS-proxy URL templates (use {url} placeholder
 *     OR {urlEnc} for percent-encoded). The list is tried in order on every
 *     fetch.
 *   - refreshIntervalMin: how often the auto-refresh loop runs (minutes).
 */

const SETTINGS_KEY = 'fm-settings';

export interface ProxyEntry {
  /** A URL template containing `{url}` (raw) or `{urlEnc}` (percent-encoded). */
  template: string;
}

export interface Settings {
  proxies: ProxyEntry[];
  refreshIntervalMin: number;
  /** Optional URL of the cloud-collected aggregated snapshot (feed-snapshot.json).
   *  When set, article panels read pre-parsed items from here instead of
   *  fetching each origin through CORS proxies. Empty string = disabled. */
  snapshotUrl: string;
}

export const DEFAULT_PROXIES: ProxyEntry[] = [
  { template: 'https://corsproxy.io/?{urlEnc}' },
  { template: 'https://api.allorigins.win/raw?url={urlEnc}' },
];

export const DEFAULT_REFRESH_MIN = 10;
const MIN_REFRESH_MIN = 1;
const MAX_REFRESH_MIN = 240;

/** Cloud snapshot published by the GitHub Actions collector (see
 *  .github/workflows/collect.yml). On by default; falls back to direct
 *  per-origin fetching automatically if it's unreachable. */
const DEFAULT_SNAPSHOT_URL = 'https://jihugwak.github.io/world-monitor/feed-snapshot.json';

const DEFAULT_SETTINGS: Settings = {
  proxies: DEFAULT_PROXIES.slice(),
  refreshIntervalMin: DEFAULT_REFRESH_MIN,
  snapshotUrl: DEFAULT_SNAPSHOT_URL,
};

let cached: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

function sanitize(raw: unknown): Settings {
  const fallback = { ...DEFAULT_SETTINGS, proxies: DEFAULT_PROXIES.slice() };
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const proxies = Array.isArray(obj.proxies)
    ? obj.proxies
        .filter((p): p is ProxyEntry =>
          !!p && typeof p === 'object' && typeof (p as ProxyEntry).template === 'string',
        )
        .map((p) => ({ template: p.template.trim() }))
        .filter((p) => p.template.length > 0)
    : null;
  const interval =
    typeof obj.refreshIntervalMin === 'number' && Number.isFinite(obj.refreshIntervalMin)
      ? clampInterval(obj.refreshIntervalMin)
      : DEFAULT_REFRESH_MIN;
  // Missing (older saved settings) → adopt the default; an explicit '' means
  // the user deliberately turned it off, so respect that.
  const snapshotUrl =
    typeof obj.snapshotUrl === 'string' ? obj.snapshotUrl.trim() : DEFAULT_SNAPSHOT_URL;
  return {
    proxies: proxies && proxies.length > 0 ? proxies : DEFAULT_PROXIES.slice(),
    refreshIntervalMin: interval,
    snapshotUrl,
  };
}

export function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_MIN;
  return Math.max(MIN_REFRESH_MIN, Math.min(MAX_REFRESH_MIN, Math.round(n)));
}

export function loadSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    cached = sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    cached = { ...DEFAULT_SETTINGS, proxies: DEFAULT_PROXIES.slice() };
  }
  return cached;
}

export function saveSettings(next: Settings): void {
  cached = sanitize(next);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cached));
  } catch {
    /* quota — keep in-memory copy */
  }
  for (const fn of listeners) fn(cached);
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Expand a proxy template against a raw URL. */
export function applyProxy(template: string, url: string): string {
  if (template.includes('{urlEnc}')) {
    return template.replace('{urlEnc}', encodeURIComponent(url));
  }
  if (template.includes('{url}')) {
    return template.replace('{url}', url);
  }
  // Legacy/loose: assume the proxy expects the URL appended as-is.
  return template + encodeURIComponent(url);
}
