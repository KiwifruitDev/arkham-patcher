// Arkham: Revived - PlayStation 3 patcher page controller.
//
// Everything runs in the browser: the official 1.06 PKG is downloaded from
// this site, decrypted in memory, its COALESCED files are patched, and the
// result is either written into a PS3 Backup Utility archive (OFW) or offered
// as a zip of COALESCED files (CFW/HEN).

import { Engine } from './engine.js';
import { buildZip } from './zip.js';
import {
  COALESCED_DIR, EDITION_NAMES, GAME_DIR, REGION_NAMES, REGIONS, regionFor, pkgUrl,
} from './config.js';
import { downloadPkg, extractPkg } from './pkg.js';
import { isCoalescedName, patchCoalescedBlob } from './coalesced.js';
import { buildDirectories, planGamePatch, readBackup, writePatch } from './archive-patch.js';
import {
  TaskProgress, Wizard, detectMobile, downloadBlob, ensureCrossOriginIsolation, formatBytes,
  h, link, supportsFolderPicker, toast,
} from './ui.js';

const COPY_CHUNK = 4 * 1024 * 1024;
const PKG_NAME = 'update.pkg';

const state = {
  mode: null,
  isolated: null,
  mobile: detectMobile(),
  folderPicker: supportsFolderPicker(),
  mobileAcknowledged: false,
  backup: null,
  backupBusy: false,
  backupError: null,
  regionName: 'US',
  editionName: 'Disc',
  pkgBlob: null,
  pkgEntryKey: null,
  patchFiles: null,
  patchRunning: false,
  patchDone: false,
  patchError: null,
  cancelRequested: false,
  abort: null,
  progress: null,
  result: null,
  staging: null,
  importLine: null,
};

let engine = null;
let wizard = null;
let root = null;

/* ------------------------------------------------------------------ utils */

function basename(path) {
  return String(path).split('/').pop() ?? '';
}

function backupSummary(backup) {
  const sizes = backup.chunkSizes;
  return {
    chunks: sizes.length,
    chunkBytes: sizes.reduce((sum, size) => sum + size, 0),
    files: backup.index.files.length,
    fileBytes: backup.index.files.reduce((sum, file) => sum + file.size, 0),
  };
}

function updateFileCount(titleId) {
  if (!state.backup) return 0;
  return state.backup.index.files.filter(file => file.path.startsWith(`${GAME_DIR(titleId)}/`)).length;
}

function resetPatch() {
  state.pkgBlob = null;
  state.pkgEntryKey = null;
  state.patchFiles = null;
  state.patchDone = false;
  state.patchError = null;
  state.result = null;
}

function isCancelled() {
  return state.cancelRequested;
}

function checkCancel() {
  if (state.cancelRequested) throw new DOMException('Cancelled', 'AbortError');
}

async function getEngine() {
  if (!engine) engine = new Engine();
  await engine.start();
  return engine;
}

/* ------------------------------------------------------------ step: intro */

const firmwareStep = {
  id: 'firmware',
  title: 'Choose your firmware',
  nextLabel: () => null,
  render() {
    const card = (mode, heading, text, tag) => h('button', {
      type: 'button',
      class: `ak-choice${state.mode === mode ? ' ak-choice-selected' : ''}`,
      onclick: () => chooseMode(mode),
    },
      h('span', { class: 'ak-choice-tag' }, tag),
      h('strong', {}, heading),
      h('span', {}, text),
    );

    return h('div', { class: 'ak-page' },
      h('h2', {}, 'What firmware is your PS3 running?'),
      h('p', {}, 'This decides how the patch is installed. You can go back and change it at any time.'),
      h('div', { class: 'ak-choice-grid' },
        card('cfw', 'CFW or HEN', 'Your PS3 can run homebrew. No backup or restore is needed: you get a zip of patched files for multiMAN (mmCM).', 'Jailbroken'),
        card('ofw', 'OFW (original firmware)', 'Stock firmware with no homebrew. The patch is applied to a Backup Utility backup, then restored on the PS3.', 'Stock'),
      ),
      h('p', { class: 'ak-note' }, 'CFW = custom firmware. HEN = the Hybrid Firmware Enabler used on some PS3 models.'),
    );
  },
};

function chooseMode(mode) {
  if (state.mode === mode) {
    wizard.go(1);
    return;
  }
  state.mode = mode;
  resetPatch();
  wizard.setSteps(buildFlow(), { keep: false });
  wizard.go(1);
}

/* --------------------------------------------------------------- OFW pages */

const ofwUsb = {
  id: 'ofw-usb',
  title: 'Prepare a USB drive',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '1. Prepare a USB drive'),
      h('p', {}, 'You need a USB storage device the PS3 can read (FAT32 is fine). It must have ', h('strong', {}, 'at least as much free space as the data currently on your PS3 hard drive'), ', because Backup Utility copies everything.'),
      h('div', { class: 'ak-callout' },
        h('strong', {}, 'Example'),
        h('p', {}, 'If your PS3 has a 500 GB drive with 300 GB used, the USB drive needs at least 300 GB free. Free space on the USB is what matters, not its total size.'),
      ),
      h('p', {}, 'Format the drive as FAT32 or exFAT, plug it into the PS3, and keep it there for the next two steps.'),
      h('p', { class: 'ak-note' }, 'Leave at least a few GB free beyond that: the patcher writes the changed data chunks next to the backup before replacing them.'),
      h('p', { class: 'ak-note' }, 'The backup is a full copy of your PS3. Nothing is uploaded by this page - the patch itself runs on your computer.'),
    );
  },
};

const ofwDelete = {
  id: 'ofw-delete',
  title: 'Delete the old game data',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '2. Delete the old game data'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'On the PS3 XMB, go to ', h('strong', {}, 'Game'), ' -> ', h('strong', {}, 'Game Data Utility'), '.'),
        h('li', {}, 'Highlight the item labeled ', h('strong', {}, '"Batman: Arkham Origins"'), ' (about 70 MB).'),
        h('li', {}, 'Press ', h('strong', {}, 'Triangle'), ' -> ', h('strong', {}, 'Delete'), ', then confirm.'),
      ),
      h('p', {}, 'This removes the old title update so the patched one can be restored cleanly. Save files and the installed game are not affected.'),
      h('p', { class: 'ak-note' }, 'If there are several Arkham Origins entries, delete the one under Game Data Utility, not the one under Game.'),
    );
  },
};

const ofwBackup = {
  id: 'ofw-backup',
  title: 'Back up the PS3',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '3. Back up your PS3'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Go to ', h('strong', {}, 'Settings'), ' -> ', h('strong', {}, 'System Settings'), ' -> ', h('strong', {}, 'Backup Utility'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Back Up"'), ' -> ', h('strong', {}, '"USB Device"'), '.'),
        h('li', {}, 'Choose the USB drive and wait for the backup to finish. Do not turn the console off while it runs.'),
      ),
      h('p', {}, 'When the PS3 is done, unplug the USB drive and connect it to this computer.'),
    );
  },
};

const selectStep = {
  id: 'ofw-select',
  title: 'Select the backup',
  nextLabel: () => 'Continue',
  canNext: () => Boolean(state.backup),
  render() {
    const controls = [];
    const error = state.backupError ? h('p', { class: 'ak-error-text' }, state.backupError) : null;

    if (!state.isolated) {
      return h('div', { class: 'ak-page' },
        h('h2', {}, '4. Select your backup on this computer'),
        h('div', { class: 'ak-status ak-status-error' },
          h('strong', {}, 'This browser cannot run the backup editor'),
          h('p', {}, 'The WebAssembly backup writer needs SharedArrayBuffer, which this browser does not expose here. Use Chrome, Edge, Firefox or Safari on a desktop, or use the CFW/HEN flow, which does not touch the backup.'),
          h('button', {
            type: 'button',
            class: 'ak-button',
            onclick: () => {
              state.mode = 'cfw';
              wizard.setSteps(buildFlow(), { keep: false });
              wizard.goToId('cfw-intro');
            },
          }, 'Use the CFW/HEN flow instead'),
        ),
      );
    }

    if (state.folderPicker) {
      controls.push(h('button', {
        type: 'button',
        class: 'ak-button',
        disabled: state.backupBusy,
        onclick: chooseFolder,
      }, 'Select backup folder'));
      controls.push(h('p', { class: 'ak-note' }, 'Recommended on Chrome/Edge: the patched files are written straight to the USB drive.'));
    } else if (!state.mobile) {
      controls.push(h('label', { class: 'ak-button ak-button-file' },
        state.backupBusy ? 'Reading the backup…' : 'Select backup folder',
        h('input', {
          type: 'file', multiple: true, webkitdirectory: '', directory: '',
          disabled: state.backupBusy,
          onchange: event => importFileSelection(event.target.files),
        }),
      ));
      controls.push(h('p', { class: 'ak-note' }, 'This browser cannot write to the USB drive, so the patched files will be downloaded for you to copy across.'));
    } else {
      controls.push(h('label', { class: 'ak-button ak-button-file' },
        state.backupBusy ? 'Reading the backup…' : 'Select backup files',
        h('input', {
          type: 'file', multiple: true, accept: '.dat,application/octet-stream',
          disabled: state.backupBusy,
          onchange: event => importFileSelection(event.target.files),
        }),
      ));
      controls.push(h('p', { class: 'ak-note' }, 'Select archive.dat and every archive_*.dat from the backup folder. Folder selection is not available on this device.'));
    }

    state.importLine = h('p', { class: 'ak-busy' }, '');
    const summary = state.backup ? backupSummary(state.backup) : null;
    const status = summary
      ? h('div', { class: 'ak-status ak-status-ok' },
        h('strong', {}, 'Backup loaded'),
        h('p', {}, `${state.backup.name} · archive.dat + ${summary.chunks} data chunk${summary.chunks === 1 ? '' : 's'} (${formatBytes(summary.chunkBytes)})`),
        h('p', {}, `${summary.files.toLocaleString()} files (${formatBytes(summary.fileBytes)}) · archive id ${state.backup.index.id}`),
        h('p', { class: 'ak-note' }, state.backup.kind === 'folder'
          ? 'The backup can be written to directly.'
          : 'The patched files will be downloaded as a zip.'),
      )
      : null;

    return h('div', { class: 'ak-page' },
      h('h2', {}, '4. Select your backup on this computer'),
      h('p', {}, 'Open the USB drive in your file manager. The backup is the folder that contains ', h('code', {}, 'archive.dat'), ' - usually ', h('code', {}, 'PS3/EXPORT/<timestamp>'), '.'),
      h('div', { class: 'ak-controls' }, controls),
      error,
      state.backupBusy ? state.importLine : null,
      status,
    );
  },
};

async function chooseFolder() {
  state.backupError = null;
  try {
    const picked = await window.showDirectoryPicker({ id: 'arkham-ps3-backup', mode: 'readwrite' });
    const dirHandle = await findBackupDirectory(picked);
    await loadDirectoryBackup(dirHandle);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.backupError = error?.message ?? String(error);
    wizard.refresh();
  }
}

async function findBackupDirectory(dir) {
  try {
    await dir.getFileHandle('archive.dat');
    return dir;
  } catch {
    // The user may have picked PS3/EXPORT; look for a single timestamp folder.
  }
  const candidates = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory' || name.startsWith('.')) continue;
    try {
      await handle.getFileHandle('archive.dat');
      candidates.push(handle);
    } catch {
      // not a backup
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('That folder contains several backups. Select the timestamp folder you want.');
  throw new Error('No archive.dat was found in the selected folder.');
}

async function loadDirectoryBackup(dirHandle, { kind = 'folder' } = {}) {
  state.backupBusy = true;
  state.backupError = null;
  state.backup = null;
  wizard.refresh();
  if (state.importLine) state.importLine.textContent = 'Reading the backup index…';
  try {
    const instance = await getEngine();
    const backup = await readBackup({
      engine: instance,
      dirHandle,
      onProgress: text => {
        if (state.importLine) state.importLine.textContent = `${text}…`;
      },
    });
    state.backup = { ...backup, dirHandle, name: dirHandle.name, kind };
    resetPatch();
  } catch (error) {
    state.backupError = error?.message ?? String(error);
    state.backup = null;
  } finally {
    state.backupBusy = false;
    wizard.refresh();
  }
}

async function importFileSelection(fileList) {
  state.backupError = null;
  const files = [...(fileList ?? [])];
  const wanted = files.filter(file => {
    const name = basename(file.webkitRelativePath || file.name);
    return name === 'archive.dat' || /^archive_\d+\.dat$/i.test(name);
  });
  const archives = wanted.filter(file => basename(file.webkitRelativePath || file.name) === 'archive.dat');
  if (!archives.length) {
    state.backupError = 'archive.dat was not in that selection. Select the whole backup folder (or archive.dat plus every archive_*.dat).';
    wizard.refresh();
    return;
  }
  if (archives.length > 1) {
    state.backupError = 'That selection contains more than one backup. Select the timestamp folder you want (the one containing the archive.dat you need).';
    wizard.refresh();
    return;
  }
  state.backupBusy = true;
  state.importLine = h('p', { class: 'ak-busy' }, 'Checking browser storage…');
  wizard.refresh();
  try {
    if (!navigator.storage?.getDirectory) {
      throw new Error('This browser cannot stage the backup files. Use Chrome, Edge, Firefox or Safari on a computer.');
    }
    const total = wanted.reduce((sum, file) => sum + file.size, 0);
    const estimate = await navigator.storage.estimate().catch(() => null);
    if (estimate?.quota && estimate.quota - estimate.usage < total * 2.1) {
      throw new Error(`Not enough browser storage for this backup. About ${formatBytes(total * 2)} is needed; this browser allows ${formatBytes(Math.max(0, estimate.quota - estimate.usage))}. Use the Chromium folder option on a computer, or free up space.`);
    }
    const opfsRoot = await navigator.storage.getDirectory();
    const dirHandle = await opfsRoot.getDirectoryHandle(`arkham-ps3-${Date.now()}`, { create: true });
    let done = 0;
    const line = state.importLine ?? h('p');
    state.importLine = line;
    for (const file of wanted) {
      const name = basename(file.webkitRelativePath || file.name);
      line.textContent = `Copying ${name} into browser storage…`;
      const handle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
          const end = Math.min(offset + COPY_CHUNK, file.size);
          const buffer = await file.slice(offset, end).arrayBuffer();
          await writable.write(buffer);
          done += buffer.byteLength;
          line.textContent = `Copying ${name} into browser storage… ${formatBytes(done)} of ${formatBytes(total)}`;
        }
      } finally {
        await writable.close();
      }
    }
    await loadDirectoryBackup(dirHandle, { kind: 'files' });
  } catch (error) {
    state.backupError = error?.message ?? String(error);
    state.backup = null;
  } finally {
    state.backupBusy = false;
    wizard.refresh();
  }
}

/* ------------------------------------------------------------- region page */

const regionStep = {
  id: 'region',
  title: 'Choose the game version',
  nextLabel: () => 'Continue',
  canNext: () => Boolean(regionFor(state.regionName, state.editionName)),
  render() {
    const regionSelect = h('select', {
      class: 'ak-select',
      onchange: event => {
        state.regionName = event.target.value;
        resetPatch();
        wizard.refresh();
      },
    }, REGION_NAMES.map(name => h('option', { value: name, selected: name === state.regionName }, name)));

    const editionSelect = h('select', {
      class: 'ak-select',
      onchange: event => {
        state.editionName = event.target.value;
        resetPatch();
        wizard.refresh();
      },
    }, EDITION_NAMES.map(name => h('option', { value: name, selected: name === state.editionName }, name)));

    const entry = regionFor(state.regionName, state.editionName);
    const existing = entry ? updateFileCount(entry.titleId) : 0;

    return h('div', { class: 'ak-page' },
      h('h2', {}, 'Choose your game version'),
      h('p', {}, 'Pick the region and edition you own. This must match the disc or the PlayStation Store copy, because each version installs into a different folder.'),
      h('div', { class: 'ak-form' },
        h('label', {}, h('span', {}, 'Region'), regionSelect),
        h('label', {}, h('span', {}, 'Edition'), editionSelect),
      ),
      entry ? h('div', { class: 'ak-status' },
        h('strong', {}, `${entry.region} · ${entry.edition} · ${entry.titleId}`),
        h('p', {}, `Update file: ${entry.file} (${formatBytes(entry.size)})`),
        state.backup ? h('p', { class: 'ak-note' }, existing
          ? `This backup already has ${existing.toLocaleString()} file${existing === 1 ? '' : 's'} in /dev_hdd0/game/${entry.titleId}; they will be replaced or kept as appropriate.`
          : `/dev_hdd0/game/${entry.titleId} is not in this backup yet and will be created.`) : null,
      ) : null,
      h('details', { class: 'ak-details' },
        h('summary', {}, 'Which title ID do I have?'),
        h('table', { class: 'ak-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Region'), h('th', {}, 'Disc'), h('th', {}, 'Digital'))),
          h('tbody', {},
            ...REGIONS.reduce((rows, item) => {
              if (item.edition !== 'Disc') return rows;
              const digital = REGIONS.find(other => other.region === item.region && other.edition === 'Digital');
              rows.push(h('tr', {},
                h('td', {}, item.region),
                h('td', {}, item.titleId),
                h('td', {}, digital?.titleId ?? '-'),
              ));
              return rows;
            }, []),
          ),
        ),
        h('p', { class: 'ak-note' }, 'On a PS3, the title ID is shown in the game data folder name under Game Data Utility, or on the disc spine/label.'),
      ),
    );
  },
};

/* -------------------------------------------------------------- patch page */

const patchStep = {
  id: 'patch',
  title: 'Patch',
  nextLabel: () => (state.patchDone ? 'Continue' : null),
  canNext: () => state.patchDone && !state.patchRunning,
  render() {
    const entry = regionFor(state.regionName, state.editionName);
    const page = h('div', { class: 'ak-page' },
      h('h2', {}, state.mode === 'cfw' ? 'Patch the COALESCED files' : 'Patch the backup'),
      h('p', {}, state.mode === 'cfw'
        ? `The official ${entry?.titleId ?? ''} 1.06 update is downloaded from this page, decrypted locally, and the Arkham: Revived redirect is added to every COALESCED file. Nothing is uploaded.`
        : `The official ${entry?.titleId ?? ''} 1.06 update is downloaded from this page and merged into your backup. Only the end of the archive is rewritten. Nothing is uploaded.`),
    );

    if (state.patchRunning && state.progress) {
      page.append(state.progress.node);
    } else if (state.patchError) {
      page.append(h('div', { class: 'ak-status ak-status-error' },
        h('strong', {}, 'The patch did not finish'),
        h('p', {}, state.patchError),
      ));
      page.append(h('button', { type: 'button', class: 'ak-button', onclick: startPatch }, 'Try again'));
    } else if (!state.patchDone) {
      page.append(h('button', {
        type: 'button',
        class: 'ak-button ak-button-primary',
        disabled: !entry || (state.mode === 'ofw' && !state.backup),
        onclick: startPatch,
      }, state.mode === 'cfw' ? 'Download and patch' : 'Patch my backup'));
      if (state.mode === 'ofw' && !state.backup) {
        page.append(h('p', { class: 'ak-error-text' }, 'Select your backup folder first (go back).'));
      }
    } else {
      page.append(h('div', { class: 'ak-status ak-status-ok' }, h('strong', {}, 'Patch complete')));
    }
    return page;
  },
};

async function startPatch() {
  const entry = regionFor(state.regionName, state.editionName);
  if (!entry) return;
  if (state.mode === 'ofw' && !state.backup) {
    toast('Select your PS3 backup first.', { kind: 'error' });
    return;
  }

  resetPatch();
  state.patchRunning = true;
  state.cancelRequested = false;
  state.abort = new AbortController();

  const progress = new TaskProgress();
  state.progress = progress;
  const phases = state.mode === 'cfw'
    ? [
      { id: 'download', label: 'Downloading', weight: 35 },
      { id: 'extract', label: 'Decrypting', weight: 35 },
      { id: 'coalesced', label: 'Patching config', weight: 10 },
      { id: 'zip', label: 'Building zip', weight: 20 },
    ]
    : [
      { id: 'download', label: 'Downloading', weight: 22 },
      { id: 'extract', label: 'Decrypting', weight: 20 },
      { id: 'coalesced', label: 'Patching config', weight: 4 },
      { id: 'read', label: 'Reading backup', weight: 4 },
      { id: 'write', label: 'Writing archive', weight: 32 },
      { id: 'install', label: 'Installing', weight: 18 },
    ];
  progress.begin(phases, {
    cancellable: true,
    onCancel: () => {
      state.cancelRequested = true;
      state.abort?.abort();
    },
  });
  wizard.refresh();

  try {
    // 1. Download
    progress.setPhase('download', `Downloading the official 1.06 update (${formatBytes(entry.size)})`);
    if (!state.pkgBlob || state.pkgEntryKey !== entry.key) {
      state.pkgBlob = await downloadPkg(pkgUrl(entry), {
        expectedSize: entry.size,
        signal: state.abort.signal,
        shouldCancel: isCancelled,
        onProgress: (done, total) => progress.setProgress(done, total, `${formatBytes(done)} of ${formatBytes(total)}`),
      });
      state.pkgEntryKey = entry.key;
      state.patchFiles = null;
    }
    checkCancel();
    progress.setFraction(1);

    // 2. Extract
    progress.setPhase('extract', 'Decrypting the title update in memory');
    if (!state.patchFiles) {
      const pkg = await extractPkg(state.pkgBlob, {
        shouldCancel: isCancelled,
        onProgress: info => {
          if (info.phase === 'names') {
            progress.setFraction(0.1 * (info.done / Math.max(1, info.total)));
            progress.setDetail(`${info.done.toLocaleString()} files`);
          } else {
            progress.setFraction(0.1 + 0.9 * (info.done / Math.max(1, info.total)));
            progress.setDetail(`${formatBytes(info.done)} of ${formatBytes(info.total)}`);
          }
        },
      });
      if (pkg.titleId !== entry.titleId) {
        throw new Error(`This update is for ${pkg.titleId}, but ${entry.titleId} was selected. Choose the correct region/edition.`);
      }
      state.patchFiles = pkg.files;
      state.pkgInfo = { titleId: pkg.titleId, appVer: pkg.appVer, title: pkg.title };
    }
    checkCancel();
    progress.setFraction(1);

    // 3. Patch COALESCED files
    progress.setPhase('coalesced', 'Adding the Arkham: Revived redirect to PS3-BmNetVars.ini');
    const updated = [];
    const inCookedDir = path => isCoalescedName(path) && path.toUpperCase().includes('/COOKEDPS3/');
    const coalesced = state.patchFiles.filter(file => inCookedDir(file.path));
    if (!coalesced.length) throw new Error('The update does not contain any COALESCED files.');
    for (let index = 0; index < state.patchFiles.length; index++) {
      const file = state.patchFiles[index];
      if (!inCookedDir(file.path)) {
        updated.push(file);
        continue;
      }
      const patched = await patchCoalescedBlob(file.blob);
      if (!patched.changed) throw new Error(`${basename(file.path)} does not contain BmGame/Config/PS3-BmNetVars.ini.`);
      updated.push({ ...file, blob: patched.blob, size: patched.blob.size });
      progress.setFraction((coalesced.findIndex(item => item.path === file.path) + 1) / coalesced.length);
      progress.setDetail(basename(file.path));
      checkCancel();
    }
    progress.setFraction(1);

    if (state.mode === 'cfw') {
      progress.setPhase('zip', 'Building the COALESCED zip');
      const archive = await buildCoalescedZip(updated, entry, bytes => {
        progress.setFraction(bytes.total ? bytes.done / bytes.total : 0);
        progress.setDetail(`${formatBytes(bytes.done)} of ${formatBytes(bytes.total)}`);
      });
      state.result = { kind: 'cfw-zip', ...archive };
      progress.finish();
      state.patchDone = true;
      state.patchRunning = false;
      wizard.refresh();
      return;
    }

    // 4. Read the backup (already loaded, but re-check the layout)
    progress.setPhase('read', 'Reading the backup index');
    const backup = state.backup;
    progress.setFraction(0.5);
    checkCancel();
    const gameRoot = GAME_DIR(entry.titleId);
    const plan = planGamePatch({
      index: backup.index,
      layout: backup.layout,
      files: updated,
      gameRoot,
    });
    const dirs = buildDirectories(backup.index, updated, gameRoot, {
      tombstones: plan.changes.unlinked.length > 0,
    });
    progress.setFraction(1);

    // 5. Write chunks + index into staging
    progress.setPhase('write', 'Writing the patched archive');
    const staging = await backup.dirHandle.getDirectoryHandle(`.arkham-patch-${Date.now().toString(36)}`, { create: true });
    state.staging = staging;

    const workTotal = Math.max(1, plan.totals.copyBytes * 2 + plan.totals.writeBytes);
    const activityBase = engine.activity.reads + engine.activity.writes;
    const timer = setInterval(() => {
      const done = engine.activity.reads + engine.activity.writes - activityBase;
      progress.setFraction(Math.min(0.995, done / workTotal));
    }, 300);

    let writeResult;
    try {
      writeResult = await writePatch({
        engine,
        plan,
        dirs,
        outDirHandle: staging,
        archive2Size: backup.index.archive2Size,
        shouldCancel: isCancelled,
        onProgress: text => progress.setStatus(text),
        onChunk: info => progress.setDetail(`${info.name} · ${formatBytes(info.total)}`),
      });
    } finally {
      clearInterval(timer);
    }
    progress.setFraction(1);
    checkCancel();

    // 6. Install or prepare the download
    progress.setPhase('install', backup.kind === 'folder' ? 'Copying the patched files to the USB drive' : 'Packaging the patched files');
    if (backup.kind === 'folder') {
      const installTotal = await stagedSize(staging, writeResult.chunkNames);
      let installed = 0;
      await copyStagedToBackup({
        backup,
        staging,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
        onBytes: delta => {
          installed += delta;
          progress.setFraction(installTotal ? installed / installTotal : 0);
          progress.setDetail(`${formatBytes(installed)} of ${formatBytes(installTotal)}`);
        },
      });
      state.result = {
        kind: 'installed',
        plan,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
      };
      // The folder on disk no longer matches the cached index; force a fresh
      // read before another write can be planned.
      state.backup = null;
    } else {
      const archive = await buildBackupZip({
        staging,
        chunkNames: writeResult.chunkNames,
        entry,
        onProgress: (done, total) => {
          progress.setFraction(total ? done / total : 0);
          progress.setDetail(`${formatBytes(done)} of ${formatBytes(total)}`);
        },
      });
      state.result = {
        kind: 'zip',
        blob: archive.blob,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
        plan,
      };
    }

    progress.finish();
    state.patchDone = true;
    state.patchRunning = false;
    wizard.refresh();
  } catch (error) {
    state.patchRunning = false;
    const cancelled = error?.name === 'AbortError' || state.cancelRequested;
    if (state.staging) {
      try {
        await state.backup?.dirHandle?.removeEntry(state.staging.name, { recursive: true });
      } catch {
        // best effort
      }
      state.staging = null;
    }
    if (cancelled) {
      progress.dispose();
      state.patchError = 'The patch was cancelled. The backup was not modified.';
    } else {
      progress.fail(error?.message ?? String(error));
      state.patchError = error?.message ?? String(error);
    }
    state.progress = null;
    wizard.refresh();
  }
}

async function stagedSize(staging, chunkNames) {
  let total = 0;
  for (const name of ['archive.dat', ...chunkNames]) {
    try {
      total += (await (await staging.getFileHandle(name)).getFile()).size;
    } catch {
      // ignore missing archive.dat until it is written
    }
  }
  return total;
}

async function copyStagedToBackup({ backup, staging, chunkNames, newChunkCount, onBytes }) {
  // Chunks first, index last: an interrupted copy never points at missing data.
  for (const name of chunkNames) {
    await copyHandleFile(staging, name, backup.dirHandle, name, onBytes);
  }
  for await (const [name, handle] of backup.dirHandle.entries()) {
    const match = /^archive_(\d+)\.dat$/i.exec(name);
    if (match && Number(match[1]) >= newChunkCount && handle.kind === 'file') {
      await backup.dirHandle.removeEntry(name);
    }
  }
  await copyHandleFile(staging, 'archive.dat', backup.dirHandle, 'archive.dat', onBytes);
  await backup.dirHandle.removeEntry(staging.name, { recursive: true });
  state.staging = null;
}

async function copyHandleFile(sourceDir, sourceName, targetDir, targetName, onBytes) {
  const source = await (await sourceDir.getFileHandle(sourceName)).getFile();
  const writable = await (await targetDir.getFileHandle(targetName, { create: true })).createWritable();
  try {
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK) {
      const end = Math.min(offset + COPY_CHUNK, source.size);
      const buffer = await source.slice(offset, end).arrayBuffer();
      await writable.write(buffer);
      onBytes?.(buffer.byteLength);
    }
  } finally {
    await writable.close();
  }
}

async function buildCoalescedZip(files, entry, onProgress) {
  const coalesced = files.filter(file => isCoalescedName(file.path) && file.path.toUpperCase().includes('/COOKEDPS3/'));
  const total = coalesced.reduce((sum, file) => sum + file.size, 0);
  const readme = [
    'Arkham: Revived - PS3 COALESCED files',
    '',
    `Game: Batman: Arkham Origins (${entry.titleId})`,
    `Copy these files into: dev_hdd0/game/${entry.titleId}/${COALESCED_DIR}`,
    '',
    'Use multiMAN (mmCM) and overwrite the existing files.',
    'Do not delete any other files or folders in that directory.',
    'If the directory does not exist, install the official 1.06 update first.',
  ].join('\n');
  const entries = coalesced.map(file => ({
    path: basename(file.path),
    mtime: new Date(),
    getBlob: async () => file.blob,
  }));
  entries.push({ path: 'README.txt', getBlob: async () => new Blob([readme]) });
  const zip = await buildZip(entries, {
    onProgress: done => onProgress?.({ done: Math.min(total, done), total }),
  });
  return { blob: zip.blob, filenames: coalesced.map(file => basename(file.path)), titleId: entry.titleId };
}

async function buildBackupZip({ staging, chunkNames, entry, onProgress }) {
  const archiveFile = await (await staging.getFileHandle('archive.dat')).getFile();
  let total = archiveFile.size;
  const chunkFiles = [];
  for (const name of chunkNames) {
    const file = await (await staging.getFileHandle(name)).getFile();
    chunkFiles.push({ name, file });
    total += file.size;
  }
  const readme = [
    'Arkham: Revived - patched PS3 backup files',
    '',
    `Game: Batman: Arkham Origins (${entry.titleId})`,
    '',
    '1. Open the backup folder on the USB drive (the one containing archive.dat).',
    '2. Copy archive.dat and the archive_*.dat files from this zip into that folder.',
    '3. Replace the existing files when asked.',
    '4. Do not delete any other file.',
    '',
    `Files in this zip: ${chunkNames.length + 1}`,
    `Rewritten chunks: ${chunkNames.join(', ') || 'none'}`,
  ].join('\n');
  const entries = [
    { path: 'archive.dat', mtime: new Date(), getBlob: async () => archiveFile },
    ...chunkFiles.map(item => ({ path: item.name, mtime: new Date(), getBlob: async () => item.file })),
    { path: 'README.txt', getBlob: async () => new Blob([readme]) },
  ];
  const zip = await buildZip(entries, {
    onProgress: done => onProgress?.(done, total),
  });
  return { blob: zip.blob, chunkNames };
}

/* ------------------------------------------------------------- OFW results */

const ofwResult = {
  id: 'ofw-result',
  title: 'Patched files',
  render() {
    const result = state.result;
    const installed = result?.kind === 'installed';
    const stats = result?.plan
      ? h('ul', { class: 'ak-list' },
        h('li', {}, `${result.plan.changes.added.length.toLocaleString()} files added to the backup`),
        h('li', {}, `${result.plan.replaced.length.toLocaleString()} old entries replaced`),
        h('li', {}, `${result.chunkNames.length} data chunk${result.chunkNames.length === 1 ? '' : 's'} written`),
      )
      : null;

    return h('div', { class: 'ak-page' },
      h('h2', {}, installed ? 'The backup has been patched' : 'Copy the patched files across'),
      installed
        ? h('div', { class: 'ak-status ak-status-ok' },
          h('strong', {}, 'Done - the files were written to the USB drive.'),
          h('p', {}, 'archive.dat and every changed data chunk are in place. Leave the USB drive plugged into this computer until you have read the next step.'),
        )
        : h('div', { class: 'ak-status' },
          h('strong', {}, 'Download the patched files'),
          h('p', {}, 'Copy archive.dat and the archive_*.dat files from the zip into the backup folder on the USB drive, replacing the old files. Keep every other file in that folder.'),
          result?.blob ? h('button', {
            type: 'button',
            class: 'ak-button ak-button-primary',
            onclick: () => downloadBlob(result.blob, `arkham-revived-${state.regionName.toLowerCase()}-${state.editionName.toLowerCase()}-backup.zip`),
          }, `Download patched files (${formatBytes(result.blob.size)})`) : null,
        ),
      stats,
      h('p', { class: 'ak-note' }, 'archive2.dat (copy-protected content) is not touched. If it exists, keep it as it is.'),
    );
  },
};

const ofwRestore = {
  id: 'ofw-restore',
  title: 'Restore the backup',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Restore the backup'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Safely eject the USB drive from this computer, then plug it back into the PS3.'),
        h('li', {}, 'On the PS3, go to ', h('strong', {}, 'Settings'), ' -> ', h('strong', {}, 'System Settings'), ' -> ', h('strong', {}, 'Backup Utility'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Restore"'), ' -> ', h('strong', {}, '"USB Device"'), ' and confirm.'),
        h('li', {}, 'The PS3 reboots. When the restore screen appears, press the ', h('strong', {}, 'PS button'), ' on the controller to continue.'),
        h('li', {}, 'Wait until the restore is completely finished. Do not turn the console off.'),
      ),
      h('p', { class: 'ak-note' }, 'The restore copies the whole backup back, including the patched Arkham Origins game data.'),
    );
  },
};

const ofwSafeMode = {
  id: 'ofw-safe-mode',
  title: 'Enter Safe Mode',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '6. Enter Safe Mode'),
      h('p', {}, 'After the restore, the PS3 needs to rebuild its database. Start by turning the console off and waiting until the red standby light is on.'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Wait until the red standby light is on.'),
        h('li', {}, 'Press and hold the power button. The PS3 beeps once - keep holding.'),
        h('li', {}, 'Keep holding while it beeps a second time, then a third time. Release after the third beep.'),
        h('li', {}, 'Wait until the red light is back.'),
        h('li', {}, 'Press and hold the power button again. It beeps once - keep holding.'),
        h('li', {}, 'Keep holding while it beeps a second time.'),
        h('li', {}, 'Keep holding until it beeps twice quickly, then release.'),
      ),
      h('p', {}, 'The Safe Mode menu should now appear. If it does not, turn the console off and repeat the sequence from the beginning.'),
    );
  },
};

const ofwRebuild = {
  id: 'ofw-rebuild',
  title: 'Rebuild the database',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '7. Rebuild the database'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Plug the PS3 controller into the console with a USB cable (wireless controllers may not work in Safe Mode).'),
        h('li', {}, 'Press the ', h('strong', {}, 'PS button'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Rebuild Database"'), ' and confirm.'),
        h('li', {}, 'The PS3 restarts when it is done.'),
      ),
      h('p', {}, 'The console will ask you to confirm the video mode after restarting. Choose the resolution your TV supports.'),
    );
  },
};

/* --------------------------------------------------------------- CFW pages */

const cfwIntro = {
  id: 'cfw-intro',
  title: 'CFW or HEN',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, 'CFW or HEN: no backup needed'),
      h('p', {}, 'This page will download the official 1.06 update, decrypt it in memory, and patch every COALESCED file with the Arkham: Revived redirect. You get a zip to copy onto the PS3 with multiMAN (mmCM).'),
      h('div', { class: 'ak-callout' },
        h('strong', {}, 'Before you start'),
        h('ul', { class: 'ak-list' },
          h('li', {}, 'Batman: Arkham Origins and the official 1.06 update must already be installed.'),
          h('li', {}, 'You need about 150 MB free on the PS3 for the files.'),
          h('li', {}, 'Do not delete Arkham: Revived data or any other files in the game folder.'),
        ),
      ),
      h('p', { class: 'ak-note' }, 'This path never reads or writes your PS3 backup.'),
    );
  },
};

const cfwInstall = {
  id: 'cfw-install',
  title: 'Install the zip',
  render() {
    const result = state.result;
    return h('div', { class: 'ak-page' },
      h('h2', {}, 'Copy the patched files with mmCM'),
      result?.blob ? h('button', {
        type: 'button',
        class: 'ak-button ak-button-primary',
        onclick: () => downloadBlob(result.blob, `arkham-revived-${result.titleId}-coalesced.zip`),
      }, `Download COALESCED files (${formatBytes(result.blob.size)})`) : h('p', { class: 'ak-error-text' }, 'The zip has not been built yet.'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Copy the zip to a USB drive and plug it into the PS3.'),
        h('li', {}, 'Open ', h('strong', {}, 'multiMAN (mmCM)'), '.'),
        h('li', {}, 'Go to ', h('code', {}, `dev_hdd0/game/${result?.titleId ?? '<TITLEID>'}/${COALESCED_DIR}`), '.'),
        h('li', {}, `Copy the ${result?.filenames?.length ?? ''} COALESCED_*.BIN files from the zip into that folder and choose `, h('strong', {}, 'Yes to All'), ' when asked to overwrite.'),
        h('li', {}, 'Do not delete any other files or folders in that directory. In particular, keep any existing Arkham: Revived data.'),
      ),
      h('p', { class: 'ak-note' }, 'If the folder does not exist, install the official 1.06 update from the PlayStation Store first, then copy the files.'),
    );
  },
};

const cfwFinish = {
  id: 'cfw-finish',
  title: 'Test it',
  render() {
    return finishPage('CFW/HEN');
  },
};

/* ------------------------------------------------------------ final device */

function finishPage(kind) {
  return h('div', { class: 'ak-page' },
    h('h2', {}, 'You are done'),
    h('p', {}, kind === 'CFW/HEN'
      ? 'Arkham Origins is patched. Start the game and try Arkham: Revived Redux.'
      : 'The backup is restored, the database is rebuilt, and Arkham Origins is patched.'),
    h('p', {}, 'Confirm the video mode prompt after the restart if the PS3 shows it.'),
    h('h3', {}, 'Try Arkham: Revived Redux'),
    h('ol', { class: 'ak-list' },
      h('li', {}, 'Sign in to PlayStation Network.'),
      h('li', {}, 'Start Batman: Arkham Origins.'),
      h('li', {}, 'Press ', h('strong', {}, 'Start'), ' at the main menu.'),
      h('li', {}, 'Load a save file.'),
      h('li', {}, 'Select ', h('strong', {}, '"Online"'), ' in the menu.'),
      h('li', {}, 'When online mode has loaded, press ', h('strong', {}, 'Start'), ' again to log in to Arkham: Revived Redux.'),
    ),
    h('div', { class: 'ak-callout' },
      h('strong', {}, 'Troubleshooting'),
      h('ul', { class: 'ak-list' },
        h('li', {}, 'No online option or a failed login? Check that the region and edition match your game.'),
        h('li', {}, 'Nothing changed? Reinstall the official 1.06 update, then run this page again.'),
        h('li', {}, 'Still stuck? Ask in the ', link('https://discord.gg/7BneAcgvZh', 'Arkham: Revived Discord'), '.'),
      ),
    ),
    h('p', { class: 'ak-note' }, 'Server: arkhamrevived.kiwifruitdev.com · Page source and patch tool by KiwifruitDev.'),
  );
}

/* ------------------------------------------------------------------- flow */

function buildFlow() {
  if (!state.mode) return [firmwareStep];
  if (state.mode === 'cfw') {
    return [firmwareStep, cfwIntro, regionStep, patchStep, cfwInstall, cfwFinish];
  }
  return [
    firmwareStep, ofwUsb, ofwDelete, ofwBackup, selectStep, regionStep, patchStep,
    ofwResult, ofwRestore, ofwSafeMode, ofwRebuild,
    {
      id: 'ofw-finish',
      title: 'Test it',
      render: () => finishPage('OFW'),
    },
  ];
}

/* -------------------------------------------------------------- mobile note */

function showMobileNotice() {
  if (!state.mobile || state.mobileAcknowledged) return;
  const overlay = h('div', { class: 'ak-modal-backdrop', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'ak-modal' },
      h('h2', {}, 'Use a computer instead'),
      h('p', {}, 'This patcher reads and rewrites a PS3 Backup Utility archive. A desktop or laptop is strongly recommended: mobile browsers cannot select a folder, cannot write to the USB drive, and may run out of storage while the patch is prepared.'),
      h('p', { class: 'ak-note' }, 'You can still continue on this device. The CFW/HEN zip works; the OFW backup path will download the patched files instead of writing them.'),
      h('div', { class: 'ak-modal-actions' },
        h('button', {
          type: 'button',
          class: 'ak-button',
          onclick: () => {
            state.mobileAcknowledged = true;
            overlay.remove();
            document.body.classList.remove('ak-modal-open');
          },
        }, 'I understand, continue anyway'),
      ),
    ),
  );
  document.body.classList.add('ak-modal-open');
  document.body.append(overlay);
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  root = document.getElementById('arkham-patcher');
  if (!root) return;

  const isolation = await ensureCrossOriginIsolation();
  if (isolation === false) return; // reloading with COOP/COEP
  state.isolated = isolation === true;

  // Browser storage is only a staging area; drop anything a previous visit
  // left behind so a large backup is not blocked by stale copies.
  navigator.storage?.getDirectory?.().then(async opfsRoot => {
    for await (const [name, handle] of opfsRoot.entries()) {
      if (handle.kind === 'directory' && name.startsWith('arkham-ps3-')) {
        await opfsRoot.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  }).catch(() => {});

  root.replaceChildren();
  wizard = new Wizard(root, { canLeave: () => !state.patchRunning });
  wizard.setSteps(buildFlow());
  showMobileNotice();

  if (!state.isolated) {
    console.info('Cross-origin isolation is unavailable; the OFW backup path will be disabled.');
  }
}

boot().catch(error => {
  console.error(error);
  if (root) {
    root.replaceChildren(h('p', { class: 'ak-error-text' }, `The patcher failed to start: ${error.message ?? error}`));
  }
});
