import './styles/main.css';
import { App } from './App';

const app = new App();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void app.init());
} else {
  void app.init();
}

window.addEventListener('beforeunload', () => app.destroy());

// Register the service worker only for the installable web/phone build — the
// Electron desktop app serves from a local static server and must not cache
// its shell through a SW.
if (import.meta.env.VITE_TARGET === 'web' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* SW is a progressive enhancement — ignore registration failures */
    });
  });
}
