/**
 * Word-level diff engine — the deterministic core of surgical markup.
 *
 * Problem: when a model proposes a document edit as an (old_text,
 * new_text) pair, it systematically widens old_text for anchor-safety
 * (a wide span is guaranteed unique; a narrow one risks ambiguity).
 * Apply layers implement the pair as one delete+insert spanning the
 * whole old_text — so a one-word change arrives as a paragraph-sized
 * block redline. Prompting the model to emit minimal spans fights its
 * gradient and loses under context load (field-observed, 2026-05-19
 * SOW session).
 *
 * Fix: let the model be sloppy, make the tightness deterministic.
 * This module computes a word-level LCS diff between the pair and
 * emits one minimal (old, new) replacement per changed run, each
 * padded with a small, configurable number of unchanged context words
 * so the span anchors uniquely in typical legal prose.
 *
 * Consumers:
 *   - tighten_edits MCP tool (TCP surfaces: Claude for Word / Desktop /
 *     phone stage the returned pairs instead of their wide originals)
 *   - Audrey App apply path (App restoration Phase B — every edit is
 *     routed through this unconditionally before touching the doc)
 *
 * Deliberately dependency-free: token-level LCS via dynamic
 * programming, inputs capped so the DP table stays small.
 */

// ============================================================
// Tokenisation — words with their exact source offsets
// ============================================================
//
// Tokens are maximal runs of non-whitespace. Punctuation stays glued
// to its word ("Solution." ≠ "Solution"), which is what makes
// sentence-boundary edits come out as tight, lawyer-natural redlines.
// Slices for output are always taken from the ORIGINAL strings, so
// smart quotes, tabs, and multiple spaces survive untouched.

interface Token {
  text: string;
  start: number; // char offset of first char in source
  end: number; // char offset AFTER last char
}

export function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

// ============================================================
// LCS over token text (exact, case-sensitive — legal text)
// ============================================================

/**
 * Returns a boolean "keep" mask per side: kept tokens are part of the
 * longest common subsequence; everything else is a changed run.
 */
function lcsKeepMasks(a: Token[], b: Token[]): { keepA: boolean[]; keepB: boolean[] } {
  const n = a.length;
  const m = b.length;
  // DP table as flat Int32Array; inputs are capped by the caller so
  // (n+1)*(m+1) stays comfortably in memory.
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i].text === b[j].text
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      keepA[i] = true;
      keepB[j] = true;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return { keepA, keepB };
}

// ============================================================
// Changed runs → minimal replacement pairs with context padding
// ============================================================

export interface TightEdit {
  old_text: string;
  new_text: string;
}

export interface TightenResult {
  edits: TightEdit[];
  /** true when old and new are identical at the word level */
  unchanged: boolean;
  stats: {
    original_old_words: number;
    changed_old_words: number;
    edits_count: number;
  };
}

interface Run {
  aFrom: number; // token index into old, inclusive
  aTo: number; // exclusive
  bFrom: number;
  bTo: number; // exclusive
}

/**
 * Walk both keep-masks in lockstep and group consecutive non-kept
 * tokens (on either side) into aligned changed runs.
 */
function changedRuns(
  a: Token[],
  b: Token[],
  keepA: boolean[],
  keepB: boolean[]
): Run[] {
  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keepA[i] && keepB[j]) {
      i++;
      j++;
      continue;
    }
    const run: Run = { aFrom: i, aTo: i, bFrom: j, bTo: j };
    while (i < a.length && !keepA[i]) i++;
    while (j < b.length && !keepB[j]) j++;
    run.aTo = i;
    run.bTo = j;
    runs.push(run);
  }
  return runs;
}

/**
 * Merge runs whose context windows would overlap or touch, so we never
 * emit two edits with overlapping anchors (which an apply layer would
 * reject or mis-order).
 */
function mergeCloseRuns(runs: Run[], contextWords: number): Run[] {
  if (runs.length === 0) return runs;
  const merged: Run[] = [runs[0]];
  for (let k = 1; k < runs.length; k++) {
    const prev = merged[merged.length - 1];
    const cur = runs[k];
    // Gap measured in unchanged old-side tokens between the runs; if
    // the two context pads would meet or cross, merge.
    if (cur.aFrom - prev.aTo <= contextWords * 2) {
      prev.aTo = cur.aTo;
      prev.bTo = cur.bTo;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Compute minimal word-level replacement pairs for a single wide
 * (oldText, newText) proposal.
 *
 * contextWords: unchanged words included on each side of a changed run
 * for anchoring (default 2). Pure insertions/deletions always get at
 * least one context word so the emitted old_text is never empty.
 */
export function tightenPair(
  oldText: string,
  newText: string,
  contextWords = 2
): TightenResult {
  const a = tokenize(oldText);
  const b = tokenize(newText);

  const { keepA, keepB } = lcsKeepMasks(a, b);
  const runs = mergeCloseRuns(changedRuns(a, b, keepA, keepB), contextWords);

  if (runs.length === 0) {
    return {
      edits: [],
      unchanged: true,
      stats: { original_old_words: a.length, changed_old_words: 0, edits_count: 0 },
    };
  }

  const edits: TightEdit[] = [];
  let changedOldWords = 0;

  for (const run of runs) {
    changedOldWords += run.aTo - run.aFrom;

    // Context window in token indices, clamped to bounds. When the
    // old side of the run is empty (pure insertion) we still have
    // context tokens to anchor on; if the whole old text is empty
    // that's caller error (validated at the tool boundary).
    let ctxFrom = Math.max(0, run.aFrom - contextWords);
    let ctxTo = Math.min(a.length, run.aTo + contextWords);
    // Guarantee a non-empty old span even at the extremes.
    if (ctxFrom === ctxTo) {
      if (ctxTo < a.length) ctxTo += 1;
      else if (ctxFrom > 0) ctxFrom -= 1;
    }

    // Old slice from original chars: start of first context token to
    // end of last.
    const oldSlice = oldText.slice(a[ctxFrom].start, a[ctxTo - 1].end);

    // New slice: same leading/trailing context tokens (they are kept,
    // so they exist on the b side in order), with the run's b-tokens
    // between them. Map: leading context tokens are a[ctxFrom..run.aFrom)
    // — kept tokens correspond 1:1 in b before bFrom; count them.
    const leadCount = run.aFrom - ctxFrom;
    const trailCount = ctxTo - run.aTo;
    const bLeadFrom = run.bFrom - leadCount;
    const bTrailTo = run.bTo + trailCount;
    const bFromTok = b[Math.max(0, bLeadFrom)];
    const bToTok = b[Math.min(b.length, bTrailTo) - 1];
    const newSlice =
      bFromTok && bToTok && bLeadFrom < bTrailTo
        ? newText.slice(bFromTok.start, bToTok.end)
        : // Pure deletion with no b-side tokens in window: rebuild from
          // the old context minus the deleted run.
          [
            ...a.slice(ctxFrom, run.aFrom).map((t) => t.text),
            ...a.slice(run.aTo, ctxTo).map((t) => t.text),
          ].join(' ');

    edits.push({ old_text: oldSlice, new_text: newSlice });
  }

  return {
    edits,
    unchanged: false,
    stats: {
      original_old_words: a.length,
      changed_old_words: changedOldWords,
      edits_count: edits.length,
    },
  };
}
