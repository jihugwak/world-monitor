import { fetchAndParse, fetchYouTubeLiveVideoId } from '@/feeds';
import type { FeedItem, StoredFeed } from '@/types';
import { escapeHtml, extractYouTubeChannelId } from '@/util';
import { FocusOverlay } from './FocusOverlay';

export interface LiveWallHooks {
  /** Called whenever a tile finishes a refresh — used to feed the ticker. */
  onItems: (feedId: string, title: string, items: FeedItem[]) => void;
}

const PRIMARY_KEY = 'fm-live-primary';

export class LiveWall {
  public readonly element: HTMLElement;
  private tiles = new Map<string, LiveTile>();
  private focus: FocusOverlay;
  private hooks: LiveWallHooks;
  private hintEl: HTMLElement;
  private primaryId: string | null;
  private resizeObserver: ResizeObserver;

  constructor(focus: FocusOverlay, hooks: LiveWallHooks) {
    this.focus = focus;
    this.hooks = hooks;
    this.element = document.createElement('section');
    this.element.className = 'live-wall';

    // Single grid container — every tile (featured or not) lives directly inside
    // `element`, and "promote" is just a CSS class toggle. Reparenting an iframe
    // forces YouTube to reload the embed (every browser does this), and the
    // reloaded embed often comes up black, so we never move tiles between
    // containers.
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'live-wall-primary-hint';
    this.hintEl.innerHTML = '<span class="live-wall-hint-icon">⤢</span><span>아래 타일의 ⤢ 버튼을 누르거나 이쪽으로 드래그하면 크게 볼 수 있어요</span>';
    this.element.appendChild(this.hintEl);

    this.primaryId = localStorage.getItem(PRIMARY_KEY);

    this.hintEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/feed-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.hintEl.classList.add('drop-target');
    });
    this.hintEl.addEventListener('dragleave', (e) => {
      if (e.target === this.hintEl) this.hintEl.classList.remove('drop-target');
    });
    this.hintEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.hintEl.classList.remove('drop-target');
      const id = e.dataTransfer?.getData('text/feed-id');
      if (id) this.setPrimary(id);
    });

    // The right-rail tile height is derived from the wall width, so re-derive it
    // whenever the wall is resized while a tile is promoted.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.element.classList.contains('has-primary')) this.applyPrimaryGrid();
    });
    this.resizeObserver.observe(this.element);
  }

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
        tile = new LiveTile(f, this.focus, this.hooks, {
          onPromote: (id) => this.setPrimary(id),
          onDemote: () => this.setPrimary(null),
          onLiveChange: () => this.handleLiveChange(),
        });
        this.tiles.set(f.id, tile);
        this.element.appendChild(tile.element);
      }
    }

    if (this.primaryId && !this.tiles.has(this.primaryId)) {
      this.primaryId = null;
      localStorage.removeItem(PRIMARY_KEY);
    }

    this.renderLayout();
  }

  setPrimary(id: string | null): void {
    const next = id === this.primaryId ? null : id;
    if (next) {
      const t = this.tiles.get(next);
      if (!t || !t.hasLive) return; // can't promote a non-live tile
    }
    this.primaryId = next;
    if (next) localStorage.setItem(PRIMARY_KEY, next);
    else localStorage.removeItem(PRIMARY_KEY);
    this.renderLayout();
  }

  private handleLiveChange(): void {
    // Pinned primary stays pinned — even if the channel temporarily drops out
    // of live detection, we keep the slot and the iframe so playback continues.
    this.renderLayout();
  }

  private renderLayout(): void {
    const primaryTile = this.primaryId ? this.tiles.get(this.primaryId) ?? null : null;
    const hasPrimary = !!primaryTile;
    const hasAnyLive = Array.from(this.tiles.values()).some((t) => t.hasLive);

    this.element.classList.toggle('has-primary', hasPrimary);
    this.hintEl.style.display = !hasPrimary && hasAnyLive ? '' : 'none';

    if (hasPrimary) {
      this.applyPrimaryGrid();
    } else {
      this.element.style.gridTemplateColumns = '';
      this.element.style.gridTemplateRows = '';
      this.element.style.gridAutoRows = '';
    }

    for (const tile of this.tiles.values()) {
      tile.setFeatured(tile === primaryTile);
    }
  }

  /** Lay out the promoted state: featured tile spans the left half (`grid-column: 1`,
   *  `grid-row: 1 / -1`) so the remaining tiles flow only into the right columns,
   *  which scroll vertically. Small-tile height is derived from the wall width so
   *  each stays 16:9 at a fixed size (overflow scrolls, it doesn't shrink). */
  private applyPrimaryGrid(): void {
    const others = this.tiles.size - 1;
    if (others <= 0) {
      this.element.style.gridTemplateColumns = '1fr';
      this.element.style.gridTemplateRows = '';
      this.element.style.gridAutoRows = '';
      return;
    }
    const cols = others === 1 ? 1 : 2; // small columns on the right half
    this.element.style.gridTemplateColumns = `${cols}fr ${Array(cols).fill('1fr').join(' ')}`;

    const GAP = 6; // .live-wall grid gap (padding is 0 in the promoted layout)
    const totalCols = cols + 1; // featured column + small columns
    const usable = Math.max(0, this.element.clientWidth - GAP * (totalCols - 1));
    const smallColW = usable / (2 * cols); // featured = `cols` fr (half), each small = 1 fr
    const BAR_H = 28; // approx height of .live-tile-bar
    const rowH = Math.max(72, Math.round((smallColW * 9) / 16 + BAR_H));

    // Use explicit rows (not grid-auto-rows) so the featured tile's
    // `grid-row: 1 / -1` truly spans the whole left column — `-1` resolves to the
    // last *explicit* row line, so without these tracks the featured tile only
    // claims row 1 and small tiles leak into the left half under the big video.
    const rows = Math.ceil(others / cols);
    this.element.style.gridTemplateRows = `repeat(${rows}, ${rowH}px)`;
    this.element.style.gridAutoRows = '';
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.tiles.values()).map((t) => t.refresh()));
  }

  /** Active live tile count (used for status bar). */
  getCount(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.hasLive) n++;
    return n;
  }
}

interface TileHooks {
  onPromote: (id: string) => void;
  onDemote: (id: string) => void;
  onLiveChange: () => void;
}

class LiveTile {
  public readonly element: HTMLElement;
  public hasLive = false;
  private feed: StoredFeed;
  private focus: FocusOverlay;
  private hooks: LiveWallHooks;
  private tileHooks: TileHooks;
  private frameEl: HTMLElement;
  private promoteBtn: HTMLButtonElement;
  private items: FeedItem[] = [];
  private videoId: string | null = null;
  private mountedVideoId: string | null = null;
  private inFlight: AbortController | null = null;
  private featured = false;

  constructor(feed: StoredFeed, focus: FocusOverlay, hooks: LiveWallHooks, tileHooks: TileHooks) {
    this.feed = feed;
    this.focus = focus;
    this.hooks = hooks;
    this.tileHooks = tileHooks;

    this.element = document.createElement('div');
    this.element.className = 'live-tile';
    this.element.dataset.feedId = feed.id;
    this.element.tabIndex = 0;
    this.element.draggable = true;
    this.element.setAttribute('role', 'button');
    this.element.setAttribute('aria-label', `${feed.title} 라이브 포커스`);

    this.element.innerHTML = `
      <div class="live-tile-frame">
        <div class="live-tile-loading">${escapeHtml(feed.title)} · 라이브 검색 중…</div>
        <button class="live-tile-promote" type="button" aria-label="크게 보기" title="크게 보기">⤢</button>
      </div>
      <div class="live-tile-bar">
        <span class="live-dot"></span>
        <span class="live-tile-name">${escapeHtml(feed.title.replace(/\s*LIVE$/i, ''))}</span>
        <span class="live-tile-tag">LIVE</span>
      </div>`;
    this.frameEl = this.element.querySelector<HTMLElement>('.live-tile-frame')!;
    this.promoteBtn = this.element.querySelector<HTMLButtonElement>('.live-tile-promote')!;

    this.promoteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.featured) this.tileHooks.onDemote(this.feed.id);
      else this.tileHooks.onPromote(this.feed.id);
    });

    const openFocus = (e: Event) => {
      if ((e.target as HTMLElement).tagName === 'IFRAME') return;
      if ((e.target as HTMLElement).closest('.live-tile-promote')) return;
      this.focus.open({ feed: this.feed, videoId: this.videoId, items: this.items });
    };
    this.element.addEventListener('click', openFocus);
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.focus.open({ feed: this.feed, videoId: this.videoId, items: this.items });
      }
    });

    this.element.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/feed-id', this.feed.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      this.element.classList.add('dragging');
    });
    this.element.addEventListener('dragend', () => {
      this.element.classList.remove('dragging');
    });

    void this.refresh();
  }

  setFeatured(featured: boolean): void {
    if (this.featured === featured) return;
    this.featured = featured;
    this.element.classList.toggle('live-tile-featured', featured);
    this.promoteBtn.textContent = featured ? '⤡' : '⤢';
    this.promoteBtn.title = featured ? '작게 보기' : '크게 보기';
    this.promoteBtn.setAttribute('aria-label', featured ? '작게 보기' : '크게 보기');
    this.syncMute();
    // Demoting an offline tile: drop the iframe so the tile can show its
    // "라이브 시작 대기 중" placeholder cleanly when it isn't live.
    if (!featured && !this.videoId) this.unmountIframe();
  }

  /** Push the current mute state to the iframe via the YouTube IFrame API.
   *  Featured (large) tile plays with sound; small tiles stay muted. */
  private syncMute(): void {
    this.postCommand(this.featured ? 'unMute' : 'mute');
  }

  /** Send a YouTube IFrame API command without reloading the embed —
   *  requires `enablejsapi=1` on the embed URL. */
  private postCommand(func: string): void {
    const iframe = this.frameEl.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args: [] }),
      '*',
    );
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

    const wasLive = this.hasLive;
    try {
      const [vidResult, parsedResult] = await Promise.allSettled([
        fetchYouTubeLiveVideoId(cid, ctrl.signal),
        fetchAndParse(this.feed.feedUrl, ctrl.signal),
      ]);
      if (ctrl.signal.aborted) return;

      if (vidResult.status === 'fulfilled') {
        this.videoId = vidResult.value;
      } else {
        this.videoId = null;
      }
      if (parsedResult.status === 'fulfilled') {
        this.items = parsedResult.value.items;
        this.hooks.onItems(this.feed.id, this.feed.title, this.items);
      }
    } catch {
      if (ctrl.signal.aborted) return;
      this.videoId = null;
    } finally {
      if (this.inFlight === ctrl) this.inFlight = null;
    }

    this.hasLive = !!this.videoId;
    if (this.videoId) {
      this.mountIframe();
    } else if (!this.featured) {
      // Non-featured tiles disappear when not live. The featured (pinned) tile
      // keeps its existing iframe so playback continues even if YouTube's live
      // detection blinks out for a refresh cycle.
      this.unmountIframe();
    } else if (!this.frameEl.querySelector('iframe')) {
      // Featured + never mounted yet (e.g. restored from localStorage but
      // currently offline) — show a meaningful waiting message.
      const loading = this.frameEl.querySelector('.live-tile-loading');
      if (loading) loading.textContent = `${this.feed.title} · 라이브 시작 대기 중`;
    }

    if (wasLive !== this.hasLive) this.tileHooks.onLiveChange();
  }

  private mountIframe(): void {
    const targetVid = this.videoId;
    if (!targetVid) return;
    if (targetVid === this.mountedVideoId && this.frameEl.querySelector('iframe')) {
      return;
    }
    this.mountedVideoId = targetVid;

    // Always autoplay muted — browsers block autoplay-with-sound without a
    // user-gesture context, and a blocked stream just shows a black frame.
    // `enablejsapi=1` lets us drive mute/unMute via postMessage when the tile
    // is promoted/demoted, instead of reloading the iframe. It MUST be paired
    // with an `origin` that matches the page — in the packaged app the renderer
    // is served from http://127.0.0.1:<port>, and without a matching origin the
    // YouTube player refuses to start and the tile stays black.
    const src = `https://www.youtube.com/embed/${targetVid}?autoplay=1&mute=1&playsinline=1&controls=1&modestbranding=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;

    const loading = this.frameEl.querySelector('.live-tile-loading');
    if (loading) loading.remove();
    const oldFrame = this.frameEl.querySelector('iframe');
    if (oldFrame) oldFrame.remove();

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('frameborder', '0');
    iframe.loading = 'lazy';
    // Resync mute when the embed finishes loading — the player ignores
    // postMessage commands until it's ready, so a small delay catches the
    // case where setFeatured fired before the iframe was alive.
    iframe.addEventListener('load', () => {
      window.setTimeout(() => this.syncMute(), 250);
    });
    this.frameEl.insertBefore(iframe, this.promoteBtn);
  }

  private unmountIframe(): void {
    const old = this.frameEl.querySelector('iframe');
    if (old) old.remove();
    this.mountedVideoId = null;
  }

  destroy(): void {
    this.inFlight?.abort();
    this.element.remove();
  }
}
