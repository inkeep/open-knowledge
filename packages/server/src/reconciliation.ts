import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';

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

export type ReconcileRefusalReason = 'conflict-markers' | 'no-base' | 'too-large';

export type ReconcileOutcome =
  | { kind: 'clean'; newContent: string }
  | { kind: 'merged'; newContent: string; mergedBlocks: number; dedupSkipped?: true }
  | { kind: 'conflicts'; newContent: string; conflicts: BlockConflict[]; dedupSkipped?: true }
  | { kind: 'refused'; reason: ReconcileRefusalReason }
  | { kind: 'noop' };

export const MAX_LCS_CELLS = 4_000_000;

export const CONFLICT_MARKER_RE = /^(<{7} |={7}$|>{7} |\|{7} )/m;

export function containsConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}

export function containsUnresolvedConflictBlock(content: string): boolean {
  const start = /^<{7} /m.exec(content);
  if (!start) return false;
  return /^>{7} /m.test(content.slice(start.index + start[0].length));
}

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
    if (!inFence && line.trim() === '') {
      if (current.length > 0) {
        const block = current.join('\n').trim();
        if (block) blocks.push(block);
        current = [];
      }
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

export function reconcile(input: ReconcileInput): ReconcileOutcome {
  if (
    isSystemDoc(input.docName) ||
    isConfigDoc(input.docName) ||
    isMermaidDoc(input.docName) ||
    isExcalidrawDoc(input.docName) ||
    isEditableTextDoc(input.docName)
  )
    return { kind: 'noop' };
  const { base, ours, theirs } = input;

  if (containsConflictMarkers(theirs)) {
    return { kind: 'refused', reason: 'conflict-markers' };
  }

  if (theirs === base) {
    return { kind: 'noop' };
  }

  if (ours === base) {
    return { kind: 'clean', newContent: theirs };
  }

  const baseBlocks = splitMarkdownBlocks(base);
  if (baseBlocks.every((block) => block.trim() === '')) {
    return { kind: 'refused', reason: 'no-base' };
  }

  const ourBlocks = splitMarkdownBlocks(ours);
  const theirBlocks = splitMarkdownBlocks(theirs);

  if (
    (baseBlocks.length + 1) * (ourBlocks.length + 1) > MAX_LCS_CELLS ||
    (baseBlocks.length + 1) * (theirBlocks.length + 1) > MAX_LCS_CELLS
  ) {
    return { kind: 'refused', reason: 'too-large' };
  }

  return mergeBlocks(baseBlocks, ourBlocks, theirBlocks);
}

function mergeBlocks(
  baseBlocks: string[],
  ourBlocks: string[],
  theirBlocks: string[],
): ReconcileOutcome {
  const ourOps = computeEditOps(baseBlocks, ourBlocks);
  const theirOps = computeEditOps(baseBlocks, theirBlocks);

  const merged: string[] = [];
  const conflicts: BlockConflict[] = [];
  let dedupSkipped = false;

  for (let i = 0; i < baseBlocks.length; i++) {
    const baseBlock = baseBlocks[i];
    const ourOp = ourOps.get(i);
    const theirOp = theirOps.get(i);

    const ourInserts = ourOp?.insertsBefore ?? [];
    const theirInserts = theirOp?.insertsBefore ?? [];
    if (pushInsertGroupDeduped(merged, ourInserts, theirInserts)) dedupSkipped = true;

    const ourAction = ourOp?.action ?? 'keep';
    const theirAction = theirOp?.action ?? 'keep';

    if (ourAction === 'keep' && theirAction === 'keep') {
      merged.push(baseBlock);
    } else if (ourAction === 'keep' && theirAction !== 'keep') {
      if (theirAction === 'modify' && theirOp?.newContent !== undefined) {
        merged.push(theirOp.newContent);
      }
    } else if (ourAction !== 'keep' && theirAction === 'keep') {
      if (ourAction === 'modify' && ourOp?.newContent !== undefined) {
        merged.push(ourOp.newContent);
      }
    } else {
      const ourContent = ourAction === 'modify' ? ourOp?.newContent : null;
      const theirContent = theirAction === 'modify' ? theirOp?.newContent : null;

      if (ourContent === theirContent) {
        if (ourContent !== null && ourContent !== undefined) merged.push(ourContent);
      } else {
        conflicts.push({
          blockIndex: i,
          base: baseBlock,
          ours: ourContent ?? '',
          theirs: theirContent ?? '',
        });
        if (ourContent !== null && ourContent !== undefined) merged.push(ourContent);
      }
    }
  }

  const lastOurOp = ourOps.get(baseBlocks.length);
  const lastTheirOp = theirOps.get(baseBlocks.length);
  if (
    pushInsertGroupDeduped(merged, lastOurOp?.insertsBefore ?? [], lastTheirOp?.insertsBefore ?? [])
  )
    dedupSkipped = true;

  const newContent = merged.length > 0 ? `${merged.join('\n\n')}\n` : '';

  if (conflicts.length > 0) {
    return dedupSkipped
      ? { kind: 'conflicts', newContent, conflicts, dedupSkipped: true }
      : { kind: 'conflicts', newContent, conflicts };
  }

  return dedupSkipped
    ? { kind: 'merged', newContent, mergedBlocks: merged.length, dedupSkipped: true }
    : { kind: 'merged', newContent, mergedBlocks: merged.length };
}

function pushInsertGroupDeduped(
  target: string[],
  ourInserts: string[],
  theirInserts: string[],
): boolean {
  if ((ourInserts.length + 1) * (theirInserts.length + 1) > MAX_LCS_CELLS) {
    target.push(...ourInserts, ...theirInserts);
    return true;
  }
  const spine = longestCommonSubsequence(ourInserts, theirInserts);
  let ourCursor = 0;
  let theirCursor = 0;
  for (const [ourMatch, theirMatch] of spine) {
    while (ourCursor < ourMatch) target.push(ourInserts[ourCursor++]);
    while (theirCursor < theirMatch) target.push(theirInserts[theirCursor++]);
    target.push(ourInserts[ourMatch]);
    ourCursor = ourMatch + 1;
    theirCursor = theirMatch + 1;
  }
  while (ourCursor < ourInserts.length) target.push(ourInserts[ourCursor++]);
  while (theirCursor < theirInserts.length) target.push(theirInserts[theirCursor++]);
  return false;
}

interface EditOp {
  action: 'keep' | 'modify' | 'delete';
  newContent?: string;
  insertsBefore: string[];
}

function computeEditOps(baseBlocks: string[], editedBlocks: string[]): Map<number, EditOp> {
  const ops = new Map<number, EditOp>();
  const lcs = longestCommonSubsequence(baseBlocks, editedBlocks);

  for (let i = 0; i <= baseBlocks.length; i++) {
    ops.set(i, { action: 'keep', insertsBefore: [] });
  }

  const matchedBase = new Set<number>();
  const matchedEdit = new Set<number>();
  for (const [bi, ei] of lcs) {
    matchedBase.add(bi);
    matchedEdit.add(ei);
  }

  let prevEditAnchor = -1;

  for (let bi = 0; bi < baseBlocks.length; bi++) {
    if (matchedBase.has(bi)) {
      const editIdx = lcs.find((p) => p[0] === bi)?.[1] ?? -1;

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
      const nextBaseAnchor = lcs.find((p) => p[0] > bi);
      const nextEditAnchor = nextBaseAnchor ? nextBaseAnchor[1] : editedBlocks.length;

      const candidateEdits: number[] = [];
      for (let ei = prevEditAnchor + 1; ei < nextEditAnchor; ei++) {
        if (!matchedEdit.has(ei)) {
          candidateEdits.push(ei);
        }
      }

      if (candidateEdits.length > 0) {
        const editIdx = candidateEdits[0];
        matchedEdit.add(editIdx);
        const op = ops.get(bi);
        if (op) {
          op.action = 'modify';
          op.newContent = editedBlocks[editIdx];
        }
      } else {
        const op = ops.get(bi);
        if (op) op.action = 'delete';
      }
    }
  }

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
