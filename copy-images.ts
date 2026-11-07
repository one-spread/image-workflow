/** Local-only image processing for rich clipboard payloads. */
export const COPY_IMAGE_MAX_EDGE = 1200;
export const COPY_IMAGE_WARNING_BYTES = 5 * 1024 * 1024;
const IMAGE_LOAD_TIMEOUT_MS = 5000;

export interface PreparedCopyImage {
  src: string;
  bytes: number;
  width: number;
  height: number;
}

export function fitCopyImage(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, COPY_IMAGE_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Count decoded payload bytes, excluding the data URL/base64 overhead. */
export function imageDataBytes(src: string): number {
  const comma = src.indexOf(',');
  if (!/^data:/i.test(src) || comma < 0) return 0;
  const data = src.slice(comma + 1);
  if (/;base64$/i.test(src.slice(0, comma))) {
    const compact = data.replace(/\s/g, '');
    return Math.max(0, Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0));
  }
  try { return new Blob([decodeURIComponent(data)]).size; } catch { return 0; }
}

// Obsidian requestUrl has no cancellation API. A late result may finish in the
// background, but the resolved fallback cannot change or reach the caller's DOM.
/** Bound slow fetches/decodes without leaving timeout handles behind. */
export async function withCopyImageTimeout<T>(work: Promise<T>, fallback: T, timeoutMs = IMAGE_LOAD_TIMEOUT_MS, timerHost: Window = window): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = timerHost.setTimeout(() => resolve(fallback), timeoutMs); })]);
  } finally {
    if (timer !== undefined) timerHost.clearTimeout(timer);
  }
}

/** Remove reversible editing data before a PNG can leave the vault.
 * This is lossless for displayed pixels and also protects decode-failure fallbacks.
 */
export function stripPrivatePngData(src: string): string {
  if (!/^data:/i.test(src)) return src;
  const comma = src.indexOf(',');
  if (comma < 0) return '';
  let bytes: Uint8Array;
  try {
    // Data URLs may percent-encode either base64 characters or raw PNG bytes.
    const payload = src.slice(comma + 1).replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const binary = /;base64$/i.test(src.slice(0, comma)) ? atob(payload) : payload;
    bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  } catch { return ''; }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  // Non-PNG test/invalid sources cannot contain valid PNG editing chunks.
  if (bytes.length < 8 || !signature.every((b, i) => bytes[i] === b)) return src;
  const view = new DataView(bytes.buffer);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let foundEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return '';
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const zero = data.indexOf(0);
    const privateText = type === 'tEXt' && zero === 14 && [...'image-workflow'].every((ch, i) => data[i] === ch.charCodeAt(0));
    if (type !== 'iwOg' && !privateText) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { foundEnd = true; break; }
  }
  if (!foundEnd) return '';
  let binary = '';
  for (const part of parts) for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(binary);
}

/** Never load a remote URL into canvas: callers resolve it to local data first. */
export async function prepareCopyImage(src: string, doc: Document, rasterize = false, timeoutMs = IMAGE_LOAD_TIMEOUT_MS): Promise<PreparedCopyImage> {
  src = stripPrivatePngData(src);
  const fallback = { src, bytes: imageDataBytes(src), width: 0, height: 0 };
  if (!/^data:/i.test(src)) return fallback;
  const timerHost = doc.defaultView ?? window;
  const loader = doc.createElement('img');
  const loaded = await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: number;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      timerHost.clearTimeout(timer);
      loader.onload = null;
      loader.onerror = null;
      if (!ok) loader.removeAttribute('src');
      resolve(ok);
    };
    timer = timerHost.setTimeout(() => finish(false), timeoutMs);
    loader.onload = () => finish(true);
    loader.onerror = () => finish(false);
    loader.src = src;
  });
  if (!loaded) return fallback;
  const size = fitCopyImage(loader.naturalWidth, loader.naturalHeight);
  if (!size.width) {
    loader.removeAttribute('src');
    return fallback;
  }
  if (!rasterize && size.width === loader.naturalWidth && size.height === loader.naturalHeight) {
    loader.removeAttribute('src');
    return { ...fallback, ...size };
  }
  // Yield before synchronous canvas work; processing is also concurrency-limited by the caller.
  await new Promise<void>((resolve) => timerHost.setTimeout(resolve, 0));
  const canvas = doc.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback;
    ctx.drawImage(loader, 0, 0, size.width, size.height);
    // Keep alpha for PNG, WebP, SVG etc.; only known opaque JPEG input stays JPEG.
    const mime = /^data:image\/jpe?g[;,]/i.test(src) ? 'image/jpeg' : 'image/png';
    const output = canvas.toDataURL(mime, 0.9);
    if (!output.startsWith(`data:${mime}`)) return fallback;
    return { src: output, bytes: imageDataBytes(output), ...size };
  } catch {
    return fallback;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    loader.removeAttribute('src');
  }
}

export function copyImageSummary(count: number, bytes: number): string {
  const amount = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  return `Images: ${count} embedded, ${amount} total${bytes > COPY_IMAGE_WARNING_BYTES ? ' — warning: over 5 MB; pasting may be slow' : ''}`;
}
