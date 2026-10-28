// Development helper: extracts every PKG hosted for the tutorial and checks
// that its TITLE_ID matches the file and that all COALESCED files can be
// patched. Run with `node scripts/validate-pkgs.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPkg } from '../src/pkg.js';
import { patchCoalescedBlob } from '../src/coalesced.js';
import { REGIONS } from '../src/config.js';

const root = fileURLToPath(new URL('../../kiwifruitdev.com/public/arkhamrevived/ps3/', import.meta.url));

for (const region of REGIONS) {
  const file = path.join(root, region.file);
  if (!fs.existsSync(file)) {
    console.log(`MISSING ${region.file}`);
    continue;
  }
  const pkg = await extractPkg(await fs.openAsBlob(file));
  const bytes = pkg.files.reduce((sum, item) => sum + item.size, 0);
  // Regions ship different numbers of language files: the Brazil update has
  // three, the US/Europe updates nine. Only patch what the package contains.
  const coalesced = pkg.files.filter(item => /COOKEDPS3\/COALESCED_[A-Z0-9_]+\.BIN$/i.test(item.path));
  let patched = 0;
  const missing = [];
  for (const item of coalesced) {
    const result = await patchCoalescedBlob(item.blob);
    if (result.redirect && result.movies) {
      patched++;
      continue;
    }
    missing.push(`${item.path.split('/').pop()}: ${[!result.redirect && 'PS3-BmNetVars.ini', !result.movies && 'PS3-BmEngine.ini'].filter(Boolean).join(', ')}`);
  }
  const ok = pkg.titleId === region.titleId && coalesced.length > 0 && patched === coalesced.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${region.titleId} (${region.file}): ${pkg.appVer} ${JSON.stringify(pkg.title)} · ${pkg.files.length} files · ${(bytes / 1048576).toFixed(1)} MiB · ${coalesced.length} coalesced, ${patched} patched${missing.length ? ` (missing ${missing.join('; ')})` : ''}`);
}
