// Generates the PWA icons into public/icons/ — a dark rounded tile with the
// app's accent "world" dot, echoing the header status-dot. Pure pixel math via
// pngjs; no design tooling needed. Re-run with `node scripts/gen-icons.mjs`.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [10, 10, 10]; // #0a0a0a app background
const TILE = [22, 24, 28]; // slightly lifted tile
const ACCENT = [56, 211, 159]; // green status dot
const RING = [45, 51, 60];

function px(img, x, y, [r, g, b], a = 255) {
  const i = (img.width * y + x) << 2;
  // simple alpha-over onto existing pixel
  const na = a / 255;
  img.data[i] = r * na + img.data[i] * (1 - na);
  img.data[i + 1] = g * na + img.data[i + 1] * (1 - na);
  img.data[i + 2] = b * na + img.data[i + 2] * (1 - na);
  img.data[i + 3] = 255;
}

function make(size, { maskable = false } = {}) {
  const img = new PNG({ width: size, height: size });
  const pad = maskable ? size * 0.14 : 0; // safe area for maskable
  const tileR = size * 0.22; // rounded-corner radius
  const cx = size / 2;
  const cy = size / 2;
  const dotR = (maskable ? 0.24 : 0.28) * size;
  const ringR = (maskable ? 0.33 : 0.38) * size;

  const inRounded = (x, y) => {
    const l = pad;
    const t = pad;
    const r = size - pad;
    const bt = size - pad;
    // distance into rounded rect
    const dx = Math.max(l + tileR - x, 0, x - (r - tileR));
    const dy = Math.max(t + tileR - y, 0, y - (bt - tileR));
    if (x < l || x > r || y < t || y > bt) return false;
    return dx * dx + dy * dy <= tileR * tileR || (dx === 0 || dy === 0);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // base
      px(img, x, y, BG);
      if (!inRounded(x, y)) continue;
      px(img, x, y, TILE);

      const d = Math.hypot(x - cx, y - cy);
      // faint orbit ring
      if (Math.abs(d - ringR) < size * 0.012) px(img, x, y, RING);
      // accent dot with soft edge
      if (d < dotR) {
        const edge = dotR - d;
        const a = edge < 2 ? Math.max(0, edge / 2) * 255 : 255;
        px(img, x, y, ACCENT, a);
      }
    }
  }
  return PNG.sync.write(img);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const jobs = [
    ['icon-192.png', make(192)],
    ['icon-512.png', make(512)],
    ['icon-maskable-512.png', make(512, { maskable: true })],
    ['apple-touch-icon.png', make(180)],
  ];
  for (const [name, buf] of jobs) {
    await writeFile(join(OUT, name), buf);
    console.log('wrote', name, buf.length, 'bytes');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
