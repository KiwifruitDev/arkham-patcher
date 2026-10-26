// Creates a small PS3 Backup Utility archive for the end-to-end test.
// Usage: node scripts/make-test-backup.mjs [destination]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createModule from '../../web/ps3xport.mjs';
import { mountHostRoots } from '../../web/pxfs.js';
import { NodeHost } from '../../test/node-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function check(code, api) {
  if (code !== 0) throw new Error(api.lastError());
}

export async function createTestBackup(destination) {
  const content = path.join(destination, 'content');
  const out = path.join(destination, 'out');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(content, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  const coalesced = fs.readFileSync(path.join(here, '../../kiwifruitdev.com/public/arkhamrevived/ps3/COALESCED_INT.BIN'));
  const files = {
    '/dev_hdd0/game/BLUS31147/PARAM.SFO': crypto.randomBytes(0x1000),
    '/dev_hdd0/game/BLUS31147/USRDIR/EBOOT.BIN': crypto.randomBytes(1500 * 1024),
    '/dev_hdd0/game/BLUS31147/USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_INT.BIN': coalesced,
    '/dev_hdd0/game/BLUS31147/USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_ESN.BIN': coalesced,
    '/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT': crypto.randomBytes(700 * 1024),
    '/dev_hdd0/photo/IMAGE.JPG': crypto.randomBytes(500 * 1024),
  };
  for (const [virtualPath, data] of Object.entries(files)) {
    const target = path.join(content, ...virtualPath.split('/').filter(Boolean));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  const Module = await createModule({ locateFile: file => path.join(here, '../../web/', file) });
  const host = new NodeHost();
  host.setRoot('content', content);
  host.setRoot('out', out);
  mountHostRoots(Module, host, ['content', 'out']);

  const api = {
    init: Module.cwrap('px_init', 'number', []),
    lastError: Module.cwrap('px_last_error', 'string', []),
    createBackup: Module.cwrap('px_create_backup', 'number', ['string', 'string', 'string']),
  };
  check(api.init(), api);
  check(api.createBackup('/px/out/20261026000000', '/px/content', '-'), api);

  const backupDir = path.join(out, '20261026000000');
  return {
    backupDir,
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [
      name,
      crypto.createHash('sha256').update(data).digest('hex'),
    ])),
    coalesced,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] ?? path.join(here, '..', 'test', '.tmp', 'fixture'));
  const result = await createTestBackup(destination);
  console.log(result.backupDir);
}
