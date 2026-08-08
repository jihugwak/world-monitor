// Client-side reader for the cloud-collected snapshot (feed-snapshot.json).
//
// When the user has configured `snapshotUrl` in settings, article panels ask
// here first. We fetch the whole aggregated document once and memoize it for a
// short TTL, so a refresh cycle across 20 panels costs a single HTTP request
// (served from GitHub Pages with permissive CORS — no proxy needed).

import { loadSettings } from './settings';
import type { FeedItem, FetchedFeed } from './types';

interface SnapshotFeed {
  inputUrl: string;
  feedUrl: string;
  title: string;
  kind: string;
  live?: boolean;
  ok: boolean;
  error?: string;
  items: FeedItem[];
}

interface SnapshotDoc {
  generatedAt: number;
  okCount: number;
  total: number;
  feeds: SnapshotFeed[];
}

const TTL_MS = 30_000;

// Hard-coded fallback(s) tried after the user's configured snapshotUrl. The
// GitHub Actions Pages snapshot (5-min cron) backs up the primary Cloudflare
// Worker (2-min cron) if the Worker is ever unreachable.
const FALLBACK_URLS = ['https://jihugwak.github.io/world-monitor/feed-snapshot.json'];

let cache: { at: number; doc: SnapshotDoc } | null = null;
let inflight: Promise<SnapshotDoc | null> | null = null;

/** Ordered list of snapshot URLs to try: configured primary, then fallbacks. */
function snapshotUrls(): string[] {
  const primary = loadSettings().snapshotUrl;
  return [...new Set([primary, ...FALLBACK_URLS].filter((u) => u.length > 0))];
}

/** True when at least one snapshot source is configured. */
export function snapshotEnabled(): boolean {
  return snapshotUrls().length > 0;
}

async function loadSnapshot(signal?: AbortSignal): Promise<SnapshotDoc | null> {
  const urls = snapshotUrls();
  if (urls.length === 0) return null;

  if (cache && Date.now() - cache.at < TTL_MS) return cache.doc;

  // Coalesce the burst of concurrent panel refreshes into one request cycle.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      for (const url of urls) {
        try {
          const r = await fetch(url, { signal, cache: 'no-store' });
          if (!r.ok) continue;
          const doc = (await r.json()) as SnapshotDoc;
          if (!doc || !Array.isArray(doc.feeds)) continue;
          cache = { at: Date.now(), doc };
          return doc;
        } catch {
          /* try the next source */
        }
      }
      // Everything failed — serve a stale cache if we have one, else null so
      // the caller fetches the origin directly.
      return cache ? cache.doc : null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Return pre-parsed items for a feed from the snapshot, or null to signal the
 *  caller should fetch the origin directly (snapshot off, stale, or missing). */
export async function getSnapshotFeed(
  feedUrl: string,
  inputUrl: string,
  signal?: AbortSignal,
): Promise<FetchedFeed | null> {
  const doc = await loadSnapshot(signal);
  if (!doc) return null;
  const f = doc.feeds.find((x) => x.feedUrl === feedUrl || x.inputUrl === inputUrl);
  if (!f || !f.ok || f.items.length === 0) return null;
  return { title: f.title, items: f.items };
}
