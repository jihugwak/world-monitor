// World Monitor — Cloudflare Worker feed collector.
//
// Endpoints:
//   GET /feed-snapshot.json → the CURRENT day's accumulated feed items (KST),
//        newest-first, deduped. Items pile up from 00:00 KST and reset at the
//        next 00:00 (previous day's KV entry auto-expires). Served with CORS.
//   GET /live?channel=UC… → resolves a channel's currently-live videoId
//        server-side (no CORS), so mobile browsers can show live tiles that a
//        client-side scrape can't reach.
//
// A cron (see wrangler.toml, every 2 min) accumulates into Workers KV even when
// the app is closed. A lightweight regex parser keeps CPU within budget.

import SEEDS from '../../src/data/seed-feeds.json';

const SERVE_TTL = 30; // seconds downstream may reuse the snapshot
const LIVE_TTL = 60; // seconds to cache a /live lookup
const FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS_PER_FETCH = 40; // per feed, per collection pass
const MAX_ITEMS_PER_DAY = 150; // per feed, accumulated over the day
const DAY_TTL_SECONDS = 60 * 60 * 26; // KV entry lives ~26h → auto-wipes next day
const RETRIES = 2;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

export default {
  // Cron: accumulate into the current KST day's bucket, independent of clients.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(accumulate(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (url.pathname.endsWith('/live')) {
      return handleLive(url);
    }

    if (url.pathname.endsWith('/feed-snapshot.json')) {
      let stored = await env.SNAPSHOT.get(dayKey());
      if (!stored) {
        // First request of a fresh day (before the first cron fired): seed it.
        stored = JSON.stringify(await accumulate(env));
      }
      return new Response(stored, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${SERVE_TTL}`,
          ...CORS,
        },
      });
    }

    const body = 'World Monitor feed collector — GET /feed-snapshot.json';
    return new Response(body, {
      status: url.pathname === '/' ? 200 : 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
    });
  },
};

// ── Daily accumulation ─────────────────────────────────────

function kstDate(ts = Date.now()) {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10); // YYYY-MM-DD
}
function dayKey(ts = Date.now()) {
  return `day:${kstDate(ts)}`;
}

async function accumulate(env) {
  const key = dayKey();
  const prev = await env.SNAPSHOT.get(key, 'json');
  const fresh = await collect();
  const merged = mergeDay(prev, fresh);
  await env.SNAPSHOT.put(key, JSON.stringify(merged), { expirationTtl: DAY_TTL_SECONDS });
  return merged;
}

function mergeDay(prev, fresh) {
  const prevByUrl = new Map((prev?.feeds ?? []).map((f) => [f.feedUrl, f]));
  const feeds = fresh.feeds.map((ff) => {
    const pf = prevByUrl.get(ff.feedUrl);
    const prevItems = pf?.items ?? [];
    // If this pass failed, keep whatever we already had for the day.
    const freshItems = ff.ok ? ff.items : [];
    const byId = new Map();
    for (const it of prevItems) byId.set(it.id, it);
    for (const it of freshItems) byId.set(it.id, it); // fresh wins on dupes
    const items = [...byId.values()]
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, MAX_ITEMS_PER_DAY);
    return {
      inputUrl: ff.inputUrl,
      feedUrl: ff.feedUrl,
      title: ff.title || pf?.title || '',
      kind: ff.kind,
      live: ff.live,
      ok: ff.ok || prevItems.length > 0,
      items,
    };
  });
  return {
    generatedAt: Date.now(),
    day: kstDate(),
    okCount: feeds.filter((f) => f.ok).length,
    total: feeds.length,
    feeds,
  };
}

async function collect() {
  const feeds = await Promise.all(SEEDS.map(collectOne));
  return { feeds };
}

async function collectOne(seed) {
  const feedUrl = seed.feedUrl ?? seed.url;
  const base = { inputUrl: seed.url, feedUrl, title: seed.title, kind: seed.kind, live: seed.live };
  try {
    const xml = await fetchText(feedUrl);
    const parsed = parseXml(xml);
    const items = parsed.items
      .filter((it) => it.link || it.title)
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, MAX_ITEMS_PER_FETCH);
    return { ...base, title: parsed.title || seed.title, ok: true, items };
  } catch (e) {
    return { ...base, ok: false, error: String(e && e.message ? e.message : e), items: [] };
  }
}

// ── Live videoId resolution (server-side, no CORS) ─────────

async function handleLive(url) {
  const cid = url.searchParams.get('channel') || '';
  if (!/^UC[\w-]{22}$/.test(cid)) {
    return json({ videoId: null, error: 'bad channel' }, 400);
  }
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/live?channel=${cid}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const videoId = await liveVideoId(cid);
  const res = json({ videoId }, 200, `public, max-age=${LIVE_TTL}`);
  // Only cache positive-or-negative briefly; both are fine to reuse for 60s.
  await cache.put(cacheKey, res.clone());
  return res;
}

async function liveVideoId(cid) {
  try {
    const html = await fetchText(`https://www.youtube.com/channel/${cid}/live`);
    const m = html.match(
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/,
    );
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  try {
    const html = await fetchText(`https://www.youtube.com/channel/${cid}/streams`);
    const m = html.match(/"videoId":"([A-Za-z0-9_-]{11})"[^]{0,1500}?"style":"LIVE"/);
    if (m) return m[1];
  } catch {
    /* none */
  }
  return null;
}

// ── HTTP + XML helpers ─────────────────────────────────────

function json(obj, status = 200, cacheControl) {
  const headers = { 'content-type': 'application/json; charset=utf-8', ...CORS };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return new Response(JSON.stringify(obj), { status, headers });
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; WorldMonitorBot/1.0; +https://github.com/)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(600 * attempt);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseXml(xml) {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000)) || /<entry[\s>]/i.test(xml);
  const title = decode(stripCdata(firstTag(xml, 'title'))) || 'Untitled';
  const blocks = matchAll(xml, isAtom ? 'entry' : 'item');
  const items = blocks.map((block, i) => (isAtom ? atomItem(block, i) : rssItem(block, i)));
  return { title, items };
}

// Items are intentionally text-only (no description / thumbnail) — the UI shows
// title + time, so extra fields would just bloat the accumulated day.
function rssItem(b, i) {
  const link = decode(stripCdata(firstTag(b, 'link'))) || '';
  return {
    id: decode(stripCdata(firstTag(b, 'guid'))) || link || String(i),
    title: decode(stripCdata(firstTag(b, 'title'))) || '(제목 없음)',
    link,
    pubDate: toMs(firstTag(b, 'pubDate') || firstTag(b, 'dc:date') || firstTag(b, 'date')),
    author: decode(stripCdata(firstTag(b, 'dc:creator') || firstTag(b, 'author'))) || undefined,
  };
}

function atomItem(b, i) {
  let link = '';
  const links = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const alt = links.find((l) => /rel=["']?alternate/i.test(l)) ?? links[0] ?? '';
  const href = alt.match(/href=["']([^"']+)["']/i);
  if (href) link = decode(href[1]);
  return {
    id: decode(stripCdata(firstTag(b, 'id'))) || link || String(i),
    title: decode(stripCdata(firstTag(b, 'title'))) || '(제목 없음)',
    link,
    pubDate: toMs(firstTag(b, 'published') || firstTag(b, 'updated')),
    author: decode(stripCdata(innerTag(firstBlock(b, 'author') || '', 'name'))) || undefined,
  };
}

function firstTag(s, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'i');
  const m = s.match(re);
  return m ? m[1].trim() : '';
}
const innerTag = firstTag;

function firstBlock(s, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRe(tag)}>`, 'i');
  const m = s.match(re);
  return m ? m[0] : '';
}

function matchAll(s, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRe(tag)}>`, 'gi');
  return [...s.matchAll(re)].map((m) => m[0]);
}

function stripCdata(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function toMs(dateStr) {
  const t = dateStr ? Date.parse(dateStr.trim()) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decode(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}
