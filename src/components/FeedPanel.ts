import { fetchAndParse, resolveFeedUrl } from '@/feeds';
import type { FeedItem, FeedStatus, StoredFeed } from '@/types';
import { escapeAttr, escapeHtml, formatRelative } from '@/util';

const ITEMS_PER_PANEL = 20;

export interface FeedPanelHooks {
  onRemove: (id: string) => void;
  onUrlResolved?: (id: string, feedUrl: string, title: string) => void;
  onItems?: (id: string, title: string, items: FeedItem[]) => void;
}

function isResolvedYouTubeFeedUrl(url: string): boolean {
  return url.includes('youtube.com/feeds/videos.xml');
}

function isUnresolvedYouTubeHandle(url: string): boolean {
  return /youtube\.com\/(?:@|c\/)/.test(url) && !isResolvedYouTubeFeedUrl(url);
}

export class FeedPanel {
  public readonly element: HTMLElement;
  private feed: StoredFeed;
  private hooks: FeedPanelHooks;
  private content: HTMLElement;
  private titleEl: HTMLElement;
  private countEl: HTMLElement;
  private badgeEl: HTMLElement;
  private inFlight: AbortController | null = null;

  constructor(feed: StoredFeed, hooks: FeedPanelHooks) {
    this.feed = feed;
    this.hooks = hooks;

    this.element = document.createElement('div');
    this.element.className = 'panel';
    this.element.dataset.feedId = feed.id;
    this.element.dataset.kind = feed.kind;

    const header = document.createElement('div');
    header.className = 'panel-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'panel-title';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'panel-title-text';
    this.titleEl.textContent = feed.title;
    this.titleEl.title = feed.feedUrl;

    this.countEl = document.createElement('span');
    this.countEl.className = 'panel-count';

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'panel-badge loading';
    this.badgeEl.textContent = '...';

    titleWrap.append(this.titleEl, this.countEl, this.badgeEl);

    const kindTag = document.createElement('span');
    kindTag.className = `panel-kind kind-${feed.kind}`;
    kindTag.textContent = feed.kind.toUpperCase();
    titleWrap.appendChild(kindTag);

    const actions = document.createElement('div');
    actions.className = 'panel-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'panel-action-btn';
    refreshBtn.title = '새로고침';
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', () => void this.refresh());

    const openBtn = document.createElement('button');
    openBtn.className = 'panel-action-btn';
    openBtn.title = '피드 URL 열기';
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', () => window.open(feed.feedUrl, '_blank', 'noopener'));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'panel-action-btn panel-action-danger';
    removeBtn.title = '삭제';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      if (confirm(`"${this.feed.title}" 삭제할까요?`)) this.hooks.onRemove(this.feed.id);
    });

    actions.append(refreshBtn, openBtn, removeBtn);
    header.append(titleWrap, actions);

    this.content = document.createElement('div');
    this.content.className = 'panel-content';
    this.renderSkeleton();

    this.element.append(header, this.content);
  }

  get id(): string {
    return this.feed.id;
  }

  setStatus(s: FeedStatus): void {
    this.badgeEl.className = `panel-badge ${s}`;
    this.badgeEl.textContent =
      s === 'live' ? 'LIVE' : s === 'cached' ? 'CACHED' : s === 'error' ? 'ERROR' : '...';
  }

  private renderSkeleton(): void {
    this.content.innerHTML = `
      <div class="loading-skeleton">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
      </div>`;
  }

  private renderError(msg: string): void {
    this.content.innerHTML = `<div class="panel-error">${escapeHtml(msg)}</div>`;
  }

  private renderItems(items: FeedItem[]): void {
    if (items.length === 0) {
      this.content.innerHTML = '<div class="panel-empty">아직 항목이 없습니다</div>';
      return;
    }
    const sorted = [...items].sort((a, b) => b.pubDate - a.pubDate).slice(0, ITEMS_PER_PANEL);
    const html = sorted.map((it) => renderItem(it, this.feed.kind)).join('');
    this.content.innerHTML = `<ul class="feed-items">${html}</ul>`;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) this.inFlight.abort();
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    this.setStatus('loading');
    try {
      // Lazy-resolve YouTube @handle / /c/ URLs to channel_id form on first fetch
      if (isUnresolvedYouTubeHandle(this.feed.feedUrl)) {
        const r = await resolveFeedUrl(this.feed.feedUrl, ctrl.signal);
        if (ctrl.signal.aborted) return;
        this.feed.feedUrl = r.feedUrl;
        if (r.title) {
          this.feed.title = r.title;
          this.titleEl.textContent = r.title;
        }
        this.hooks.onUrlResolved?.(this.feed.id, r.feedUrl, this.feed.title);
        this.countEl.textContent = `(${r.items.length})`;
        this.renderItems(r.items);
        this.hooks.onItems?.(this.feed.id, this.feed.title, r.items);
        this.setStatus('live');
        return;
      }
      const result = await fetchAndParse(this.feed.feedUrl, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (result.title && result.title !== this.feed.title) {
        this.feed.title = result.title;
        this.titleEl.textContent = result.title;
      }
      this.countEl.textContent = `(${result.items.length})`;
      this.renderItems(result.items);
      this.hooks.onItems?.(this.feed.id, this.feed.title, result.items);
      this.setStatus('live');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      this.setStatus('error');
      this.renderError(e instanceof Error ? e.message : '알 수 없는 오류');
    } finally {
      if (this.inFlight === ctrl) this.inFlight = null;
    }
  }

  /** Apply already-fetched items (used right after add) */
  applyInitial(title: string, items: FeedItem[]): void {
    if (title) {
      this.feed.title = title;
      this.titleEl.textContent = title;
    }
    this.countEl.textContent = `(${items.length})`;
    this.renderItems(items);
    this.hooks.onItems?.(this.feed.id, this.feed.title, items);
    this.setStatus('live');
  }

  destroy(): void {
    this.inFlight?.abort();
    this.element.remove();
  }
}

function renderItem(item: FeedItem, kind: string): string {
  const time = formatRelative(item.pubDate);
  const author = item.author ? `<span class="item-author">${escapeHtml(item.author)}</span>` : '';
  const thumb = item.thumbnail
    ? `<img class="item-thumb" loading="lazy" src="${escapeAttr(item.thumbnail)}" alt="" />`
    : '';
  const link = item.link ? escapeAttr(item.link) : '#';
  const isYouTube = kind === 'youtube';
  return `
    <li class="feed-item${isYouTube ? ' has-thumb' : ''}">
      ${thumb}
      <div class="item-body">
        <a class="item-title" href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
        <div class="item-meta">
          <span class="item-time">${time}</span>
          ${author}
        </div>
      </div>
    </li>`;
}
