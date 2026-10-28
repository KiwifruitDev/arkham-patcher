import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyHttpRedirect, applyNoMovies, applyPatches, parseCoalesced, writeCoalesced } from '../src/coalesced.js';

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
    { key: 'Settings', value: '(BaseURL="http://arkhamrevived.kiwifruitdev.com/",EchoBaseURL="http://arkhamrevived.kiwifruitdev.com/Echo",WBIDTicketURL="http://arkhamrevived.kiwifruitdev.com/TokenService",WBIDAMSURL="http://arkhamrevived.kiwifruitdev.com/CLS")' },
  ]);
});

test('sets bForceNoMovies in PS3-BmEngine.ini', { skip: !fs.existsSync(fixture) }, () => {
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const parsed = parseCoalesced(bytes);

  const result = applyNoMovies(parsed);
  assert.equal(result.found, true);
  assert.equal(result.changed, true);
  assert.equal(result.patched.length, 1);

  const roundTrip = parseCoalesced(writeCoalesced(parsed));
  const engine = roundTrip.files.find(file => /PS3-BmEngine\.ini$/i.test(file.name));
  const section = engine.sections.find(item => item.name === 'FullScreenMovie');
  assert.ok(section, 'the FullScreenMovie section is kept');
  assert.equal(section.values.find(item => item.key === 'bForceNoMovies')?.value, 'TRUE');
  assert.equal(section.values.find(item => item.key === 'StartupMovies')?.value, 'Startup.swf');

  // Re-running the patch on an already patched file changes nothing.
  assert.equal(applyNoMovies(roundTrip).changed, false);
});

test('creates the FullScreenMovie section when PS3-BmEngine.ini lacks it', { skip: !fs.existsSync(fixture) }, () => {
  const parsed = parseCoalesced(new Uint8Array(fs.readFileSync(fixture)));
  const engine = parsed.files.find(file => /PS3-BmEngine\.ini$/i.test(file.name));
  engine.sections = engine.sections.filter(section => section.name !== 'FullScreenMovie');

  assert.equal(applyNoMovies(parsed).changed, true);
  const roundTrip = parseCoalesced(writeCoalesced(parsed));
  const patched = roundTrip.files.find(file => /PS3-BmEngine\.ini$/i.test(file.name));
  const section = patched.sections.find(item => item.name === 'FullScreenMovie');
  assert.deepEqual(section.values, [{ key: 'bForceNoMovies', value: 'TRUE' }]);
});

test('patches a coalesced file that has no PS3-BmEngine.ini', { skip: !fs.existsSync(fixture) }, () => {
  const parsed = parseCoalesced(new Uint8Array(fs.readFileSync(fixture)));
  parsed.files = parsed.files.filter(file => !/PS3-BmEngine\.ini$/i.test(file.name));
  const netVars = parsed.files.find(file => /PS3-BmNetVars\.ini$/i.test(file.name));
  netVars.sections = netVars.sections.filter(section => section.name !== 'Default__GDHttp GDHttp');

  const result = applyPatches(parsed);
  assert.equal(result.redirect, true);
  assert.equal(result.movies, false);
  assert.equal(result.changed, true);

  const roundTrip = parseCoalesced(writeCoalesced(parsed));
  assert.equal(roundTrip.files.some(file => /PS3-BmEngine\.ini$/i.test(file.name)), false);
  const patched = roundTrip.files.find(file => /PS3-BmNetVars\.ini$/i.test(file.name));
  assert.equal(patched.sections[0].name, 'Default__GDHttp GDHttp');
});
