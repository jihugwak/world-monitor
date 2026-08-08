import { escapeAttr, escapeHtml } from '@/util';

/** Full-screen overlay that loads an article URL inside an iframe so users
 *  can read feed items without bouncing out to an external browser.
 *
 *  Relies on electron/main.cjs stripping X-Frame-Options and CSP
 *  frame-ancestors headers — most news sites would otherwise refuse to embed. */
export class ArticleReader {
  public readonly element: HTMLElement;
  private currentUrl: string | null = null;
  private iframeEl: HTMLIFrameElement | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'reader-overlay';
    this.element.style.display = 'none';

    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentUrl) this.close();
    });
  }

  open(url: string, title?: string): void {
    if (!url) return;

    // The in-app iframe reader depends on the Electron main process stripping
    // X-Frame-Options / CSP frame-ancestors. In a plain browser (the web/phone
    // PWA build) that's impossible and most sites refuse to embed — so just
    // open the article in a new tab instead of showing a blank frame.
    if (import.meta.env.VITE_TARGET === 'web') {
      window.open(url, '_blank', 'noopener');
      return;
    }

    this.currentUrl = url;

    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = url;
    }

    const heading = title?.trim() ? title : host;

    this.element.innerHTML = `
      <div class="reader-content" role="dialog" aria-label="${escapeAttr(heading)}">
        <div class="reader-header">
          <div class="reader-title">
            <span class="reader-host">${escapeHtml(host)}</span>
            <span class="reader-heading">${escapeHtml(heading)}</span>
          </div>
          <div class="reader-actions">
            <button class="reader-btn reader-back" type="button" title="뒤로" aria-label="뒤로">‹</button>
            <button class="reader-btn reader-fwd" type="button" title="앞으로" aria-label="앞으로">›</button>
            <button class="reader-btn reader-reload" type="button" title="새로고침" aria-label="새로고침">↻</button>
            <button class="reader-btn reader-external" type="button" title="브라우저로 열기" aria-label="브라우저로 열기">↗</button>
            <button class="reader-btn reader-close" type="button" title="닫기" aria-label="닫기">×</button>
          </div>
        </div>
        <div class="reader-body">
          <iframe
            src="${escapeAttr(url)}"
            referrerpolicy="no-referrer-when-downgrade"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowfullscreen></iframe>
        </div>
      </div>`;

    this.iframeEl = this.element.querySelector<HTMLIFrameElement>('iframe');
    this.element.style.display = 'flex';

    this.element.querySelector<HTMLButtonElement>('.reader-close')?.addEventListener('click', () => this.close());
    this.element.querySelector<HTMLButtonElement>('.reader-external')?.addEventListener('click', () => {
      if (this.currentUrl) window.open(this.currentUrl, '_blank', 'noopener');
    });
    this.element.querySelector<HTMLButtonElement>('.reader-reload')?.addEventListener('click', () => {
      const f = this.iframeEl;
      if (!f) return;
      // contentWindow.location.reload() throws cross-origin; re-set src instead.
      const u = f.src;
      f.src = 'about:blank';
      requestAnimationFrame(() => { f.src = u; });
    });
    this.element.querySelector<HTMLButtonElement>('.reader-back')?.addEventListener('click', () => {
      try { this.iframeEl?.contentWindow?.history.back(); } catch { /* cross-origin */ }
    });
    this.element.querySelector<HTMLButtonElement>('.reader-fwd')?.addEventListener('click', () => {
      try { this.iframeEl?.contentWindow?.history.forward(); } catch { /* cross-origin */ }
    });
  }

  close(): void {
    this.currentUrl = null;
    this.iframeEl = null;
    this.element.style.display = 'none';
    this.element.innerHTML = '';
  }
}
