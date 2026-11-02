import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPkg } from '../src/pkg.js';
import { parseCoalesced, patchCoalescedBlob } from '../src/coalesced.js';
import { REGIONS } from '../src/config.js';

const expected = String.raw`There was an error connecting to Arkham: Revived Redux. If you're using CFW or HEN, did you disable syscalls? Check out https://kiwifruitdev.com/arkhamrevived/ Join the Discord at https://discord.gg/7BneAcgvZh Error`;
const root = fileURLToPath(new URL('../../kiwifruitdev.com/public/arkhamrevived/ps3/', import.meta.url));
let failed = false;

for (const region of REGIONS) {
  const pkgPath = path.join(root, region.file);
  if (!fs.existsSync(pkgPath)) {
    console.log(`MISSING ${region.file}`);
    failed = true;
    continue;
  }

  const pkg = await extractPkg(await fs.openAsBlob(pkgPath));
  const coalesced = pkg.files.filter(item => /COOKEDPS3\/COALESCED_[A-Z0-9_]+\.BIN$/i.test(item.path));
  const languages = [];

  for (const item of coalesced) {
    const result = await patchCoalescedBlob(item.blob);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const parsed = parseCoalesced(bytes);
    const gfxFiles = parsed.files.filter(file => {
      const name = file.name.replace(/\\/g, '/').toLowerCase();
      return name.includes('bmgame/localization/') && /\/gfxui\.[^.\/]+$/.test(name);
    });

    for (const file of gfxFiles) {
      const network = file.sections.find(section => section.name.toLowerCase() === 'network');
      const value = network?.values.find(entry => entry.key.toLowerCase() === 'couldnotconnectfireteam')?.value;
      const language = file.name.split(/[\\/]/).at(-2);
      languages.push(language);
      if (value !== expected) {
        failed = true;
        console.log(`FAIL ${region.titleId} ${item.path.split('/').pop()} ${language}: incorrect value`);
      }
    }
  }

  console.log(`${languages.length > 0 ? 'ok  ' : 'FAIL'} ${region.titleId}: ${coalesced.length} coalesced, ${languages.length} GFxUI.int (${[...new Set(languages)].join(', ')})`);
  if (languages.length === 0) failed = true;
}

if (failed) process.exitCode = 1;
