// Applies the extracted title update to a PS3 Backup Utility archive.
//
// The whole update is appended to the end of the data archive and the index
// entries of the files it replaces are unlinked (renamed to a path that cannot
// exist). That keeps the write incremental: only the last chunk and the new
// chunks are produced, and no existing file has to be read.

import { CHUNK_CAP, chunkName, layoutArchive, planArchive } from './layout.js';
import { applyIndex, beginIndex, closeIndex, writePlanChunks } from './writer.js';

const FILE_MODE = 0x81b6;
const DIR_MODE = 0x41ff;

function normalizePath(path) {
  const stack = [];
  for (const segment of String(path ?? '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

function dirName(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function seconds(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value ?? Date.now()).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : Math.floor(Date.now() / 1000);
}

/** Lists archive_*.dat sizes, stopping at the first gap like the PS3 does. */
export async function listChunkSizes(dirHandle, prefix = 'archive') {
  const sizes = [];
  for (let index = 0; index < 10000; index++) {
    try {
      const handle = await dirHandle.getFileHandle(chunkName(prefix, index));
      sizes.push((await handle.getFile()).size);
    } catch {
      break;
    }
  }
  return sizes;
}

/** Reads archive.dat and computes where every entry lives. */
export async function readBackup({ engine, dirHandle, onProgress } = {}) {
  if (!dirHandle) throw new Error('Select the PS3 backup folder first.');
  await engine.setRoot('usb', dirHandle);
  onProgress?.('Reading archive.dat');
  const index = await engine.rpc('listIndex', { path: '/px/usb/archive.dat' });
  onProgress?.('Mapping data chunks');
  const chunkSizes = await listChunkSizes(dirHandle, 'archive');
  const layout = layoutArchive(
    index.files.map(file => ({ path: file.path, size: file.size, mode: file.mode, mtime: file.mtime, flags: file.flags })),
    chunkSizes,
  );
  return { index, chunkSizes, layout };
}

/**
 * Builds the incremental write plan for the title update.
 *
 * Existing entries that the update overwrites are unlinked instead of erased,
 * so only the tail of the archive is rewritten.
 */
export function planGamePatch({ index, layout, files, gameRoot }) {
  const normalizedRoot = normalizePath(gameRoot);
  const byPath = new Map();
  for (const file of files) byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) });
  const updates = [...byPath.values()];
  const updatePaths = new Set(updates.map(file => file.path));
  const now = new Date();

  const treeFiles = [];
  const unlink = new Set();
  for (const entry of index.files) {
    if (updatePaths.has(entry.path)) {
      unlink.add(entry.path);
      continue;
    }
    treeFiles.push({
      path: entry.path,
      size: entry.size,
      node: {
        type: 'file',
        size: entry.size,
        mode: entry.mode,
        mtime: new Date(entry.mtime * 1000),
        content: { kind: 'archive', prefix: 'archive', srcPath: entry.path },
      },
    });
  }

  for (const file of updates) {
    treeFiles.push({
      path: file.path,
      size: file.size,
      node: {
        type: 'file',
        size: file.size,
        mode: FILE_MODE,
        mtime: now,
        content: { kind: 'blob', blob: file.blob },
      },
    });
  }

  const plan = planArchive({
    prefix: 'archive',
    index: index.files.map(file => ({ path: file.path, size: file.size, mode: file.mode, mtime: file.mtime, flags: file.flags })),
    layout,
    treeFiles,
    unlink,
    chunkCap: CHUNK_CAP,
  });
  plan.id = index.id;
  plan.archiveType = index.archiveType;
  plan.gameRoot = normalizedRoot;
  plan.updateFiles = updates;
  plan.replaced = [...unlink];
  return plan;
}

/** Rebuilds the directory table, adding the parents of the new files. */
export function buildDirectories(index, files, gameRoot, { tombstones = false } = {}) {
  const now = seconds(new Date());
  const dirs = new Map();
  for (const dir of index.dirs) {
    dirs.set(dir.path, { path: dir.path, mode: dir.mode, mtime: dir.mtime, flags: dir.flags });
  }
  dirs.set(normalizePath(gameRoot), {
    path: normalizePath(gameRoot),
    mode: DIR_MODE,
    mtime: now,
    flags: 1,
  });
  // Unlinked entries are renamed under this folder; the restore needs the
  // directory entry to be present for their paths to be valid.
  if (tombstones) {
    const tombstone = '/dev_hdd0/.ps3xport-unlinked';
    if (!dirs.has(tombstone)) dirs.set(tombstone, { path: tombstone, mode: DIR_MODE, mtime: now, flags: 1 });
  }
  for (const file of files) {
    let parent = dirName(file.path);
    while (parent !== '/' && !dirs.has(parent)) {
      dirs.set(parent, { path: parent, mode: DIR_MODE, mtime: now, flags: 1 });
      parent = dirName(parent);
    }
  }
  return [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes the plan into a staging folder. Chromium folder installs then copy
 * the staged files over the backup; other browsers download them.
 */
export async function writePatch({
  engine,
  plan,
  dirs,
  outDirHandle,
  outRoot = 'out',
  archive2Size = null,
  onProgress,
  onChunk,
  shouldCancel,
}) {
  await engine.setRoot(outRoot, outDirHandle);
  const opened = await beginIndex({ engine, open: '/px/usb/archive.dat' });
  try {
    await writePlanChunks({
      plan,
      idHex: opened.id,
      archiveType: plan.archiveType,
      engine,
      base: `/px/${outRoot}`,
      sourceBase: '/px/usb',
      materialize: async node => node.content.blob,
      shouldCancel,
      onChunkStart: info => onChunk?.(info),
    });
    onProgress?.('Writing archive.dat');
    await applyIndex({
      plan,
      engine,
      saveTo: `/px/${outRoot}/archive.dat`,
      dirs,
      archive2Size,
    });
  } finally {
    await closeIndex(engine);
  }
  const lastProduced = plan.rewrites.length
    ? plan.rewrites[plan.rewrites.length - 1].index + 1
    : 0;
  return {
    chunkNames: plan.rewrites.map(chunk => chunkName(plan.prefix, chunk.index)),
    deleteChunks: plan.deleteChunks.map(index => chunkName(plan.prefix, index)),
    newChunkCount: plan.structural
      ? lastProduced
      : Math.max(plan.layout.chunkCount, lastProduced),
  };
}
