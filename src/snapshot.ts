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

const TTL_MS = 60_000;

let cache: { url: string; at: number; doc: SnapshotDoc } | null = null;
let inflight: { url: string; promise: Promise<SnapshotDoc | null> } | null = null;

/** True when the user has opted into cloud snapshots. */
export function snapshotEnabled(): boolean {
  return loadSettings().snapshotUrl.length > 0;
}

async function loadSnapshot(signal?: AbortSignal): Promise<SnapshotDoc | null> {
  const url = loadSettings().snapshotUrl;
  if (!url) return null;

  const fresh = cache && cache.url === url && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache!.doc;

  // Coalesce the burst of concurrent panel refreshes into one request.
  if (inflight && inflight.url === url) return inflight.promise;

  const promise = (async () => {
    try {
      const r = await fetch(url, { signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = (await r.json()) as SnapshotDoc;
      if (!doc || !Array.isArray(doc.feeds)) throw new Error('bad snapshot');
      cache = { url, at: Date.now(), doc };
      return doc;
    } catch {
      // On failure fall back to a still-valid-URL cache if we have one, else
      // null so the caller fetches the origin directly.
      return cache && cache.url === url ? cache.doc : null;
    } finally {
      inflight = null;
    }
  })();

  inflight = { url, promise };
  return promise;
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
