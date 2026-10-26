import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import createModule from '../../web/ps3xport.mjs';
import { mountHostRoots } from '../../web/pxfs.js';
import { NodeHost } from '../../test/node-host.mjs';
import { buildDirectories, planGamePatch, writePatch } from '../src/archive-patch.js';
import { layoutArchive } from '../src/layout.js';

const wasmDir = fileURLToPath(new URL('../../web/', import.meta.url));

function writeFile(root, virtualPath, data) {
  const target = path.join(root, ...virtualPath.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function random(size) {
  return crypto.randomBytes(size);
}

class NodeEngine {
  constructor(Module, host) {
    this.Module = Module;
    this.host = host;
    this.api = bind(Module);
    this.mounted = new Set();
    this.activity = { reads: 0, writes: 0 };
    this.copyBuffer = 0;
    this.copyBufferSize = 0;
  }

  setRoot(name, directory) {
    this.host.setRoot(name, directory);
    this.mount(name);
  }

  mount(name) {
    const FS = this.Module.FS;
    if (!FS.analyzePath('/px').exists) FS.mkdir('/px');
    const mountpoint = `/px/${name}`;
    if (this.mounted.has(name)) {
      try { FS.unmount(mountpoint); } catch { /* not mounted */ }
      this.mounted.delete(name);
    }
    if (!FS.analyzePath(mountpoint).exists) FS.mkdir(mountpoint);
    FS.mount(this.Module.PXFS, { root: name }, mountpoint);
    this.mounted.add(name);
  }

  chunkWrite(bytes) {
    if (bytes.length > this.copyBufferSize) {
      if (this.copyBuffer) this.Module._free(this.copyBuffer);
      this.copyBuffer = this.Module._malloc(bytes.length);
      this.copyBufferSize = bytes.length;
    }
    this.Module.HEAPU8.set(bytes, this.copyBuffer);
    check(this.api.chunkWrite(this.copyBuffer, bytes.length));
  }

  async rpc(command, args = {}) {
    const api = this.api;
    try {
      return await this.run(command, args);
    } catch (error) {
      console.error('rpc failed', command, args?.path ?? args?.saveTo ?? '', error);
      throw error;
    }
  }

  async run(command, args = {}) {
    const api = this.api;
    switch (command) {
      case 'chunkBegin': check(api.chunkBegin(args.path, args.id, args.index, args.archiveType, args.cap)); return {};
      case 'chunkWrite': this.chunkWrite(args.data instanceof Uint8Array ? args.data : new Uint8Array(args.data)); return { n: args.data.byteLength };
      case 'chunkCopy': check(api.chunkCopy(args.source, args.offset, args.length)); return {};
      case 'chunkFinish': { const size = api.chunkSize(); check(api.chunkFinish()); return { size }; }
      case 'chunkAbort': api.chunkAbort(); return {};
      case 'indexBegin':
        if (args.create !== null && args.create !== undefined) check(api.indexNew(args.create));
        else check(api.indexOpen(args.open));
        return { id: api.indexId() };
      case 'indexApply': {
        for (const item of args.remove) check(api.indexRemoveFile(item));
        for (const item of args.rename) check(api.indexRenameFile(item.from, item.to));
        for (const item of args.update) check(api.indexUpdateFile(item.path, item.size, item.mode ?? 0, item.mtime ?? 0, item.flags ?? 0));
        for (const item of args.add) check(api.indexAddFile(item.path, item.size, item.mode ?? 0, item.mtime ?? 0, item.flags ?? 0));
        check(api.indexClearDirs());
        for (const dir of args.dirs ?? []) check(api.indexAddDir(dir.path, dir.mode ?? 0, dir.mtime ?? 0, dir.flags ?? 0));
        if (args.archive2Size !== null && args.archive2Size !== undefined) api.indexSetArchive2Size(args.archive2Size);
        check(api.indexSave(args.saveTo));
        return {};
      }
      case 'indexClose': api.indexClose(); return {};
      default: throw new Error(`unexpected rpc ${command}`);
    }
  }
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
    indexFileMode: wrap('px_index_file_mode', 'number', ['number']),
    indexFileMtime: wrap('px_index_file_mtime', 'number', ['number']),
    indexFileFlags: wrap('px_index_file_flags', 'number', ['number']),
    indexDirCount: wrap('px_index_dir_count', 'number', []),
    indexDirPath: wrap('px_index_dir_path', 'string', ['number']),
    indexDirMode: wrap('px_index_dir_mode', 'number', ['number']),
    indexDirMtime: wrap('px_index_dir_mtime', 'number', ['number']),
    indexDirFlags: wrap('px_index_dir_flags', 'number', ['number']),
    indexArchiveType: wrap('px_index_archive_type', 'number', []),
    indexId: wrap('px_index_id', 'string', []),
    indexArchive2Size: wrap('px_index_archive2_size', 'number', []),
    probeDat: wrap('px_probe_dat', 'number', ['string']),
    dataRead: wrap('px_data_read', 'number', ['string']),
    extractFile: wrap('px_extract_file', 'number', ['string', 'string', 'string', 'string']),
    createBackup: wrap('px_create_backup', 'number', ['string', 'string', 'string']),
    chunkBegin: wrap('px_chunk_begin', 'number', ['string', 'string', 'number', 'number', 'number']),
    chunkWrite: wrap('px_chunk_write', 'number', ['number', 'number']),
    chunkCopy: wrap('px_chunk_copy', 'number', ['string', 'number', 'number']),
    chunkFinish: wrap('px_chunk_finish', 'number', []),
    chunkAbort: wrap('px_chunk_abort', 'number', []),
    chunkSize: wrap('px_chunk_size', 'number', []),
    indexNew: wrap('px_index_new', 'number', ['number']),
    indexRemoveFile: wrap('px_index_remove_file', 'number', ['string']),
    indexRenameFile: wrap('px_index_rename_file', 'number', ['string', 'string']),
    indexUpdateFile: wrap('px_index_update_file', 'number', ['string', 'number', 'number', 'number', 'number']),
    indexAddFile: wrap('px_index_add_file', 'number', ['string', 'number', 'number', 'number', 'number']),
    indexClearDirs: wrap('px_index_clear_dirs', 'number', []),
    indexAddDir: wrap('px_index_add_dir', 'number', ['string', 'number', 'number', 'number']),
    indexSetArchive2Size: wrap('px_index_set_archive2_size', 'number', ['number']),
    indexSave: wrap('px_index_save', 'number', ['string']),
  };
}

function check(code) {
  if (code !== 0) throw new Error('wasm call failed');
}

function readIndex(api) {
  check(api.indexOpen('/px/usb/archive.dat'));
  const files = [];
  for (let index = 0; index < api.indexFileCount(); index++) {
    files.push({
      path: api.indexFilePath(index),
      size: api.indexFileSize(index),
      mode: api.indexFileMode(index),
      mtime: api.indexFileMtime(index),
      flags: api.indexFileFlags(index),
    });
  }
  const dirs = [];
  for (let index = 0; index < api.indexDirCount(); index++) {
    dirs.push({ path: api.indexDirPath(index), mode: api.indexDirMode(index), mtime: api.indexDirMtime(index), flags: api.indexDirFlags(index) });
  }
  const result = {
    id: api.indexId(), archiveType: api.indexArchiveType(), archive2Size: api.indexArchive2Size(), files, dirs,
  };
  api.indexClose();
  return result;
}

test('plans and writes the title update into a backup archive', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkham-archive-'));
  const content = path.join(tmp, 'content');
  const outRoot = path.join(tmp, 'out');
  const out = path.join(outRoot, '20261026000000');
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });

  const hashes = new Map();
  hashes.set('/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT', writeFile(content, '/dev_hdd0/home/00000001/savedata/BATMAN/SAVE.DAT', random(700 * 1024)));
  hashes.set('/dev_hdd0/game/BLUS31147/USRDIR/EBOOT.BIN', writeFile(content, '/dev_hdd0/game/BLUS31147/USRDIR/EBOOT.BIN', random(1500 * 1024)));
  hashes.set('/dev_hdd0/photo/IMAGE.JPG', writeFile(content, '/dev_hdd0/photo/IMAGE.JPG', random(500 * 1024)));
  writeFile(content, '/dev_hdd0/game/BLUS31147/PARAM.SFO', random(0x1000));
  writeFile(content, '/dev_hdd0/game/BLUS31147/USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_INT.BIN', random(1200 * 1024));

  const Module = await createModule({ locateFile: file => path.join(wasmDir, file) });
  const host = new NodeHost();
  host.setRoot('content', content);
  host.setRoot('out', outRoot);
  host.setRoot('scratch', scratch);
  mountHostRoots(Module, host, ['content', 'out', 'scratch']);

  const engine = new NodeEngine(Module, host);
  check(engine.api.init());
  check(engine.api.createBackup('/px/out/20261026000000', '/px/content', '-'));

  engine.setRoot('usb', out);
  const before = readIndex(engine.api);
  const chunkSizes = [];
  for (let index = 0; ; index++) {
    const file = path.join(out, `archive_${String(index).padStart(2, '0')}.dat`);
    if (!fs.existsSync(file)) break;
    chunkSizes.push(fs.statSync(file).size);
  }
  const layout = layoutArchive(before.files, chunkSizes);

  const newParam = random(0x1200);
  const newEbootPatch = random(300 * 1024);
  const newCoalesced = random(1250 * 1024);
  const updates = [
    { path: '/dev_hdd0/game/BLUS31147/PARAM.SFO', blob: new Blob([newParam]), size: newParam.length },
    { path: '/dev_hdd0/game/BLUS31147/USRDIR/NEWFILE.BIN', blob: new Blob([newEbootPatch]), size: newEbootPatch.length },
    { path: '/dev_hdd0/game/BLUS31147/USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3/COALESCED_INT.BIN', blob: new Blob([newCoalesced]), size: newCoalesced.length },
  ].map(file => ({ ...file, binary: true }));

  const plan = planGamePatch({ index: before, layout, files: updates, gameRoot: '/dev_hdd0/game/BLUS31147' });
  assert.equal(plan.mode, 'append');
  assert.equal(plan.changes.added.length, 3);
  assert.equal(plan.replaced.length, 2);

  const dirs = buildDirectories(before, updates, '/dev_hdd0/game/BLUS31147', { tombstones: true });
  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const written = await writePatch({
    engine, plan, dirs, outDirHandle: staging, outRoot: 'staging', archive2Size: before.archive2Size,
  });

  // Commit into the backup folder the same way the page does.
  for (const name of [...written.chunkNames]) fs.copyFileSync(path.join(staging, name), path.join(out, name));
  fs.copyFileSync(path.join(staging, 'archive.dat'), path.join(out, 'archive.dat'));

  const after = readIndex(engine.api);
  const paths = new Set(after.files.map(file => file.path));
  for (const pathName of hashes.keys()) assert.ok(paths.has(pathName), `${pathName} is still in the index`);
  assert.ok(paths.has('/dev_hdd0/game/BLUS31147/USRDIR/NEWFILE.BIN'), 'new file is in the index');
  assert.ok(paths.has('/dev_hdd0/game/BLUS31147/PARAM.SFO'), 'replaced PARAM.SFO is in the index');
  assert.ok(after.files.some(file => file.path.startsWith('/dev_hdd0/.ps3xport-unlinked/')), 'unlinked entries are tombstoned');
  assert.ok(after.dirs.some(dir => dir.path === '/dev_hdd0/game/BLUS31147'), 'game directory is recorded');

  for (let index = 0; ; index++) {
    const file = path.join(out, `archive_${String(index).padStart(2, '0')}.dat`);
    if (!fs.existsSync(file)) break;
    check(engine.api.dataRead(`/px/usb/archive_${String(index).padStart(2, '0')}.dat`));
  }

  check(engine.api.extractFile('/px/usb', 'archive', '/dev_hdd0/game/BLUS31147/USRDIR/NEWFILE.BIN', '/px/scratch/new.bin'));
  const extractedNew = fs.readFileSync(path.join(scratch, 'new.bin'));
  assert.deepEqual(Buffer.from(extractedNew), newEbootPatch);

  check(engine.api.extractFile('/px/usb', 'archive', '/dev_hdd0/game/BLUS31147/USRDIR/EBOOT.BIN', '/px/scratch/eboot.bin'));
  const extractedOld = fs.readFileSync(path.join(scratch, 'eboot.bin'));
  assert.equal(crypto.createHash('sha256').update(extractedOld).digest('hex'), hashes.get('/dev_hdd0/game/BLUS31147/USRDIR/EBOOT.BIN'));

  fs.rmSync(tmp, { recursive: true, force: true });
});
