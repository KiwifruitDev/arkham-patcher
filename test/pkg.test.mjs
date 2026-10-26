import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractPkg, readPkgHeader } from '../src/pkg.js';
import { patchCoalescedBlob } from '../src/coalesced.js';

const pkgDir = fileURLToPath(new URL('../../kiwifruitdev.com/public/arkhamrevived/ps3/', import.meta.url));
const fixture = `${pkgDir}UP1018-BLUS31147_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg`;

test('reads the PKG header without decrypting the payload', { skip: !fs.existsSync(fixture) }, async () => {
  const blob = await fs.openAsBlob(fixture);
  const header = await readPkgHeader(blob);
  assert.equal(header.itemCount > 0, true);
  assert.ok(header.dataOffset > 0);
  assert.match(header.contentId, /UP1018-BLUS31147/);
});

test('extracts the title update and patches every COALESCED file', { skip: !fs.existsSync(fixture), timeout: 300000 }, async () => {
  const blob = await fs.openAsBlob(fixture);
  const pkg = await extractPkg(blob);
  assert.equal(pkg.titleId, 'BLUS31147');
  assert.match(pkg.appVer, /^01\.06$/);
  assert.ok(pkg.files.length > 100, `expected the title update files, got ${pkg.files.length}`);

  const param = pkg.files.find(file => file.path === '/dev_hdd0/game/BLUS31147/PARAM.SFO');
  assert.ok(param, 'PARAM.SFO is extracted to the game folder');

  const coalesced = pkg.files.filter(file => /COOKEDPS3\/COALESCED_[A-Z]+\.BIN$/i.test(file.path));
  assert.equal(coalesced.length, 9, 'all nine COALESCED files are present');

  for (const file of coalesced) {
    const patched = await patchCoalescedBlob(file.blob);
    assert.equal(patched.changed, true, `${file.path} contains PS3-BmNetVars.ini`);
  }
});
