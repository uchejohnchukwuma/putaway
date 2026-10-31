// Renders static/icons/*.png from the box mark. Uses Playwright's Chromium.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#ff5a1f"/>
  <path d="M10 24h44v28a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3z" fill="#1c1a17"/>
  <path d="M7 12h50v12H7z" fill="#f4eee1"/>
  <rect x="24" y="31" width="16" height="6" rx="1" fill="#f4eee1"/>
</svg>`;

await mkdir('static/icons', { recursive: true });
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>*{margin:0}</style>${svg(size)}`);
  await page.screenshot({ path: `static/icons/${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
