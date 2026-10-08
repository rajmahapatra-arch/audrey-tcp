/**
 * Structure-aware chunker for converted Markdown (document-ingestion spec
 * §3.5, step I5).
 *
 * Documents are converted once at upload to Markdown in which Word's
 * automatic clause numbers are real text ("12.3 Limitation of liability")
 * and headings are `#` lines. Passages should follow that structure, not
 * fixed character windows, and each passage should say where it comes
 * from — the chat and search_matter_text cite it.
 *
 * Strategy:
 *   1. Split the Markdown into blocks (blank-line separated); drop
 *      `<!-- page N -->` markers (they are citation scaffolding, not text).
 *   2. A block that is a heading or starts with a clause number opens a new
 *      unit; other blocks join the current unit.
 *   3. Pack consecutive units into a chunk up to TARGET_CHARS. A heading
 *      always starts a new chunk once the current one has MIN_CHARS, so
 *      unrelated sections do not share a passage (tiny ones still merge).
 *   4. A unit longer than HARD_MAX_CHARS falls back to the size-based
 *      chunkText() (paragraph/sentence packing with overlap); every piece
 *      keeps the unit's label.
 *   5. Each chunk's text starts with its label in brackets, e.g.
 *      "[12.3 Limitation of liability]" — clause number plus the clause's
 *      own short title, or the enclosing heading when it has none.
 *
 * Text with no headings or clause numbers at all (plain text pasted by a
 * connector, legacy rows) goes straight to chunkText(), unchanged from
 * before, so nothing regresses for unstructured input.
 */

import { chunkText, type Chunk } from './chunker.js';

const TARGET_CHARS = 2000;
const HARD_MAX_CHARS = 3000;
const MIN_CHARS = 400;
const MAX_LABEL_CHARS = 90;

const PAGE_MARKER_RE = /^<!--\s*page\s+\d+\s*-->$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// "12.3 Text", "12. Text", "12.3.1 Text" (optionally bold-wrapped number)
const NUMBERED_RE = /^(?:\*\*)?(\d{1,3}(?:\.\d{1,3}){0,4})(\.)?(?:\*\*)?\s+(\S.*)$/s;
const KEYWORD_RE = /^(?:\*\*)?((?:Clause|Section|Article|Schedule|Part|Annex|Appendix|Exhibit)\s+[0-9A-Z]{1,6}(?:\.\d{1,3})*)\.?(?:\*\*)?(?:\s+[-–—:]?\s*(\S.*))?$/is;

interface Unit {
  /** label for this unit, without brackets */
  label: string | null;
  /** true when the unit begins with a Markdown heading */
  isHeading: boolean;
  blocks: string[];
}

/** Strip Markdown emphasis/escapes for use in a label. */
function plain(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\\\w])\*(\S(?:[^*\n]*?\S)?)\*(?=[^\w]|$)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, n = MAX_LABEL_CHARS): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '') + '…';
}

/**
 * A clause's own title: "Limitation of liability" in
 *   "12.3 Limitation of liability"               (a short title line)
 *   "12.3 **Limitation of liability.** The ..."  (bold lead-in)
 * or null when the clause starts straight into prose.
 */
function ownTitle(rest: string): string | null {
  const bold = rest.match(/^\*\*([^*\n]{2,120}?)\*\*/);
  if (bold) return plain(bold[1]).replace(/[.:]$/, '');
  const firstLine = rest.split('\n')[0];
  const p = plain(firstLine);
  // A short line that is not a sentence reads as a title.
  if (p.length <= 80 && !/[.;:,]$/.test(p) && !rest.includes('\n') && p.split(' ').length <= 10) return p;
  return null;
}

interface Classified {
  kind: 'heading' | 'clause' | 'body';
  label: string | null;
  /** title text usable as heading context for later clauses */
  headingTitle?: string | null;
}

function classify(block: string, headingContext: string | null): Classified {
  const h = block.match(HEADING_RE);
  if (h && !block.includes('\n')) {
    const text = plain(h[2]);
    // "# 12 Liability" -> number 12, title Liability
    const num = text.match(/^(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+(.+)$/);
    const title = num ? num[2] : text;
    return { kind: 'heading', label: clip(text), headingTitle: title };
  }
  const n = block.match(NUMBERED_RE);
  if (n) {
    const number = n[1];
    // Guard against prose that merely starts with a figure ("30 days after...")
    // by requiring either a dotted number, a trailing dot, or a capital next.
    const looksLikeClause = number.includes('.') || !!n[2] || /^[A-Z("“*]/.test(n[3]);
    if (looksLikeClause) {
      const t = ownTitle(n[3]);
      const title = t ?? headingContext;
      return { kind: 'clause', label: clip(title ? `${number} ${title}` : number), headingTitle: t };
    }
  }
  const k = block.match(KEYWORD_RE);
  if (k && (k[2] === undefined || block.split('\n')[0].length <= 120)) {
    const t = k[2] ? ownTitle(k[2]) : null;
    return { kind: 'clause', label: clip(plain(t ? `${k[1]} ${t}` : k[1])), headingTitle: t };
  }
  return { kind: 'body', label: null };
}

/**
 * A single block over HARD_MAX_CHARS with internal line breaks — almost
 * always a Markdown table (rows are single-newline separated, so neither the
 * paragraph nor the sentence splitter can cut it) — is split on lines. Table
 * pieces repeat the header row + separator so every passage stays readable.
 */
function splitLongBlock(block: string): string[] {
  if (block.length <= HARD_MAX_CHARS || !block.includes('\n')) return [block];
  const lines = block.split('\n');
  const isTable = lines.length > 2 && lines[0].startsWith('|') && /^\|?\s*:?-{2,}/.test(lines[1]);
  const header = isTable ? lines.slice(0, 2).join('\n') : '';
  const body = isTable ? lines.slice(2) : lines;
  const out: string[] = [];
  let cur: string[] = [];
  let size = header.length;
  for (const line of body) {
    if (cur.length && size + line.length + 1 > TARGET_CHARS) {
      out.push((header ? header + '\n' : '') + cur.join('\n'));
      cur = [];
      size = header.length;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length) out.push((header ? header + '\n' : '') + cur.join('\n'));
  return out;
}

/** True when the text carries Markdown structure worth chunking on. */
export function hasStructure(text: string): boolean {
  let hits = 0;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (HEADING_RE.test(l) || /^(?:\*\*)?\d{1,3}\.\d{1,3}(?:\.\d{1,3})*\.?(?:\*\*)?\s+\S/.test(l)) {
      if (++hits >= 2) return true;
    }
  }
  return false;
}

/**
 * Chunk converted Markdown on headings and numbered clauses, falling back to
 * chunkText() for unstructured input and for over-long sections.
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const normalised = markdown.replace(/\r\n?/g, '\n').trim();
  if (normalised.length === 0) return [];
  if (!hasStructure(normalised)) return chunkText(normalised);

  const blocks = normalised
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && !PAGE_MARKER_RE.test(b))
    .flatMap(splitLongBlock);

  // 1. Units
  const units: Unit[] = [];
  let headingContext: string | null = null;
  for (const block of blocks) {
    const c = classify(block, headingContext);
    if (c.kind === 'heading') {
      headingContext = c.headingTitle ?? null;
      units.push({ label: c.label, isHeading: true, blocks: [block] });
    } else if (c.kind === 'clause') {
      units.push({ label: c.label, isHeading: false, blocks: [block] });
    } else if (units.length === 0) {
      units.push({ label: null, isHeading: false, blocks: [block] }); // preamble
    } else {
      units[units.length - 1].blocks.push(block);
    }
  }

  // 2. Pack units into chunks
  const out: Array<{ label: string | null; body: string }> = [];
  let buf: { label: string | null; parts: string[]; size: number } | null = null;
  const flush = () => {
    if (buf && buf.parts.length) out.push({ label: buf.label, body: buf.parts.join('\n\n') });
    buf = null;
  };

  for (const u of units) {
    const body = u.blocks.join('\n\n');
    if (body.length > HARD_MAX_CHARS) {
      flush();
      for (const piece of chunkText(body)) out.push({ label: u.label, body: piece.text });
      continue;
    }
    if (buf) {
      const b: { label: string | null; parts: string[]; size: number } = buf;
      const tooBig = b.size + 2 + body.length > TARGET_CHARS;
      const newSection = u.isHeading && b.size >= MIN_CHARS;
      if (tooBig || newSection) flush();
    }
    if (!buf) buf = { label: u.label, parts: [], size: 0 };
    const cur: { label: string | null; parts: string[]; size: number } = buf;
    if (!cur.label && u.label) cur.label = u.label;
    cur.parts.push(body);
    cur.size += body.length + 2;
  }
  flush();

  // 3. Label + offsets (best-effort: locate each chunk body in the source)
  const chunks: Chunk[] = [];
  let cursor = 0;
  for (const c of out) {
    const probe = c.body.slice(0, 80);
    const at = normalised.indexOf(probe, cursor);
    const start = at >= 0 ? at : cursor;
    cursor = at >= 0 ? at + 1 : cursor;
    const text = c.label ? `[${c.label}]\n${c.body}` : c.body;
    chunks.push({ index: chunks.length, text, startOffset: start, endOffset: start + c.body.length });
  }
  return chunks;
}
