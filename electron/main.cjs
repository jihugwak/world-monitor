const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(u.pathname);
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        const resolved = path.normalize(path.join(rootDir, pathname));
        if (!resolved.startsWith(rootDir)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        fs.readFile(resolved, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          res.setHeader('Content-Type', MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream');
          res.end(data);
        });
      } catch {
        res.statusCode = 500;
        res.end('Server Error');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      // YouTube embeds refuse to play (black frame / "YouTube에서 보기") when the
      // page origin is a raw 127.0.0.1:<port>, but allow `localhost`. Serve the
      // renderer from a localhost origin so embedded live streams play in the
      // packaged app the same way they do under the Vite dev server.
      resolve(`http://localhost:${addr.port}/index.html`);
    });
    server.on('error', reject);
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'World Monitor',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const distDir = path.join(__dirname, '..', 'dist');
    const url = await startStaticServer(distDir);
    win.loadURL(url);
  }
}

app.whenReady().then(() => {
  // YouTube blocks playback when User-Agent contains "Electron/..." — strip it.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*world-monitor\/[\d.]+/gi, '');

  // RSS 피드 CORS 우회를 위해 ACAO를 '*'로 덮어쓰지만, YouTube/구글 비디오
  // 인프라는 credentials:'include'로 요청해서 와일드카드 ACAO에 걸리면 차단됨
  // — 영상이 검은 화면으로 멈추는 원인이라 해당 호스트는 건드리지 않는다.
  const YT_HOSTS = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|ggpht\.com|gstatic\.com|google\.com)$/i;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const host = new URL(details.url).hostname;
      if (YT_HOSTS.test(host)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
    } catch {
      /* fall through to wildcard rewrite */
    }
    const headers = details.responseHeaders || {};
    delete headers['access-control-allow-origin'];
    delete headers['Access-Control-Allow-Origin'];
    headers['Access-Control-Allow-Origin'] = ['*'];

    // Strip frame-blocking headers so the in-app article reader can iframe
    // news sites that would otherwise refuse to embed (X-Frame-Options:
    // SAMEORIGIN/DENY, or CSP frame-ancestors restrictions).
    for (const k of Object.keys(headers)) {
      if (/^x-frame-options$/i.test(k)) delete headers[k];
    }
    for (const k of Object.keys(headers)) {
      if (/^content-security-policy(?:-report-only)?$/i.test(k)) {
        const v = headers[k];
        if (Array.isArray(v)) {
          headers[k] = v
            .map((s) => s.replace(/(?:^|;)\s*frame-ancestors[^;]*/gi, '').replace(/^\s*;+/, '').trim())
            .filter((s) => s.length > 0);
        }
      }
    }
    callback({ responseHeaders: headers });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
