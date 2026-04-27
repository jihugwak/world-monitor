import { fetchAndParse, fetchYouTubeLiveVideoId } from '@/feeds';
import type { FeedItem, StoredFeed } from '@/types';
import { escapeAttr, escapeHtml, extractYouTubeChannelId } from '@/util';
import { FocusOverlay } from './FocusOverlay';

export interface LiveWallHooks {
  /** Called whenever a tile finishes a refresh — used to feed the ticker. */
  onItems: (feedId: string, title: string, items: FeedItem[]) => void;
}

export class LiveWall {
  public readonly element: HTMLElement;
  private tiles = new Map<string, LiveTile>();
  private focus: FocusOverlay;
  private hooks: LiveWallHooks;

  constructor(focus: FocusOverlay, hooks: LiveWallHooks) {
    this.focus = focus;
    this.hooks = hooks;
    this.element = document.createElement('section');
    this.element.className = 'live-wall';
  }

  /** Sync the wall to the given feeds (live YouTube channels only). */
  setFeeds(feeds: StoredFeed[]): void {
    const live = feeds.filter((f) => f.live && f.kind === 'youtube');
    const liveIds = new Set(live.map((f) => f.id));

    for (const [id, tile] of this.tiles) {
      if (!liveIds.has(id)) {
        tile.destroy();
        this.tiles.delete(id);
      }
    }

    for (const f of live) {
      let tile = this.tiles.get(f.id);
      if (!tile) {
        tile = new LiveTile(f, this.focus, this.hooks);
        this.tiles.set(f.id, tile);
        this.element.appendChild(tile.element);
      }
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.tiles.values()).map((t) => t.refresh()));
  }

  getCount(): number {
    return this.tiles.size;
  }
}

class LiveTile {
  public readonly element: HTMLElement;
  private feed: StoredFeed;
  private focus: FocusOverlay;
  private hooks: LiveWallHooks;
  private frameEl: HTMLElement;
  private items: FeedItem[] = [];
  private videoId: string | null = null;
  private mountedVideoId: string | null = null;
  private inFlight: AbortController | null = null;

  constructor(feed: StoredFeed, focus: FocusOverlay, hooks: LiveWallHooks) {
    this.feed = feed;
    this.focus = focus;
    this.hooks = hooks;

    this.element = document.createElement('div');
    this.element.className = 'live-tile';
    this.element.dataset.feedId = feed.id;
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'button');
    this.element.setAttribute('aria-label', `${feed.title} 라이브 포커스`);

    this.element.innerHTML = `
      <div class="live-tile-frame">
        <div class="live-tile-loading">${escapeHtml(feed.title)} · 라이브 검색 중…</div>
      </div>
      <div class="live-tile-bar">
        <span class="live-dot"></span>
        <span class="live-tile-name">${escapeHtml(feed.title.replace(/\s*LIVE$/i, ''))}</span>
        <span class="live-tile-tag">LIVE</span>
      </div>`;
    this.frameEl = this.element.querySelector<HTMLElement>('.live-tile-frame')!;

    const openFocus = (e: Event) => {
      // Avoid clicks on the iframe — those are eaten by the iframe anyway, but
      // fall through if user clicks the bar/border.
      if ((e.target as HTMLElement).tagName === 'IFRAME') return;
      this.focus.open({ feed: this.feed, videoId: this.videoId, items: this.items });
    };
    this.element.addEventListener('click', openFocus);
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.focus.open({ feed: this.feed, videoId: this.videoId, items: this.items });
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.inFlight) this.inFlight.abort();
    const ctrl = new AbortController();
    this.inFlight = ctrl;

    const cid = extractYouTubeChannelId(this.feed.feedUrl);
    if (!cid) {
      this.frameEl.innerHTML = '<div class="live-tile-loading">채널 ID 없음</div>';
      return;
    }

    try {
      // Run both in parallel: items for ticker/sidebar, videoId for embed.
      const [vidResult, parsedResult] = await Promise.allSettled([
        fetchYouTubeLiveVideoId(cid, ctrl.signal),
        fetchAndParse(this.feed.feedUrl, ctrl.signal),
      ]);
      if (ctrl.signal.aborted) return;

      if (vidResult.status === 'fulfilled') {
        this.videoId = vidResult.value;
      }
      if (parsedResult.status === 'fulfilled') {
        this.items = parsedResult.value.items;
        this.hooks.onItems(this.feed.id, this.feed.title, this.items);
      }
      this.mountIframe(cid);
    } catch {
      if (ctrl.signal.aborted) return;
      this.mountIframe(cid);
    } finally {
      if (this.inFlight === ctrl) this.inFlight = null;
    }
  }

  private mountIframe(channelId: string): void {
    const targetVid = this.videoId;
    // Don't reload the iframe if the live videoId hasn't changed — refreshes
    // shouldn't interrupt playback.
    if (targetVid === this.mountedVideoId && this.frameEl.querySelector('iframe')) return;
    this.mountedVideoId = targetVid;

    const src = targetVid
      ? `https://www.youtube.com/embed/${targetVid}?autoplay=1&mute=1&playsinline=1&controls=1`
      : `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1&playsinline=1&controls=1`;
    this.frameEl.innerHTML = `
      <iframe
        src="${escapeAttr(src)}"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        frameborder="0"
        loading="lazy"></iframe>`;
  }

  destroy(): void {
    this.inFlight?.abort();
    this.element.remove();
  }
}
