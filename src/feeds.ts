import { applyProxy, loadSettings } from './settings';
import type { FeedItem, FeedKind, FetchedFeed } from './types';

/** Resolve the currently-broadcast videoId for a YouTube channel.
 *  Tries /live (which redirects to the active broadcast on live channels)
 *  first, then falls back to the /streams listing. Returns null if no live
 *  broadcast can be found. */
export async function fetchYouTubeLiveVideoId(
  channelId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // 1) /live — when the channel is currently live, the canonical URL points
  //    to the watch page of that live video. Otherwise it falls back to the
  //    channel landing.
  try {
    const html = await fetchText(`https://www.youtube.com/channel/${channelId}/live`, signal);
    const canonical = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/);
    if (canonical) return canonical[1];
  } catch {
    /* fall through */
  }

  // 2) /streams — pick the first videoId tagged `"style":"LIVE"` if any.
  //    Only return when the LIVE marker is present; the bare-first-videoId
  //    fallback used to leak unrelated sidebar recommendations into the embed.
  try {
    const html = await fetchText(`https://www.youtube.com/channel/${channelId}/streams`, signal);
    const liveMatches = html.matchAll(
      /"videoId":"([A-Za-z0-9_-]{11})"[^]{0,1500}?"style":"LIVE"/g,
    );
    for (const m of liveMatches) return m[1];
  } catch {
    /* return null */
  }
  return null;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  // Direct first (some servers send permissive CORS)
  try {
    const r = await fetch(url, { signal, redirect: 'follow' });
    if (r.ok) {
      const t = await r.text();
      if (t) return t;
    }
  } catch {
    /* CORS or network — fall through */
  }

  let lastErr: unknown;
  const proxies = loadSettings().proxies;
  for (const p of proxies) {
    try {
      const r = await fetch(applyProxy(p.template, url), { signal, redirect: 'follow' });
      if (r.ok) {
        const t = await r.text();
        if (t) return t;
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Fetch failed: ${lastErr instanceof Error ? lastErr.message : 'unknown'}`);
}

// ── URL detection ──────────────────────────────────────────

function parseYouTubeDirect(url: string): string | null {
  let m = url.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (m) return `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`;
  m = url.match(/youtube\.com\/playlist\?list=([\w-]+)/i);
  if (m) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${m[1]}`;
  m = url.match(/youtube\.com\/user\/([\w-]+)/i);
  if (m) return `https://www.youtube.com/feeds/videos.xml?user=${m[1]}`;
  return null;
}

function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function detectFeedKindFromText(text: string): FeedKind | null {
  const head = text.slice(0, 4096);
  if (/<feed[\s>]/i.test(head)) return 'atom';
  if (/<rss[\s>]/i.test(head)) return 'rss';
  return null;
}

function discoverFeedFromHtml(html: string, baseUrl: string): string | null {
  const linkTags = html.match(/<link[^>]+rel=["']alternate["'][^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (/(rss|atom)\+xml/i.test(tag)) {
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) {
        try {
          return new URL(href, baseUrl).toString();
        } catch {
          /* malformed */
        }
      }
    }
  }
  return null;
}

function discoverYouTubeChannelId(html: string): string | null {
  return (
    html.match(/"channelId":"(UC[\w-]+)"/)?.[1] ??
    html.match(/<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[\w-]+)["']/i)?.[1] ??
    null
  );
}

/** Take user-pasted URL, return the actual feed URL plus initial parse. */
export async function resolveFeedUrl(
  input: string,
  signal?: AbortSignal,
): Promise<{ feedUrl: string; kind: FeedKind; title: string; items: FeedItem[] }> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('URL is empty');

  // 1) Direct YouTube formats
  const direct = parseYouTubeDirect(trimmed);
  if (direct) {
    const parsed = await fetchAndParse(direct, signal);
    return { feedUrl: direct, kind: 'youtube', title: parsed.title, items: parsed.items };
  }

  // 2) Fetch the URL — may be a feed or HTML
  const text = await fetchText(trimmed, signal);

  const kind = detectFeedKindFromText(text);
  if (kind) {
    const parsed = parseXml(text);
    return { feedUrl: trimmed, kind, title: parsed.title, items: parsed.items };
  }

  // 3) HTML — try YouTube channel-id discovery first
  if (isYouTubeUrl(trimmed)) {
    const cid = discoverYouTubeChannelId(text);
    if (cid) {
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`;
      const parsed = await fetchAndParse(feedUrl, signal);
      return { feedUrl, kind: 'youtube', title: parsed.title, items: parsed.items };
    }
  }

  // 4) Generic <link rel="alternate"> discovery
  const discovered = discoverFeedFromHtml(text, trimmed);
  if (discovered) {
    const parsed = await fetchAndParse(discovered, signal);
    const k = detectFeedKindFromXml(parsed) ?? 'rss';
    return { feedUrl: discovered, kind: k, title: parsed.title, items: parsed.items };
  }

  throw new Error('이 URL에서 RSS/Atom 피드를 찾지 못했습니다');
}

/** Periodic refresh — already-resolved feed URL */
export async function fetchAndParse(url: string, signal?: AbortSignal): Promise<FetchedFeed> {
  const xml = await fetchText(url, signal);
  return parseXml(xml);
}

function detectFeedKindFromXml(_p: FetchedFeed): FeedKind | null {
  // best-effort marker; we don't carry kind back from parser
  return null;
}

// ── XML parsing ────────────────────────────────────────────

function parseXml(xml: string): FetchedFeed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    // Some servers serve XML with HTML mime — try text/xml
    const doc2 = new DOMParser().parseFromString(xml, 'text/xml');
    if (!doc2.querySelector('parsererror')) return parseDoc(doc2);
    throw new Error('XML parse error');
  }
  return parseDoc(doc);
}

function parseDoc(doc: Document): FetchedFeed {
  const root = doc.documentElement;
  if (!root) throw new Error('Empty document');

  // Atom
  if (root.localName === 'feed') return parseAtom(root);
  // RSS
  const channel = root.querySelector('channel');
  if (channel) return parseRss(channel);
  // RDF (RSS 1.0)
  if (root.localName === 'RDF') {
    const ch = root.querySelector('channel');
    if (ch) return parseRss(ch);
  }
  throw new Error('알 수 없는 피드 포맷');
}

function textOf(parent: Element, ...localNames: string[]): string {
  for (const name of localNames) {
    for (const child of Array.from(parent.children)) {
      if (child.localName === name) return (child.textContent ?? '').trim();
    }
  }
  return '';
}

function firstChild(parent: Element, localName: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName === localName) return child;
  }
  return null;
}

function findDescendant(parent: Element, localName: string): Element | null {
  const list = parent.getElementsByTagName('*');
  for (let i = 0; i < list.length; i++) {
    if (list[i].localName === localName) return list[i];
  }
  return null;
}

function parseAtom(feed: Element): FetchedFeed {
  const title = textOf(feed, 'title') || 'Untitled';
  const entries: FeedItem[] = [];
  for (const e of Array.from(feed.children)) {
    if (e.localName !== 'entry') continue;
    const id = textOf(e, 'id') || `${entries.length}`;
    const itemTitle = textOf(e, 'title') || '(제목 없음)';
    let link = '';
    const linkEl = firstChild(e, 'link');
    if (linkEl) link = linkEl.getAttribute('href') ?? '';
    const pubText = textOf(e, 'published', 'updated');
    const pubDate = pubText ? Date.parse(pubText) || Date.now() : Date.now();
    const author = (() => {
      const a = firstChild(e, 'author');
      return a ? textOf(a, 'name') : undefined;
    })();
    const thumbEl = findDescendant(e, 'thumbnail');
    const thumbnail = thumbEl?.getAttribute('url') ?? undefined;
    const description =
      textOf(e, 'summary') || (findDescendant(e, 'description')?.textContent ?? '').trim();

    entries.push({ id, title: itemTitle, link, pubDate, author, thumbnail, description });
  }
  return { title, items: entries };
}

function parseRss(channel: Element): FetchedFeed {
  const title = textOf(channel, 'title') || 'Untitled';
  const items: FeedItem[] = [];
  for (const it of Array.from(channel.children)) {
    if (it.localName !== 'item') continue;
    const id = textOf(it, 'guid') || textOf(it, 'link') || `${items.length}`;
    const itemTitle = textOf(it, 'title') || '(제목 없음)';
    const link = textOf(it, 'link');
    const pubText = textOf(it, 'pubDate', 'date');
    const pubDate = pubText ? Date.parse(pubText) || Date.now() : Date.now();
    const author = textOf(it, 'creator', 'author') || undefined;
    const description = textOf(it, 'description');
    let thumbnail: string | undefined;
    const enc = firstChild(it, 'enclosure');
    if (enc && /^image\//i.test(enc.getAttribute('type') ?? '')) {
      thumbnail = enc.getAttribute('url') ?? undefined;
    }
    if (!thumbnail) {
      const thumbEl = findDescendant(it, 'thumbnail');
      thumbnail = thumbEl?.getAttribute('url') ?? undefined;
    }
    items.push({ id, title: itemTitle, link, pubDate, author, thumbnail, description });
  }
  return { title, items };
}
