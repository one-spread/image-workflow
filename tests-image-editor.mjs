// Focused no-dependency regression tests. Run: node tests-image-editor.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const notices = [];
const writes = [];
let metadata;
let original;
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(new URL('./image-editor.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
class TFile {}
vm.runInNewContext(code, {
  module, exports: module.exports, console, AbortController, Uint8Array, Blob, URL,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  require: (name) => name === 'obsidian' ? { TFile, Notice: class { constructor(text) { notices.push(text); } } } : {
    readPngChunk: () => original, readPngText: () => metadata,
    writePngChunk: (bytes, key, value) => { original = value; return bytes; },
    writePngText: (bytes, key, value) => { metadata = value; return bytes; },
  },
});
const { ImageEditor } = module.exports;
class Canvas {
  constructor(w = 1, h = 1) { this.width = w; this.height = h; this.ctx = new Context(this); }
  getContext() { return this.ctx; }
  toDataURL() { this.encoded = { w: this.width, h: this.height, pixels: this.ctx.pixels.slice() }; return 'data:image/png;base64,AA=='; }
}
// Tiny grayscale canvas models pixel replacement, including transparent pixels.
class Context {
  constructor(canvas) { this.canvas = canvas; this.pixels = []; }
  save() {} restore() {} strokeRect() {} fillRect() {} strokeText() {} fillText() {}
  clearRect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.pixels[yy * this.canvas.width + xx] = 0;
  }
  drawImage(source, ...args) {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 4
      ? [0, 0, source.width, source.height, ...args] : args;
    const input = (source.ctx?.pixels ?? source.pixels).slice();
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const ix = Math.min(source.width - 1, Math.floor(sx + x * sw / dw));
      const iy = Math.min(source.height - 1, Math.floor(sy + y * sh / dh));
      this.pixels[(dy + y) * this.canvas.width + dx + x] = input[iy * source.width + ix];
    }
  }
}
const canvases = [];
const doc = { createElement: (kind) => { assert.equal(kind, 'canvas'); const c = new Canvas(); canvases.push(c); return c; } };
const file = Object.assign(new TFile(), { path: 'test.png', extension: 'png', name: 'test.png' });
const originalBytes = new Uint8Array([137, 80, 78, 71]);
const app = { vault: {
  modifyBinary: async (target, bytes) => writes.push({ target, bytes: new Uint8Array(bytes) }),
  readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
}, keymap: {} };
function make() {
  const editor = new ImageEditor({ app, doc, src: '', imageFile: file, notePath: null });
  editor.canvas = new Canvas(8, 6); editor.ctx = editor.canvas.ctx;
  editor.image = { width: 8, height: 6, pixels: Array.from({ length: 48 }, (_, i) => i + 1) };
  return editor;
}
const editor = make();
editor.shapes = [{ kind: 'mosaic', x: 0, y: 0, w: 4, h: 4, blockSize: 2 }];
editor.render(false);
assert.equal(editor.ctx.pixels[0], editor.ctx.pixels[1]);
assert.equal(editor.ctx.pixels[0], editor.ctx.pixels[8]);
assert.notEqual(editor.ctx.pixels[1], editor.image.pixels[1], 'mosaic changes the actual output pixels');
assert.equal(editor.ctx.pixels[7], editor.image.pixels[7], 'outside mosaic stays intact');
// A fractional drag must cover every touched pixel, including its far edges.
const fractional = make();
fractional.shapes = [{ kind: 'mosaic', x: 0.8, y: 0.8, w: 3.8, h: 3.8, blockSize: 8 }];
fractional.render(false);
assert.equal(fractional.ctx.pixels[4], fractional.ctx.pixels[0], 'fractional right edge is covered');
assert.equal(fractional.ctx.pixels[4 * 8], fractional.ctx.pixels[0], 'fractional bottom edge is covered');
assert.equal(fractional.ctx.pixels[4 * 8 + 4], fractional.ctx.pixels[0], 'fractional bottom-right pixel is covered');
assert.equal(fractional.ctx.pixels[5], fractional.image.pixels[5], 'pixel beyond the selected right edge stays intact');
assert.equal(fractional.ctx.pixels[5 * 8], fractional.image.pixels[5 * 8], 'pixel beyond the selected bottom edge stays intact');

editor.shapes.push({ kind: 'crop', x: 2, y: 1, w: 4, h: 3 });
editor.toPngBytes();
assert.deepEqual({ w: canvases.filter((c) => c.encoded).at(-1).width, h: canvases.filter((c) => c.encoded).at(-1).height }, { w: 4, h: 3 });
assert.equal(editor.canvas.width, 8, 'export must not mutate working dimensions');
editor.draft = { kind: 'crop', x: 0, y: 0, w: 1, h: 1 };
editor.toPngBytes();
assert.equal(canvases.filter((c) => c.encoded).at(-1).width, 4, 'export excludes unfinished crop draft');
editor.draft = null;
editor.shapes.push({ kind: 'crop', x: 1, y: 2, w: 2, h: 2 });
assert.equal(editor.activeCrop().x, 1);
editor.undo(); assert.equal(editor.activeCrop().x, 2, 'undo restores previous crop');
editor.undo(); assert.equal(editor.activeCrop(), null);
editor.undo(); assert.equal(editor.shapes.length, 0);
editor.render(false); assert.deepEqual(editor.ctx.pixels, editor.image.pixels);

editor.shapes = [{ kind: 'crop', x: 2, y: 1, w: 4, h: 3 }];
editor.originalBytes = originalBytes; editor.overwriteFile = file;
await editor.save();
const savedMeta = JSON.parse(metadata);
assert.equal(savedMeta.w, 8); assert.equal(savedMeta.h, 6);
assert.equal(savedMeta.v, 2); assert.equal(savedMeta.shapes[0].x, 2);
assert.deepEqual(original, originalBytes, 'saving retains exact original bytes');
const reopened = make();
await reopened.resolveSession();
assert.equal(reopened.pendingShapes.w, 8, 'reopen scales against original, not cropped dimensions');
reopened.shapes = reopened.pendingShapes.shapes;
reopened.toPngBytes();
assert.equal(canvases.filter((c) => c.encoded).at(-1).width, 4); assert.equal(canvases.filter((c) => c.encoded).at(-1).height, 3);
await reopened.revert();
assert.deepEqual(writes.at(-1).bytes, originalBytes, 'Revert restores exact original bytes');

// Legacy v1 metadata continues to resolve the separate source.
metadata = JSON.stringify({ v: 1, source: 'source.jpg', w: 8, h: 6, shapes: [{ kind: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#fff', width: 3 }] });
original = null;
const source = Object.assign(new TFile(), { path: 'source.jpg', extension: 'jpg' });
app.vault.getAbstractFileByPath = () => source;
const legacy = make(); await legacy.resolveSession();
assert.equal(legacy.baseFile, source); assert.equal(legacy.pendingShapes.shapes[0].kind, 'rect');
legacy.close();
console.log('Image editor: mosaic pixels, crop export, undo, metadata roundtrip, original preservation, Revert and legacy v1 passed.');
