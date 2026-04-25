import { resolveFeedUrl } from '@/feeds';
import type { FeedItem, FeedKind } from '@/types';

export interface AddResult {
  inputUrl: string;
  feedUrl: string;
  kind: FeedKind;
  title: string;
  items: FeedItem[];
}

export class AddFeedDialog {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private statusEl: HTMLElement;
  private addBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private resolveFn: ((r: AddResult | null) => void) | null = null;
  private busy = false;
  private ctrl: AbortController | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'dialog-backdrop';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="dialog">
        <div class="dialog-header">피드 추가</div>
        <div class="dialog-body">
          <input type="url" class="dialog-input" placeholder="https://example.com  /  YouTube 채널 URL  /  RSS XML URL" autocomplete="off" />
          <div class="dialog-hint">RSS · Atom · YouTube (채널/플레이리스트/@핸들). 블로그 메인 URL 붙여넣어도 자동 탐색합니다.</div>
          <div class="dialog-status"></div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-cancel">취소</button>
          <button class="btn btn-confirm">추가</button>
        </div>
      </div>`;

    this.input = this.root.querySelector<HTMLInputElement>('.dialog-input')!;
    this.statusEl = this.root.querySelector<HTMLElement>('.dialog-status')!;
    this.addBtn = this.root.querySelector<HTMLButtonElement>('.btn-confirm')!;
    this.cancelBtn = this.root.querySelector<HTMLButtonElement>('.btn-cancel')!;

    this.addBtn.addEventListener('click', () => void this.submit());
    this.cancelBtn.addEventListener('click', () => this.close(null));
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close(null);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.submit();
      if (e.key === 'Escape') this.close(null);
    });

    document.body.appendChild(this.root);
  }

  open(): Promise<AddResult | null> {
    this.input.value = '';
    this.statusEl.textContent = '';
    this.statusEl.className = 'dialog-status';
    this.busy = false;
    this.addBtn.disabled = false;
    this.root.style.display = 'flex';
    setTimeout(() => this.input.focus(), 0);
    return new Promise<AddResult | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const url = this.input.value.trim();
    if (!url) {
      this.setStatus('URL을 입력하세요', 'err');
      return;
    }
    this.busy = true;
    this.addBtn.disabled = true;
    this.setStatus('피드 탐색 중...', 'info');

    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;

    try {
      const result = await resolveFeedUrl(url, ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.close({
        inputUrl: url,
        feedUrl: result.feedUrl,
        kind: result.kind,
        title: result.title,
        items: result.items,
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const msg = e instanceof Error ? e.message : '알 수 없는 오류';
      this.setStatus(msg, 'err');
      this.busy = false;
      this.addBtn.disabled = false;
    }
  }

  private setStatus(text: string, kind: 'info' | 'err' | 'ok'): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `dialog-status status-${kind}`;
  }

  private close(result: AddResult | null): void {
    this.ctrl?.abort();
    this.root.style.display = 'none';
    const fn = this.resolveFn;
    this.resolveFn = null;
    fn?.(result);
  }
}
