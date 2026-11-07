import { App, Component, Editor, FileSystemAdapter, MarkdownRenderer, MarkdownView, Notice, Plugin, PluginSettingTab, requestUrl, Scope, Setting, SuggestModal, TFile } from 'obsidian';
import { buildChatHtml, serializeToText, TextFlavor } from './copy-text';
import { ImageEditor } from './image-editor';
import { copyImageSummary, prepareCopyImage, withCopyImageTimeout } from './copy-images';
import { buildClipboardHtml, CLIPBOARD_MARKER, DocsHeadingStyles, GOOGLE_DOCS_STANDARD_HEADINGS, HeadingLevel, HtmlTarget, inlineStyleForExternalPaste, preserveSoftLineBreaks } from './html-style';

const IMG_SELECTOR = `.workspace-leaf-content[data-type='markdown'] img:not(a img), .workspace-leaf-content[data-type='image'] img`;
const ZOOM_FACTOR = 0.8;
const IMG_VIEW_MIN = 30;
const BUTTON_AREA_HEIGHT = 100; // bottom button group clearance
const MAX_CANVAS_DIM = 8192;
const MAX_EMBED_BYTES = 5 * 1024 * 1024; // 5MB per image

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

interface ImgInfo {
  curWidth: number;
  curHeight: number;
  realWidth: number;
  realHeight: number;
  left: number;
  top: number;
}

type CopyTarget = 'gdocs' | 'gmail' | TextFlavor;

interface CopyTargetDef {
  id: CopyTarget;
  name: string;
  desc: string;
}

const COPY_TARGETS: CopyTargetDef[] = [
  { id: 'gdocs', name: 'Google Docs', desc: 'Rich HTML with embedded images' },
  { id: 'gmail', name: 'Gmail', desc: 'Rich HTML with embedded images' },
  { id: 'slack', name: 'Slack', desc: 'Rich text + *markup* (highlight becomes bold)' },
  { id: 'gchat', name: 'Google Chat', desc: 'Rich text + *markup* (highlight becomes bold)' },
  { id: 'chatwork', name: 'Chatwork', desc: 'Plain text with [info] / [code] tags' },
  { id: 'plain', name: 'Plain text', desc: 'No markdown symbols' },
];


interface ImageWorkflowSettings {
  autoEmbedOnCopy: boolean;
  autoFormatMarkdownOnCopy: boolean;
  preserveSoftLineBreaks: boolean;
  lastCopyTarget: CopyTarget;
  docsHeadingStyles: DocsHeadingStyles;
}

const DEFAULT_SETTINGS: ImageWorkflowSettings = {
  autoEmbedOnCopy: false,
  autoFormatMarkdownOnCopy: false,
  preserveSoftLineBreaks: true,
  lastCopyTarget: 'gdocs',
  docsHeadingStyles: { ...GOOGLE_DOCS_STANDARD_HEADINGS },
};

export default class ImageEnlargePlugin extends Plugin {
  settings: ImageWorkflowSettings = { ...DEFAULT_SETTINGS };
  private overlayEl: HTMLDivElement | null = null;
  private imageEditor: ImageEditor | null = null;
  private imgInfo: ImgInfo = { curWidth: 0, curHeight: 0, realWidth: 0, realHeight: 0, left: 0, top: 0 };
  private overlayScope: Scope | null = null;
  private overlayAbortController: AbortController | null = null;
  private rafId: number | null = null;
  private rafWin: Window | null = null;

  private handleImageClick = (evt: MouseEvent) => {
    const target = getEventTargetElement(evt);
    if (!target) return;
    const img = target.instanceOf(HTMLImageElement)
      ? target
      : target.closest('img');
    if (!img?.instanceOf(HTMLImageElement)) return;
    if (!img.matches(IMG_SELECTOR)) return;
    if (this.overlayEl) return;
    evt.preventDefault();
    evt.stopPropagation(); // Obsidian 側のハンドラが画像を別ペインで開くのを防ぐ
    this.openOverlay(img.src, img.doc);
  };

  private handlePaste = (evt: ClipboardEvent) => {
    const target = getEventTargetElement(evt);
    if (!target || !target.closest(`.workspace-leaf-content[data-type='markdown']`)) return;

    const data = evt.clipboardData;
    if (!data) return;
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (!html || !text) return;

    // Only override when the HTML is our own rich copy (marker) or carries data:
    // image URLs. For ordinary HTML pastes, let Obsidian handle it normally.
    const isOwnCopy = html.includes(CLIPBOARD_MARKER);
    if (!isOwnCopy && !/<img\b[^>]*\bsrc=["']data:image\//i.test(html)) return;

    evt.preventDefault();
    evt.stopPropagation();
    // Insert the plain-text (original markdown) version instead.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      view.editor.replaceSelection(text);
    }
  };

  private handleCopy = (evt: ClipboardEvent) => {
    if (!this.settings.autoEmbedOnCopy) return;

    const target = getEventTargetElement(evt);
    // Only intercept copies originating from a markdown leaf
    if (!target || !target.closest(`.workspace-leaf-content[data-type='markdown']`)) return;

    // Prefer the editor's source selection: the DOM selection loses markdown
    // syntax hidden by Live Preview (e.g. ==highlight==) and lines outside the
    // rendered viewport.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editorText = view && view.getMode() === 'source' ? view.editor.getSelection() : '';
    const text = editorText || target.win.getSelection()?.toString();
    if (!text) return;

    if (!this.settings.autoFormatMarkdownOnCopy && !hasImageRef(text)) return;

    // We will handle this copy: prevent default and write asynchronously.
    evt.preventDefault();
    evt.stopPropagation();
    void this.writeRichClipboard(text, target.doc);
  };

  async onload() {
    await this.loadSettings();

    // capture: true — Obsidian/CM6 の stopPropagation より先に発火
    this.registerDomEvent(activeDocument, 'click', this.handleImageClick, true);
    this.registerDomEvent(activeDocument, 'copy', this.handleCopy, true);
    this.registerDomEvent(activeDocument, 'paste', this.handlePaste, true);

    this.addCommand({
      id: 'copy-for-destination',
      name: 'Copy for… (choose destination)',
      editorCallback: (editor: Editor) => {
        new CopyTargetModal(this, editor).open();
      },
    });

    // Keep the original command id so existing hotkeys keep working.
    this.addCommand({
      id: 'copy-as-html-with-images',
      name: 'Copy for Google Docs (HTML with embedded images)',
      editorCallback: (editor: Editor) => {
        void this.copyFor('gdocs', editor);
      },
    });

    COPY_TARGETS.filter((t) => t.id !== 'gdocs').forEach((t) => {
      this.addCommand({
        id: `copy-for-${t.id}`,
        name: `Copy for ${t.name}`,
        editorCallback: (editor: Editor) => {
          void this.copyFor(t.id, editor);
        },
      });
    });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      menu.addItem((item) =>
        item
          .setTitle('Copy for…')
          .setIcon('clipboard-copy')
          .onClick(() => new CopyTargetModal(this, editor).open())
      );
    }));

    this.addSettingTab(new ImageWorkflowSettingTab(this.app, this));
  }

  onunload() {
    this.imageEditor?.close();
    this.closeOverlay();
  }

  async loadSettings() {
    const loaded: unknown = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, isSettingsObject(loaded) ? loaded : {});
    this.settings.docsHeadingStyles = Object.assign({}, GOOGLE_DOCS_STANDARD_HEADINGS, this.settings.docsHeadingStyles);
    if (!COPY_TARGETS.some((t) => t.id === this.settings.lastCopyTarget)) {
      this.settings.lastCopyTarget = DEFAULT_SETTINGS.lastCopyTarget;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private openOverlay(src: string, doc: Document = activeDocument) {
    if (this.overlayEl) return;

    const { overlay, imgView, editBtn, copyBtn, downloadBtn, copyPathBtn } = this.buildOverlayDom(src, doc);
    this.overlayEl = overlay;
    doc.body.appendChild(overlay);
    this.fitImageWhenReady(imgView);

    const controller = new AbortController();
    this.overlayAbortController = controller;
    const { signal } = controller;

    this.attachOverlayMouseHandlers(overlay, imgView, signal);
    this.attachOverlayButtonHandlers({ copyBtn, downloadBtn, copyPathBtn, imgView, src, signal });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openEditor(src, doc);
    }, { signal });
    this.registerOverlayKeymap(imgView, src);
  }

  private buildOverlayDom(src: string, doc: Document) {
    const overlay = doc.createElement('div');
    overlay.addClass('image-workflow-overlay');

    const imgView = doc.createElement('img');
    imgView.addClass('image-workflow-view');
    imgView.setAttr('decoding', 'async');
    imgView.src = src;

    const btnGroup = doc.createElement('div');
    btnGroup.addClass('image-workflow-btn-group');

    const make = (label: string) => {
      const btn = doc.createElement('button');
      btn.addClass('image-workflow-btn');
      btn.textContent = label;
      btnGroup.appendChild(btn);
      return btn;
    };
    const editBtn = make('Edit');
    const copyBtn = make('Copy');
    const downloadBtn = make('Download');
    const copyPathBtn = make('Copy Path');

    overlay.appendChild(imgView);
    overlay.appendChild(btnGroup);
    return { overlay, imgView, editBtn, copyBtn, downloadBtn, copyPathBtn };
  }

  private fitImageWhenReady(imgView: HTMLImageElement) {
    if (imgView.complete && imgView.naturalWidth > 0) {
      this.calculateFitSize(imgView);
      return;
    }

    imgView.onload = () => {
      if (!this.overlayEl) return;
      this.calculateFitSize(imgView);
    };
    imgView.onerror = () => {
      new Notice('Failed to load image');
      this.closeOverlay();
    };
  }

  private attachOverlayMouseHandlers(overlay: HTMLDivElement, imgView: HTMLImageElement, signal: AbortSignal) {
    imgView.addEventListener('dragstart', (e) => e.preventDefault(), { signal });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeOverlay();
    }, { signal });
    imgView.addEventListener('wheel', (e) => {
      e.preventDefault();
      const ratio = e.deltaY < 0 ? 0.1 : -0.1;
      const rect = imgView.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      if (this.rafId !== null && this.rafWin) this.rafWin.cancelAnimationFrame(this.rafId);
      this.rafWin = imgView.win;
      this.rafId = imgView.win.requestAnimationFrame(() => {
        this.rafId = null;
        this.rafWin = null;
        this.zoom(ratio, { offsetX, offsetY });
        this.applyTransform(imgView);
      });
    }, { signal });
  }

  private attachOverlayButtonHandlers(opts: {
    copyBtn: HTMLButtonElement;
    downloadBtn: HTMLButtonElement;
    copyPathBtn: HTMLButtonElement;
    imgView: HTMLImageElement;
    src: string;
    signal: AbortSignal;
  }) {
    const { copyBtn, downloadBtn, copyPathBtn, imgView, src, signal } = opts;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyImageToClipboard(imgView);
    }, { signal });
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.downloadImage(src);
    }, { signal });
    copyPathBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyImagePath(src);
    }, { signal });
  }

  private registerOverlayKeymap(imgView: HTMLImageElement, src: string) {
    const scope = new Scope();
    scope.register(null, 'Escape', () => { this.closeOverlay(); return false; });
    scope.register(['Mod'], 'c', () => { this.copyImageToClipboard(imgView); return false; });
    scope.register(['Mod', 'Shift'], 'c', () => { this.copyImagePath(src); return false; });
    scope.register(['Mod'], 's', () => { void this.downloadImage(src); return false; });
    scope.register(null, 'e', () => { this.openEditor(src, imgView.doc); return false; });
    this.overlayScope = scope;
    this.app.keymap.pushScope(scope);
  }

  private calculateFitSize(imgView: HTMLImageElement) {
    const winW = imgView.doc.documentElement.clientWidth;
    const winH = imgView.doc.documentElement.clientHeight - BUTTON_AREA_HEIGHT;
    const zoomW = winW * ZOOM_FACTOR;
    const zoomH = winH * ZOOM_FACTOR;

    let w = imgView.naturalWidth, h = imgView.naturalHeight;
    if (h > zoomH) {
      h = zoomH;
      w = h / imgView.naturalHeight * imgView.naturalWidth;
      if (w > zoomW) w = zoomW;
    } else if (w > zoomW) {
      w = zoomW;
    }
    h = w * imgView.naturalHeight / imgView.naturalWidth;

    this.imgInfo = {
      curWidth: w,
      curHeight: h,
      realWidth: imgView.naturalWidth,
      realHeight: imgView.naturalHeight,
      left: (winW - w) / 2,
      top: (winH - h) / 2,
    };
    this.applyTransform(imgView);
    imgView.addClass('is-ready');
  }

  private zoom(ratio: number, offset: { offsetX: number; offsetY: number }) {
    const info = this.imgInfo;
    const zoomIn = ratio > 0;
    const multiplier = zoomIn ? 1 + ratio : 1 / (1 - ratio);
    let zoomRatio = info.curWidth * multiplier / info.realWidth;

    const curRatio = info.curWidth / info.realWidth;
    if ((curRatio < 1 && zoomRatio > 1) || (curRatio > 1 && zoomRatio < 1)) {
      zoomRatio = 1;
      const snapMultiplier = 1 / curRatio;
      info.left += offset.offsetX * (1 - snapMultiplier);
      info.top += offset.offsetY * (1 - snapMultiplier);
      info.curWidth = info.realWidth;
      info.curHeight = info.realHeight;
      return;
    }

    let newW = info.realWidth * zoomRatio;
    let newH = info.realHeight * zoomRatio;

    if (newW < IMG_VIEW_MIN || newH < IMG_VIEW_MIN) {
      if (newW < IMG_VIEW_MIN) {
        newW = IMG_VIEW_MIN;
        newH = newW * info.realHeight / info.realWidth;
      } else {
        newH = IMG_VIEW_MIN;
        newW = newH * info.realWidth / info.realHeight;
      }
      info.curWidth = newW;
      info.curHeight = newH;
      return;
    }

    info.left += offset.offsetX * (1 - multiplier);
    info.top += offset.offsetY * (1 - multiplier);
    info.curWidth = newW;
    info.curHeight = newH;
  }

  private applyTransform(imgView: HTMLImageElement) {
    const info = this.imgInfo;
    imgView.setCssProps({
      '--image-workflow-view-width': `${info.curWidth}px`,
      '--image-workflow-view-height': `${info.curHeight}px`,
      '--image-workflow-view-transform': `translate(${info.left}px, ${info.top}px)`,
    });
  }

  private openEditor(src: string, doc: Document): void {
    const isRemote = /^https?:\/\//i.test(src);
    const found = isRemote ? null : this.app.vault.getAbstractFileByPath(this.srcToVaultPath(src));
    const imageFile = found instanceof TFile ? found : null;
    const notePath = this.app.workspace.getActiveFile()?.path ?? null;
    this.closeOverlay();
    this.imageEditor?.close();
    const editor = new ImageEditor({ app: this.app, doc, src, imageFile, notePath,
      onClose: () => { if (this.imageEditor === editor) this.imageEditor = null; },
    });
    this.imageEditor = editor;
    editor.open();
  }

  private srcToVaultPath(src: string): string {
    let path = src;
    try {
      const url = new URL(src);
      const decodedPath = decodeURIComponent(url.pathname);
      const vaultBasePath = this.app.vault.adapter instanceof FileSystemAdapter
        ? this.app.vault.adapter.getBasePath()
        : null;
      if (vaultBasePath && decodedPath.includes(vaultBasePath)) {
        const idx = decodedPath.indexOf(vaultBasePath);
        path = decodedPath.substring(idx + vaultBasePath.length);
        if (path.startsWith('/')) path = path.substring(1);
      } else {
        path = decodedPath;
        if (path.startsWith('/')) path = path.substring(1);
      }
    } catch {
      // not a valid URL — use as-is
    }
    return path;
  }

  private copyImagePath(src: string): void {
    const path = this.srcToVaultPath(src);
    navigator.clipboard.writeText(path).then(
      () => new Notice('Path copied: ' + path),
      () => new Notice('Failed to copy path')
    );
  }

  private async downloadImage(src: string): Promise<void> {
    try {
      const blob = await this.readImageBlob(src);
      const url = URL.createObjectURL(blob);
      const path = this.srcToVaultPath(src);
      const filename = path.split('/').pop() || 'image';
      const doc = this.overlayEl?.doc ?? activeDocument;
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after a tick so the download has time to start
      doc.defaultView?.setTimeout(() => URL.revokeObjectURL(url), 1000);
      new Notice('Downloaded: ' + filename);
    } catch (err) {
      console.error(err);
      new Notice('Failed to download');
    }
  }

  private async readImageBlob(src: string): Promise<Blob> {
    if (/^https?:\/\//i.test(src)) {
      const res = await requestUrl({ url: src, throw: false });
      if (res.status >= 400) throw new Error('request failed');
      const contentType = res.headers['content-type'] ?? 'application/octet-stream';
      return new Blob([res.arrayBuffer], { type: contentType });
    }

    const path = this.srcToVaultPath(src);
    const buf = await this.app.vault.adapter.readBinary(path);
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const contentType = IMAGE_EXT_MIME[ext] ?? 'application/octet-stream';
    return new Blob([buf], { type: contentType });
  }

  private copyImageToClipboard(imgView: HTMLImageElement): void {
    const image = imgView.doc.createElement('img');
    const isFileUrl = imgView.src.startsWith('file:');
    if (!isFileUrl) {
      image.crossOrigin = 'anonymous';
    }
    image.src = imgView.src;
    image.onload = () => {
      const canvas = imgView.doc.createElement('canvas');
      let w = image.naturalWidth;
      let h = image.naturalHeight;
      if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
        const scale = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, w, h);
      try {
        canvas.toBlob((blob) => {
          void this.writeImageBlobToClipboard(blob, canvas);
        });
      } catch (err) {
        new Notice('Failed to copy image');
        console.error(err);
      }
    };
    image.onerror = () => {
      new Notice('Failed to copy image');
    };
  }

  private closeOverlay() {
    if (this.rafId !== null && this.rafWin) {
      this.rafWin.cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.rafWin = null;
    }
    if (this.overlayAbortController) {
      this.overlayAbortController.abort();
      this.overlayAbortController = null;
    }
    if (this.overlayScope) {
      this.app.keymap.popScope(this.overlayScope);
      this.overlayScope = null;
    }
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  private async writeImageBlobToClipboard(blob: Blob | null, canvas: HTMLCanvasElement): Promise<void> {
    canvas.width = 0;
    if (!blob) {
      new Notice('Failed to copy image');
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      new Notice('Image copied');
    } catch {
      new Notice('Failed to copy image');
    }
  }

  // ---- Copy for a destination (Docs / Gmail / chat apps / plain text) ----

  async copyFor(target: CopyTarget, editor: Editor): Promise<void> {
    const markdown = editor.getSelection() || editor.getValue();
    if (!markdown) {
      new Notice('Nothing to copy');
      return;
    }
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
    const def = COPY_TARGETS.find((t) => t.id === target);

    if (this.settings.lastCopyTarget !== target) {
      this.settings.lastCopyTarget = target;
      void this.saveSettings();
    }

    // Pass Promise<Blob> values so the browser keeps the user-gesture window
    // across the async rendering work.
    const items: Record<string, Promise<Blob>> = {};
    if (target === 'gdocs' || target === 'gmail') {
      items['text/html'] = this.renderSelectionToHtmlBlob(markdown, sourcePath, activeDocument, target);
      items['text/plain'] = Promise.resolve(new Blob([markdown], { type: 'text/plain' }));
    } else {
      const rendered = this.renderForText(markdown, sourcePath, activeDocument, target);
      if (target === 'slack' || target === 'gchat') {
        items['text/html'] = rendered.then((r) => new Blob([r.html], { type: 'text/html' }));
      }
      items['text/plain'] = rendered.then((r) => new Blob([r.text], { type: 'text/plain' }));
    }

    try {
      await navigator.clipboard.write([new ClipboardItem(items)]);
      new Notice(`Copied for ${def?.name ?? target}`);
    } catch (err) {
      console.error('Clipboard write failed', err);
      try {
        await navigator.clipboard.writeText(markdown);
        new Notice('Copy failed — wrote markdown text instead');
      } catch {
        new Notice('Failed to copy');
      }
    }
  }

  private async withRenderedMarkdown<T>(
    markdown: string,
    sourcePath: string,
    doc: Document,
    fn: (container: HTMLElement) => Promise<T>,
  ): Promise<T> {
    const container = doc.createElement('div');
    // opacity:0 (not visibility:hidden) — Mermaid/MathJax post-processors skip
    // elements they consider "invisible". opacity:0 keeps them processable.
    container.classList.add('markdown-preview-view', 'markdown-rendered', 'image-workflow-render-buffer');
    doc.body.appendChild(container);
    const renderComponent = new Component();
    renderComponent.load();

    try {
      await MarkdownRenderer.render(this.app, markdown, container, sourcePath, renderComponent);
      await waitForAsyncRenders(container);
      container
        .querySelectorAll('.copy-code-button, .frontmatter, .frontmatter-container, .edit-block-button, .list-collapse-indicator, .collapse-indicator, .footnote-backref, button, .clickable-icon, svg.svg-icon')
        .forEach((el) => el.remove());
      return await fn(container);
    } finally {
      renderComponent.unload();
      container.remove();
    }
  }

  private renderForText(markdown: string, sourcePath: string, doc: Document, flavor: TextFlavor): Promise<{ html: string; text: string }> {
    return this.withRenderedMarkdown(markdown, sourcePath, doc, async (container) => ({
      text: serializeToText(container, flavor),
      html: flavor === 'slack' || flavor === 'gchat' ? buildChatHtml(container) : '',
    }));
  }

  private async renderSelectionToHtmlBlob(selection: string, sourcePath: string, doc: Document, target: HtmlTarget = 'gdocs'): Promise<Blob> {
    return this.withRenderedMarkdown(selection, sourcePath, doc, async (container) => {
      if (this.settings.preserveSoftLineBreaks) preserveSoftLineBreaks(container);
      await convertSvgToImg(container);
      inlineStyleForExternalPaste(container, target, this.settings.docsHeadingStyles);
      await this.embedRenderedImages(container, sourcePath);

      // innerHTML source is Obsidian's MarkdownRenderer.render output (trusted),
      // serialized into a clipboard payload (not re-injected into DOM).
      const html = buildClipboardHtml(container.innerHTML, target);
      return new Blob([html], { type: 'text/html' });
    });
  }

  // ---- Rich copy (markdown selection → text/plain + text/html with embedded images) ----

  private async writeRichClipboard(markdown: string, doc: Document): Promise<void> {
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
    const htmlPromise = this.renderSelectionToHtmlBlob(markdown, sourcePath, doc);
    const textBlob = new Blob([markdown], { type: 'text/plain' });

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlPromise, 'text/plain': textBlob }),
      ]);
    } catch (err) {
      console.error('Rich clipboard write failed', err);
      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        new Notice('Failed to copy');
      }
    }
  }

  private async embedRenderedImages(root: HTMLElement, sourcePath: string): Promise<void> {
    const imgs = Array.from(root.querySelectorAll('img'));
    let next = 0;
    let embedded = 0;
    let bytes = 0;
    // Limit concurrent decodes/canvases for image-heavy notes.
    await Promise.all(Array.from({ length: Math.min(2, imgs.length) }, async () => {
      while (next < imgs.length) {
        const img = imgs[next++];
        const src = img.getAttribute('src');
        if (!src) continue;
        const dataUrl = /^data:/i.test(src) ? src : await withCopyImageTimeout(
          this.resolveImageSrc(this.getRenderedImageEmbedSrc(img, sourcePath), sourcePath), null, undefined, root.ownerDocument.defaultView ?? window,
        ).catch(() => null);
        if (!dataUrl) continue;
        const prepared = await prepareCopyImage(dataUrl, root.ownerDocument);
        if (!prepared.src) { img.remove(); continue; }
        img.setAttribute('src', prepared.src);
        img.removeAttribute('srcset');
        if (prepared.width && prepared.height) {
          // Retain deliberately small rendered widths while preventing display upscaling.
          const width = Math.min(Number(img.getAttribute('width')) || prepared.width, prepared.width);
          img.setAttribute('width', String(width));
          img.setAttribute('height', String(Math.max(1, Math.round(width * prepared.height / prepared.width))));
        }
        if (/^data:/i.test(prepared.src)) {
          embedded++;
          bytes += prepared.bytes;
        }
      }
    }));
    if (imgs.length) new Notice(copyImageSummary(embedded, bytes), bytes > MAX_EMBED_BYTES ? 8000 : 5000);
  }

  private getRenderedImageEmbedSrc(img: HTMLImageElement, sourcePath: string): string {
    const internalEmbed = img.closest<HTMLElement>('.internal-embed[src]');
    const internalSrc = internalEmbed?.getAttribute('src')?.trim();
    if (internalSrc) return internalSrc;

    const rawSrc = img.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(rawSrc)) return rawSrc;

    const alt = img.getAttribute('alt')?.trim();
    if (alt && this.app.metadataCache.getFirstLinkpathDest(alt, sourcePath)) return alt;

    return this.renderedUrlToVaultPath(rawSrc) ?? rawSrc;
  }

  private renderedUrlToVaultPath(src: string): string | null {
    if (!/^(app|file):\/\//i.test(src)) return null;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return null;

    try {
      const decodedPath = decodeURIComponent(new URL(src).pathname);
      const vaultBasePath = this.app.vault.adapter.getBasePath();
      if (!decodedPath.includes(vaultBasePath)) return null;

      let path = decodedPath.substring(decodedPath.indexOf(vaultBasePath) + vaultBasePath.length);
      if (path.startsWith('/')) path = path.substring(1);
      return path || null;
    } catch {
      return null;
    }
  }

  private async resolveImageSrc(src: string, sourcePath: string): Promise<string | null> {
    // Already inline / remote
    if (src.startsWith('data:')) return src;
    if (/^https?:\/\//i.test(src)) {
      const dataUrl = await fetchAsDataUrl(src);
      return dataUrl ?? src;
    }

    // Vault-resolved path
    const linkpath = decodeURIComponent(src).replace(/^\/+/, '');
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    if (!file || !(file instanceof TFile)) return null;

    try {
      const buf = await this.app.vault.adapter.readBinary(file.path);
      if (buf.byteLength > MAX_EMBED_BYTES) {
        new Notice(`Skipped embedding (too large): ${file.name}`);
        return null;
      }
      const ext = file.extension.toLowerCase();
      const mime = IMAGE_EXT_MIME[ext] ?? 'application/octet-stream';
      return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    } catch (err) {
      console.error('Failed to read vault image', err);
      new Notice(`Could not embed image: ${file.name}`);
      return null;
    }
  }
}

// ---- Helpers ----

function hasImageRef(text: string): boolean {
  return /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/.test(text);
}

function getEventTargetElement(evt: Event): HTMLElement | null {
  const target = evt.target;
  if (!target) return null;
  const maybeNode = target as EventTarget & { instanceOf?: Node['instanceOf'] };
  if (typeof maybeNode.instanceOf !== 'function') return null;
  return maybeNode.instanceOf(HTMLElement) ? target as HTMLElement : null;
}

function isSettingsObject(value: unknown): value is Partial<ImageWorkflowSettings> {
  return typeof value === 'object' && value !== null;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

async function waitForAsyncRenders(container: HTMLElement): Promise<void> {
  // Try to trigger Mermaid manually if the global is available and unrendered
  // mermaid blocks remain. Obsidian bundles mermaid; calling its run() is the
  // most reliable way to force render off-screen.
  await tryRunMermaid(container);

  // Poll for Mermaid / MathJax / similar async renderers up to ~3s total.
  // We consider the DOM "settled" when no unrendered placeholder remains AND
  // two consecutive samples see the same SVG / mjx-container count.
  const deadline = Date.now() + 3000;
  let lastCount = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => container.win.setTimeout(r, 120));
    const pendingMermaid = container.querySelector('code.language-mermaid, pre.language-mermaid, .mermaid:not([data-processed])');
    const pendingMath = container.querySelector('.math:not(.is-loaded), code.language-math');
    const count = container.querySelectorAll('svg, mjx-container').length;
    if (!pendingMermaid && !pendingMath) {
      if (count === lastCount) {
        stableTicks++;
        if (stableTicks >= 2) return;
      } else {
        stableTicks = 0;
      }
    }
    lastCount = count;
    // Re-attempt Mermaid in case more code blocks appeared
    if (pendingMermaid) await tryRunMermaid(container);
  }
}

async function tryRunMermaid(container: HTMLElement): Promise<void> {
  // Mermaid is exposed on window in Obsidian. Try common APIs.
  const w = container.win as Window & { mermaid?: { run?: (opts?: { nodes?: NodeListOf<Element> | Element[] }) => Promise<unknown>; init?: (config?: unknown, nodes?: NodeListOf<Element> | string) => void } };
  const mermaid = w.mermaid;
  if (!mermaid) return;

  // Find unrendered mermaid blocks. Obsidian usually wraps with <pre class="language-mermaid"><code>...</code></pre>
  const codeBlocks = Array.from(container.querySelectorAll<HTMLElement>('code.language-mermaid, pre.language-mermaid'));
  if (codeBlocks.length === 0) return;

  // Convert each block to a <div class="mermaid">code</div> that mermaid.run can consume
  for (const block of codeBlocks) {
    const code = block.tagName === 'PRE' ? block.querySelector('code')?.textContent ?? block.textContent ?? '' : block.textContent ?? '';
    const wrapper = container.doc.createElement('div');
    wrapper.className = 'mermaid';
    wrapper.textContent = code;
    const target = block.tagName === 'PRE' ? block : block.parentElement || block;
    target.replaceWith(wrapper);
  }

  try {
    if (typeof mermaid.run === 'function') {
      await mermaid.run({ nodes: container.querySelectorAll('.mermaid') });
    } else if (typeof mermaid.init === 'function') {
      mermaid.init(undefined, container.querySelectorAll('.mermaid'));
    }
  } catch (err) {
    console.error('Manual mermaid render failed', err);
    new Notice('Mermaid diagram could not be rendered for clipboard');
  }
}

async function convertSvgToImg(root: HTMLElement): Promise<void> {
  // MathJax produces <mjx-container><svg/></mjx-container>. Extract the inner svg
  // first so the wrapping <mjx-container> (which Docs strips entirely) goes away.
  root.querySelectorAll('mjx-container').forEach((mjx) => {
    const svg = mjx.querySelector('svg');
    if (svg) {
      const isInline = (mjx as HTMLElement).getAttribute('display') !== 'true';
      const wrapper = root.doc.createElement(isInline ? 'span' : 'div');
      if (!isInline) wrapper.setCssProps({
        '--image-workflow-math-align': 'center',
        '--image-workflow-math-margin': '8px 0',
      });
      if (!isInline) wrapper.addClass('image-workflow-math-block');
      wrapper.appendChild(svg);
      mjx.replaceWith(wrapper);
    } else {
      mjx.remove();
    }
  });

  const svgs = Array.from(root.querySelectorAll<SVGSVGElement>('svg'));
  // Bound rasterization memory and yield between diagrams.
  for (const svg of svgs) {
    try {
      const png = await rasterizeSvg(svg);
      if (png) {
        svg.replaceWith(png);
      }
    } catch (err) {
      console.error('SVG rasterization failed', err);
    }
  }
}

async function rasterizeSvg(svg: SVGSVGElement): Promise<HTMLImageElement | null> {
  // Ensure xmlns + concrete dimensions so the standalone SVG renders correctly.
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!svg.getAttribute('xmlns:xlink')) svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const rect = svg.getBoundingClientRect();
  const viewBox = svg.getAttribute('viewBox')?.split(/\s+/).map(Number);
  const intrinsicW = viewBox && viewBox.length === 4 ? viewBox[2] : 0;
  const intrinsicH = viewBox && viewBox.length === 4 ? viewBox[3] : 0;
  const cssW = rect.width || parseFloat(svg.getAttribute('width') || '0') || intrinsicW || 600;
  const cssH = rect.height || parseFloat(svg.getAttribute('height') || '0') || intrinsicH || 400;

  if (!svg.getAttribute('width')) svg.setAttribute('width', String(cssW));
  if (!svg.getAttribute('height')) svg.setAttribute('height', String(cssH));

  const serialized = new XMLSerializer().serializeToString(svg);
  const prepared = await prepareCopyImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`, svg.ownerDocument, true);
  if (!prepared.width || !prepared.height || !prepared.src.startsWith('data:image/png')) return null;
  const img = svg.ownerDocument.createElement('img');
  img.src = prepared.src;
  img.width = prepared.width;
  img.height = prepared.height;
  img.alt = 'diagram';
  return img;
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  // Only follow http(s). Refuse file://, app://, blob:, etc. — in Electron's
  // renderer fetch can read local files, which would let a crafted note
  // exfiltrate them via the clipboard payload.
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await requestUrl({ url, throw: false });
    if (res.status >= 400) return null;
    if (res.arrayBuffer.byteLength > MAX_EMBED_BYTES) return null;
    const mime = res.headers['content-type'] ?? 'application/octet-stream';
    const buf = res.arrayBuffer;
    return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
  } catch {
    return null;
  }
}

// ---- Destination picker ----

class CopyTargetModal extends SuggestModal<CopyTargetDef> {
  constructor(private plugin: ImageEnlargePlugin, private editor: Editor) {
    super(plugin.app);
    this.setPlaceholder('Copy for…');
  }

  getSuggestions(query: string): CopyTargetDef[] {
    const last = this.plugin.settings.lastCopyTarget;
    const ordered = [
      ...COPY_TARGETS.filter((t) => t.id === last),
      ...COPY_TARGETS.filter((t) => t.id !== last),
    ];
    const q = query.trim().toLowerCase();
    return q ? ordered.filter((t) => t.name.toLowerCase().includes(q) || t.id.includes(q)) : ordered;
  }

  renderSuggestion(target: CopyTargetDef, el: HTMLElement): void {
    el.createDiv({ text: target.name });
    el.createEl('small', { text: target.desc, cls: 'image-workflow-target-desc' });
  }

  onChooseSuggestion(target: CopyTargetDef): void {
    void this.plugin.copyFor(target.id, this.editor);
  }
}

// ---- Settings tab ----

class ImageWorkflowSettingTab extends PluginSettingTab {
  plugin: ImageEnlargePlugin;

  constructor(app: App, plugin: ImageEnlargePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Expose searchable definitions on Obsidian 1.13+, while retaining a renderer
  // compatible with the existing minimum version.
  getSettingDefinitions() {
    const toggle = (name: string, desc: string, key: 'autoEmbedOnCopy' | 'autoFormatMarkdownOnCopy' | 'preserveSoftLineBreaks') => ({
      name, desc,
      render: (setting: Setting) => { setting.addToggle(control => control
        .setValue(this.plugin.settings[key])
        .onChange(async value => { this.plugin.settings[key] = value; await this.plugin.saveSettings(); })); },
    });
    return [
      toggle('Rich copy on Cmd/Ctrl+C', 'Off by default: Cmd/Ctrl+C copies plain markdown as usual. Enable to copy selections with image embeds as rich HTML. Copy for… commands are always available.', 'autoEmbedOnCopy'),
      toggle('Format all markdown copies for Google apps', 'When automatic rich copy is enabled, include selections without images.', 'autoFormatMarkdownOnCopy'),
      toggle('Preserve line breaks for Google paste', 'Keep soft line breaks visible in rich HTML. Plain markdown is unchanged.', 'preserveSoftLineBreaks'),
      {
        name: 'Google Docs heading styles',
        desc: 'Match these CSS values to your Docs template so pasted headings use its styles.',
        render: (setting: Setting) => { setting.setHeading(); },
      },
      {
        name: 'Reset to Google Docs standard',
        render: (setting: Setting) => { setting.addButton(button => button.setButtonText('Reset').onClick(async () => {
          this.plugin.settings.docsHeadingStyles = { ...GOOGLE_DOCS_STANDARD_HEADINGS };
          await this.plugin.saveSettings(); this.display();
        })); },
      },
      ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as HeadingLevel[]).map(level => ({
        name: `Heading ${level.slice(1)}`,
        render: (setting: Setting) => { setting.addTextArea(control => {
          control.inputEl.rows = 2;
          control.inputEl.addClass('image-workflow-heading-css');
          control.setValue(this.plugin.settings.docsHeadingStyles[level]).onChange(async value => {
            this.plugin.settings.docsHeadingStyles[level] = value.trim(); await this.plugin.saveSettings();
          });
        }); },
      })),
    ];
  }

  display(): void {
    this.containerEl.empty();
    for (const definition of this.getSettingDefinitions()) {
      const setting = new Setting(this.containerEl).setName(definition.name);
      if ('desc' in definition && definition.desc) setting.setDesc(definition.desc);
      definition.render(setting);
    }
  }
}
