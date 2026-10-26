// Unreal Engine 3 binary INI ("coalesced") reader/writer, ported from
// coalesced-inifier/ (see ../../coalesced-inifier/gow2 and gowenc).
// coalesced-inifier is GPL-3.0 licensed.
//
// The parser keeps the stored keys and values verbatim, so unpacking and
// repacking an untouched file reproduces its bytes. Only the section that
// points GDHttp at Arkham: Revived is added.

const SECTION_NAME = 'Default__GDHttp GDHttp';
const TARGET_INI = 'bmgame/config/ps3-bmnetvars.ini';
const SETTINGS = [
  ['TitleFileName', 'dummy.json'],
  ['Settings', '(BaseURL="http://arkhamrevived.kiwifruitdev.com/")'],
];

function normalizeInternalName(name) {
  const segments = name.replace(/\\/g, '/').split('/');
  const stack = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/').toLowerCase();
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  get remaining() {
    return this.bytes.length - this.offset;
  }

  u32() {
    if (this.offset + 4 > this.bytes.length) throw new Error('Unexpected end of coalesced file.');
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  string() {
    const rawLength = this.u32();
    if (rawLength === 0) return '';
    // The Go reader treats 0xFFFFFFFF as an empty string without consuming the
    // two-byte terminator, so keep the same behaviour for compatibility.
    if (rawLength === 0xFFFFFFFF) return '';
    const length = (~rawLength) >>> 0;
    if (length > 0x100000 || this.offset + length * 2 + 2 > this.bytes.length) {
      throw new Error('Invalid string length in coalesced file.');
    }
    let out = '';
    for (let index = 0; index < length; index++) {
      out += String.fromCharCode(this.view.getUint16(this.offset, true));
      this.offset += 2;
    }
    this.offset += 2;
    return out;
  }
}

export function parseCoalesced(bytes) {
  const reader = new Reader(bytes);
  const fileCount = reader.u32();
  if (fileCount > 20000) throw new Error(`Unreasonable coalesced file count (${fileCount}).`);
  const files = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const name = reader.string();
    const sectionCount = reader.u32();
    if (sectionCount > 10000) throw new Error(`Unreasonable section count for ${name}.`);
    const sections = [];
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
      const sectionName = reader.string();
      const valueCount = reader.u32();
      if (valueCount > 100000) throw new Error(`Unreasonable value count for ${sectionName}.`);
      const values = [];
      for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
        values.push({ key: reader.string(), value: reader.string() });
      }
      sections.push({ name: sectionName, values });
    }
    files.push({ name, sections });
  }
  return { files, tail: bytes.slice(reader.offset) };
}

function utf16String(text) {
  const units = text.length;
  if (units === 0) return new Uint8Array([0, 0, 0, 0]);
  const out = new Uint8Array(4 + units * 2 + 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, (~units) >>> 0);
  for (let index = 0; index < units; index++) view.setUint16(4 + index * 2, text.charCodeAt(index), true);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  number(value) {
    this.push(u32(value));
  }

  string(value) {
    this.push(utf16String(value));
  }

  bytesValue() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

export function writeCoalesced(coalesced) {
  const writer = new Writer();
  writer.number(coalesced.files.length);
  for (const file of coalesced.files) {
    writer.string(file.name);
    writer.number(file.sections.length);
    for (const section of file.sections) {
      writer.string(section.name);
      writer.number(section.values.length);
      for (const entry of section.values) {
        writer.string(entry.key);
        writer.string(entry.value);
      }
    }
  }
  if (coalesced.tail?.length) writer.push(coalesced.tail);
  return writer.bytesValue();
}

/**
 * Adds (or updates) the GDHttp redirect section at the top of every
 * PS3-BmNetVars.ini in a coalesced file.
 *
 * @returns {{changed: boolean, patched: string[]}}
 */
export function applyHttpRedirect(coalesced) {
  const patched = [];
  for (const file of coalesced.files) {
    if (normalizeInternalName(file.name) !== TARGET_INI) continue;
    let section = file.sections.find(item => item.name.toLowerCase() === SECTION_NAME.toLowerCase());
    if (!section) {
      section = { name: SECTION_NAME, values: [] };
      file.sections.unshift(section);
    }
    for (const [key, value] of SETTINGS) {
      const existing = section.values.find(item => item.key === key);
      if (existing) existing.value = value;
      else section.values.push({ key, value });
    }
    patched.push(file.name);
  }
  return { changed: patched.length > 0, patched };
}

/** Convenience wrapper used by the patcher for an in-memory COALESCED blob. */
export async function patchCoalescedBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parsed = parseCoalesced(bytes);
  const result = applyHttpRedirect(parsed);
  if (!result.changed) return { blob, changed: false, patched: [] };
  return { blob: new Blob([writeCoalesced(parsed)]), changed: true, patched: result.patched };
}

export function isCoalescedName(path) {
  return /^COALESCED_[A-Z0-9_]+\.BIN$/i.test(path.split('/').pop() ?? '');
}
