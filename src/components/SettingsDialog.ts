import {
  DEFAULT_PROXIES,
  DEFAULT_REFRESH_MIN,
  clampInterval,
  loadSettings,
  saveSettings,
  type ProxyEntry,
} from '@/settings';
import { escapeHtml } from '@/util';

export class SettingsDialog {
  private root: HTMLElement;
  private proxyList!: HTMLElement;
  private intervalInput!: HTMLInputElement;
  private snapshotInput!: HTMLInputElement;
  private resolveFn: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'dialog-backdrop';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="dialog dialog-wide">
        <div class="dialog-header">설정</div>
        <div class="dialog-body">
          <div class="settings-section">
            <div class="settings-label">자동 새로고침 간격 (분)</div>
            <input type="number" class="dialog-input settings-interval" min="1" max="240" step="1" />
            <div class="dialog-hint">탭이 활성 상태일 때만 동작합니다. 1–240분.</div>
          </div>

          <div class="settings-section">
            <div class="settings-label">클라우드 스냅샷 URL (선택)</div>
            <input type="text" class="dialog-input settings-snapshot"
              placeholder="https://<사용자>.github.io/<레포>/feed-snapshot.json" />
            <div class="dialog-hint">
              설정하면 기사 패널이 여기서 미리 수집·파싱된 데이터를 읽습니다
              (CORS 프록시 불필요). 비워두면 각 소스를 직접 가져옵니다.
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-label">CORS 프록시 (위에서부터 순차 시도)</div>
            <ul class="settings-proxies"></ul>
            <div class="settings-proxy-add">
              <input type="text" class="dialog-input settings-new-proxy"
                placeholder="https://example.com/?url={urlEnc}" />
              <button class="btn settings-add-btn" type="button">추가</button>
            </div>
            <div class="dialog-hint">
              <code>{urlEnc}</code> = percent-encoded URL · <code>{url}</code> = 원본 URL.
              둘 다 없으면 끝에 인코딩된 URL이 붙습니다.
            </div>
            <button class="btn settings-reset-btn" type="button">기본값으로 초기화</button>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-cancel" type="button">취소</button>
          <button class="btn btn-confirm" type="button">저장</button>
        </div>
      </div>`;

    this.proxyList = this.root.querySelector<HTMLElement>('.settings-proxies')!;
    this.intervalInput = this.root.querySelector<HTMLInputElement>('.settings-interval')!;
    this.snapshotInput = this.root.querySelector<HTMLInputElement>('.settings-snapshot')!;

    this.root.querySelector<HTMLButtonElement>('.btn-cancel')!
      .addEventListener('click', () => this.close());
    this.root.querySelector<HTMLButtonElement>('.btn-confirm')!
      .addEventListener('click', () => this.commit());
    this.root.querySelector<HTMLButtonElement>('.settings-add-btn')!
      .addEventListener('click', () => this.addProxyFromInput());
    this.root.querySelector<HTMLButtonElement>('.settings-reset-btn')!
      .addEventListener('click', () => this.resetProxies());
    this.root.querySelector<HTMLInputElement>('.settings-new-proxy')!
      .addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.addProxyFromInput();
      });

    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.root.style.display !== 'none') this.close();
    });

    document.body.appendChild(this.root);
  }

  open(): Promise<void> {
    const s = loadSettings();
    this.intervalInput.value = String(s.refreshIntervalMin);
    this.snapshotInput.value = s.snapshotUrl;
    this.renderProxies(s.proxies);
    this.root.style.display = 'flex';
    return new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  private renderProxies(proxies: ProxyEntry[]): void {
    if (proxies.length === 0) {
      this.proxyList.innerHTML = '<li class="settings-empty">등록된 프록시가 없습니다 — 직접 fetch만 시도합니다.</li>';
      return;
    }
    this.proxyList.innerHTML = proxies
      .map(
        (p, i) => `
          <li class="settings-proxy" data-index="${i}">
            <span class="settings-proxy-num">${i + 1}</span>
            <code class="settings-proxy-url">${escapeHtml(p.template)}</code>
            <div class="settings-proxy-actions">
              <button class="settings-proxy-btn" data-act="up" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="settings-proxy-btn" data-act="down" title="아래로" ${i === proxies.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="settings-proxy-btn settings-proxy-del" data-act="del" title="삭제">×</button>
            </div>
          </li>`,
      )
      .join('');

    this.proxyList.querySelectorAll<HTMLButtonElement>('.settings-proxy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const li = btn.closest<HTMLElement>('.settings-proxy');
        if (!li) return;
        const idx = Number(li.dataset.index);
        const act = btn.dataset.act;
        if (act === 'up') this.move(idx, idx - 1);
        else if (act === 'down') this.move(idx, idx + 1);
        else if (act === 'del') this.remove(idx);
      });
    });
  }

  private currentProxies(): ProxyEntry[] {
    return Array.from(this.proxyList.querySelectorAll<HTMLElement>('.settings-proxy'))
      .map((li) => ({
        template: li.querySelector<HTMLElement>('.settings-proxy-url')!.textContent ?? '',
      }))
      .filter((p) => p.template.length > 0);
  }

  private move(from: number, to: number): void {
    const list = this.currentProxies();
    if (to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    this.renderProxies(list);
  }

  private remove(idx: number): void {
    const list = this.currentProxies();
    list.splice(idx, 1);
    this.renderProxies(list);
  }

  private addProxyFromInput(): void {
    const input = this.root.querySelector<HTMLInputElement>('.settings-new-proxy')!;
    const value = input.value.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) {
      input.classList.add('input-invalid');
      setTimeout(() => input.classList.remove('input-invalid'), 600);
      return;
    }
    const list = this.currentProxies();
    list.push({ template: value });
    this.renderProxies(list);
    input.value = '';
  }

  private resetProxies(): void {
    this.renderProxies(DEFAULT_PROXIES.slice());
  }

  private commit(): void {
    const interval = clampInterval(Number(this.intervalInput.value) || DEFAULT_REFRESH_MIN);
    saveSettings({
      proxies: this.currentProxies(),
      refreshIntervalMin: interval,
      snapshotUrl: this.snapshotInput.value.trim(),
    });
    this.close();
  }

  private close(): void {
    this.root.style.display = 'none';
    const fn = this.resolveFn;
    this.resolveFn = null;
    fn?.();
  }
}

