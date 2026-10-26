# Arkham: Revived - PS3 patcher

The browser tool behind <https://kiwifruitdev.com/arkhamrevived/ps3-tutorial/>.
It patches **Batman: Arkham Origins** on PlayStation 3 so the multiplayer
client connects to Arkham: Revived.

Everything runs locally in the browser. The official 1.06 title update is
downloaded from this site, decrypted in memory, and its COALESCED files are
patched. Depending on the firmware answer:

- **OFW (stock firmware)**: the update is merged into a PS3 Backup Utility
  archive (`archive.dat` + `archive_*.dat`) which the user restores on the PS3.
- **CFW / HEN**: the patched `COALESCED_*.BIN` files are downloaded as a zip to
  copy with multiMAN (mmCM); the backup is never touched.

There is no backend. The page is static and can be served by GitHub Pages.

## Why the PKGs are hosted here

Sony's title-update URLs are plain HTTP, send no CORS headers, and the HTTPS
endpoint presents a certificate that is not valid for
`b0.ww.np.dl.playstation.net`. A static HTTPS page cannot fetch them. The six
1.06 packages therefore live in
`kiwifruitdev.com/public/arkhamrevived/ps3/` and are fetched same-origin.

| Region | Edition | Title ID | Package |
| --- | --- | --- | --- |
| US | Disc | BLUS31147 | `UP1018-BLUS31147_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg` |
| US | Digital | NPUB31261 | `UP1018-NPUB31261_00-BATMANARKHAMORIG-A0106-V0100-PE.pkg` |
| Europe | Disc | BLES01784 | `EP1018-BLES01784_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg` |
| Europe | Digital | NPEB01414 | `EP1018-NPEB01414_00-BATMANORIGINS001-A0106-V0100-PE.pkg` |
| Brazil | Disc | BLUS31207 | `UP1018-BLUS31207_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg` |
| Brazil | Digital | NPUB31264 | `UP1018-NPUB31264_00-BATMANARKHAMORIG-A0106-V0100-PE.pkg` |

`node scripts/validate-pkgs.mjs` re-extracts all of them, checks the TITLE_ID
from PARAM.SFO, and verifies that every COALESCED file contains
`BmGame/Config/PS3-BmNetVars.ini`.

## The patch

1. Parse the PKG header, decrypt the AES-CTR item table and the payloads
   (`src/pkg.js`, ported from PyKG).
2. Prepend the redirect section to every
   `USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_*.BIN`
   (`src/coalesced.js`, ported from coalesced-inifier):

   ```ini
   [Default__GDHttp GDHttp]
   TitleFileName = dummy.json
   Settings      = (BaseURL="http://arkhamrevived.kiwifruitdev.com/")
   ```

3. **OFW**: read the backup index, unlink the index entries the update
   replaces (the bytes stay in place), append the patched files to the last
   chunk, and write a new `archive.dat` (`src/archive-patch.js`). Only the last
   chunk and the new chunks are produced; no existing file is read. The
   archive index and chunk encryption come from the ps3xport WebAssembly core.
4. **CFW/HEN**: zip the patched COALESCED files with a README.

The COALESCED parser/writer keeps the stored keys, values and trailing bytes
verbatim, so repacking an untouched file is byte-for-byte identical (tested
against `public/arkhamrevived/ps3/COALESCED_INT.BIN`).

## Page

`src/app.js` + `src/ui.js` implement the paginated wizard: firmware question,
USB/backup/restore/safe-mode/rebuild instructions for OFW, region/edition
selection, the patch progress (status, bar, ETA, elapsed), and the download or
in-place install result. Mobile devices get an "use a computer" notice with an
"I understand" option; folder selection is hidden there.

### Cross-origin isolation

The WebAssembly writer needs `SharedArrayBuffer`, which requires COOP/COEP.
GitHub Pages cannot send custom headers, so `src/coi-sw.js` is registered at
`/arkhamrevived/ps3-tutorial/coi-sw.js`, adds the two headers, and reloads the
page once. `build.mjs` also writes a `_headers` file for hosts that support
one. The CFW/HEN flow works even without isolation.

## Build

```powershell
# from ps3xport-wasm/arkham-patcher
npm run build
```

This copies the modules and the ps3xport WebAssembly build into
`kiwifruitdev.com/public/arkhamrevived/ps3-tutorial/app/` (build artifacts only;
the source stays here) and writes `coi-sw.js` and `_headers` next to the page.
Rebuild the WebAssembly core with `npm run build` in the repository root if
`web/ps3xport.wasm` changes.

## Tests

```powershell
npm test                    # PKG extraction, coalesced round-trip, archive patch
node test/e2e.mjs           # real Chrome: OFW zip, direct install, CFW zip, mobile
node scripts/validate-pkgs.mjs
node test/site-smoke.mjs    # the built Astro page (needs `npm run build` in kiwifruitdev.com)
```

`npm test` runs the Node tests. The PKG tests use the hosted packages, so they
are skipped if those files are missing. `test/e2e.mjs` starts a local static
server with no COOP/COEP headers (like GitHub Pages), creates a synthetic
backup with the ps3xport core, and drives the page with Playwright. It
requires Chrome or Edge; Playwright is installed by the repository root's
`npm install`.

## Credits and licences

- `ps3xport` WebAssembly core: GPL-3.0-or-later (kakaroto); the web panel
  drivers around it are MIT. Both come from [ps3xport-wasm](../README.md).
- PKG reader ported from [PyKG](../PyKG): MIT, © 2026 Aphelion.
- Coalesced reader/writer ported from
  [coalesced-inifier](../coalesced-inifier): GPL-3.0.
- The page, wizard and patch logic: MIT, © 2026 KiwifruitDev. Because it
  combines the GPL-3.0-or-later ps3xport core and coalesced-inifier code, the
  combined build is distributed under the GPL-3.0-or-later.
