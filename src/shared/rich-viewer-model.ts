/**
 * Rich-viewer model (PURE) — issue 179, ADR-0023.
 *
 * The parse half of the shared rich viewer: frontmatter + a small legible
 * markdown-block parse (this repo deliberately has no markdown dependency;
 * the viewer needs "legible", not CommonMark), plus fenced-mermaid detection
 * so a ` ```mermaid ` block renders as a diagram instead of plain code.
 *
 * Grown out of `planning-model.ts`'s doc-preview parser (issue 83) — that
 * parser was already reused by three views (Planning, the curator-report
 * view, and the CORE-proposal diff, issue 151); this module is the one home
 * for it so a fourth (or fifth) caller doesn't reimplement it again.
 *
 * PURE: no I/O, no Electron, no timers, no DOM.
 */

/** One `key: value` frontmatter line (issue files: status / depends_on / hitl). */
export interface FrontmatterField {
  /** The key, or '' for a line that isn't `key: value` (kept verbatim). */
  key: string;
  value: string;
}

/** One list item; `checked` is null for a plain (non-checkbox) item. */
export interface RichListItem {
  text: string;
  checked: boolean | null;
}

/** The block shapes the rich viewer renders. Legible, not CommonMark. */
export type RichBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mermaid'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'list'; ordered: boolean; items: RichListItem[] };

export interface ParsedRichDoc {
  frontmatter: FrontmatterField[];
  blocks: RichBlock[];
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const ORDERED_ITEM_RE = /^\s*\d+[.)]\s+/;
const CHECKBOX_RE = /^\[([ xX])\]\s*(.*)$/;

/**
 * Parse one document into frontmatter fields + markdown blocks for the
 * read-only rich viewer. Handles what the pipeline's documents actually use:
 * a leading `---` frontmatter block, ATX headings, fenced code (a
 * ` ```mermaid ` fence becomes a `mermaid` block, any other fence a plain
 * `code` block), blockquotes, horizontal rules, ordered/unordered lists with
 * `- [ ]` checkboxes, and paragraphs. Never throws; unrecognized lines are
 * paragraph text.
 */
export function parseRichDoc(content: string): ParsedRichDoc {
  const frontmatter: FrontmatterField[] = [];
  let body = content;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    for (const raw of fmMatch[1].split(/\r?\n/)) {
      if (raw.trim().length === 0) continue;
      const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(raw.trim());
      if (kv) frontmatter.push({ key: kv[1].trim(), value: kv[2].trim() });
      else frontmatter.push({ key: '', value: raw.trim() });
    }
  }

  const blocks: RichBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;
  let codeIsMermaid = false;
  let list: { ordered: boolean; items: RichListItem[] } | null = null;

  const flushPara = (): void => {
    if (para.length > 0) blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  const flushQuote = (): void => {
    if (quote.length > 0) blocks.push({ kind: 'quote', text: quote.join(' ') });
    quote = [];
  };
  const flushList = (): void => {
    if (list !== null && list.items.length > 0)
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushAll = (): void => {
    flushPara();
    flushQuote();
    flushList();
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');

    if (code !== null) {
      if (line.trim().startsWith('```')) {
        blocks.push({ kind: codeIsMermaid ? 'mermaid' : 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    const fenceOpen = /^```\s*(\S*)/.exec(line.trim());
    if (fenceOpen) {
      flushAll();
      code = [];
      codeIsMermaid = fenceOpen[1].trim().toLowerCase() === 'mermaid';
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    if (line.startsWith('>')) {
      flushPara();
      flushList();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      const ordered = ORDERED_ITEM_RE.test(line);
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      const checkbox = CHECKBOX_RE.exec(item[1]);
      list.items.push(
        checkbox
          ? { text: checkbox[2], checked: checkbox[1] !== ' ' }
          : { text: item[1], checked: null },
      );
      continue;
    }

    // A continuation line while a list is open belongs to its last item.
    if (list !== null && /^\s+\S/.test(raw)) {
      const last = list.items[list.items.length - 1];
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }

    flushQuote();
    flushList();
    para.push(line.trim());
  }

  if (code !== null && code.length > 0)
    blocks.push({ kind: codeIsMermaid ? 'mermaid' : 'code', text: code.join('\n') });
  flushAll();

  return { frontmatter, blocks };
}

// --- Inline formatting -------------------------------------------------------------

/** One inline run of a block's text: plain, `code`, or **bold**. */
export interface InlineSegment {
  kind: 'text' | 'code' | 'bold';
  text: string;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

/**
 * Split a block's text into inline segments — code spans and bold runs — so
 * the rich viewer renders them legibly without a markdown dependency.
 * Anything else stays literal text.
 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) segments.push({ kind: 'text', text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith('`')) segments.push({ kind: 'code', text: token.slice(1, -1) });
    else segments.push({ kind: 'bold', text: token.slice(2, -2) });
    last = idx + token.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
