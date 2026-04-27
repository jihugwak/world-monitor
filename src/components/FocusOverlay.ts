import type { FeedItem, StoredFeed } from '@/types';
import { escapeAttr, escapeHtml, formatRelative } from '@/util';

export interface FocusContext {
  feed: StoredFeed;
  videoId: string | null;
  /** Recent feed items for this channel (sidebar). */
  items: FeedItem[];
}

export class FocusOverlay {
  public readonly element: HTMLElement;
  private current: StoredFeed | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'focus-overlay';
    this.element.style.display = 'none';

    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.current) this.close();
    });
  }

  open(ctx: FocusContext): void {
    this.current = ctx.feed;
    const cid = ctx.feed.feedUrl.match(/channel_id=(UC[\w-]+)/)?.[1] ?? '';
    // Sound on for focus mode — user opted in by clicking
    const src = ctx.videoId
      ? `https://www.youtube.com/embed/${ctx.videoId}?autoplay=1&playsinline=1`
      : `https://www.youtube.com/embed/live_stream?channel=${cid}&autoplay=1&playsinline=1`;

    const items = [...ctx.items]
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 30)
      .map(
        (it) => `
        <li class="focus-item">
          <a href="${escapeAttr(it.link || '#')}" target="_blank" rel="noopener noreferrer" class="focus-item-link">
            <span class="focus-item-title">${escapeHtml(it.title)}</span>
            <span class="focus-item-time">${formatRelative(it.pubDate)}</span>
          </a>
        </li>`,
      )
      .join('');

    this.element.innerHTML = `
      <div class="focus-content" role="dialog" aria-label="${escapeAttr(ctx.feed.title)}">
        <div class="focus-header">
          <span class="focus-title">${escapeHtml(ctx.feed.title)}</span>
          <button class="focus-close" type="button" aria-label="닫기">×</button>
        </div>
        <div class="focus-body">
          <div class="focus-video">
            <iframe
              src="${src}"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
              frameborder="0"></iframe>
          </div>
          <aside class="focus-sidebar">
            <div class="focus-sidebar-title">최근 클립</div>
            <ul class="focus-items">${items || '<li class="focus-empty">항목 없음</li>'}</ul>
          </aside>
        </div>
      </div>`;
    this.element.style.display = 'flex';
    this.element.querySelector<HTMLButtonElement>('.focus-close')?.addEventListener('click', () => this.close());
  }

  close(): void {
    this.current = null;
    this.element.style.display = 'none';
    this.element.innerHTML = '';
  }
}
