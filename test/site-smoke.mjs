// Smoke test for the built Astro page (run `npm run build` in kiwifruitdev.com
// first). Verifies that the real page bootstraps the patcher and reloads into
// a cross-origin isolated document without console errors.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', 'kiwifruitdev.com', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pkg': 'application/octet-stream',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

const port = await new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  let file = path.join(dist, ...pathname.split('/').filter(Boolean));
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(data);
  });
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().includes('Failed to load resource')) return;
    errors.push(message.text());
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`http://127.0.0.1:${port}/arkhamrevived/ps3-tutorial/`).catch(() => {});
    try {
      await page.waitForFunction(() => window.crossOriginIsolated === true && Boolean(document.querySelector('.ak-wizard')), null, { timeout: 15000 });
      break;
    } catch {
      // service worker reload
    }
  }

  if (!(await page.evaluate(() => window.crossOriginIsolated))) throw new Error('not cross-origin isolated');
  if (!(await page.locator('.ak-wizard').count())) throw new Error('wizard did not render');
  if (!(await page.locator('.ak-choice').count())) throw new Error('firmware choices are missing');
  if (!(await page.locator('header.header').count())) throw new Error('site header is missing');

  // The page is cross-origin isolated, so any cross-origin asset on it has to be
  // a CORS request; the Ko-fi icon is the one external image that is not bundled.
  if (!(await page.locator('a.kofi-button').count())) throw new Error('the Ko-fi button is missing');
  await page.locator('a.kofi-button img').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const image = document.querySelector('a.kofi-button img');
    return Boolean(image) && image.complete && image.naturalWidth > 0;
  }, null, { timeout: 15000 }).catch(() => {
    throw new Error('the Ko-fi icon did not load, check its crossorigin attribute');
  });

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log('ok   built Astro page bootstraps the patcher');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
