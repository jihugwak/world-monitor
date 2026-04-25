export type FeedKind = 'rss' | 'atom' | 'youtube';

export type FeedStatus = 'loading' | 'live' | 'cached' | 'error';

/** Persistable feed metadata (saved to localStorage) */
export interface StoredFeed {
  id: string;
  /** What the user originally typed */
  inputUrl: string;
  /** Resolved feed URL we actually fetch */
  feedUrl: string;
  title: string;
  kind: FeedKind;
  addedAt: number;
}

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  pubDate: number;
  author?: string;
  description?: string;
  thumbnail?: string;
}

export interface FetchedFeed {
  title: string;
  items: FeedItem[];
}
