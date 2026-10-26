// PS3 NPDRM PKG reader, ported from PyKG (see ../../PyKG/PyKG.py).
// PyKG is MIT licensed, Copyright (C) 2026 Aphelion.
//
// Only what a retail title update needs is implemented: the header, the
// AES-CTR item table, PARAM.SFO and the file payloads. Everything stays in
// browser memory; nothing is written to disk.

const PKG_MAGIC = 0x7f504b47; // "\x7fPKG"
const PKG_TYPE_PS3 = 0x0001;
const PKG_RELEASE_TYPE_RELEASE = 0x8000;
const PS3_NPDRM_KEY = new Uint8Array([
  0x2e, 0x7b, 0x71, 0xd7, 0xc9, 0xc9, 0xa1, 0x4e,
  0xa3, 0x22, 0x1f, 0x18, 0x88, 0x28, 0xb8, 0xf8,
]);

export const PKG_HEADER_SIZE = 0x80;
export const PKG_ITEM_SIZE = 0x20;
const FLAG_DIR = 0x04;
const DECRYPT_CHUNK = 8 * 1024 * 1024;

let importedKey = null;

function key() {
  importedKey ??= crypto.subtle.importKey('raw', PS3_NPDRM_KEY, 'AES-CTR', false, ['decrypt']);
  return importedKey;
}

function ascii(bytes) {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out.replace(/\0+$/, '');
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function counterFor(iv, blockIndex) {
  const mask = (1n << 128n) - 1n;
  return bigIntToBytes((bytesToBigInt(iv) + BigInt(blockIndex)) & mask, 16);
}

export async function readPkgHeader(blob) {
  const raw = new Uint8Array(await blob.slice(0, PKG_HEADER_SIZE).arrayBuffer());
  if (raw.length < PKG_HEADER_SIZE) throw new Error('This file is too small to be a PKG.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0);
  if (magic !== PKG_MAGIC) throw new Error('This is not a PS3 PKG file.');
  const releaseType = view.getUint16(4);
  const pkgType = view.getUint16(6);
  if (pkgType !== PKG_TYPE_PS3) throw new Error('This PKG is not a PS3 package.');
  if (releaseType !== PKG_RELEASE_TYPE_RELEASE) {
    throw new Error('Debug PKGs are not supported. Use the retail title update from the list.');
  }

  return {
    releaseType,
    itemCount: view.getUint32(20),
    totalSize: Number(view.getBigUint64(24)),
    dataOffset: Number(view.getBigUint64(32)),
    dataSize: Number(view.getBigUint64(40)),
    contentId: ascii(raw.subarray(0x30, 0x60)),
    qaDigest: raw.slice(0x60, 0x70),
    iv: raw.slice(0x70, 0x80),
  };
}

async function decryptAligned(blob, header, streamPosition, size) {
  if (size <= 0) return new Uint8Array(0);
  const blockStart = streamPosition - (streamPosition % 16);
  const prefix = streamPosition - blockStart;
  const wanted = prefix + size;
  const blockCount = Math.ceil(wanted / 16);
  const start = header.dataOffset + blockStart;
  const cipher = new Uint8Array(await blob.slice(start, start + blockCount * 16).arrayBuffer());
  const usable = Math.min(cipher.length, blockCount * 16);
  const counter = counterFor(header.iv, blockStart / 16);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter, length: 128 },
    await key(),
    cipher.subarray(0, usable),
  ));
  return plain.subarray(prefix, prefix + size);
}

/** Decrypts and concatenates a payload without buffering the whole item. */
async function decryptPayload(blob, header, offset, size, onBytes) {
  const parts = [];
  let done = 0;
  while (done < size) {
    const length = Math.min(DECRYPT_CHUNK, size - done);
    parts.push(await decryptAligned(blob, header, offset + done, length));
    done += length;
    onBytes?.(length);
  }
  return parts.length === 1 ? parts[0] : new Blob(parts);
}

function parseSfo(bytes) {
  if (bytes.length < 0x14 || bytes[0] !== 0 || bytes[1] !== 0x50 || bytes[2] !== 0x53 || bytes[3] !== 0x46) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyTable = view.getUint32(8, true);
  const dataTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const result = {};
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    const entry = 0x14 + index * 0x10;
    if (entry + 0x10 > bytes.length) break;
    const keyOffset = view.getUint16(entry, true);
    const size = view.getUint32(entry + 4, true);
    const dataOffset = view.getUint32(entry + 12, true);
    const keyStart = keyTable + keyOffset;
    let keyEnd = keyStart;
    while (keyEnd < bytes.length && bytes[keyEnd] !== 0) keyEnd++;
    const name = decoder.decode(bytes.subarray(keyStart, keyEnd));
    const valueStart = dataTable + dataOffset;
    const raw = bytes.subarray(valueStart, valueStart + size);
    const value = decoder.decode(raw).replace(/\0+$/, '');
    if (name === 'TITLE_ID' || name === 'APP_VER' || name === 'TITLE') result[name] = value;
  }
  return result.TITLE_ID ? result : null;
}

function decodeName(bytes) {
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes)
    .replace(/\0+$/, '');
}

function resolveItemPath(name, titleId) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return null;
  const segments = clean.split('/');
  const rootRelative = /^(dev_hdd0|dev_flash|dev_flash2)\//i.test(clean);
  const stack = rootRelative ? [] : `/dev_hdd0/game/${titleId}`.split('/').filter(Boolean);
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (!stack.length) return null;
  const resolved = `/${stack.join('/')}`;
  return resolved.startsWith('/dev_hdd0/') || resolved.startsWith('/dev_flash') ? resolved : null;
}

/**
 * Extracts every file of a PKG.
 *
 * @param {Blob} blob
 * @param {{onProgress?: (done: number, total: number) => void, shouldCancel?: () => boolean}} options
 * @returns {Promise<{titleId: string, appVer: string, title: string, files: {path: string, blob: Blob, size: number}[]}>}
 */
export async function extractPkg(blob, { onProgress, shouldCancel } = {}) {
  const header = await readPkgHeader(blob);
  if (header.itemCount === 0 || header.itemCount > 100000) {
    throw new Error('This PKG has an unreasonable item count; it may be corrupt.');
  }

  const table = await decryptAligned(blob, header, 0, header.itemCount * PKG_ITEM_SIZE);
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const items = [];
  for (let index = 0; index < header.itemCount; index++) {
    const base = index * PKG_ITEM_SIZE;
    items.push({
      nameOffset: view.getUint32(base),
      nameSize: view.getUint32(base + 4),
      dataOffset: Number(view.getBigUint64(base + 8)),
      dataSize: Number(view.getBigUint64(base + 16)),
      flags: view.getUint32(base + 24),
    });
  }

  const names = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.nameSize > 0) {
      const raw = await decryptAligned(blob, header, item.nameOffset, item.nameSize);
      names.push(decodeName(raw));
    } else {
      names.push('');
    }
    onProgress?.({ phase: 'names', done: index + 1, total: items.length });
    if (shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
  }

  let titleId = null;
  let appVer = '';
  let title = '';
  for (let index = 0; index < items.length; index++) {
    if (!/PARAM\.SFO$/i.test(names[index])) continue;
    const sfo = await decryptPayload(blob, header, items[index].dataOffset, items[index].dataSize);
    const parsed = parseSfo(sfo instanceof Blob ? new Uint8Array(await sfo.arrayBuffer()) : sfo);
    if (parsed) {
      titleId = parsed.TITLE_ID;
      appVer = parsed.APP_VER ?? '';
      title = parsed.TITLE ?? '';
      break;
    }
  }
  if (!titleId) throw new Error('PARAM.SFO is missing or has no TITLE_ID; this PKG cannot be installed.');

  const payloadBytes = items.reduce((sum, item) => sum + ((item.flags & FLAG_DIR) ? 0 : item.dataSize), 0);
  const files = [];
  let done = 0;
  onProgress?.({ phase: 'data', done: 0, total: Math.max(1, payloadBytes) });
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!names[index] || (item.flags & FLAG_DIR)) continue;
    const path = resolveItemPath(names[index], titleId);
    if (!path) continue;
    const payload = await decryptPayload(blob, header, item.dataOffset, item.dataSize, length => {
      done += length;
      onProgress?.({ phase: 'data', done, total: Math.max(1, payloadBytes) });
    });
    files.push({
      path,
      blob: payload instanceof Blob ? payload : new Blob([payload]),
      size: item.dataSize,
    });
    if (shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
  }

  return { titleId, appVer, title, files, header };
}

/** Downloads a PKG with progress. `onProgress(done, total)` gets byte counts. */
export async function downloadPkg(url, { onProgress, shouldCancel, signal, expectedSize = 0 } = {}) {
  const response = await fetch(url, { signal, cache: 'force-cache' });
  if (!response.ok) throw new Error(`The patch download failed (HTTP ${response.status}).`);
  const length = Number(response.headers.get('content-length') ?? 0) || expectedSize;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength || length);
    return new Blob([buffer], { type: 'application/octet-stream' });
  }

  const reader = response.body.getReader();
  const parts = [];
  let done = 0;
  try {
    for (;;) {
      if (shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
      const { done: finished, value } = await reader.read();
      if (finished) break;
      parts.push(value);
      done += value.byteLength;
      onProgress?.(done, length || done);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
