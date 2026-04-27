import { AddFeedDialog } from '@/components/AddFeedDialog';
import { FeedPanel } from '@/components/FeedPanel';
import { FocusOverlay } from '@/components/FocusOverlay';
import { LiveWall } from '@/components/LiveWall';
import { Ticker } from '@/components/Ticker';
import { loadFeeds, loadTheme, makeId, saveFeeds, saveTheme } from '@/storage';
import type { FeedKind, StoredFeed } from '@/types';

const REFRESH_INTERVAL_MS = 10 * 60_000; // 10 min
const TICKER_VISIBLE_KEY = 'fm-ticker-visible';

const SEED_URLS_KEY = 'fm-seeded-urls';

interface SeedFeed {
  url: string;
  title: string;
  kind: FeedKind;
  live?: boolean;
  /** Resolved feed URL for cases where the handle (`@xxx`) is unreachable. */
  feedUrl?: string;
}

const ytFeed = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

const SEED_FEEDS: SeedFeed[] = [
  // 한국 종합
  { url: 'https://www.yna.co.kr/rss/news.xml', title: '연합뉴스', kind: 'rss' },
  { url: 'http://www.hani.co.kr/rss/', title: '한겨레', kind: 'rss' },
  { url: 'https://feeds.bbci.co.uk/korean/rss.xml', title: 'BBC News 한국어', kind: 'rss' },
  // 국내 라이브 — 핸들 페이지가 종종 404를 주므로 channel_id를 직접 박음
  { url: 'https://www.youtube.com/@YTN', feedUrl: ytFeed('UChlgI3UHCOnwUGzWzbJ3H5w'), title: 'YTN', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@yonhapnewstv', feedUrl: ytFeed('UCTHCOPwqNfZ0uiKOvFyhGwg'), title: '연합뉴스TV', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@SBSNEWS', feedUrl: ytFeed('UCkinYTS9IHqOEwR1Sze2JTw'), title: 'SBS 뉴스', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@KBSnews', feedUrl: ytFeed('UCcQTRi69dsVYHN3exePtZ1A'), title: 'KBS News', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@JTBCnews', feedUrl: ytFeed('UCsU-I-vHLiaMfV_ceaYz5rQ'), title: 'JTBC 뉴스', kind: 'youtube', live: true },
  // 국제 라이브 (24/7 스트림 또는 자주 라이브 송출)
  { url: 'https://www.youtube.com/@SkyNews', feedUrl: ytFeed('UCoMdktPbSTixAyNGwb-UYkQ'), title: 'Sky News', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@ABCNews', feedUrl: ytFeed('UCBi2mrWuNuyYy4gbM6fU18Q'), title: 'ABC News', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@aljazeeraenglish', feedUrl: ytFeed('UCNye-wNBqNL5ZzHSJj3l8Bg'), title: 'Al Jazeera', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@NHKWORLDJAPAN', feedUrl: ytFeed('UCSPEjw8F2nQDtmUKPFNF7_A'), title: 'NHK World', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@FRANCE24English', feedUrl: ytFeed('UCQfwfsi5VrQ8yKZ-UWmAEFg'), title: 'France 24', kind: 'youtube', live: true },
  { url: 'https://www.youtube.com/@dwnews', feedUrl: ytFeed('UCknLrEdhRCp1aegoMqRaCZg'), title: 'DW News', kind: 'youtube', live: true },
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
  private liveWall!: LiveWall;
  private ticker!: Ticker;
  private focus!: FocusOverlay;
  private tickerVisible = true;

  async init(): Promise<void> {
    this.theme = loadTheme();
    document.documentElement.dataset.theme = this.theme;
    this.tickerVisible = localStorage.getItem(TICKER_VISIBLE_KEY) !== '0';

    this.focus = new FocusOverlay();
    this.ticker = new Ticker();
    this.liveWall = new LiveWall(this.focus, {
      onItems: (id, title, items) => {
        this.ticker.setFeedItems(id, title, items.map((it) => ({ title: it.title, pubDate: it.pubDate, link: it.link })));
      },
    });

    this.buildShell();
    this.dialog = new AddFeedDialog();

    this.feeds = loadFeeds();
    this.seedNewDefaults();

    this.ticker.show(this.tickerVisible);
    this.syncWall();

    if (this.feeds.length === 0) {
      this.showEmpty(true);
    } else {
      this.showEmpty(false);
      for (const feed of this.feeds) {
        if (feed.live && feed.kind === 'youtube') continue; // handled by LiveWall
        this.mountPanel(feed);
      }
      // initial load — fire all in parallel (panels + live wall)
      await Promise.allSettled([
        ...Array.from(this.panels.values()).map((p) => p.refresh()),
        this.liveWall.refreshAll(),
      ]);
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
        <span class="header-title">WORLD MONITOR</span>
        <span class="header-clock" id="header-clock"></span>
      </div>
      <div class="header-right">
        <button class="header-btn" id="btn-add">+ 피드 추가</button>
        <button class="header-btn" id="btn-ticker" title="티커 표시 전환" aria-pressed="${this.tickerVisible}">≡</button>
        <button class="header-btn" id="btn-refresh-all" title="전체 새로고침">↻</button>
        <button class="header-btn" id="btn-theme" title="테마 전환">◐</button>
      </div>`;
    app.appendChild(header);

    // Ticker (between header and live wall)
    app.appendChild(this.ticker.element);

    // Live wall (always above main grid)
    app.appendChild(this.liveWall.element);

    const main = document.createElement('main');
    main.className = 'main-content';

    this.grid = document.createElement('div');
    this.grid.className = 'panels-grid';
    this.grid.id = 'panels-grid';
    main.appendChild(this.grid);

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.innerHTML = `
      <div class="empty-icon">□</div>
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

    // Focus overlay sits at root so it covers everything
    app.appendChild(this.focus.element);

    this.statusText = footer.querySelector<HTMLElement>('#status-text')!;

    document.getElementById('btn-add')!.addEventListener('click', () => void this.handleAdd());
    document.getElementById('btn-refresh-all')!.addEventListener('click', () => void this.refreshAll());
    document.getElementById('btn-theme')!.addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-ticker')!.addEventListener('click', () => this.toggleTicker());
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
    const existingByInputUrl = new Map(this.feeds.map((f) => [f.inputUrl, f]));
    let added = false;
    let migrated = false;
    for (const s of SEED_FEEDS) {
      const existing = existingByInputUrl.get(s.url);
      if (existing) {
        // Backfill live flag onto already-saved seed feeds (pre-feature data).
        if (s.live && !existing.live) {
          existing.live = true;
          migrated = true;
        }
        // Repair feedUrl on entries that never resolved past the @handle form
        // (the handle page returns 404 through CORS proxies).
        if (s.feedUrl && existing.feedUrl !== s.feedUrl && !/channel_id=UC/.test(existing.feedUrl)) {
          existing.feedUrl = s.feedUrl;
          migrated = true;
        }
        seenUrls.add(s.url);
        continue;
      }
      if (seenUrls.has(s.url)) continue;
      this.feeds.push({
        id: makeId(),
        inputUrl: s.url,
        feedUrl: s.feedUrl ?? s.url,
        title: s.title,
        kind: s.kind,
        addedAt: Date.now(),
        live: s.live,
      });
      seenUrls.add(s.url);
      added = true;
    }
    if (added || migrated) saveFeeds(this.feeds);
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
      onItems: (id, title, items) => {
        this.ticker.setFeedItems(
          id,
          title,
          items.map((it) => ({ title: it.title, pubDate: it.pubDate, link: it.link })),
        );
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
    this.ticker.dropFeed(id);
    this.syncWall();
    if (this.feeds.length === 0) this.showEmpty(true);
    this.updateStatus();
  }

  private syncWall(): void {
    this.liveWall.setFeeds(this.feeds);
  }

  private async refreshAll(): Promise<void> {
    await Promise.allSettled([
      ...Array.from(this.panels.values()).map((p) => p.refresh()),
      this.liveWall.refreshAll(),
    ]);
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

  private toggleTicker(): void {
    this.tickerVisible = !this.tickerVisible;
    this.ticker.show(this.tickerVisible);
    localStorage.setItem(TICKER_VISIBLE_KEY, this.tickerVisible ? '1' : '0');
    document.getElementById('btn-ticker')!.setAttribute('aria-pressed', String(this.tickerVisible));
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
      : `정상 동작 · ${REFRESH_INTERVAL_MS / 60_000}분마다 자동 새로고침 · 라이브 ${this.liveWall.getCount()}개`;
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    for (const p of this.panels.values()) p.destroy();
    this.panels.clear();
  }
}
