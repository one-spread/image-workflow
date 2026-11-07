// Converts Obsidian-rendered markdown DOM into paste formats for chat apps and
// plain-text destinations. Pure DOM code (no Obsidian API) so it can be tested
// outside Obsidian.

export type TextFlavor = 'plain' | 'slack' | 'gchat' | 'chatwork';

interface FlavorRules {
  bold(s: string): string;
  italic(s: string): string;
  strike(s: string): string;
  highlight(s: string): string;
  code(s: string): string;
  codeBlock(s: string): string;
  heading(level: number, s: string): string;
  quote(s: string): string;
  callout(title: string, body: string): string;
  link(text: string, href: string): string;
  table(rows: string[][], hasHeader: boolean): string;
  image(name: string): string;
  hr: string;
  bullet: string;
  indent: string;
}

// Zero-width space: Slack / Google Chat only apply *bold* when the markers sit
// on a word boundary, which fails next to Japanese characters.
const ZW = '​';

function wrapMark(mark: string, s: string): string {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || !m[2]) return s;
  return `${m[1]}${ZW}${mark}${m[2]}${mark}${ZW}${m[3]}`;
}

function prefixLines(prefix: string, s: string): string {
  return s.split('\n').map((l) => prefix + l).join('\n');
}

function linkText(text: string, href: string, sep: (t: string, h: string) => string): string {
  const t = text.trim();
  if (!t || t === href || t === href.replace(/^https?:\/\//, '')) return href;
  return sep(t, href);
}

const imageLabel = (name: string) => `[画像: ${name}]`;

const MARKUP_CHAT: FlavorRules = {
  bold: (s) => wrapMark('*', s),
  italic: (s) => wrapMark('_', s),
  strike: (s) => wrapMark('~', s),
  highlight: (s) => wrapMark('*', s),
  code: (s) => '`' + s + '`',
  codeBlock: (s) => '```\n' + s + '\n```',
  heading: (_l, s) => wrapMark('*', s),
  quote: (s) => prefixLines('> ', s),
  callout: (t, b) => prefixLines('> ', wrapMark('*', t) + (b ? '\n' + b : '')),
  link: (t, h) => linkText(t, h, (tt, hh) => `${tt} (${hh})`),
  table: (rows, header) => '```\n' + padTable(rows, header) + '\n```',
  image: imageLabel,
  hr: '──────────',
  bullet: '• ',
  indent: '    ',
};

export const FLAVORS: Record<TextFlavor, FlavorRules> = {
  plain: {
    bold: (s) => s,
    italic: (s) => s,
    strike: (s) => s,
    highlight: (s) => s,
    code: (s) => s,
    codeBlock: (s) => s,
    heading: (_l, s) => s,
    quote: (s) => s,
    callout: (t, b) => `【${t}】` + (b ? '\n' + b : ''),
    link: (t, h) => linkText(t, h, (tt, hh) => `${tt}（${hh}）`),
    table: (rows) => rows.map((r) => r.join('\t')).join('\n'),
    image: imageLabel,
    hr: '──────────',
    bullet: '・',
    indent: '  ',
  },
  slack: MARKUP_CHAT,
  gchat: MARKUP_CHAT,
  chatwork: {
    bold: (s) => s,
    italic: (s) => s,
    strike: (s) => s,
    highlight: (s) => (s.trim() ? `【${s.trim()}】` : s),
    code: (s) => s,
    codeBlock: (s) => `[code]${s}[/code]`,
    heading: (l, s) => (l <= 2 ? `■ ${s}` : `● ${s}`),
    quote: (s) => prefixLines('＞ ', s),
    callout: (t, b) => `[info][title]${t}[/title]${b}[/info]`,
    link: (t, h) => linkText(t, h, (tt, hh) => `${tt} ${hh}`),
    table: (rows, header) => `[code]${padTable(rows, header)}[/code]`,
    image: imageLabel,
    hr: '[hr]',
    bullet: '・',
    indent: '  ',
  },
};

// ---- Text serializer ----

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE',
  'TABLE', 'HR', 'DIV', 'SECTION', 'FIGURE', 'DETAILS', 'SUMMARY', 'LI', 'DL',
]);

function isElement(n: Node): n is HTMLElement {
  return n.nodeType === 1;
}

function isBlock(n: Node): boolean {
  if (!isElement(n)) return false;
  if (BLOCK_TAGS.has(n.tagName)) return true;
  return n.classList.contains('markdown-embed');
}

export function serializeToText(root: HTMLElement, flavor: TextFlavor): string {
  const out = blocks(root, FLAVORS[flavor], 0);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blocks(container: Element, r: FlavorRules, depth: number): string {
  const parts: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.replace(/^\n+|\n+$/g, '');
    if (t.trim()) parts.push(t);
    buf = '';
  };
  container.childNodes.forEach((n) => {
    if (isBlock(n)) {
      flush();
      const b = block(n as HTMLElement, r, depth);
      if (b.trim()) parts.push(b);
    } else {
      buf += inline(n, r);
    }
  });
  flush();
  return parts.join('\n\n');
}

function block(el: HTMLElement, r: FlavorRules, depth: number): string {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return r.heading(Number(tag[1]), inlineChildren(el, r).trim());
  switch (tag) {
    case 'P':
      return inlineChildren(el, r).replace(/^\n+|\n+$/g, '');
    case 'UL':
    case 'OL':
      return list(el, r, depth);
    case 'BLOCKQUOTE':
      return r.quote(blocks(el, r, depth));
    case 'PRE':
      return r.codeBlock(codeText(el));
    case 'TABLE':
      return table(el, r);
    case 'HR':
      return r.hr;
  }
  if (el.classList.contains('callout')) {
    const title = el.querySelector('.callout-title-inner')?.textContent?.trim()
      || el.getAttribute('data-callout') || '';
    const content = el.querySelector<HTMLElement>('.callout-content');
    return r.callout(title, content ? blocks(content, r, depth) : '');
  }
  if (el.classList.contains('mermaid') || el.querySelector(':scope > .mermaid')) return '[Mermaid図]';
  return blocks(el, r, depth);
}

function codeText(pre: HTMLElement): string {
  const code = pre.querySelector('code') ?? pre;
  return (code.textContent ?? '').replace(/\n+$/, '').replace(/\t/g, '    ');
}

function list(el: HTMLElement, r: FlavorRules, depth: number): string {
  const ordered = el.tagName === 'OL';
  let n = parseInt(el.getAttribute('start') ?? '1', 10) || 1;
  const indent = r.indent.repeat(depth);
  const lines: string[] = [];

  Array.from(el.children).forEach((li) => {
    if (li.tagName !== 'LI') return;
    let marker = ordered ? `${n++}. ` : r.bullet;
    if (li.classList.contains('task-list-item')) {
      const cb = li.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const task = li.getAttribute('data-task');
      const checked = cb ? cb.checked || cb.hasAttribute('checked') : !!task && task !== ' ';
      const box = checked ? '☑ ' : '☐ ';
      marker = ordered ? marker + box : box;
    }

    let text = '';
    const subs: string[] = [];
    li.childNodes.forEach((c) => {
      if (isElement(c)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') {
          subs.push(list(c, r, depth + 1));
          return;
        }
        if (c.tagName === 'INPUT') return;
        if (isBlock(c)) {
          const b = block(c, r, depth + 1);
          if (b.trim()) text += (text ? '\n' : '') + b;
          return;
        }
      }
      text += inline(c, r);
    });
    text = text.trim().replace(/\n/g, '\n' + indent + r.indent);
    lines.push(indent + marker + text);
    subs.forEach((s) => { if (s) lines.push(s); });
  });
  return lines.join('\n');
}

function tableRows(el: HTMLElement, cell: (c: HTMLElement) => string): { rows: string[][]; hasHeader: boolean } {
  const rows: string[][] = [];
  let hasHeader = false;
  el.querySelectorAll('tr').forEach((tr, i) => {
    const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH') as HTMLElement[];
    if (i === 0 && cells.length > 0 && cells.every((c) => c.tagName === 'TH')) hasHeader = true;
    rows.push(cells.map((c) => cell(c).replace(/\s*\n\s*/g, ' ').trim()));
  });
  return { rows, hasHeader };
}

function table(el: HTMLElement, r: FlavorRules): string {
  const { rows, hasHeader } = tableRows(el, (c) => inlineChildren(c, r));
  return rows.length ? r.table(rows, hasHeader) : '';
}

function inlineChildren(el: Node, r: FlavorRules): string {
  let s = '';
  el.childNodes.forEach((c) => { s += inline(c, r); });
  return s;
}

function inline(n: Node, r: FlavorRules): string {
  if (n.nodeType === 3) return n.nodeValue ?? '';
  if (!isElement(n)) return '';
  const el = n;
  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return r.bold(inlineChildren(el, r));
    case 'EM':
    case 'I':
      return r.italic(inlineChildren(el, r));
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return r.strike(inlineChildren(el, r));
    case 'MARK':
      return r.highlight(inlineChildren(el, r));
    case 'CODE':
      return r.code(el.textContent ?? '');
    case 'IMG':
      return r.image(imageName(el.getAttribute('alt') || el.getAttribute('src') || ''));
    case 'INPUT':
      return '';
    case 'SUP':
      return `[${(el.textContent ?? '').trim()}]`;
    case 'A': {
      const text = inlineChildren(el, r);
      if (el.classList.contains('internal-link') || el.classList.contains('tag')) return text;
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      return r.link(text, href);
    }
  }
  if (el.classList.contains('internal-embed')) {
    const src = el.getAttribute('src') ?? el.getAttribute('alt') ?? '';
    if (el.classList.contains('image-embed') || el.querySelector('img')) return r.image(imageName(src));
    return `[${src}]`;
  }
  if (el.tagName.toLowerCase() === 'mjx-container' || el.classList.contains('math')) return '[数式]';
  if (el.tagName.toLowerCase() === 'svg') return '';
  return inlineChildren(el, r);
}

function imageName(src: string): string {
  const clean = src.split(/[?#]/)[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || clean);
  } catch {
    return clean.split('/').pop() || clean;
  }
}

// ---- Table padding (monospace alignment, CJK = 2 columns) ----

function charWidth(c: number): number {
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
  ) return 2;
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export function padTable(rows: string[][], hasHeader: boolean): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) widths[i] = Math.max(...rows.map((r) => strWidth(r[i] ?? '')));
  const line = (r: string[]) =>
    widths.map((w, i) => {
      const c = r[i] ?? '';
      return c + ' '.repeat(w - strWidth(c));
    }).join(' | ').replace(/\s+$/, '');
  const out = rows.map(line);
  if (hasHeader && out.length > 1) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('-+-'));
  return out.join('\n');
}

// ---- Simplified rich HTML for chat composers (Slack / Google Chat) ----
// Chat composers keep bold / italic / lists / links / code from pasted HTML but
// drop colors, tables and images, so convert those into something they keep.

export function buildChatHtml(root: HTMLElement): string {
  const doc = root.ownerDocument;
  const clone = root.cloneNode(true) as HTMLElement;

  const replaceTag = (el: Element, tag: string) => {
    const next = doc.createElement(tag);
    while (el.firstChild) next.appendChild(el.firstChild);
    el.replaceWith(next);
    return next;
  };

  clone.querySelectorAll('mark').forEach((el) => replaceTag(el, 'b'));
  clone.querySelectorAll('del, strike').forEach((el) => replaceTag(el, 's'));
  clone.querySelectorAll('a.internal-link, a.tag').forEach((el) => replaceTag(el, 'span'));
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el) => {
    const p = doc.createElement('p');
    const b = doc.createElement('b');
    while (el.firstChild) b.appendChild(el.firstChild);
    p.appendChild(b);
    el.replaceWith(p);
  });
  clone.querySelectorAll('.internal-embed, img').forEach((el) => {
    if (!clone.contains(el)) return;
    if (el.tagName === 'IMG' || el.classList.contains('image-embed') || el.querySelector('img')) {
      const name = imageName(el.getAttribute('src') || el.getAttribute('alt') || '');
      el.replaceWith(doc.createTextNode(imageLabel(name)));
    }
  });
  clone.querySelectorAll('.mermaid').forEach((el) => el.replaceWith(doc.createTextNode('[Mermaid図]')));
  clone.querySelectorAll('mjx-container, .math').forEach((el) => el.replaceWith(doc.createTextNode('[数式]')));
  clone.querySelectorAll('svg').forEach((el) => el.remove());
  clone.querySelectorAll('table').forEach((el) => {
    const { rows, hasHeader } = tableRows(el, (c) => c.textContent ?? '');
    const pre = doc.createElement('pre');
    pre.textContent = padTable(rows, hasHeader);
    el.replaceWith(pre);
  });
  clone.querySelectorAll('pre').forEach((pre) => {
    const text = codeText(pre);
    const next = doc.createElement('pre');
    next.textContent = text;
    pre.replaceWith(next);
  });
  clone.querySelectorAll('.callout').forEach((co) => {
    const title = co.querySelector('.callout-title-inner')?.textContent?.trim() || co.getAttribute('data-callout') || '';
    const content = co.querySelector('.callout-content');
    const bq = doc.createElement('blockquote');
    const b = doc.createElement('b');
    b.textContent = title;
    bq.appendChild(b);
    if (content) while (content.firstChild) bq.appendChild(content.firstChild);
    co.replaceWith(bq);
  });
  clone.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    const checked = (cb as HTMLInputElement).checked || cb.hasAttribute('checked');
    cb.replaceWith(doc.createTextNode(checked ? '☑ ' : '☐ '));
  });
  clone.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class');
    el.removeAttribute('style');
    el.removeAttribute('data-task');
    el.removeAttribute('dir');
  });

  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><!--StartFragment-->' +
    clone.innerHTML + '<!--EndFragment--></body></html>';
}
