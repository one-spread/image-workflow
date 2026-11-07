const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../copy-images.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
const moduleShim = { exports: {} };
const timerWindow = { setTimeout, clearTimeout };
new Function('module', 'exports', 'window', compiled)(moduleShim, moduleShim.exports, timerWindow);
const { fitCopyImage, imageDataBytes, prepareCopyImage, withCopyImageTimeout, copyImageSummary, stripPrivatePngData } = moduleShim.exports;

function fakeDocument({ width = 2400, height = 1600, fail = false, stalled = false, canvasFails = false } = {}) {
  const images = [];
  const calls = [];
  const doc = {
    defaultView: timerWindow,
    createElement(kind) {
      if (kind === 'img') {
        const image = {
          naturalWidth: width, naturalHeight: height, onload: null, onerror: null,
          removeAttribute(name) { calls.push(['remove', name]); },
          set src(value) {
            calls.push(['load', value]);
            if (!stalled) queueMicrotask(() => { if (fail) this.onerror?.(); else this.onload?.(); });
          },
        };
        images.push(image);
        return image;
      }
      assert.equal(kind, 'canvas');
      return {
        width: 0, height: 0,
        getContext() {
          if (canvasFails) return null;
          return { drawImage(_image, x, y, w, h) { calls.push(['draw', x, y, w, h]); } };
        },
        toDataURL(mime) { calls.push(['encode', mime]); return `data:${mime};base64,AQIDBA==`; },
      };
    },
  };
  return { doc, images, calls };
}

test('fits landscape, portrait, square and tiny images without upscaling', () => {
  assert.deepEqual(fitCopyImage(2400, 1600), { width: 1200, height: 800 });
  assert.deepEqual(fitCopyImage(1600, 2400), { width: 800, height: 1200 });
  assert.deepEqual(fitCopyImage(2400, 2400), { width: 1200, height: 1200 });
  assert.deepEqual(fitCopyImage(30, 20), { width: 30, height: 20 });
  assert.deepEqual(fitCopyImage(Infinity, 3), { width: 0, height: 0 });
});

test('counts decoded base64 and UTF-8 bytes', () => {
  assert.equal(imageDataBytes('data:image/png;base64,AQIDBA=='), 4);
  assert.equal(imageDataBytes('data:image/png;base64,AQI='), 2);
  assert.equal(imageDataBytes('data:image/png;base64,AQID'), 3);
  assert.equal(imageDataBytes('data:image/svg+xml,%E3%81%82'), 3);
  assert.equal(imageDataBytes('https://example.com/picture.png'), 0);
});

test('resizes transparent input to PNG with no background fill and counts output', async () => {
  const { doc, images, calls } = fakeDocument();
  const result = await prepareCopyImage('data:image/webp;base64,AQID', doc);
  assert.deepEqual(result, { src: 'data:image/png;base64,AQIDBA==', bytes: 4, width: 1200, height: 800 });
  assert.ok(calls.some((call) => call.join() === 'draw,0,0,1200,800'));
  assert.equal(images[0].onload, null);
  assert.equal(images[0].onerror, null);
});

test('keeps JPEG encoding for opaque JPEG input', async () => {
  const { doc, calls } = fakeDocument();
  await prepareCopyImage('data:image/jpeg;base64,AQID', doc);
  assert.ok(calls.some((call) => call.join() === 'encode,image/jpeg'));
});

test('preserves small images byte-for-byte without canvas re-encoding', async () => {
  const { doc, calls } = fakeDocument({ width: 320, height: 200 });
  const src = 'data:image/png;base64,AQID';
  const result = await prepareCopyImage(src, doc);
  assert.equal(result.src, src);
  assert.equal(result.width, 320);
  assert.equal(result.bytes, 3);
  assert.ok(!calls.some((call) => call[0] === 'draw'));
});

test('rasterizes SVG even below maximum dimensions', async () => {
  const { doc, calls } = fakeDocument({ width: 400, height: 200 });
  const result = await prepareCopyImage('data:image/svg+xml,%3Csvg%2F%3E', doc, true);
  assert.equal(result.src, 'data:image/png;base64,AQIDBA==');
  assert.ok(calls.some((call) => call.join() === 'draw,0,0,400,200'));
});

test('never loads remote or application URLs into canvas', async () => {
  const { doc, calls } = fakeDocument();
  for (const src of ['https://example.com/image.png', 'app://local/file.png', 'file:///tmp/file.png']) {
    assert.equal((await prepareCopyImage(src, doc)).src, src);
  }
  assert.deepEqual(calls, []);
});

test('failed decode and unavailable canvas preserve original bytes', async () => {
  const src = 'data:image/png;base64,AQID';
  for (const options of [{ fail: true }, { canvasFails: true }]) {
    const { doc, images } = fakeDocument(options);
    const result = await prepareCopyImage(src, doc);
    assert.equal(result.src, src);
    assert.equal(result.bytes, 3);
    assert.equal(images[0].onerror, null);
    assert.equal(images[0].onload, null);
  }
});

test('stalled image loading times out and detaches event handlers', async () => {
  const { doc, images, calls } = fakeDocument({ stalled: true });
  const src = 'data:image/png;base64,AQID';
  assert.equal((await prepareCopyImage(src, doc, false, 5)).src, src);
  assert.equal(images[0].onerror, null);
  assert.equal(images[0].onload, null);
  assert.ok(calls.some((call) => call.join() === 'remove,src'));
});

test('slow resolution returns fallback and success resolves normally', async () => {
  assert.equal(await withCopyImageTimeout(new Promise(() => {}), null, 5), null);
  assert.equal(await withCopyImageTimeout(Promise.resolve('ready'), null, 5), 'ready');
  await assert.rejects(withCopyImageTimeout(Promise.reject(new Error('failed')), null, 5));
});

test('warns only when final embedded payload exceeds 5 MiB', () => {
  assert.equal(copyImageSummary(1, 1024), 'Images: 1 embedded, 1.0 KB total');
  assert.ok(!copyImageSummary(2, 5 * 1024 * 1024).includes('warning'));
  assert.ok(copyImageSummary(2, 5 * 1024 * 1024 + 1).includes('warning: over 5 MB'));
});


test('late remote results cannot replace the timeout fallback', async () => {
  let complete;
  const work = new Promise((resolve) => { complete = resolve; });
  const result = await withCopyImageTimeout(work, null, 5, timerWindow);
  assert.equal(result, null);
  complete('data:image/png;base64,AQID');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(result, null);
});

test('uses the image document timer host and ignores late decode callbacks', async () => {
  const { doc, calls } = fakeDocument({ stalled: true });
  let lateLoad;
  let scheduled = 0;
  doc.defaultView = {
    setTimeout(callback, delay) { scheduled++; return setTimeout(callback, delay); },
    clearTimeout,
  };
  const create = doc.createElement;
  doc.createElement = (kind) => {
    const element = create(kind);
    if (kind === 'img') {
      Object.defineProperty(element, 'src', { set() { lateLoad = this.onload; } });
    }
    return element;
  };
  const result = await prepareCopyImage('data:image/png;base64,AQID', doc, false, 5);
  assert.equal(scheduled, 1);
  const callCount = calls.length;
  lateLoad();
  assert.equal(calls.length, callCount);
  assert.equal(result.width, 0);
});


test('private PNG edit chunks are removed even when image decoding fails', async () => {
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const makeChunk = (type, payload) => { const chunk = Buffer.alloc(payload.length + 12); chunk.writeUInt32BE(payload.length,0);chunk.write(type,4,4,'ascii');payload.copy(chunk,8);return chunk; };
  const edited = Buffer.concat([original.subarray(0,original.length-12),makeChunk('iwOg',Buffer.from('SECRET ORIGINAL')),makeChunk('tEXt',Buffer.from('image-workflow\0metadata')),original.subarray(original.length-12)]);
  const src='data:image/png;base64,'+edited.toString('base64');
  const cleaned=stripPrivatePngData(src);
  assert.deepEqual(Buffer.from(cleaned.split(',')[1],'base64'),original);
  const {doc}=fakeDocument({stalled:true});
  const result=await prepareCopyImage(src,doc,false,5);
  assert.equal(result.src,cleaned);
  assert.ok(!Buffer.from(result.src.split(',')[1],'base64').includes(Buffer.from('SECRET ORIGINAL')));
});


test('oversized PNG text keywords do not overflow the call stack', () => {
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const payload=Buffer.alloc(300001,65);payload[payload.length-1]=0;
  const chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length);chunk.write('tEXt',4);payload.copy(chunk,8);
  const data=Buffer.concat([original.subarray(0,original.length-12),chunk,original.subarray(original.length-12)]);
  assert.doesNotThrow(()=>stripPrivatePngData('data:image/png;base64,'+data.toString('base64')));
});
