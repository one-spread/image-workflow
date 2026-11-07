// Inline-style conversion of Obsidian-rendered HTML for external paste targets
// (Google Docs / Gmail). Pure DOM code so it can be tested outside Obsidian.

// Marker on our own clipboard HTML so pasting it back into Obsidian restores
// the original markdown instead of Obsidian's HTML-to-markdown conversion.
export const CLIPBOARD_MARKER = 'data-image-workflow-copy';

export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
export type DocsHeadingStyles = Record<HeadingLevel, string>;

// Google Docs' built-in "Normal" template.
export const GOOGLE_DOCS_STANDARD_HEADINGS: DocsHeadingStyles = {
  h1: 'font-size:20pt; font-weight:400; color:#000000; margin:20pt 0 6pt',
  h2: 'font-size:16pt; font-weight:400; color:#000000; margin:18pt 0 6pt',
  h3: 'font-size:14pt; font-weight:400; color:#434343; margin:16pt 0 4pt',
  h4: 'font-size:12pt; font-weight:400; color:#666666; margin:14pt 0 4pt',
  h5: 'font-size:11pt; font-weight:400; color:#666666; margin:12pt 0 4pt',
  h6: 'font-size:11pt; font-weight:400; font-style:italic; color:#666666; margin:12pt 0 4pt',
};

function styleBlocksForDocs(root: HTMLElement, headingCss: DocsHeadingStyles): void {
  root.querySelectorAll<HTMLElement>('p, ul, ol, li').forEach((el) => {
    setStyle(el, 'margin:0');
  });
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const css = headingCss[h.tagName.toLowerCase() as HeadingLevel];
    if (css) h.setAttribute('style', css);
  });
}

const CALLOUT_COLORS: Record<string, { border: string; bg: string; title: string }> = {
  note:     { border: '#448aff', bg: '#e3f2fd', title: '#1565c0' },
  abstract: { border: '#00bcd4', bg: '#e0f7fa', title: '#00838f' },
  summary:  { border: '#00bcd4', bg: '#e0f7fa', title: '#00838f' },
  tldr:     { border: '#00bcd4', bg: '#e0f7fa', title: '#00838f' },
  info:     { border: '#00b8d4', bg: '#e1f5fe', title: '#0277bd' },
  todo:     { border: '#00b0ff', bg: '#e1f5fe', title: '#0277bd' },
  tip:      { border: '#00bfa5', bg: '#e0f2f1', title: '#00695c' },
  hint:     { border: '#00bfa5', bg: '#e0f2f1', title: '#00695c' },
  important:{ border: '#00bfa5', bg: '#e0f2f1', title: '#00695c' },
  success:  { border: '#00c853', bg: '#e8f5e9', title: '#2e7d32' },
  check:    { border: '#00c853', bg: '#e8f5e9', title: '#2e7d32' },
  done:     { border: '#00c853', bg: '#e8f5e9', title: '#2e7d32' },
  question: { border: '#64dd17', bg: '#f1f8e9', title: '#558b2f' },
  help:     { border: '#64dd17', bg: '#f1f8e9', title: '#558b2f' },
  faq:      { border: '#64dd17', bg: '#f1f8e9', title: '#558b2f' },
  warning:  { border: '#ff9100', bg: '#fff3e0', title: '#e65100' },
  caution:  { border: '#ff9100', bg: '#fff3e0', title: '#e65100' },
  attention:{ border: '#ff9100', bg: '#fff3e0', title: '#e65100' },
  failure:  { border: '#ff5252', bg: '#ffebee', title: '#c62828' },
  fail:     { border: '#ff5252', bg: '#ffebee', title: '#c62828' },
  missing:  { border: '#ff5252', bg: '#ffebee', title: '#c62828' },
  danger:   { border: '#ff1744', bg: '#ffebee', title: '#b71c1c' },
  error:    { border: '#ff1744', bg: '#ffebee', title: '#b71c1c' },
  bug:      { border: '#f50057', bg: '#fce4ec', title: '#ad1457' },
  example:  { border: '#7c4dff', bg: '#ede7f6', title: '#4527a0' },
  quote:    { border: '#9e9e9e', bg: '#fafafa', title: '#424242' },
  cite:     { border: '#9e9e9e', bg: '#fafafa', title: '#424242' },
};

function setStyle(el: HTMLElement, css: string): void {
  const existing = el.getAttribute('style') ?? '';
  el.setAttribute('style', existing ? `${existing}; ${css}` : css);
}

export type HtmlTarget = 'gdocs' | 'gmail';

export function buildClipboardHtml(fragmentHtml: string, target: HtmlTarget): string {
  // Google Docs turns every inline font / size / color into a text-style
  // override, so leave the wrapper unstyled there and let the document's own
  // Normal text / Heading styles apply.
  const wrapperStyle = target === 'gdocs'
    ? ''
    : ' style="font-family:Arial, sans-serif; font-size:11pt; line-height:1.45; color:#202124"';
  const fragment =
    `<div ${CLIPBOARD_MARKER}="1"${wrapperStyle}>` +
    fragmentHtml +
    '</div>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    '<!--StartFragment-->' +
    fragment +
    '<!--EndFragment-->' +
    '</body></html>';
}

export function inlineStyleForExternalPaste(root: HTMLElement, target: HtmlTarget, docsHeadingCss: DocsHeadingStyles = GOOGLE_DOCS_STANDARD_HEADINGS): void {
  const docsNative = target === 'gdocs';
  // Google Docs stores every value that differs from the document's named
  // style as an override, and fills unspecified values with browser defaults
  // (h1 = 2em, p = 1em margins, ...). So for Docs we emit values that equal the
  // target template: paragraphs/lists with zero margins, headings with the
  // configured heading styles. Matching values leave no override behind.
  if (docsNative) styleBlocksForDocs(root, docsHeadingCss);
  else styleParagraphs(root);
  styleCodeBlocks(root);
  styleInlineCode(root);
  if (!docsNative) styleLists(root);
  styleFootnotes(root);
  styleHighlights(root);
  styleStrikethrough(root);
  styleLinks(root);
  styleCallouts(root, docsNative);
  styleBlockquotes(root, docsNative);
  styleTables(root);
  styleImages(root);
  styleHorizontalRules(root);
  if (!docsNative) styleHeadings(root);
  if (docsNative) convertTasksToBullets(root);
  else replaceTaskCheckboxes(root);
}

// Docs has no checklist representation in pasted HTML, so task items become
// ordinary bullets; completed tasks are struck through.
function convertTasksToBullets(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    const li = cb.closest('li');
    const checked = cb.checked || cb.hasAttribute('checked');
    cb.remove();
    if (!li || !checked) return;
    const span = root.ownerDocument.createElement('span');
    setStyle(span, 'text-decoration:line-through');
    Array.from(li.childNodes).forEach((n) => {
      if (n.nodeType === 1 && ['UL', 'OL'].includes((n as HTMLElement).tagName)) return;
      span.appendChild(n);
    });
    li.insertBefore(span, li.firstChild);
  });
  root.querySelectorAll<HTMLElement>('li.task-list-item').forEach((li) => {
    li.removeAttribute('data-task');
    li.classList.remove('task-list-item', 'is-checked');
  });
}

function styleParagraphs(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('p').forEach((p) => {
    setStyle(p, 'margin:0 0 8px; line-height:1.45');
  });
}

export function preserveSoftLineBreaks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('p, th, td').forEach((block) => {
    if (block.closest('pre, code')) return;

    const walker = root.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }

    textNodes.forEach((textNode) => {
      const text = textNode.nodeValue ?? '';
      if (!text.includes('\n')) return;

      const fragment = root.ownerDocument.createDocumentFragment();
      const parts = text.split(/(\n+)/);
      parts.forEach((part) => {
        if (!part) return;
        if (/^\n+$/.test(part)) {
          for (let i = 0; i < part.length; i++) {
            fragment.appendChild(root.ownerDocument.createElement('br'));
          }
        } else {
          fragment.appendChild(root.ownerDocument.createTextNode(part));
        }
      });
      textNode.replaceWith(fragment);
    });
  });
}

// Code blocks: flatten to a single-cell <table> with plain text, since Docs is
// unreliable with <pre>/<code> + syntax-highlight <span>s.
function styleCodeBlocks(root: HTMLElement): void {
  const doc = root.ownerDocument;
  root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code');
    const raw = (codeEl ?? pre).textContent || '';
    const text = raw.replace(/^\n+|\n+$/g, '');

    const table = doc.createElement('table');
    table.setAttribute('data-iw-code', '1');
    setStyle(table, 'border-collapse:collapse; width:100%; border:1px solid #d0d7de');
    const tr = doc.createElement('tr');
    const td = doc.createElement('td');
    // Background on the cell (Docs ignores table backgrounds). No line-height:
    // Docs turns it plus cell padding into extra spacing between lines.
    td.setAttribute('style',
      'padding:8px 12px; background-color:#f6f8fa; border:1px solid #d0d7de; ' +
      'font-family:Menlo, Consolas, "Courier New", monospace; font-size:10pt; color:#24292e'
    );
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const span = doc.createElement('span');
      span.textContent = keepSpaces(line.replace(/\t/g, '    '));
      td.appendChild(span);
      if (i < lines.length - 1) td.appendChild(doc.createElement('br'));
    });
    tr.appendChild(td);
    table.appendChild(tr);
    pre.replaceWith(table);
  });
}

// Paste targets collapse runs of spaces; keep code indentation with NBSPs.
function keepSpaces(line: string): string {
  return line.replace(/^ +/, (m) => ' '.repeat(m.length)).replace(/ {2,}/g, (m) => ' '.repeat(m.length));
}

// Inline code: Docs strips <code>, so wrap in <span>.
function styleInlineCode(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('code').forEach((code) => {
    if (code.closest('pre')) return;
    const span = root.ownerDocument.createElement('span');
    while (code.firstChild) span.appendChild(code.firstChild);
    span.setAttribute('style',
      'background-color:#f6f8fa; padding:2px 6px; border-radius:4px; ' +
      'font-family:Menlo, Consolas, "Courier New", monospace; font-size:0.9em; color:#d6336c'
    );
    code.replaceWith(span);
  });
}

function styleLists(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('ul, ol').forEach((list) => {
    setStyle(list, 'margin:4px 0; padding-left:28px');
  });
  root.querySelectorAll<HTMLElement>('ul ul, ol ol, ul ol, ol ul').forEach((list) => {
    setStyle(list, 'margin:2px 0; padding-left:28px');
  });
  root.querySelectorAll<HTMLElement>('li').forEach((li) => {
    setStyle(li, 'margin:2px 0');
  });
}

function styleFootnotes(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('section.footnotes, .footnotes').forEach((sec) => {
    setStyle(sec, 'margin-top:24px; padding-top:12px; border-top:1px solid #d0d7de; font-size:0.9em; color:#586069');
  });
  root.querySelectorAll<HTMLElement>('sup, .footnote-ref').forEach((sup) => {
    setStyle(sup, 'font-size:0.75em; vertical-align:super; line-height:0');
  });
}

// Gmail / Docs / Outlook drop <mark> or ignore the `background` shorthand on
// paste, so use a <span> with an explicit background-color.
function styleHighlights(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('mark').forEach((mk) => {
    const span = replaceWithSpan(mk);
    setStyle(span, 'background-color:#fff59d');
  });
}

function styleStrikethrough(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('del, s, strike').forEach((el) => {
    const span = replaceWithSpan(el);
    setStyle(span, 'text-decoration:line-through');
  });
}

// Internal links and tags point at vault paths that are meaningless outside
// Obsidian; keep their text only.
function styleLinks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('a.internal-link, a.tag').forEach((a) => {
    const span = replaceWithSpan(a);
    span.removeAttribute('class');
  });
  root.querySelectorAll<HTMLElement>('a[href]').forEach((a) => {
    a.removeAttribute('class');
    a.removeAttribute('target');
    a.removeAttribute('rel');
    setStyle(a, 'color:#1a73e8; text-decoration:underline');
  });
}

function replaceWithSpan(el: HTMLElement): HTMLElement {
  const span = el.ownerDocument.createElement('span');
  const existing = el.getAttribute('style');
  if (existing) span.setAttribute('style', existing);
  while (el.firstChild) span.appendChild(el.firstChild);
  el.replaceWith(span);
  return span;
}

function styleBlockquotes(root: HTMLElement, docsNative: boolean): void {
  root.querySelectorAll<HTMLElement>('blockquote').forEach((bq) => {
    if (bq.classList.contains('callout')) return;
    if (docsNative) {
      // Docs keeps paragraph borders but not container (div/blockquote) styling.
      flattenToBorderedParagraphs(bq, 'border-left:3pt solid #dfe2e5; padding-left:8pt; color:#586069');
      return;
    }
    setStyle(bq,
      'border-left:4px solid #dfe2e5; margin:8px 0; padding:4px 12px; ' +
      'color:#586069; background-color:#fafbfc'
    );
  });
}

// Replace a container with its block children, each carrying the given
// paragraph style (inline-only content is wrapped in a <p>).
function flattenToBorderedParagraphs(container: HTMLElement, css: string): void {
  const doc = container.ownerDocument;
  const out: HTMLElement[] = [];
  let pending: HTMLElement | null = null;
  const blockTags = new Set(['P', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'BLOCKQUOTE']);
  Array.from(container.childNodes).forEach((n) => {
    const isBlock = n.nodeType === 1 && blockTags.has((n as HTMLElement).tagName);
    if (isBlock) {
      pending = null;
      out.push(n as HTMLElement);
    } else {
      if (n.nodeType === 3 && !(n.textContent ?? '').trim() && !pending) return;
      if (!pending) {
        pending = doc.createElement('p');
        out.push(pending);
      }
      pending.appendChild(n);
    }
  });
  const flat: HTMLElement[] = [];
  out.forEach((el) => {
    if (el.tagName === 'DIV' || el.tagName === 'BLOCKQUOTE') {
      el.querySelectorAll<HTMLElement>('p, li').forEach((p) => flat.push(p));
      if (!el.querySelector('p, li')) flat.push(el);
    } else {
      flat.push(el);
    }
  });
  flat.forEach((el) => {
    if (el.tagName === 'P' || /^H[1-6]$/.test(el.tagName)) setStyle(el, `margin:0; ${css}`);
  });
  container.replaceWith(...out);
}

function styleCallouts(root: HTMLElement, docsNative: boolean): void {
  root.querySelectorAll<HTMLElement>('.callout').forEach((co) => {
    const type = (co.getAttribute('data-callout') || 'note').toLowerCase();
    const colors = CALLOUT_COLORS[type] ?? CALLOUT_COLORS.note;
    co.querySelectorAll<HTMLElement>('.callout-icon, .callout-fold').forEach((el) => el.remove());

    if (docsNative) {
      const doc = co.ownerDocument;
      const box = `border-left:3pt solid ${colors.border}; background-color:${colors.bg}; padding:4pt 8pt`;
      const title = doc.createElement('p');
      title.textContent = co.querySelector('.callout-title-inner')?.textContent?.trim() || type;
      title.setAttribute('style', `margin:0; ${box}; color:${colors.title}; font-weight:700`);
      const content = co.querySelector<HTMLElement>('.callout-content');
      const wrapper = doc.createElement('div');
      wrapper.appendChild(title);
      if (content) while (content.firstChild) wrapper.appendChild(content.firstChild);
      co.replaceWith(wrapper);
      Array.from(wrapper.children).forEach((child) => {
        const el = child as HTMLElement;
        if (el === title) return;
        if (el.tagName === 'P') setStyle(el, `margin:0; ${box}`);
        else el.querySelectorAll<HTMLElement>('p, li').forEach((p) => setStyle(p, `margin:0; ${box}`));
      });
      wrapper.replaceWith(...Array.from(wrapper.childNodes));
      return;
    }

    setStyle(co,
      `border-left:4px solid ${colors.border}; background-color:${colors.bg}; ` +
      `border-radius:4px; padding:10px 14px; margin:8px 0; color:#24292e`
    );
    co.querySelectorAll<HTMLElement>('.callout-title').forEach((t) => {
      setStyle(t, `color:${colors.title}; font-weight:600; margin-bottom:4px; display:block`);
    });
  });
}

// No table margins: Docs converts them into spacing above/below every
// paragraph inside the cells.
function styleTables(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('table:not([data-iw-code])').forEach((tbl) => {
    setStyle(tbl, 'border-collapse:collapse; width:100%; border:1px solid #d0d7de');
    tbl.querySelectorAll<HTMLElement>('th, td').forEach((cell) => {
      setStyle(cell, 'border:1px solid #d0d7de; padding:4px 8px; vertical-align:top; text-align:left');
    });
    tbl.querySelectorAll<HTMLElement>('th').forEach((th) => {
      setStyle(th, 'background-color:#f6f8fa; font-weight:700');
    });
  });
}

function styleImages(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    img.removeAttribute('decoding');
    img.removeAttribute('draggable');

    const rect = img.getBoundingClientRect();
    const width = img.width || Math.round(rect.width) || img.naturalWidth;
    const height = img.height || Math.round(rect.height) || img.naturalHeight;
    if (width > 0 && !img.getAttribute('width')) img.setAttribute('width', String(width));
    if (height > 0 && !img.getAttribute('height')) img.setAttribute('height', String(height));

    setStyle(img,
      'display:block; max-width:100%; height:auto; margin:8px 0; border:0; outline:none'
    );
  });
}

function styleHorizontalRules(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('hr').forEach((hr) => {
    setStyle(hr, 'border:0; border-top:1px solid #d0d7de; margin:16px 0');
  });
}

const HEADING_SIZE: Record<string, string> = { H1: '1.8em', H2: '1.5em', H3: '1.25em', H4: '1.1em', H5: '1em', H6: '0.9em' };

function styleHeadings(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const size = HEADING_SIZE[h.tagName] ?? '1em';
    setStyle(h, `font-weight:700; margin:0.6em 0 0.3em; font-size:${size}`);
  });
}

function replaceTaskCheckboxes(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    const span = root.ownerDocument.createElement('span');
    span.textContent = cb.checked ? '☑ ' : '☐ ';
    setStyle(span, 'font-family:monospace');
    cb.replaceWith(span);
  });
}

