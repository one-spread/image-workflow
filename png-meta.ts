// Minimal PNG tEXt chunk read/write, used to keep editable annotation data
// inside "-edited.png" files. Text is stored as base64-encoded UTF-8 JSON so
// it stays within tEXt's Latin-1 character set.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface Chunk { type: string; start: number; end: number; dataStart: number; dataLength: number }

function chunks(bytes: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const end = pos + 12 + len;
    if (end > bytes.length) break;
    out.push({ type, start: pos, end, dataStart: pos + 8, dataLength: len });
    pos = end;
    if (type === 'IEND') break;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function encodeText(text: string): string {
  const utf8 = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < utf8.length; i += 0x8000) bin += String.fromCharCode(...Array.from(utf8.subarray(i, i + 0x8000)));
  return btoa(bin);
}

function decodeText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function readPngText(bytes: Uint8Array, keyword: string): string | null {
  if (!isPng(bytes)) return null;
  for (const c of chunks(bytes)) {
    if (c.type !== 'tEXt') continue;
    const data = bytes.subarray(c.dataStart, c.dataStart + c.dataLength);
    const sep = data.indexOf(0);
    if (sep < 0 || latin1(data.subarray(0, sep)) !== keyword) continue;
    try {
      return decodeText(latin1(data.subarray(sep + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

// Returns a copy of the PNG with a single tEXt chunk for `keyword` placed
// right after IHDR (any previous chunk with the same keyword is dropped).
export function writePngText(bytes: Uint8Array, keyword: string, text: string): Uint8Array {
  if (!isPng(bytes)) return bytes;
  const list = chunks(bytes);
  const ihdr = list.find((c) => c.type === 'IHDR');
  if (!ihdr) return bytes;

  const payload = latin1ToBytes(`${keyword}\0${encodeText(text)}`);
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(latin1ToBytes('tEXt'), 4);
  chunk.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));

  const keep = list.filter((c) => {
    if (c.type !== 'tEXt') return true;
    const data = bytes.subarray(c.dataStart, c.dataStart + c.dataLength);
    const sep = data.indexOf(0);
    return sep < 0 || latin1(data.subarray(0, sep)) !== keyword;
  });
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  keep.forEach((c) => {
    parts.push(bytes.subarray(c.start, c.end));
    if (c === ihdr) parts.push(chunk);
  });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  parts.forEach((p) => { out.set(p, off); off += p.length; });
  return out;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Private ancillary chunk holding raw bytes (e.g. the untouched original
// image). Inserted just before IEND, replacing any existing chunk of the type.
export function readPngChunk(bytes: Uint8Array, type: string): Uint8Array | null {
  if (!isPng(bytes)) return null;
  const c = chunks(bytes).find((ch) => ch.type === type);
  return c ? bytes.slice(c.dataStart, c.dataStart + c.dataLength) : null;
}

export function writePngChunk(bytes: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  if (!isPng(bytes) || type.length !== 4) return bytes;
  const list = chunks(bytes).filter((c) => c.type !== type);
  const iend = list.find((c) => c.type === 'IEND');
  if (!iend) return bytes;

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(latin1ToBytes(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  list.forEach((c) => {
    if (c === iend) parts.push(chunk);
    parts.push(bytes.subarray(c.start, c.end));
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  parts.forEach((p) => { out.set(p, off); off += p.length; });
  return out;
}
