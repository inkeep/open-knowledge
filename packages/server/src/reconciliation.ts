import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';

/**
 * Three-way reconciliation for external writes.
 *
 * Operates on markdown strings (not Y.Doc) — pure function, no Hocuspocus dependency.
 *
 * Three versions:
 *   base  — reconciledBase (last known-good state shared between Y.Doc and disk)
 *   ours  — current Y.Doc serialized to markdown
 *   theirs — content just read from disk (external write)
 *
 * Outcomes:
 *   clean     — Y.Doc was clean (ours === base), just apply theirs
 *   merged    — both changed non-overlapping blocks, auto-resolved
 *   conflicts — both changed overlapping blocks, needs human resolution
 *   refused   — theirs contains git conflict markers OR block-merge would
 *               exceed `MAX_LCS_CELLS` (refuse to ingest rather than OOM)
 *   noop      — theirs === base, nothing changed on disk
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReconcileInput {
  docName: string;
  base: string;
  ours: string;
  theirs: string;
}

export interface BlockConflict {
  blockIndex: number;
  base: string;
  ours: string;
  theirs: string;
}

export type ReconcileOutcome =
  | { kind: 'clean'; newContent: string }
  | { kind: 'merged'; newContent: string; mergedBlocks: number }
  | { kind: 'conflicts'; newContent: string; conflicts: BlockConflict[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'noop' };

// ─── LCS resource bound ──────────────────────────────────────────────────────

/**
 * Hard cap on the LCS DP table size, in cells.
 *
 * The block-level merge runs LCS over `splitMarkdownBlocks(ours)` and
 * `splitMarkdownBlocks(theirs)`, which allocates an `(m+1) * (n+1)` DP grid.
 * A pathologically large markdown file (millions of blank-line-separated
 * blocks) would otherwise drive this allocation past process memory and
 * crash the server on every external-disk update — the file watcher would
 * re-trigger reconcile on the next event and OOM again.
 *
 * 4_000_000 cells × 4 bytes (Uint32Array) ≈ 16 MB, which matches the
 * `MAX_STDOUT_BYTES` ceiling used elsewhere on this code path. Permits
 * symmetric ~2000×2000 or asymmetric ~1000×4000 merges — well above any
 * realistic prose document, while still bounded.
 */
export const MAX_LCS_CELLS = 4_000_000;

// ─── Conflict marker detection ───────────────────────────────────────────────

/**
 * Detect git conflict markers in content.
 * Covers merge, diff3, and zdiff3 styles.
 */
export const CONFLICT_MARKER_RE = /^(<{7} |={7}$|>{7} |\|{7} )/m;

export function containsConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}

// ─── Block splitting ─────────────────────────────────────────────────────────

/**
 * Split markdown into top-level blocks (paragraphs, headings, etc.).
 * Blocks are separated by blank lines. Respects fenced code blocks
 * (``` and ~~~) — blank lines inside fences do not cause splits.
 *
 * Adapted from packages/app/src/editor/three-way-merge.ts.
 */
export function splitMarkdownBlocks(md: string): string[] {
  const normalized = md.replace(/\n+$/, '');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fenceChar: string | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!fenceChar) fenceChar = char;
      else if (char === fenceChar) fenceChar = null;
    }
    const inFence = fenceChar !== null;
    if (!inFence && line.trim() === '' && current.length > 0) {
      blocks.push(current.join('\n').trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

// ─── Three-way block merge ───────────────────────────────────────────────────

/**
 * Perform three-way reconciliation between base, ours, and theirs.
 */
export function reconcile(input: ReconcileInput): ReconcileOutcome {
  if (isSystemDoc(input.docName) || isConfigDoc(input.docName)) return { kind: 'noop' };
  const { base, ours, theirs } = input;

  // Check for conflict markers first — refuse to ingest
  if (containsConflictMarkers(theirs)) {
    return { kind: 'refused', reason: 'conflict-markers' };
  }

  // Noop: disk unchanged
  if (theirs === base) {
    return { kind: 'noop' };
  }

  // Clean: Y.Doc unchanged — just apply theirs
  if (ours === base) {
    return { kind: 'clean', newContent: theirs };
  }

  // Both changed — block-level merge
  const baseBlocks = splitMarkdownBlocks(base);
  const ourBlocks = splitMarkdownBlocks(ours);
  const theirBlocks = splitMarkdownBlocks(theirs);

  // Refuse if either block-level LCS would blow past the memory cap.
  // computeEditOps runs LCS on (base, ours) and (base, theirs).
  if (
    (baseBlocks.length + 1) * (ourBlocks.length + 1) > MAX_LCS_CELLS ||
    (baseBlocks.length + 1) * (theirBlocks.length + 1) > MAX_LCS_CELLS
  ) {
    return { kind: 'refused', reason: 'too-large' };
  }

  return mergeBlocks(baseBlocks, ourBlocks, theirBlocks);
}

/**
 * Block-level three-way merge.
 *
 * Uses LCS alignment to determine what ours and theirs did relative to base,
 * then produces a merged result or identifies conflicts.
 */
function mergeBlocks(
  baseBlocks: string[],
  ourBlocks: string[],
  theirBlocks: string[],
): ReconcileOutcome {
  const ourOps = computeEditOps(baseBlocks, ourBlocks);
  const theirOps = computeEditOps(baseBlocks, theirBlocks);

  const merged: string[] = [];
  const conflicts: BlockConflict[] = [];

  for (let i = 0; i < baseBlocks.length; i++) {
    const baseBlock = baseBlocks[i];
    const ourOp = ourOps.get(i);
    const theirOp = theirOps.get(i);

    // Flush insertions before this base position
    const ourInserts = ourOp?.insertsBefore ?? [];
    const theirInserts = theirOp?.insertsBefore ?? [];
    merged.push(...ourInserts, ...theirInserts);

    const ourAction = ourOp?.action ?? 'keep';
    const theirAction = theirOp?.action ?? 'keep';

    if (ourAction === 'keep' && theirAction === 'keep') {
      merged.push(baseBlock);
    } else if (ourAction === 'keep' && theirAction !== 'keep') {
      // Only theirs changed — accept theirs
      if (theirAction === 'modify' && theirOp?.newContent !== undefined) {
        merged.push(theirOp.newContent);
      }
      // theirAction === 'delete' → block removed, don't add
    } else if (ourAction !== 'keep' && theirAction === 'keep') {
      // Only ours changed — accept ours
      if (ourAction === 'modify' && ourOp?.newContent !== undefined) {
        merged.push(ourOp.newContent);
      }
    } else {
      // Both changed — check convergence
      const ourContent = ourAction === 'modify' ? ourOp?.newContent : null;
      const theirContent = theirAction === 'modify' ? theirOp?.newContent : null;

      if (ourContent === theirContent) {
        // Converged to same result
        if (ourContent !== null && ourContent !== undefined) merged.push(ourContent);
      } else {
        // True conflict
        conflicts.push({
          blockIndex: i,
          base: baseBlock,
          ours: ourContent ?? '',
          theirs: theirContent ?? '',
        });
        // Keep ours in merged output
        if (ourContent !== null && ourContent !== undefined) merged.push(ourContent);
      }
    }
  }

  // Flush trailing insertions (after the last base block)
  const lastOurOp = ourOps.get(baseBlocks.length);
  const lastTheirOp = theirOps.get(baseBlocks.length);
  if (lastOurOp?.insertsBefore) merged.push(...lastOurOp.insertsBefore);
  if (lastTheirOp?.insertsBefore) merged.push(...lastTheirOp.insertsBefore);

  const newContent = merged.length > 0 ? `${merged.join('\n\n')}\n` : '';

  if (conflicts.length > 0) {
    return { kind: 'conflicts', newContent, conflicts };
  }

  return { kind: 'merged', newContent, mergedBlocks: merged.length };
}

// ─── Edit operation computation ──────────────────────────────────────────────

interface EditOp {
  action: 'keep' | 'modify' | 'delete';
  newContent?: string;
  insertsBefore: string[];
}

/**
 * Compute edit operations from base → edited using LCS alignment.
 *
 * Returns a map keyed by base block index. Each entry describes what happened
 * to that base block (kept, modified, deleted) and any insertions before it.
 *
 * Entry at index `baseBlocks.length` captures trailing insertions.
 */
function computeEditOps(baseBlocks: string[], editedBlocks: string[]): Map<number, EditOp> {
  const ops = new Map<number, EditOp>();
  const lcs = longestCommonSubsequence(baseBlocks, editedBlocks);

  // Initialize all base positions
  for (let i = 0; i <= baseBlocks.length; i++) {
    ops.set(i, { action: 'keep', insertsBefore: [] });
  }

  // Mark matched base positions from LCS
  const matchedBase = new Set<number>();
  const matchedEdit = new Set<number>();
  for (const [bi, ei] of lcs) {
    matchedBase.add(bi);
    matchedEdit.add(ei);
  }

  // Walk through base and determine actions for unmatched blocks
  // Unmatched base blocks were either modified or deleted.
  // To pair them with modifications: look for unmatched edited blocks
  // between the surrounding LCS anchors.
  let prevEditAnchor = -1;

  for (let bi = 0; bi < baseBlocks.length; bi++) {
    if (matchedBase.has(bi)) {
      // This base block is in LCS — it was kept
      // Find its edit index to update prevEditAnchor
      const editIdx = lcs.find((p) => p[0] === bi)?.[1] ?? -1;

      // Collect insertions: unmatched edited blocks between prevEditAnchor and editIdx
      const inserts: string[] = [];
      for (let ei = prevEditAnchor + 1; ei < editIdx; ei++) {
        if (!matchedEdit.has(ei)) {
          inserts.push(editedBlocks[ei]);
        }
      }
      const op = ops.get(bi);
      if (op) op.insertsBefore = inserts;

      prevEditAnchor = editIdx;
    } else {
      // Base block not in LCS — it was modified or deleted
      // Look for unmatched edited blocks adjacent to this position
      // Find next LCS anchor in base
      const nextBaseAnchor = lcs.find((p) => p[0] > bi);
      const nextEditAnchor = nextBaseAnchor ? nextBaseAnchor[1] : editedBlocks.length;

      // Find unmatched edited blocks between prevEditAnchor and nextEditAnchor
      // that haven't been consumed yet
      const candidateEdits: number[] = [];
      for (let ei = prevEditAnchor + 1; ei < nextEditAnchor; ei++) {
        if (!matchedEdit.has(ei)) {
          candidateEdits.push(ei);
        }
      }

      if (candidateEdits.length > 0) {
        // Take the first available unmatched edited block as the modification
        const editIdx = candidateEdits[0];
        matchedEdit.add(editIdx); // consume it
        const op = ops.get(bi);
        if (op) {
          op.action = 'modify';
          op.newContent = editedBlocks[editIdx];
        }
      } else {
        // No replacement found — block was deleted
        const op = ops.get(bi);
        if (op) op.action = 'delete';
      }
    }
  }

  // Trailing insertions: unmatched edited blocks after the last LCS anchor
  const trailingInserts: string[] = [];
  for (let ei = prevEditAnchor + 1; ei < editedBlocks.length; ei++) {
    if (!matchedEdit.has(ei)) {
      trailingInserts.push(editedBlocks[ei]);
    }
  }
  const trailingOp = ops.get(baseBlocks.length);
  if (trailingOp) trailingOp.insertsBefore = trailingInserts;

  return ops;
}

/**
 * Compute LCS of two string arrays, returning pairs of (aIdx, bIdx).
 *
 * Uses a flat row-major Uint32Array so the DP grid is one packed allocation
 * (4 bytes/cell, no per-row Array overhead). Caller is responsible for
 * gating on `MAX_LCS_CELLS` before invoking — this helper assumes the
 * inputs have already been validated.
 */
function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const stride = n + 1;
  const dp = new Uint32Array((m + 1) * stride);

  for (let i = 1; i <= m; i++) {
    const rowBase = i * stride;
    const prevRowBase = (i - 1) * stride;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[rowBase + j] = dp[prevRowBase + (j - 1)] + 1;
      } else {
        const top = dp[prevRowBase + j];
        const left = dp[rowBase + (j - 1)];
        dp[rowBase + j] = top > left ? top : left;
      }
    }
  }

  const pairs: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * stride + j] >= dp[i * stride + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }

  return pairs.reverse();
}
