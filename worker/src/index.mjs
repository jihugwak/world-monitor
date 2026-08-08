// World Monitor — Cloudflare Worker feed collector (scheduled + KV).
//
// A cron trigger (see wrangler.toml, every 2 min) runs collect() and stores the
// aggregated snapshot in Workers KV — so news keeps being collected even when
// the app is closed. GET /feed-snapshot.json serves the stored snapshot with
// permissive CORS (cold-starts by collecting once if KV is still empty).
//
// A lightweight regex parser is used instead of a full XML DOM to stay well
// within the Worker CPU budget across ~20 feeds per invocation.

import SEEDS from '../../src/data/seed-feeds.json';

const KV_KEY = 'latest';
const SERVE_TTL = 45; // seconds the served JSON may be reused downstream
const FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS = 40;
const RETRIES = 2;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

export default {
  // Cron: collect and persist to KV, independent of any client.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/feed-snapshot.json')) {
      const body = 'World Monitor feed collector — GET /feed-snapshot.json';
      return new Response(body, {
        status: url.pathname === '/' ? 200 : 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
      });
    }

    // Serve the cron-collected snapshot from KV. If it's not there yet (very
    // first request after deploy, before the first cron fired), collect once
    // now and store it so this request isn't empty.
    let stored = await env.SNAPSHOT.get(KV_KEY);
    if (!stored) {
      stored = JSON.stringify(await collect());
      ctx.waitUntil(env.SNAPSHOT.put(KV_KEY, stored));
    }
    return new Response(stored, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${SERVE_TTL}`,
        ...CORS,
      },
    });
  },
};

async function refresh(env) {
  const snapshot = await collect();
  await env.SNAPSHOT.put(KV_KEY, JSON.stringify(snapshot));
  return snapshot;
}

async function collect() {
  const feeds = await Promise.all(SEEDS.map(collectOne));
  const okCount = feeds.filter((f) => f.ok).length;
  return { generatedAt: Date.now(), okCount, total: feeds.length, feeds };
}

async function collectOne(seed) {
  const feedUrl = seed.feedUrl ?? seed.url;
  const base = {
    inputUrl: seed.url,
    feedUrl,
    title: seed.title,
    kind: seed.kind,
    live: seed.live,
  };
  try {
    const xml = await fetchText(feedUrl);
    const parsed = parseXml(xml);
    const items = parsed.items
      .filter((it) => it.link || it.title)
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, MAX_ITEMS);
    return { ...base, title: parsed.title || seed.title, ok: true, items };
  } catch (e) {
    return { ...base, ok: false, error: String(e && e.message ? e.message : e), items: [] };
  }
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

// ── Lightweight XML parsing (regex-based) ──────────────────

function parseXml(xml) {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000)) || /<entry[\s>]/i.test(xml);
  const title = decode(stripCdata(firstTag(xml, 'title'))) || 'Untitled';
  const blocks = matchAll(xml, isAtom ? 'entry' : 'item');
  const items = blocks.map((block, i) => (isAtom ? atomItem(block, i) : rssItem(block, i)));
  return { title, items };
}

function rssItem(b, i) {
  const link = decode(stripCdata(firstTag(b, 'link'))) || '';
  return {
    id: decode(stripCdata(firstTag(b, 'guid'))) || link || String(i),
    title: decode(stripCdata(firstTag(b, 'title'))) || '(제목 없음)',
    link,
    pubDate: toMs(firstTag(b, 'pubDate') || firstTag(b, 'dc:date') || firstTag(b, 'date')),
    author: decode(stripCdata(firstTag(b, 'dc:creator') || firstTag(b, 'author'))) || undefined,
    description: decode(stripCdata(firstTag(b, 'description') || firstTag(b, 'content:encoded'))) || undefined,
  };
}

function atomItem(b, i) {
  // <link href="..." rel="alternate"/> — prefer alternate, else first href.
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
    description: decode(stripCdata(firstTag(b, 'summary') || firstTag(b, 'content'))) || undefined,
  };
}

// Return the inner text of the first <tag>…</tag> in s (namespace-aware).
function firstTag(s, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'i');
  const m = s.match(re);
  return m ? m[1].trim() : '';
}
const innerTag = firstTag;

// First whole <tag>…</tag> block (element + contents).
function firstBlock(s, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRe(tag)}>`, 'i');
  const m = s.match(re);
  return m ? m[0] : '';
}

// All <tag>…</tag> blocks.
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
