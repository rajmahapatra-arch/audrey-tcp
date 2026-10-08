import { describe, expect, test } from 'vitest';
import { chunkMarkdown, hasStructure } from './markdownChunker.js';
import { chunkText } from './chunker.js';

const filler = (n: number, word = 'obligation') =>
  Array.from({ length: n }, (_, i) => `${word}${i % 7}`).join(' ') + '.';

const CONTRACT = [
  '# MASTER SERVICES AGREEMENT',
  'This agreement is made between the Supplier and the Customer.',
  '<!-- page 1 -->',
  '# 1 Definitions',
  '1.1 **"Business Day"** means a day other than a Saturday or Sunday.',
  '1.2 **"Services"** means the services in Schedule 1.',
  '# 12 Liability',
  '12.1 Neither party excludes liability for death or personal injury.',
  '12.3 **Limitation of liability.** ' + filler(40),
  '(a) ' + filler(10, 'limb'),
  '(b) ' + filler(10, 'limb'),
  '<!-- page 2 -->',
  'Schedule 1 Services',
  'The Supplier shall provide support.',
].join('\n\n');

describe('chunkMarkdown', () => {
  test('splits on headings and carries clause/heading labels', () => {
    const chunks = chunkMarkdown(CONTRACT);
    const labels = chunks.map((c) => c.text.split('\n')[0]);
    // Tiny sections merge, but a heading starts a new passage once the
    // current one is substantial; every passage starts with its label.
    expect(chunks.every((c) => c.text.startsWith('['))).toBe(true);
    expect(labels[0]).toBe('[MASTER SERVICES AGREEMENT]');
    const liability = chunks.find((c) => c.text.includes('12.3 **Limitation of liability.**'));
    expect(liability).toBeDefined();
    // the passage holding 12.3 also holds its limbs
    expect(liability!.text).toContain('(b) limb');
    // page markers are not passage text
    expect(chunks.some((c) => c.text.includes('<!--'))).toBe(false);
    // indices are sequential
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test('a clause with a bold lead-in is labelled with its own title', () => {
    const md = ['# 12 Liability', '12.3 **Limitation of liability.** ' + filler(380)].join('\n\n');
    const chunks = chunkMarkdown(md);
    const withClause = chunks.filter((c) => c.text.includes('12.3'));
    expect(withClause.length).toBeGreaterThan(0);
    // 12.3 is long enough to stand alone (> target), so it gets its own label
    expect(chunks.some((c) => c.text.startsWith('[12.3 Limitation of liability]'))).toBe(true);
  });

  test('clause without a title falls back to the enclosing heading title', () => {
    const md = ['# 7 Payment', filler(120), '7.2 The Customer shall pay within 30 days. ' + filler(330)].join('\n\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.some((c) => c.text.startsWith('[7.2 Payment]'))).toBe(true);
  });

  test('over-long sections fall back to the size-based chunker, label repeated', () => {
    const long = Array.from({ length: 12 }, () => filler(60)).join('\n\n'); // ~ 6-7k chars, one unit
    const md = ['# 4 Services', '4.1 **Scope.** Intro.', long].join('\n\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.startsWith('[4.1 Scope]') || c.text.startsWith('[4 Services]')).toBe(true);
      expect(c.text.length).toBeLessThan(3200);
    }
  });

  test('prose starting with a figure is not mistaken for a clause', () => {
    const md = ['# 1 Term', '1.1 The term is five years.', '30 days after notice the agreement ends.'].join('\n\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('30 days after notice');
  });

  test('unstructured text is chunked exactly as before', () => {
    const plainText = Array.from({ length: 8 }, () => filler(80, 'word')).join('\n\n');
    expect(hasStructure(plainText)).toBe(false);
    expect(chunkMarkdown(plainText)).toEqual(chunkText(plainText));
  });

  test('long Markdown tables are split on rows, header repeated', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| Item ${i} | ${filler(4, 'cell')} |`);
    const md = ['# 3 Charges', '3.1 The charges are:', ['| Item | Charge |', '| --- | --- |', ...rows].join('\n')].join('\n\n');
    const chunks = chunkMarkdown(md);
    const tableChunks = chunks.filter((c) => c.text.includes('| Item 1'));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThan(3200);
    for (const c of chunks.filter((x) => x.text.includes('| Item 5'))) expect(c.text).toContain('| Item | Charge |\n| --- | --- |');
    expect(tableChunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join('\n')).toContain('| Item 119 |');
  });

  test('empty input', () => {
    expect(chunkMarkdown('   \n\n ')).toEqual([]);
  });

  test('all text survives (no loss across chunk boundaries)', () => {
    const chunks = chunkMarkdown(CONTRACT);
    const joined = chunks.map((c) => c.text).join('\n');
    for (const needle of ['made between the Supplier', '"Business Day"', 'personal injury', 'limb6', 'provide support']) {
      expect(joined).toContain(needle);
    }
  });
});
