import { AddFeedDialog } from '@/components/AddFeedDialog';
import { FeedPanel } from '@/components/FeedPanel';
import { loadFeeds, loadTheme, makeId, saveFeeds, saveTheme } from '@/storage';
import type { FeedKind, StoredFeed } from '@/types';

const REFRESH_INTERVAL_MS = 10 * 60_000; // 10 min

const SEED_URLS_KEY = 'fm-seeded-urls';

const SEED_FEEDS: Array<{ url: string; title: string; kind: FeedKind }> = [
  // 한국 종합
  { url: 'https://www.yna.co.kr/rss/news.xml', title: '연합뉴스', kind: 'rss' },
  { url: 'http://www.hani.co.kr/rss/', title: '한겨레', kind: 'rss' },
  { url: 'https://feeds.bbci.co.uk/korean/rss.xml', title: 'BBC News 한국어', kind: 'rss' },
  // 라이브 뉴스 (YouTube 24h 스트림 채널 — 핸들은 첫 fetch에서 channel_id로 자동 해석)
  { url: 'https://www.youtube.com/@YTN', title: 'YTN 뉴스 LIVE', kind: 'youtube' },
  { url: 'https://www.youtube.com/@yonhapnewstv', title: '연합뉴스TV LIVE', kind: 'youtube' },
  { url: 'https://www.youtube.com/@SBSNEWS', title: 'SBS 뉴스 LIVE', kind: 'youtube' },
  { url: 'https://www.youtube.com/@KBSnews', title: 'KBS 뉴스 LIVE', kind: 'youtube' },
  { url: 'https://www.youtube.com/@JTBCnews', title: 'JTBC 뉴스 LIVE', kind: 'youtube' },
  // 테크 / 국제
  { url: 'https://feeds.feedburner.com/geeknews-feed', title: 'GeekNews', kind: 'rss' },
  { url: 'https://news.ycombinator.com/rss', title: 'Hacker News', kind: 'rss' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', title: 'NYT World', kind: 'rss' },
];

export class App {
  private feeds: StoredFeed[] = [];
  private panels = new Map<string, FeedPanel>();
  private grid!: HTMLElement;
  private emptyState!: HTMLElement;
  private statusText!: HTMLElement;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private theme: 'dark' | 'light' = 'dark';
  private dialog!: AddFeedDialog;

  async init(): Promise<void> {
    this.theme = loadTheme();
    document.documentElement.dataset.theme = this.theme;

    this.buildShell();
    this.dialog = new AddFeedDialog();

    this.feeds = loadFeeds();
    this.seedNewDefaults();

    if (this.feeds.length === 0) {
      this.showEmpty(true);
    } else {
      this.showEmpty(false);
      for (const feed of this.feeds) this.mountPanel(feed);
      // initial load — fire all in parallel
      await Promise.allSettled(
        Array.from(this.panels.values()).map((p) => p.refresh()),
      );
    }

    this.startRefreshLoop();
    this.startClock();
    this.updateStatus();
  }

  private buildShell(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML = `
      <div class="header-left">
        <span class="status-dot"></span>
        <span class="header-title">FEED MONITOR</span>
        <span class="header-clock" id="header-clock"></span>
      </div>
      <div class="header-right">
        <button class="header-btn" id="btn-add">+ 피드 추가</button>
        <button class="header-btn" id="btn-refresh-all" title="전체 새로고침">\u21BB</button>
        <button class="header-btn" id="btn-theme" title="테마 전환">\u25D0</button>
      </div>`;
    app.appendChild(header);

    const main = document.createElement('main');
    main.className = 'main-content';

    this.grid = document.createElement('div');
    this.grid.className = 'panels-grid';
    this.grid.id = 'panels-grid';
    main.appendChild(this.grid);

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.innerHTML = `
      <div class="empty-icon">\u25A1</div>
      <div class="empty-title">등록된 피드가 없습니다</div>
      <div class="empty-hint">상단 <b>+ 피드 추가</b> 버튼으로 RSS / 블로그 / YouTube 채널 URL을 등록하세요.</div>
      <div class="empty-examples">
        <div class="empty-example-title">예시</div>
        <ul>
          <li>https://news.ycombinator.com/rss</li>
          <li>https://www.youtube.com/@MrBeast</li>
          <li>https://overreacted.io/rss.xml</li>
          <li>https://www.bbc.com/news (자동 탐색)</li>
        </ul>
      </div>`;
    main.appendChild(this.emptyState);

    app.appendChild(main);

    const footer = document.createElement('footer');
    footer.className = 'status-bar';
    footer.innerHTML = `
      <div id="status-text">초기화 중...</div>
      <div class="status-bar-right">
        <span id="status-feed-count">0개 피드</span>
      </div>`;
    app.appendChild(footer);

    this.statusText = footer.querySelector<HTMLElement>('#status-text')!;

    document.getElementById('btn-add')!.addEventListener('click', () => void this.handleAdd());
    document.getElementById('btn-refresh-all')!.addEventListener('click', () => void this.refreshAll());
    document.getElementById('btn-theme')!.addEventListener('click', () => this.toggleTheme());
  }

  /**
   * Add any seed entries the user hasn't seen yet — and skip ones they already
   * have or have explicitly removed. Tracking is per-URL so adding new seeds
   * later only inserts the new ones.
   */
  private seedNewDefaults(): void {
    const raw = localStorage.getItem(SEED_URLS_KEY);
    const seenUrls = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    // Migration: if user only has the old flag, mark all currently-saved feeds
    // as already-seeded so we don't re-add them.
    if (!raw && localStorage.getItem('fm-seeded') === '1') {
      for (const f of this.feeds) seenUrls.add(f.feedUrl);
    }
    const existingUrls = new Set(this.feeds.map((f) => f.feedUrl));
    let added = false;
    for (const s of SEED_FEEDS) {
      if (seenUrls.has(s.url)) continue;
      if (existingUrls.has(s.url)) {
        seenUrls.add(s.url);
        continue;
      }
      this.feeds.push({
        id: makeId(),
        inputUrl: s.url,
        feedUrl: s.url,
        title: s.title,
        kind: s.kind,
        addedAt: Date.now(),
      });
      seenUrls.add(s.url);
      added = true;
    }
    if (added) saveFeeds(this.feeds);
    localStorage.setItem(SEED_URLS_KEY, JSON.stringify(Array.from(seenUrls)));
  }

  private async handleAdd(): Promise<void> {
    const result = await this.dialog.open();
    if (!result) return;

    const newFeed: StoredFeed = {
      id: makeId(),
      inputUrl: result.inputUrl,
      feedUrl: result.feedUrl,
      title: result.title || result.inputUrl,
      kind: result.kind,
      addedAt: Date.now(),
    };
    this.feeds.unshift(newFeed);
    saveFeeds(this.feeds);
    this.showEmpty(false);

    const panel = this.mountPanel(newFeed, true);
    panel.applyInitial(result.title, result.items);
    this.updateStatus();
  }

  private mountPanel(feed: StoredFeed, prepend = false): FeedPanel {
    const panel = new FeedPanel(feed, {
      onRemove: (id) => this.removeFeed(id),
      onUrlResolved: (id, feedUrl, title) => {
        const f = this.feeds.find((x) => x.id === id);
        if (!f) return;
        f.feedUrl = feedUrl;
        if (title) f.title = title;
        saveFeeds(this.feeds);
      },
    });
    this.panels.set(feed.id, panel);
    if (prepend && this.grid.firstChild) {
      this.grid.insertBefore(panel.element, this.grid.firstChild);
    } else {
      this.grid.appendChild(panel.element);
    }
    return panel;
  }

  private removeFeed(id: string): void {
    const panel = this.panels.get(id);
    panel?.destroy();
    this.panels.delete(id);
    this.feeds = this.feeds.filter((f) => f.id !== id);
    saveFeeds(this.feeds);
    if (this.feeds.length === 0) this.showEmpty(true);
    this.updateStatus();
  }

  private async refreshAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.panels.values()).map((p) => p.refresh()));
    this.updateStatus();
  }

  private startRefreshLoop(): void {
    this.refreshTimer = setInterval(() => {
      if (document.hidden) return;
      void this.refreshAll();
    }, REFRESH_INTERVAL_MS);
  }

  private toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    saveTheme(this.theme);
  }

  private showEmpty(empty: boolean): void {
    this.emptyState.style.display = empty ? '' : 'none';
    this.grid.style.display = empty ? 'none' : '';
  }

  private startClock(): void {
    const el = document.getElementById('header-clock')!;
    const tick = () => {
      el.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    };
    tick();
    this.clockTimer = setInterval(tick, 1000);
  }

  private updateStatus(): void {
    document.getElementById('status-feed-count')!.textContent = `${this.feeds.length}개 피드`;
    this.statusText.textContent = this.feeds.length === 0
      ? '대기 중'
      : `정상 동작 · ${REFRESH_INTERVAL_MS / 60_000}분마다 자동 새로고침`;
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    for (const p of this.panels.values()) p.destroy();
    this.panels.clear();
  }
}
