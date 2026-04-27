import { escapeAttr, escapeHtml, formatRelative } from '@/util';

export interface TickerEntry {
  feedId: string;
  channel: string;
  title: string;
  link: string;
  pubDate: number;
}

const MAX_ENTRIES = 60;

export class Ticker {
  public readonly element: HTMLElement;
  private trackEl: HTMLElement;
  private byFeed = new Map<string, TickerEntry[]>();
  private renderQueued = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'ticker';
    this.element.innerHTML = `<div class="ticker-track" role="marquee" aria-live="off"></div>`;
    this.trackEl = this.element.querySelector<HTMLElement>('.ticker-track')!;
  }

  /** Replace this feed's contribution to the ticker. */
  setFeedItems(
    feedId: string,
    channel: string,
    items: Array<{ title: string; pubDate: number; link: string }>,
  ): void {
    this.byFeed.set(
      feedId,
      items.slice(0, 5).map((it) => ({
        feedId,
        channel,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate,
      })),
    );
    this.scheduleRender();
  }

  /** Drop a feed (e.g. when user removes it). */
  dropFeed(feedId: string): void {
    if (this.byFeed.delete(feedId)) this.scheduleRender();
  }

  show(visible: boolean): void {
    this.element.style.display = visible ? '' : 'none';
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const all: TickerEntry[] = [];
    for (const list of this.byFeed.values()) all.push(...list);
    all.sort((a, b) => b.pubDate - a.pubDate);
    const top = all.slice(0, MAX_ENTRIES);

    if (top.length === 0) {
      this.trackEl.innerHTML = '';
      return;
    }

    const renderOne = (e: TickerEntry) => `
      <a class="ticker-item" href="${escapeAttr(e.link || '#')}" target="_blank" rel="noopener noreferrer">
        <span class="ticker-channel">${escapeHtml(e.channel)}</span>
        <span class="ticker-sep">·</span>
        <span class="ticker-title">${escapeHtml(e.title)}</span>
        <span class="ticker-time">${formatRelative(e.pubDate)}</span>
      </a>`;

    // Duplicate the run so the CSS animation can loop seamlessly (translate -50%).
    const run = top.map(renderOne).join('');
    this.trackEl.innerHTML = `<div class="ticker-run">${run}</div><div class="ticker-run" aria-hidden="true">${run}</div>`;
  }
}
