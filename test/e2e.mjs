// End-to-end test for the patcher page: a local static server with the same
// headers as GitHub Pages (none), a synthetic backup, and real Chrome.
//
//   node test/e2e.mjs
//
// Set ARKHAM_E2E_KEEP=1 to keep the temporary folders.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from 'playwright-core';

import createModule from '../../web/ps3xport.mjs';
import { mountHostRoots } from '../../web/pxfs.js';
import { NodeHost } from '../../test/node-host.mjs';
import { readZip } from '../../web/zip.js';
import { parseCoalesced } from '../src/coalesced.js';
import { createTestBackup } from '../scripts/make-test-backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..', '..');
const siteRoot = path.join(projectRoot, 'kiwifruitdev.com', 'public');
const wasmDir = path.join(projectRoot, 'web');
const tmpRoot = path.join(here, '.e2e');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arkham patcher test</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/arkhamrevived/ps3-tutorial/app/ui.css">
</head><body>
<div id="arkham-patcher"><p class="ak-busy">Loading the patcher…</p></div>
<script type="module" src="/arkhamrevived/ps3-tutorial/app/app.js"></script>
</body></html>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pkg': 'application/octet-stream',
  '.json': 'application/json',
};

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/arkhamrevived/ps3-tutorial' || pathname === '/arkhamrevived/ps3-tutorial/') {
      response.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      response.end(PAGE);
      return;
    }
    const file = path.join(siteRoot, ...pathname.split('/').filter(Boolean));
    if (!file.startsWith(siteRoot)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      response.end(data);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next channel
    }
  }
  throw new Error('Neither Chrome nor Edge could be launched by Playwright.');
}

async function bootPage(context, baseUrl, { mobile = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().includes('Failed to load resource')) return;
    errors.push(message.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`${baseUrl}/arkhamrevived/ps3-tutorial/`).catch(() => {});
    try {
      await page.waitForFunction(() => window.crossOriginIsolated === true && Boolean(document.querySelector('.ak-wizard')), null, { timeout: 15000 });
      return { page, errors };
    } catch {
      // the service worker reloaded the page; try again
    }
  }
  throw new Error('The page never became cross-origin isolated.');
}

async function nextPage(page, heading) {
  await page.locator('.ak-wizard-nav button').nth(1).click();
  if (heading) await page.locator('.ak-page h2', { hasText: heading }).waitFor({ timeout: 30000 });
}

function bind(Module) {
  const wrap = (name, ret, args) => Module.cwrap(name, ret, args);
  return {
    init: wrap('px_init', 'number', []),
    lastError: wrap('px_last_error', 'string', []),
    indexOpen: wrap('px_index_open', 'number', ['string']),
    indexClose: wrap('px_index_close', null, []),
    indexFileCount: wrap('px_index_file_count', 'number', []),
    indexFilePath: wrap('px_index_file_path', 'string', ['number']),
    indexFileSize: wrap('px_index_file_size', 'number', ['number']),
    dataRead: wrap('px_data_read', 'number', ['string']),
    extractFile: wrap('px_extract_file', 'number', ['string', 'string', 'string', 'string']),
  };
}

async function inspectBackup(backupDir, scratchDir) {
  const Module = await createModule({ locateFile: file => path.join(wasmDir, file) });
  const host = new NodeHost();
  host.setRoot('usb', backupDir);
  host.setRoot('scratch', scratchDir);
  mountHostRoots(Module, host, ['usb', 'scratch']);
  const api = bind(Module);
  assert.equal(api.init(), 0, api.lastError());
  assert.equal(api.indexOpen('/px/usb/archive.dat'), 0, api.lastError());
  const files = new Map();
  for (let index = 0; index < api.indexFileCount(); index++) {
    files.set(api.indexFilePath(index), api.indexFileSize(index));
  }
  api.indexClose();

  const chunkNames = fs.readdirSync(backupDir).filter(name => /^archive_\d+\.dat$/i.test(name));
  for (const name of chunkNames) {
    assert.equal(api.dataRead(`/px/usb/${name}`), 0, `${name} HMAC: ${api.lastError()}`);
  }

  const read = (virtualPath, name) => {
    const target = `/px/scratch/${name}`;
    assert.equal(api.extractFile('/px/usb', 'archive', virtualPath, target), 0, api.lastError());
    return fs.readFileSync(path.join(scratchDir, name));
  };

  return { api, files, chunkNames, read };
}

function assertPatchedCoalesced(buffer, label) {
  const parsed = parseCoalesced(new Uint8Array(buffer));
  const target = parsed.files.find(file => /PS3-BmNetVars\.ini$/i.test(file.name));
  assert.ok(target, `${label} contains PS3-BmNetVars.ini`);
  const section = target.sections.find(item => item.name === 'Default__GDHttp GDHttp');
  assert.ok(section, `${label} has the GDHttp section`);
  assert.equal(section.values.find(item => item.key === 'TitleFileName')?.value, 'dummy.json');
  assert.equal(section.values.find(item => item.key === 'Settings')?.value, '(BaseURL="http://arkhamrevived.kiwifruitdev.com/")');
}

async function downloadAndSave(page, buttonText, target) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.locator('button', { hasText: buttonText }).click(),
  ]);
  await download.saveAs(target);
  return target;
}

async function unzip(file, dir) {
  const archive = await readZip(new Blob([fs.readFileSync(file)]));
  const entries = new Map();
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of archive.entries) {
    if (entry.isDir) continue;
    const buffer = Buffer.from(await (await entry.getBlob()).arrayBuffer());
    entries.set(entry.path, buffer);
    const target = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
  }
  return entries;
}

async function testOfw(page, baseUrl, fixture) {
  await page.locator('.ak-choice', { hasText: 'OFW (original firmware)' }).click();
  await page.locator('.ak-page h2', { hasText: 'Prepare a USB drive' }).waitFor();
  await nextPage(page, 'Delete the old game data');
  await nextPage(page, 'Back up your PS3');
  await nextPage(page, 'Select your backup on this computer');

  await page.locator('#arkham-patcher input[type=file]').setInputFiles(fixture.backupDir);
  try {
    await page.locator('.ak-status-ok', { hasText: 'Backup loaded' }).waitFor({ timeout: 120000 });
  } catch (error) {
    console.error('PATCHER TEXT:', await page.locator('#arkham-patcher').innerText().catch(() => '?'));
    throw error;
  }
  await nextPage(page, 'Choose your game version');
  await nextPage(page, 'Patch the backup');

  await page.locator('button', { hasText: 'Patch my backup' }).click();
  await page.locator('.ak-progress').waitFor({ timeout: 30000 });
  const progressText = await page.locator('.ak-progress').innerText();
  assert.match(progressText, /ETA/);
  assert.match(progressText, /Elapsed/);
  await page.locator('.ak-status-ok', { hasText: 'Patch complete' }).waitFor({ timeout: 300000 });
  await nextPage(page, 'Copy the patched files across');

  const zipFile = path.join(tmpRoot, 'ofw.zip');
  await downloadAndSave(page, 'Download patched files', zipFile);
  const unzipped = path.join(tmpRoot, 'ofw');
  const entries = await unzip(zipFile, unzipped);
  assert.ok(entries.has('archive.dat'), 'zip has archive.dat');
  assert.ok([...entries.keys()].some(name => /^archive_\d+\.dat$/i.test(name)), 'zip has data chunks');

  const backupDir = path.join(unzipped, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  // Unchanged chunks stay on the USB drive; the zip only carries rewritten ones.
  for (const name of fs.readdirSync(fixture.backupDir)) {
    if (/^archive_\d+\.dat$/i.test(name)) fs.copyFileSync(path.join(fixture.backupDir, name), path.join(backupDir, name));
  }
  for (const [name, data] of entries) {
    if (name === 'README.txt') continue;
    fs.writeFileSync(path.join(backupDir, name), data);
  }
  const backup = await inspectBackup(backupDir, path.join(tmpRoot, 'ofw-scratch'));
  assert.ok(backup.files.has('/dev_hdd0/game/BLUS31147/PARAM.SFO'), 'PARAM.SFO in index');
  assert.notEqual(backup.files.get('/dev_hdd0/game/BLUS31147/PARAM.SFO'), 0x1000, 'PARAM.SFO was replaced');
  assert.ok([...backup.files.keys()].some(name => name.startsWith('/dev_hdd0/.ps3xport-unlinked/')), 'old entries are tombstoned');
  assert.ok(backup.files.has('/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT'), 'save data kept');

  const save = backup.read('/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT', 'SAVE.DAT');
  assert.equal(crypto.createHash('sha256').update(save).digest('hex'), fixture.files['/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT']);

  const coalesced = backup.read('/dev_hdd0/game/BLUS31147/USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_INT.BIN', 'COALESCED_INT.BIN');
  assertPatchedCoalesced(coalesced, 'restored COALESCED_INT.BIN');
  assert.notDeepEqual(coalesced, fixture.coalesced, 'the config file was repacked');

  const photo = backup.read('/dev_hdd0/photo/IMAGE.JPG', 'IMAGE.JPG');
  assert.equal(crypto.createHash('sha256').update(photo).digest('hex'), fixture.files['/dev_hdd0/photo/IMAGE.JPG'], 'untouched files keep their bytes');
}

async function testFolderInstall(browser, baseUrl, fixture) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().includes('Failed to load resource')) return;
    errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => window.__folderHandle;
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`${baseUrl}/arkhamrevived/ps3-tutorial/`).catch(() => {});
    try {
      await page.waitForFunction(() => window.crossOriginIsolated === true && Boolean(document.querySelector('.ak-wizard')), null, { timeout: 15000 });
      break;
    } catch {
      // service worker reload
    }
  }

  const files = {};
  for (const name of fs.readdirSync(fixture.backupDir)) {
    files[name] = fs.readFileSync(path.join(fixture.backupDir, name)).toString('base64');
  }
  await page.evaluate(async seed => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('backup', { recursive: true });
    } catch {
      // no previous run
    }
    const dir = await root.getDirectoryHandle('backup', { create: true });
    for (const [name, base64] of Object.entries(seed)) {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
    window.__folderHandle = dir;
  }, files);

  await page.locator('.ak-choice', { hasText: 'OFW (original firmware)' }).click();
  await nextPage(page, 'Delete the old game data');
  await nextPage(page, 'Back up your PS3');
  await nextPage(page, 'Select your backup on this computer');
  await page.locator('button', { hasText: 'Select backup folder' }).click();
  await page.locator('.ak-status-ok', { hasText: 'Backup loaded' }).waitFor({ timeout: 120000 });
  assert.match(await page.locator('.ak-status-ok').first().innerText(), /can be written to directly/);
  await nextPage(page, 'Choose your game version');
  await nextPage(page, 'Patch the backup');
  await page.locator('button', { hasText: 'Patch my backup' }).click();
  await page.locator('.ak-status-ok', { hasText: 'Patch complete' }).waitFor({ timeout: 300000 });
  await nextPage(page, 'The backup has been patched');
  assert.match(await page.locator('.ak-page').innerText(), /written to the USB drive/);

  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('backup');
    const out = { files: {}, entries: [] };
    for await (const [name, handle] of dir.entries()) {
      out.entries.push(name);
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      if (name === 'archive.dat') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        out.files[name] = btoa(binary);
      } else {
        out.files[name] = file.size;
      }
    }
    return out;
  });

  assert.ok(!result.entries.some(name => name.startsWith('.arkham-patch-')), 'staging folder was removed');
  assert.ok(result.entries.some(name => /^archive_\d+\.dat$/i.test(name)), 'chunks are in the backup folder');

  const indexDir = path.join(tmpRoot, 'folder-install');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'archive.dat'), Buffer.from(result.files['archive.dat'], 'base64'));
  const Module = await createModule({ locateFile: file => path.join(wasmDir, file) });
  const host = new NodeHost();
  host.setRoot('usb', indexDir);
  mountHostRoots(Module, host, ['usb']);
  const api = bind(Module);
  assert.equal(api.init(), 0, api.lastError());
  assert.equal(api.indexOpen('/px/usb/archive.dat'), 0, api.lastError());
  const paths = new Set();
  for (let index = 0; index < api.indexFileCount(); index++) paths.add(api.indexFilePath(index));
  api.indexClose();
  assert.ok(paths.has('/dev_hdd0/game/BLUS31147/PARAM.SFO'), 'direct install wrote the patched index');
  assert.ok(paths.has('/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT'), 'direct install kept the save data');
  assert.deepEqual(errors, [], 'no page errors');
  await context.close();
}

async function testCfw(browser, baseUrl) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  const { page, errors } = await bootPage(context, baseUrl);
  assert.deepEqual(errors, [], 'no page errors');
  await page.locator('.ak-choice', { hasText: 'CFW or HEN' }).click();
  await page.locator('.ak-page h2', { hasText: 'CFW or HEN: no backup needed' }).waitFor();
  await nextPage(page, 'Choose your game version');
  await nextPage(page, 'Patch the COALESCED files');
  await page.locator('button', { hasText: 'Download and patch' }).click();
  await page.locator('.ak-status-ok', { hasText: 'Patch complete' }).waitFor({ timeout: 300000 });
  await nextPage(page, 'Copy the patched files with mmCM');

  const zipFile = path.join(tmpRoot, 'cfw.zip');
  await downloadAndSave(page, 'Download COALESCED files', zipFile);
  const entries = await unzip(zipFile, path.join(tmpRoot, 'cfw'));
  const coalesced = [...entries.keys()].filter(name => /^COALESCED_[A-Z]+\.BIN$/i.test(name));
  assert.equal(coalesced.length, 9, 'nine COALESCED files for the US release');
  for (const name of coalesced) assertPatchedCoalesced(entries.get(name), name);
  await context.close();
}

async function testMobile(browser, baseUrl) {
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    acceptDownloads: true,
  });
  const { page } = await bootPage(context, baseUrl, { mobile: true });
  const modal = page.locator('.ak-modal');
  await modal.waitFor({ timeout: 15000 });
  assert.match(await modal.innerText(), /Use a computer instead/);
  await page.locator('button', { hasText: 'I understand, continue anyway' }).click();
  assert.equal(await page.locator('.ak-modal').count(), 0, 'modal is dismissed');
  await page.locator('.ak-choice', { hasText: 'OFW (original firmware)' }).click();
  await nextPage(page, 'Delete the old game data');
  await nextPage(page, 'Back up your PS3');
  await nextPage(page, 'Select your backup on this computer');
  assert.equal(await page.locator('button', { hasText: 'Select backup folder' }).count(), 0, 'no folder picker on mobile');
  assert.equal(await page.locator('label', { hasText: 'Select backup files' }).count(), 1, 'file selection is offered');
  await context.close();
}

async function main() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const fixture = await createTestBackup(path.join(tmpRoot, 'fixture'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await startServer(port);
  const browser = await launch();

  console.log('fixture', fixture.backupDir);
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 900 } });
    const { page, errors } = await bootPage(context, baseUrl);
    assert.equal(await page.evaluate(() => window.crossOriginIsolated), true, 'crossOriginIsolated');
    assert.deepEqual(errors, [], 'no page errors');
    assert.equal(await page.locator('.ak-modal').count(), 0, 'no mobile warning on desktop');
    console.log('ok   page boots cross-origin isolated');
    await testOfw(page, baseUrl, fixture);
    console.log('ok   OFW backup path');
    await context.close();
    await testFolderInstall(browser, baseUrl, fixture);
    console.log('ok   Chromium direct install');
    await testCfw(browser, baseUrl);
    console.log('ok   CFW zip path');
    await testMobile(browser, baseUrl);
    console.log('ok   mobile warning and file fallback');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    if (!process.env.ARKHAM_E2E_KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
