import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyHttpRedirect, parseCoalesced, writeCoalesced } from '../src/coalesced.js';

const fixture = fileURLToPath(new URL('../../kiwifruitdev.com/public/arkhamrevived/ps3/COALESCED_INT.BIN', import.meta.url));

test('parses and repacks a real coalesced file byte-for-byte', { skip: !fs.existsSync(fixture) }, () => {
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const parsed = parseCoalesced(bytes);
  assert.ok(parsed.files.length > 100, 'expected the full PS3 config set');
  const again = writeCoalesced(parsed);
  assert.deepEqual(Buffer.from(again), Buffer.from(bytes));
});

test('adds the GDHttp redirect section to PS3-BmNetVars.ini', { skip: !fs.existsSync(fixture) }, () => {
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const parsed = parseCoalesced(bytes);
  // Remove the section first so this exercises insertion rather than update.
  const target = parsed.files.find(file => /PS3-BmNetVars\.ini$/i.test(file.name));
  target.sections = target.sections.filter(section => section.name !== 'Default__GDHttp GDHttp');

  const result = applyHttpRedirect(parsed);
  assert.equal(result.changed, true);
  assert.equal(result.patched.length, 1);

  const roundTrip = parseCoalesced(writeCoalesced(parsed));
  const patched = roundTrip.files.find(file => /PS3-BmNetVars\.ini$/i.test(file.name));
  assert.equal(patched.sections[0].name, 'Default__GDHttp GDHttp');
  assert.deepEqual(patched.sections[0].values, [
    { key: 'TitleFileName', value: 'dummy.json' },
    { key: 'Settings', value: '(BaseURL="http://arkhamrevived.kiwifruitdev.com/")' },
  ]);
});
