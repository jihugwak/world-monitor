// Server-side feed collector — runs in GitHub Actions on a cron.
//
// Fetches every source in src/data/seed-feeds.json directly (no CORS, no
// public proxy), parses RSS/Atom into the app's FeedItem shape, and writes a
// single aggregated snapshot to snapshot/feed-snapshot.json. The workflow then
// publishes that folder to GitHub Pages so the desktop app can read one clean,
// always-fresh JSON instead of hammering 20 origins through flaky proxies.
//
// "Latest only": the file is overwritten every run — no history is kept.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_PATH = join(ROOT, 'src', 'data', 'seed-feeds.json');
const OUT_DIR = join(ROOT, 'snapshot');
const OUT_PATH = join(OUT_DIR, 'feed-snapshot.json');

const FETCH_TIMEOUT_MS = 20_000;
const MAX_ITEMS = 40; // cap per feed to keep the snapshot small

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Keep every namespaced tag verbatim (dc:creator, media:thumbnail, …).
  removeNSPrefix: false,
});

/** Always return an array whether the parser gave us one item or many. */
function arr(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Text content of a possibly-object node (fast-xml-parser wraps text as #text). */
function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && '#text' in node) return String(node['#text']).trim();
  return '';
}

function toMs(dateStr) {
  const t = dateStr ? Date.parse(dateStr) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function pickThumbnail(node) {
  const media = node['media:thumbnail'] ?? node['media:content'];
  if (media) {
    const m = arr(media)[0];
    const url = m?.['@_url'];
    if (url) return url;
  }
  const enc = arr(node.enclosure)[0];
  if (enc?.['@_url'] && /^image\//i.test(enc['@_type'] ?? '')) return enc['@_url'];
  return undefined;
}

function parseRssItems(channel) {
  return arr(channel.item).map((it, i) => {
    const link = text(it.link) || it.link?.['@_href'] || '';
    return {
      id: text(it.guid) || link || String(i),
      title: text(it.title) || '(제목 없음)',
      link,
      pubDate: toMs(text(it.pubDate) || text(it['dc:date']) || text(it.date)),
      author: text(it['dc:creator']) || text(it.author) || undefined,
      description: text(it.description) || text(it['content:encoded']) || undefined,
      thumbnail: pickThumbnail(it),
    };
  });
}

function parseAtomEntries(feed) {
  return arr(feed.entry).map((e, i) => {
    // <link> can be a single object or an array; prefer rel="alternate".
    const links = arr(e.link);
    const alt = links.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate') ?? links[0];
    const link = alt?.['@_href'] ?? text(e.link) ?? '';
    return {
      id: text(e.id) || link || String(i),
      title: text(e.title) || '(제목 없음)',
      link,
      pubDate: toMs(text(e.published) || text(e.updated)),
      author: text(e.author?.name) || undefined,
      description: text(e.summary) || text(e.content) || undefined,
      thumbnail: pickThumbnail(e),
    };
  });
}

function parseXml(xml) {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    return { title: text(ch.title) || 'Untitled', items: parseRssItems(ch) };
  }
  if (doc['rdf:RDF']?.channel || doc.RDF?.channel) {
    const root = doc['rdf:RDF'] ?? doc.RDF;
    const ch = root.channel;
    // RSS 1.0 lists <item> as siblings of <channel>, not children.
    const items = arr(root.item).length ? arr(root.item) : arr(ch.item);
    return { title: text(ch.title) || 'Untitled', items: parseRssItems({ item: items }) };
  }
  if (doc.feed) {
    return { title: text(doc.feed.title) || 'Untitled', items: parseAtomEntries(doc.feed) };
  }
  throw new Error('알 수 없는 피드 포맷');
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Some origins 403 the default undici UA.
        'user-agent': 'Mozilla/5.0 (compatible; WorldMonitorBot/1.0; +https://github.com/)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function collectOne(seed) {
  const url = seed.feedUrl ?? seed.url;
  const base = { inputUrl: seed.url, feedUrl: url, title: seed.title, kind: seed.kind, live: seed.live };
  try {
    const xml = await fetchText(url);
    const parsed = parseXml(xml);
    const items = parsed.items
      .filter((it) => it.link || it.title)
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, MAX_ITEMS);
    console.log(`  ok   ${seed.title} — ${items.length} items`);
    return { ...base, title: parsed.title || seed.title, ok: true, items };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  FAIL ${seed.title} — ${msg}`);
    return { ...base, ok: false, error: msg, items: [] };
  }
}

async function main() {
  const seeds = JSON.parse(await readFile(SEED_PATH, 'utf8'));
  console.log(`Collecting ${seeds.length} feeds…`);
  // Run in parallel — one slow/broken origin shouldn't stall the rest.
  const feeds = await Promise.all(seeds.map(collectOne));
  const okCount = feeds.filter((f) => f.ok).length;

  const snapshot = { generatedAt: Date.now(), okCount, total: feeds.length, feeds };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(snapshot), 'utf8');
  console.log(`Wrote ${OUT_PATH} — ${okCount}/${feeds.length} feeds ok`);

  // Fail the CI run only if literally nothing came back (likely a code/network
  // regression). Partial failures are normal and shouldn't block publishing.
  if (okCount === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
