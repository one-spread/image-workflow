// Image editor shown from the overlay: box, arrow, text, mosaic and crop
// with undo. Crop metadata uses the uncropped working-image coordinates.
//
// PNG images are saved in place: the file is overwritten with the annotated
// image, and the untouched original plus the shapes are kept inside it
// (private PNG chunk + tEXt). Editing it again shows the original with every
// shape still editable, and "Revert" restores the original bytes exactly.
// Other formats (and "-edited.png" files from earlier versions) are saved as
// "<name>-edited.png" next to the source, with embeds in the note relinked.

import { App, Notice, Scope, TFile } from 'obsidian';
import { readPngChunk, readPngText, writePngChunk, writePngText } from './png-meta';

const META_KEY = 'image-workflow';
// Private, ancillary, safe-to-copy chunk with the original file's bytes.
const ORIGINAL_CHUNK = 'iwOg';

interface EditMeta {
  v: 1 | 2;
  // v1: path of the original image (separate "-edited.png" file).
  // v2: absent; the original lives in the ORIGINAL_CHUNK of the same file.
  source?: string;
  // Full working-image dimensions, even when the exported PNG is cropped.
  w: number;
  h: number;
  shapes: Shape[];
}

type Tool = 'rect' | 'arrow' | 'text' | 'mosaic' | 'crop';

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
  | { kind: 'mosaic'; x: number; y: number; w: number; h: number; blockSize: number }
  | { kind: 'crop'; x: number; y: number; w: number; h: number };

const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#000000', '#ffffff'];
const MAX_CANVAS_DIM = 8192;
const MIN_DRAG = 4;

export interface ImageEditorOptions {
  app: App;
  doc: Document;
  src: string;
  imageFile: TFile | null;
  notePath: string | null;
}

export class ImageEditor {
  private root: HTMLDivElement | null = null;
  private stage!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private image!: HTMLImageElement;
  private shapes: Shape[] = [];
  private draft: Shape | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private tool: Tool = 'rect';
  private color = COLORS[0];
  private scope: Scope | null = null;
  private abort = new AbortController();
  private textInput: HTMLInputElement | null = null;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private swatches: HTMLButtonElement[] = [];
  private escArmedUntil = 0;
  private busy = false;
  private objectUrl: string | null = null;
  // Session: the image drawn underneath, the file to overwrite on save (an
  // existing "-edited.png"), and the file whose embeds should point to the result.
  private baseFile: TFile | null = null;
  private overwriteFile: TFile | null = null;
  private relinkFrom: TFile | null = null;
  // In-place mode: original bytes to keep inside the saved PNG.
  private originalBytes: Uint8Array | null = null;
  private revertBtn: HTMLButtonElement | null = null;
  private hasEmbeddedOriginal = false;
  private pendingShapes: { shapes: Shape[]; w: number; h: number } | null = null;

  constructor(private readonly o: ImageEditorOptions) {}

  open(): void {
    const { doc } = this.o;
    const signal = this.abort.signal;

    const root = doc.createElement('div');
    root.addClass('image-workflow-editor');
    this.root = root;

    const toolbar = root.createDiv({ cls: 'image-workflow-editor-toolbar' });
    const toolGroup = toolbar.createDiv({ cls: 'image-workflow-editor-group' });
    ([['rect', 'Box'], ['arrow', 'Arrow'], ['text', 'Text'], ['mosaic', 'Mosaic'], ['crop', 'Crop']] as [Tool, string][]).forEach(([tool, label]) => {
      const btn = toolGroup.createEl('button', { text: label, cls: 'image-workflow-editor-btn' });
      btn.addEventListener('click', () => this.setTool(tool), { signal });
      this.toolButtons.set(tool, btn);
    });

    const colorGroup = toolbar.createDiv({ cls: 'image-workflow-editor-group' });
    COLORS.forEach((c) => {
      const sw = colorGroup.createEl('button', { cls: 'image-workflow-editor-swatch', attr: { 'aria-label': c } });
      sw.style.setProperty('--swatch-color', c);
      sw.addEventListener('click', () => this.setColor(c), { signal });
      this.swatches.push(sw);
    });

    toolbar.createSpan({ cls: 'image-workflow-editor-share-hint', text: 'Save keeps a recoverable original. Use Copy to share a flattened image.' });

    const actionGroup = toolbar.createDiv({ cls: 'image-workflow-editor-group' });
    const undoBtn = actionGroup.createEl('button', { text: 'Undo', cls: 'image-workflow-editor-btn' });
    undoBtn.addEventListener('click', () => this.undo(), { signal });

    const outGroup = toolbar.createDiv({ cls: 'image-workflow-editor-group' });
    const revertBtn = outGroup.createEl('button', { text: 'Revert', cls: 'image-workflow-editor-btn' });
    revertBtn.title = 'Restore the original image (removes all annotations)';
    revertBtn.hide();
    revertBtn.addEventListener('click', () => void this.revert(), { signal });
    this.revertBtn = revertBtn;
    const cancelBtn = outGroup.createEl('button', { text: 'Cancel', cls: 'image-workflow-editor-btn' });
    const copyBtn = outGroup.createEl('button', { text: 'Copy', cls: 'image-workflow-editor-btn' });
    const saveBtn = outGroup.createEl('button', { text: 'Save', cls: 'image-workflow-editor-btn mod-cta' });
    if (!this.o.imageFile) {
      saveBtn.disabled = true;
      saveBtn.title = 'Only images stored in the vault can be saved. Use Copy instead.';
    }
    cancelBtn.addEventListener('click', () => this.close(), { signal });
    copyBtn.addEventListener('click', () => void this.copy(), { signal });
    saveBtn.addEventListener('click', () => void this.save(), { signal });

    this.stage = root.createDiv({ cls: 'image-workflow-editor-stage' });
    this.canvas = this.stage.createEl('canvas', { cls: 'image-workflow-editor-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      new Notice('Canvas is not available');
      return;
    }
    this.ctx = ctx;

    doc.body.appendChild(root);
    this.setTool('rect');
    this.setColor(COLORS[0]);
    this.registerKeys();
    void this.loadImage();

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal });
    this.canvas.addEventListener('pointercancel', () => { this.draft = null; this.dragStart = null; this.render(); }, { signal });
  }

  close(): void {
    this.abort.abort();
    if (this.scope) this.o.app.keymap.popScope(this.scope);
    this.scope = null;
    this.root?.remove();
    this.root = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  // ---- setup ----

  // Decide what to edit. Images are read through a same-origin blob: URL:
  // vault files are served from app://<id>/..., a different origin than the
  // window, and drawing them directly would taint the canvas (no export).
  private async resolveSession(): Promise<string> {
    const { app, imageFile: clicked } = this.o;
    if (!clicked) return this.o.src;

    const isPng = clicked.extension.toLowerCase() === 'png';
    const clickedBytes = new Uint8Array(await app.vault.readBinary(clicked));
    const meta = isPng ? parseMeta(readPngText(clickedBytes, META_KEY)) : null;
    const embedded = isPng ? readPngChunk(clickedBytes, ORIGINAL_CHUNK) : null;

    if (meta && embedded) {
      // Edited in place before: original is inside the file.
      this.overwriteFile = clicked;
      this.originalBytes = embedded;
      this.hasEmbeddedOriginal = true;
      this.pendingShapes = { shapes: meta.shapes, w: meta.w, h: meta.h };
      this.revertBtn?.show();
      return this.blobUrl(embedded, 'png');
    }

    if (meta && meta.source) {
      // "-edited.png" from an earlier version: keep editing that copy.
      const source = app.vault.getAbstractFileByPath(meta.source);
      if (source instanceof TFile) {
        this.baseFile = source;
        this.overwriteFile = clicked;
        this.pendingShapes = { shapes: meta.shapes, w: meta.w, h: meta.h };
        return this.blobUrl(new Uint8Array(await app.vault.readBinary(source)), source.extension);
      }
      new Notice('Original image not found — editing the flattened image');
    }

    if (isPng) {
      // Plain PNG: edit in place, keeping its current bytes as the original.
      this.overwriteFile = clicked;
      this.originalBytes = clickedBytes;
      return this.blobUrl(clickedBytes, 'png');
    }

    // Other formats: write "<name>-edited.png" and relink embeds.
    this.baseFile = clicked;
    this.relinkFrom = clicked;
    return this.blobUrl(clickedBytes, clicked.extension);
  }

  private blobUrl(bytes: Uint8Array, ext: string): string {
    const e = ext.toLowerCase();
    const type = e === 'svg' ? 'image/svg+xml' : `image/${e === 'jpg' ? 'jpeg' : e}`;
    this.objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
    return this.objectUrl;
  }

  private async loadImage(): Promise<void> {
    const img = this.o.doc.createElement('img');
    let src: string;
    try {
      src = await this.resolveSession();
    } catch (err) {
      console.error('Image Workflow: failed to read image', err);
      new Notice('Failed to load image for editing');
      this.close();
      return;
    }
    if (!this.o.imageFile && !/^(file|data|blob):/.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
        const s = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h);
        w = Math.floor(w * s);
        h = Math.floor(h * s);
      }
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = img;
      if (this.pendingShapes) {
        this.shapes = scaleShapes(this.pendingShapes.shapes, w / this.pendingShapes.w, h / this.pendingShapes.h);
        this.pendingShapes = null;
      }
      this.render();
    };
    img.onerror = () => {
      new Notice('Failed to load image for editing');
      this.close();
    };
    img.src = src;
  }

  private registerKeys(): void {
    const scope = new Scope();
    scope.register(null, 'Escape', () => { this.onEscape(); return false; });
    // While typing a label, let the text field handle its own undo / copy.
    scope.register(['Mod'], 'z', () => { if (this.textInput) return true; this.undo(); return false; });
    scope.register(['Mod'], 'c', () => { if (this.textInput) return true; void this.copy(); return false; });
    scope.register(['Mod'], 's', () => { void this.save(); return false; });
    this.scope = scope;
    this.o.app.keymap.pushScope(scope);
  }

  private setTool(tool: Tool): void {
    this.commitText();
    this.tool = tool;
    this.toolButtons.forEach((btn, t) => btn.toggleClass('is-active', t === tool));
    this.canvas.toggleClass('is-text', tool === 'text');
  }

  private setColor(color: string): void {
    this.color = color;
    this.swatches.forEach((sw) => sw.toggleClass('is-active', sw.getAttribute('aria-label') === color));
    if (this.textInput) this.textInput.style.color = color;
  }

  // ---- geometry ----

  private get base(): number {
    return Math.max(this.canvas.width, this.canvas.height);
  }

  private get lineWidth(): number {
    return Math.max(3, Math.round(this.base / 250));
  }

  private get fontSize(): number {
    return Math.max(18, Math.round(this.base / 32));
  }

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.canvas.width, (e.clientX - rect.left) * (this.canvas.width / rect.width))),
      y: Math.max(0, Math.min(this.canvas.height, (e.clientY - rect.top) * (this.canvas.height / rect.height))),
    };
  }

  // ---- pointer handling ----

  private onPointerDown(e: PointerEvent): void {
    if (!this.image || e.button !== 0) return;
    e.preventDefault();
    const p = this.toCanvas(e);
    if (this.tool === 'text') {
      this.commitText();
      this.openTextInput(e, p);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.dragStart = p;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragStart) return;
    const p = this.toCanvas(e);
    const s = this.dragStart;
    const box = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    if (this.tool === 'crop') this.draft = { kind: 'crop', ...box };
    else if (this.tool === 'mosaic') this.draft = { kind: 'mosaic', ...box, blockSize: Math.max(8, Math.round(this.base / 80)) };
    else if (this.tool === 'rect') this.draft = { kind: 'rect', ...box, color: this.color, width: this.lineWidth };
    else this.draft = { kind: 'arrow', x1: s.x, y1: s.y, x2: p.x, y2: p.y, color: this.color, width: this.lineWidth };
    this.render();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragStart) return;
    this.onPointerMove(e);
    const d = this.draft;
    const big = d && ((d.kind === 'rect' || d.kind === 'mosaic' || d.kind === 'crop') ? d.w > MIN_DRAG && d.h > MIN_DRAG
      : d.kind === 'arrow' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > MIN_DRAG * 2 : false);
    if (d && big) this.shapes.push(d);
    this.draft = null;
    this.dragStart = null;
    this.render();
  }

  private openTextInput(e: PointerEvent, p: { x: number; y: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    const stageRect = this.stage.getBoundingClientRect();
    const scale = rect.width / this.canvas.width;
    const input = this.stage.createEl('input', { type: 'text', cls: 'image-workflow-editor-text' });
    input.style.left = `${e.clientX - stageRect.left}px`;
    input.style.top = `${e.clientY - stageRect.top}px`;
    input.style.fontSize = `${Math.max(12, this.fontSize * scale)}px`;
    input.style.color = this.color;
    input.dataset.x = String(p.x);
    input.dataset.y = String(p.y);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        this.commitText();
      }
    });
    input.addEventListener('blur', () => this.commitText());
    this.textInput = input;
    input.focus();
    (this.o.doc.defaultView ?? window).setTimeout(() => input.focus(), 0);
  }

  private commitText(): void {
    const input = this.textInput;
    if (!input) return;
    this.textInput = null;
    const text = input.value.trim();
    if (text) {
      this.shapes.push({
        kind: 'text', x: Number(input.dataset.x), y: Number(input.dataset.y),
        text, color: this.color, size: this.fontSize,
      });
    }
    input.remove();
    this.render();
  }

  private onEscape(): void {
    if (this.textInput) {
      this.textInput.value = '';
      this.commitText();
      return;
    }
    if (this.shapes.length === 0 || Date.now() < this.escArmedUntil) {
      this.close();
      return;
    }
    this.escArmedUntil = Date.now() + 2000;
    new Notice('Press Esc again to discard your edits');
  }

  private undo(): void {
    this.shapes.pop();
    this.render();
  }

  // ---- drawing ----

  private render(preview = true): void {
    if (!this.image) return;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);
    this.shapes.forEach((s) => this.drawShape(s));
    if (preview && this.draft) this.drawShape(this.draft);
    // Cropping never changes the working coordinate space. Only export crops
    // pixels; metadata remains relative to the original-sized working canvas.
    const crop = preview ? this.activeCrop() : null;
    if (crop) {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(0, 0, canvas.width, crop.y);
      ctx.fillRect(0, crop.y + crop.h, canvas.width, canvas.height - crop.y - crop.h);
      ctx.fillRect(0, crop.y, crop.x, crop.h);
      ctx.fillRect(crop.x + crop.w, crop.y, canvas.width - crop.x - crop.w, crop.h);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = this.lineWidth;
      ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
      ctx.restore();
    }
  }

  private activeCrop(includeDraft = true): Extract<Shape, { kind: 'crop' }> | null {
    const shapes = includeDraft && this.draft?.kind === 'crop' ? [...this.shapes, this.draft] : this.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i];
      if (shape.kind === 'crop') {
        const x = Math.max(0, Math.min(this.canvas.width - 1, Math.round(shape.x)));
        const y = Math.max(0, Math.min(this.canvas.height - 1, Math.round(shape.y)));
        return { kind: 'crop', x, y, w: Math.max(1, Math.min(this.canvas.width - x, Math.round(shape.w))), h: Math.max(1, Math.min(this.canvas.height - y, Math.round(shape.h))) };
      }
    }
    return null;
  }

  private drawShape(s: Shape): void {
    const { ctx } = this;
    if (s.kind === 'crop') return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (s.kind === 'mosaic') {
      const x = Math.max(0, Math.floor(s.x));
      const y = Math.max(0, Math.floor(s.y));
      const right = Math.min(this.canvas.width, Math.ceil(s.x + s.w));
      const bottom = Math.min(this.canvas.height, Math.ceil(s.y + s.h));
      const w = right - x;
      const h = bottom - y;
      if (w > 0 && h > 0) {
        const sample = this.o.doc.createElement('canvas');
        sample.width = Math.max(1, Math.ceil(w / s.blockSize));
        sample.height = Math.max(1, Math.ceil(h / s.blockSize));
        const sampleCtx = sample.getContext('2d');
        if (sampleCtx) {
          sampleCtx.drawImage(this.canvas, x, y, w, h, 0, 0, sample.width, sample.height);
          ctx.imageSmoothingEnabled = false;
          // Clear first so transparent images do not retain the original detail.
          ctx.clearRect(x, y, w, h);
          ctx.drawImage(sample, 0, 0, sample.width, sample.height, x, y, w, h);
        }
      }
    } else if (s.kind === 'rect') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
    } else if (s.kind === 'arrow') {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = s.width * 4 + 6;
      // Stop the shaft before the tip so the round cap does not poke out.
      const sx = s.x2 - Math.cos(angle) * head * 0.6;
      const sy = s.y2 - Math.sin(angle) * head * 0.6;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.font = `bold ${s.size}px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      ctx.textBaseline = 'top';
      // Outline keeps text readable on any background.
      ctx.lineWidth = Math.max(2, s.size / 7);
      ctx.strokeStyle = s.color.toLowerCase() === '#ffffff' ? '#000000' : '#ffffff';
      ctx.strokeText(s.text, s.x, s.y);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x, s.y);
    }
    ctx.restore();
  }

  // Synchronous encode: canvas.toBlob's callback can stall in background or
  // unfocused windows, which left Save waiting forever in testing.
  private toPngBytes(): Uint8Array {
    this.commitText();
    this.render(false);
    let output = this.canvas;
    const crop = this.activeCrop(false);
    if (crop) {
      output = this.o.doc.createElement('canvas');
      output.width = crop.w;
      output.height = crop.h;
      const ctx = output.getContext('2d');
      if (!ctx) throw new Error('Canvas is not available');
      ctx.drawImage(this.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    }
    let dataUrl: string;
    try { dataUrl = output.toDataURL('image/png'); }
    finally { this.render(); }
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---- output ----

  private async copy(): Promise<void> {
    if (!this.image) return;
    try {
      const blob = new Blob([this.toPngBytes()], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      new Notice('Edited image copied');
    } catch (err) {
      console.error('Image Workflow: copy failed', err);
      new Notice(`Failed to copy edited image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async save(): Promise<void> {
    // No image yet (still loading): saving now would write a blank canvas.
    if (this.busy || !this.image || (!this.overwriteFile && !this.baseFile)) return;
    this.commitText();
    if (this.originalBytes && this.overwriteFile && this.shapes.length === 0) {
      // Nothing drawn: keep the plain original instead of an annotated copy.
      if (this.hasEmbeddedOriginal) await this.revert();
      else new Notice('Nothing to save — draw something first');
      return;
    }
    this.busy = true;
    try {
      const { app } = this.o;
      let bytes = this.toPngBytes();
      let target: TFile;

      if (this.originalBytes && this.overwriteFile) {
        const meta: EditMeta = { v: 2, w: this.canvas.width, h: this.canvas.height, shapes: this.shapes };
        bytes = writePngText(bytes, META_KEY, JSON.stringify(meta));
        bytes = writePngChunk(bytes, ORIGINAL_CHUNK, this.originalBytes);
        await app.vault.modifyBinary(this.overwriteFile, toArrayBuffer(bytes));
        target = this.overwriteFile;
      } else {
        const base = this.baseFile as TFile;
        const meta: EditMeta = { v: 1, source: base.path, w: this.canvas.width, h: this.canvas.height, shapes: this.shapes };
        bytes = writePngText(bytes, META_KEY, JSON.stringify(meta));
        if (this.overwriteFile) {
          await app.vault.modifyBinary(this.overwriteFile, toArrayBuffer(bytes));
          target = this.overwriteFile;
        } else {
          const dir = base.parent && base.parent.path !== '/' ? `${base.parent.path}/` : '';
          let n = 1;
          let path = `${dir}${base.basename}-edited.png`;
          while (app.vault.getAbstractFileByPath(path)) {
            n++;
            path = `${dir}${base.basename}-edited-${n}.png`;
          }
          target = await app.vault.createBinary(path, toArrayBuffer(bytes));
        }
      }

      const updated = this.relinkFrom && this.relinkFrom.path !== target.path
        ? await this.relinkEmbeds(this.relinkFrom, target)
        : 0;
      new Notice(updated > 0
        ? `Saved ${target.name} and updated ${updated} link${updated > 1 ? 's' : ''}`
        : `Saved ${target.name}`);
      this.close();
    } catch (err) {
      console.error('Image Workflow: save failed', err);
      new Notice(`Failed to save edited image: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  // Write the original bytes back, dropping annotations and edit data.
  private async revert(): Promise<void> {
    if (this.busy || !this.overwriteFile || !this.originalBytes) return;
    this.busy = true;
    try {
      await this.o.app.vault.modifyBinary(this.overwriteFile, toArrayBuffer(this.originalBytes));
      new Notice(`Restored the original ${this.overwriteFile.name}`);
      this.close();
    } catch (err) {
      console.error('Image Workflow: revert failed', err);
      new Notice(`Failed to restore the original: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  // Point embeds of the original image in the source note at the edited copy.
  private async relinkEmbeds(original: TFile, edited: TFile): Promise<number> {
    const { app, notePath } = this.o;
    if (!notePath) return 0;
    const note = app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return 0;
    const embeds = app.metadataCache.getFileCache(note)?.embeds ?? [];
    const targets = embeds
      .filter((em) => app.metadataCache.getFirstLinkpathDest(em.link, note.path)?.path === original.path)
      .sort((a, b) => b.position.start.offset - a.position.start.offset);
    if (targets.length === 0) return 0;

    let count = 0;
    await app.vault.process(note, (data) => {
      let out = data;
      targets.forEach((em) => {
        const { start, end } = em.position;
        if (out.slice(start.offset, end.offset) !== em.original) return;
        const alias = em.original.match(/^!\[\[[^\]|]*\|([^\]]*)\]\]$/)?.[1];
        const link = '!' + app.fileManager.generateMarkdownLink(edited, note.path, undefined, alias);
        out = out.slice(0, start.offset) + link + out.slice(end.offset);
        count++;
      });
      return out;
    });
    return count;
  }
}

function scaleShapes(shapes: Shape[], sx: number, sy: number): Shape[] {
  if (!isFinite(sx) || !isFinite(sy) || (sx === 1 && sy === 1)) return shapes.map((s) => ({ ...s }));
  const sl = (sx + sy) / 2;
  return shapes.map((s) => {
    if (s.kind === 'crop') return { ...s, x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy };
    if (s.kind === 'mosaic') return { ...s, x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy, blockSize: s.blockSize * sl };
    if (s.kind === 'rect') return { ...s, x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy, width: s.width * sl };
    if (s.kind === 'arrow') return { ...s, x1: s.x1 * sx, y1: s.y1 * sy, x2: s.x2 * sx, y2: s.y2 * sy, width: s.width * sl };
    return { ...s, x: s.x * sx, y: s.y * sy, size: s.size * sl };
  });
}

function parseMeta(text: string | null): EditMeta | null {
  if (!text) return null;
  try {
    const meta = JSON.parse(text) as EditMeta;
    if (meta && (meta.v === 1 || meta.v === 2) && Array.isArray(meta.shapes)) return meta;
  } catch (err) {
    console.error('Image Workflow: unreadable edit data', err);
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
