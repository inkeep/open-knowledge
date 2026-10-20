import { type LineEnding, spellLineEndings } from '@inkeep/open-knowledge-core';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { getLogger } from './logger.ts';
import { mdManager } from './md-manager.ts';
import { incrementReconcileConstructCheckSkipped } from './metrics.ts';

export interface ReconcileInput {
  docName: string;
  base: string;
  ours: string;
  theirs: string;
}

export interface KeptBlockPair {
  blockIndex: number;
  base: string;
  ours: string;
  theirs: string;
  landed: 'both' | 'ours' | 'theirs';
}

export interface KeptBlockCounts {
  readonly duplicated: number;
  readonly restoredDeletedHere: number;
  readonly restoredDeletedOutside: number;
}

export function countKeptBlocks(kept: readonly KeptBlockPair[]): KeptBlockCounts {
  let duplicated = 0;
  let restoredDeletedHere = 0;
  let restoredDeletedOutside = 0;
  for (const pair of kept) {
    if (pair.landed === 'both') duplicated++;
    else if (pair.landed === 'theirs') restoredDeletedHere++;
    else restoredDeletedOutside++;
  }
  return { duplicated, restoredDeletedHere, restoredDeletedOutside };
}

export type ReconcileRefusalReason = 'conflict-markers' | 'no-base' | 'too-large' | 'check-failed';

type MergeSide = 'ours' | 'theirs';

type MergeCheckFailure =
  | { readonly check: 'untouched-verbatim'; readonly baseBlockIndex: number }
  | { readonly check: 'side-bytes'; readonly side: MergeSide; readonly sideBlockIndex: number }
  | { readonly check: 'single-occurrence'; readonly outputBlockIndex: number }
  | { readonly check: 'construct'; readonly outputBlockIndex: number }
  | { readonly check: 'parse' };

export type ReconcileOutcome =
  | { kind: 'clean'; newContent: string }
  | { kind: 'merged'; newContent: string; mergedBlocks: number; dedupSkipped?: true }
  | { kind: 'both-kept'; newContent: string; kept: KeptBlockPair[]; dedupSkipped?: true }
  | { kind: 'refused'; reason: Exclude<ReconcileRefusalReason, 'check-failed'> }
  | { kind: 'refused'; reason: 'check-failed'; failure: MergeCheckFailure }
  | { kind: 'noop' };

export const MAX_LCS_CELLS = 4_000_000;

export const MAX_CONSTRUCT_CHECK_BYTES = 256 * 1024;

export const CONFLICT_MARKER_RE = /^(<{7} |={7}$|>{7} |\|{7} )/m;

export function containsConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}

export function containsUnresolvedConflictBlock(content: string): boolean {
  const start = /^<{7} /m.exec(content);
  if (!start) return false;
  return /^>{7} /m.test(content.slice(start.index + start[0].length));
}

interface MarkdownBlock {
  readonly separator: string;
  readonly text: string;
}

interface MarkdownBlocks {
  readonly blocks: readonly MarkdownBlock[];
  readonly trailing: string;
}

const FENCE_OPEN_RE = /^(`{3,}|~{3,})/;
const BLANK_LINE_RE = /^[ \t]*$/;

export function splitMarkdownDocument(md: string): MarkdownBlocks {
  const blocks: MarkdownBlock[] = [];
  let fenceChar: string | null = null;
  let separatorStart = 0;
  let blockStart = -1;
  let blockEnd = -1;
  let lineStart = 0;

  while (lineStart < md.length) {
    const newline = md.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? md.length : newline + 1;
    const contentEnd =
      newline === -1
        ? md.length
        : newline > lineStart && md[newline - 1] === '\r'
          ? newline - 1
          : newline;
    const content = md.slice(lineStart, contentEnd);

    const fenceMatch = FENCE_OPEN_RE.exec(content);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!fenceChar) fenceChar = char;
      else if (char === fenceChar) fenceChar = null;
    }
    const blank = BLANK_LINE_RE.test(content);

    if (!fenceMatch && fenceChar === null && blank) {
      if (blockStart !== -1) {
        blocks.push({
          separator: md.slice(separatorStart, blockStart),
          text: md.slice(blockStart, blockEnd),
        });
        separatorStart = blockEnd;
        blockStart = -1;
      }
    } else {
      if (blockStart === -1) blockStart = lineStart;
      if (!blank) blockEnd = contentEnd;
    }
    lineStart = lineEnd;
  }

  if (blockStart !== -1) {
    blocks.push({
      separator: md.slice(separatorStart, blockStart),
      text: md.slice(blockStart, blockEnd),
    });
    separatorStart = blockEnd;
  }
  return { blocks, trailing: md.slice(separatorStart) };
}

export function splitMarkdownBlocks(md: string): string[] {
  return splitMarkdownDocument(md).blocks.map((block) => block.text);
}

interface BlockDocument extends MarkdownBlocks {
  readonly keys: readonly string[];
}

function blockIdentity(bytes: string): string {
  return spellLineEndings(bytes, '\n');
}

function readBlockDocument(md: string): BlockDocument {
  const split = splitMarkdownDocument(md);
  return { ...split, keys: split.blocks.map((block) => blockIdentity(block.text)) };
}

type LineEndingConvention = 'crlf' | 'lf' | 'mixed' | 'none';

function lineEndingConvention(text: string): LineEndingConvention {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return 'none';
  if (lf === 0) return 'crlf';
  if (crlf === 0) return 'lf';
  return 'mixed';
}

function uniformLineEnding(convention: LineEndingConvention): LineEnding | null {
  if (convention === 'crlf') return '\r\n';
  if (convention === 'lf') return '\n';
  return null;
}

function mergeOutputLineEnding(base: string, ours: string, theirs: string): LineEnding | null {
  const baseConvention = lineEndingConvention(base);
  const theirConvention = lineEndingConvention(theirs);
  if (theirConvention !== baseConvention) {
    const converted = uniformLineEnding(theirConvention);
    if (converted) return converted;
  }
  const ourConvention = lineEndingConvention(ours);
  if (ourConvention !== baseConvention) return uniformLineEnding(ourConvention);
  return null;
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

  const baseDoc = readBlockDocument(base);
  if (baseDoc.blocks.every((block) => block.text.trim() === '')) {
    return { kind: 'refused', reason: 'no-base' };
  }

  const ourDoc = readBlockDocument(ours);
  const theirDoc = readBlockDocument(theirs);

  if (
    (baseDoc.blocks.length + 1) * (ourDoc.blocks.length + 1) > MAX_LCS_CELLS ||
    (baseDoc.blocks.length + 1) * (theirDoc.blocks.length + 1) > MAX_LCS_CELLS
  ) {
    return { kind: 'refused', reason: 'too-large' };
  }

  const merge = mergeBlocks(baseDoc, ourDoc, theirDoc, mergeOutputLineEnding(base, ours, theirs));

  const verdict = verifyMergeOutput({
    base,
    ours,
    theirs,
    newContent: merge.newContent,
    dedupSkipped: merge.dedupSkipped,
  });
  if (verdict.failure) return { kind: 'refused', reason: 'check-failed', failure: verdict.failure };
  if (verdict.constructCheck !== 'ran') {
    reportConstructCheckSkipped(input.docName, verdict.constructCheck);
  }

  if (merge.kept.length > 0) {
    return merge.dedupSkipped
      ? { kind: 'both-kept', newContent: merge.newContent, kept: merge.kept, dedupSkipped: true }
      : { kind: 'both-kept', newContent: merge.newContent, kept: merge.kept };
  }

  return merge.dedupSkipped
    ? {
        kind: 'merged',
        newContent: merge.newContent,
        mergedBlocks: merge.mergedBlocks,
        dedupSkipped: true,
      }
    : { kind: 'merged', newContent: merge.newContent, mergedBlocks: merge.mergedBlocks };
}

interface EmittedBlock {
  readonly text: string;
  readonly separator: string | null;
}

interface BlockMerge {
  readonly newContent: string;
  readonly mergedBlocks: number;
  readonly kept: KeptBlockPair[];
  readonly dedupSkipped: boolean;
}

function interBlockSeparator(doc: BlockDocument, index: number): string | null {
  return index === 0 ? null : doc.blocks[index].separator;
}

function sameModuloLineEndings(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return blockIdentity(a) === blockIdentity(b);
}

function pickThreeWay<T extends string | null>(
  base: T,
  ours: T | undefined,
  theirs: T | undefined,
): T {
  if (theirs !== undefined && !sameModuloLineEndings(theirs, base)) return theirs;
  if (ours !== undefined) return ours;
  return theirs ?? base;
}

function sideSeparator(doc: BlockDocument, op: EditOp): string | null | undefined {
  return op.editIndex === undefined ? undefined : interBlockSeparator(doc, op.editIndex);
}

function firstInterBlockSeparator(docs: readonly BlockDocument[], fallback: string): string {
  for (const doc of docs) {
    if (doc.blocks.length > 1) return doc.blocks[1].separator;
  }
  return fallback;
}

function mergeBlocks(
  base: BlockDocument,
  ours: BlockDocument,
  theirs: BlockDocument,
  outputLineEnding: LineEnding | null,
): BlockMerge {
  const ourEdits = computeEditOps(base.keys, ours.keys);
  const theirEdits = computeEditOps(base.keys, theirs.keys);

  const emitted: EmittedBlock[] = [];
  const kept: KeptBlockPair[] = [];
  let dedupSkipped = false;

  for (let i = 0; i < base.blocks.length; i++) {
    const ourOp = ourEdits.blockOps[i];
    const theirOp = theirEdits.blockOps[i];

    if (pushInsertGroupDeduped(emitted, ours, ourOp.insertsBefore, theirs, theirOp.insertsBefore))
      dedupSkipped = true;

    const anchored = (text: string): void => {
      emitted.push({
        text,
        separator: pickThreeWay(
          interBlockSeparator(base, i),
          sideSeparator(ours, ourOp),
          sideSeparator(theirs, theirOp),
        ),
      });
    };
    const ourText = ourOp.action === 'modify' ? ours.blocks[ourOp.editIndex].text : null;
    const theirText = theirOp.action === 'modify' ? theirs.blocks[theirOp.editIndex].text : null;

    if (ourOp.action === 'keep' && theirOp.action === 'keep') {
      anchored(base.blocks[i].text);
    } else if (ourOp.action === 'keep') {
      if (theirText !== null) anchored(theirText);
    } else if (theirOp.action === 'keep') {
      if (ourText !== null) anchored(ourText);
    } else {
      const ourKey = ourText === null ? null : blockIdentity(ourText);
      const theirKey = theirText === null ? null : blockIdentity(theirText);
      if (ourText !== null) anchored(ourText);
      if (ourKey !== theirKey) {
        let landed: KeptBlockPair['landed'] = 'ours';
        if (theirText !== null) {
          if (ourText === null) {
            landed = 'theirs';
            anchored(theirText);
          } else {
            landed = 'both';
            emitted.push({ text: theirText, separator: sideSeparator(theirs, theirOp) ?? null });
          }
        }
        kept.push({
          blockIndex: i,
          base: base.blocks[i].text,
          ours: ourText ?? '',
          theirs: theirText ?? '',
          landed,
        });
      }
    }
  }

  if (
    pushInsertGroupDeduped(
      emitted,
      ours,
      ourEdits.trailingInserts,
      theirs,
      theirEdits.trailingInserts,
    )
  )
    dedupSkipped = true;

  const leading = pickThreeWay(
    base.blocks[0]?.separator ?? '',
    ours.blocks[0]?.separator ?? '',
    theirs.blocks[0]?.separator ?? '',
  );
  const trailing = pickThreeWay(base.trailing, ours.trailing, theirs.trailing);
  const fallbackSeparator = firstInterBlockSeparator(
    [base, ours, theirs],
    base.trailing.startsWith('\r\n') ? '\r\n\r\n' : '\n\n',
  );

  let assembled = '';
  if (emitted.length > 0) {
    emitted.forEach((block, index) => {
      assembled += index === 0 ? leading : (block.separator ?? fallbackSeparator);
      assembled += block.text;
    });
    assembled += trailing;
  }

  return {
    newContent: outputLineEnding ? spellLineEndings(assembled, outputLineEnding) : assembled,
    mergedBlocks: emitted.length,
    kept,
    dedupSkipped,
  };
}

function pushInsertGroupDeduped(
  target: EmittedBlock[],
  ours: BlockDocument,
  ourInserts: readonly number[],
  theirs: BlockDocument,
  theirInserts: readonly number[],
): boolean {
  const pushOurs = (index: number): void => {
    target.push({ text: ours.blocks[index].text, separator: interBlockSeparator(ours, index) });
  };
  const pushTheirs = (index: number): void => {
    target.push({ text: theirs.blocks[index].text, separator: interBlockSeparator(theirs, index) });
  };
  if ((ourInserts.length + 1) * (theirInserts.length + 1) > MAX_LCS_CELLS) {
    for (const index of ourInserts) pushOurs(index);
    for (const index of theirInserts) pushTheirs(index);
    return true;
  }
  const spine = longestCommonSubsequence(
    ourInserts.map((index) => ours.keys[index]),
    theirInserts.map((index) => theirs.keys[index]),
  );
  let ourCursor = 0;
  let theirCursor = 0;
  for (const [ourMatch, theirMatch] of spine) {
    while (ourCursor < ourMatch) pushOurs(ourInserts[ourCursor++]);
    while (theirCursor < theirMatch) pushTheirs(theirInserts[theirCursor++]);
    pushOurs(ourInserts[ourMatch]);
    ourCursor = ourMatch + 1;
    theirCursor = theirMatch + 1;
  }
  while (ourCursor < ourInserts.length) pushOurs(ourInserts[ourCursor++]);
  while (theirCursor < theirInserts.length) pushTheirs(theirInserts[theirCursor++]);
  return false;
}

type EditOp =
  | { action: 'keep'; editIndex: number; insertsBefore: number[] }
  | { action: 'modify'; editIndex: number; insertsBefore: number[] }
  | { action: 'delete'; editIndex?: undefined; insertsBefore: number[] };

interface EditScript {
  readonly blockOps: readonly EditOp[];
  readonly trailingInserts: readonly number[];
}

function computeEditOps(baseKeys: readonly string[], editedKeys: readonly string[]): EditScript {
  const lcs = longestCommonSubsequence(baseKeys, editedKeys);
  const editOfBase = new Array<number>(baseKeys.length).fill(-1);
  const matchedEdit = new Array<boolean>(editedKeys.length).fill(false);
  for (const [bi, ei] of lcs) {
    editOfBase[bi] = ei;
    matchedEdit[ei] = true;
  }
  const nextAnchorEdit = new Array<number>(baseKeys.length + 1).fill(editedKeys.length);
  for (let bi = baseKeys.length - 1; bi >= 0; bi--) {
    nextAnchorEdit[bi] = editOfBase[bi] === -1 ? nextAnchorEdit[bi + 1] : editOfBase[bi];
  }

  const blockOps: EditOp[] = [];
  let prevEditAnchor = -1;

  for (let bi = 0; bi < baseKeys.length; bi++) {
    const editIdx = editOfBase[bi];
    if (editIdx !== -1) {
      const inserts: number[] = [];
      for (let ei = prevEditAnchor + 1; ei < editIdx; ei++) {
        if (!matchedEdit[ei]) inserts.push(ei);
      }
      blockOps.push({ action: 'keep', editIndex: editIdx, insertsBefore: inserts });
      prevEditAnchor = editIdx;
      continue;
    }
    let candidate = -1;
    for (let ei = prevEditAnchor + 1; ei < nextAnchorEdit[bi + 1]; ei++) {
      if (!matchedEdit[ei]) {
        candidate = ei;
        break;
      }
    }
    if (candidate === -1) {
      blockOps.push({ action: 'delete', insertsBefore: [] });
    } else {
      matchedEdit[candidate] = true;
      blockOps.push({ action: 'modify', editIndex: candidate, insertsBefore: [] });
    }
  }

  const trailingInserts: number[] = [];
  for (let ei = prevEditAnchor + 1; ei < editedKeys.length; ei++) {
    if (!matchedEdit[ei]) trailingInserts.push(ei);
  }
  return { blockOps, trailingInserts };
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): [number, number][] {
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

interface MergeCheckInput {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly newContent: string;
  readonly dedupSkipped: boolean;
}

type ConstructCheckRun = 'ran' | 'skipped-oversized' | 'skipped-unparsed-source';

interface MergeVerdict {
  readonly failure: MergeCheckFailure | null;
  readonly constructCheck: ConstructCheckRun;
}

type CheckedDocument = 'base' | MergeSide | 'output';

interface BlockSource {
  readonly document: CheckedDocument;
  readonly index: number;
}

interface SideAlignment {
  readonly sideOfBase: readonly number[];
  readonly gapStart: readonly number[];
  readonly gapEnd: readonly number[];
  readonly unmatched: readonly number[];
}

interface Occurrence {
  readonly key: string;
  readonly expected: readonly string[];
  readonly sources: readonly BlockSource[];
  readonly side: MergeSide;
  readonly sideBlockIndex: number;
  consumed: boolean;
}

function alignToBase(baseKeys: readonly string[], sideKeys: readonly string[]): SideAlignment {
  const sideOfBase = new Array<number>(baseKeys.length).fill(-1);
  const baseOfSide = new Array<number>(sideKeys.length).fill(-1);
  for (const [bi, si] of longestCommonSubsequence(baseKeys, sideKeys)) {
    sideOfBase[bi] = si;
    baseOfSide[si] = bi;
  }
  const gapStart = new Array<number>(sideKeys.length).fill(-1);
  const gapEnd = new Array<number>(sideKeys.length).fill(baseKeys.length);
  const unmatched: number[] = [];
  let previous = -1;
  for (let si = 0; si < sideKeys.length; si++) {
    if (baseOfSide[si] === -1) {
      gapStart[si] = previous;
      unmatched.push(si);
    } else previous = baseOfSide[si];
  }
  let next = baseKeys.length;
  for (let si = sideKeys.length - 1; si >= 0; si--) {
    if (baseOfSide[si] === -1) gapEnd[si] = next;
    else next = baseOfSide[si];
  }
  return { sideOfBase, gapStart, gapEnd, unmatched };
}

function gapsOverlap(a: SideAlignment, ai: number, b: SideAlignment, bi: number): boolean {
  return Math.max(a.gapStart[ai], b.gapStart[bi]) < Math.min(a.gapEnd[ai], b.gapEnd[bi]);
}

function indexByKey(keys: readonly string[], indices: readonly number[]): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const index of indices) {
    const bucket = byKey.get(keys[index]);
    if (bucket) bucket.push(index);
    else byKey.set(keys[index], [index]);
  }
  return byKey;
}

function collectOccurrences(
  ours: BlockDocument,
  ourAlignment: SideAlignment,
  theirs: BlockDocument,
  theirAlignment: SideAlignment,
  pairIdentical: boolean,
  expectBytes: (raw: string) => string,
): Map<string, Occurrence[]> {
  const occurrences = new Map<string, Occurrence[]>();
  const add = (occurrence: Occurrence): void => {
    const bucket = occurrences.get(occurrence.key);
    if (bucket) bucket.push(occurrence);
    else occurrences.set(occurrence.key, [occurrence]);
  };
  const theirsByKey = indexByKey(theirs.keys, theirAlignment.unmatched);
  const pairedTheirs = new Set<number>();
  for (const oi of ourAlignment.unmatched) {
    const key = ours.keys[oi];
    const ourBytes = expectBytes(ours.blocks[oi].text);
    const twin = pairIdentical
      ? theirsByKey
          .get(key)
          ?.find((ti) => !pairedTheirs.has(ti) && gapsOverlap(ourAlignment, oi, theirAlignment, ti))
      : undefined;
    if (twin !== undefined) pairedTheirs.add(twin);
    add({
      key,
      expected: twin === undefined ? [ourBytes] : [ourBytes, expectBytes(theirs.blocks[twin].text)],
      sources:
        twin === undefined
          ? [{ document: 'ours', index: oi }]
          : [
              { document: 'ours', index: oi },
              { document: 'theirs', index: twin },
            ],
      side: 'ours',
      sideBlockIndex: oi,
      consumed: false,
    });
  }
  for (const ti of theirAlignment.unmatched) {
    if (pairedTheirs.has(ti)) continue;
    add({
      key: theirs.keys[ti],
      expected: [expectBytes(theirs.blocks[ti].text)],
      sources: [{ document: 'theirs', index: ti }],
      side: 'theirs',
      sideBlockIndex: ti,
      consumed: false,
    });
  }
  return occurrences;
}

export function checkMergeOutput(input: MergeCheckInput): MergeCheckFailure | null {
  return verifyMergeOutput(input).failure;
}

function failed(failure: MergeCheckFailure): MergeVerdict {
  return { failure, constructCheck: 'ran' };
}

function verifyMergeOutput(input: MergeCheckInput): MergeVerdict {
  const outputLineEnding = mergeOutputLineEnding(input.base, input.ours, input.theirs);
  const expectBytes = (raw: string): string =>
    outputLineEnding ? spellLineEndings(raw, outputLineEnding) : raw;
  const base = readBlockDocument(input.base);
  const ours = readBlockDocument(input.ours);
  const theirs = readBlockDocument(input.theirs);
  const output = readBlockDocument(input.newContent);
  const ourAlignment = alignToBase(base.keys, ours.keys);
  const theirAlignment = alignToBase(base.keys, theirs.keys);

  const untouched: number[] = [];
  for (let bi = 0; bi < base.keys.length; bi++) {
    if (ourAlignment.sideOfBase[bi] !== -1 && theirAlignment.sideOfBase[bi] !== -1)
      untouched.push(bi);
  }

  const sources = new Array<readonly BlockSource[]>(output.blocks.length).fill([]);
  const rest: number[] = [];
  let nextUntouched = 0;
  for (let k = 0; k < output.blocks.length; k++) {
    const bi = untouched[nextUntouched];
    if (bi === undefined || output.keys[k] !== base.keys[bi]) {
      rest.push(k);
      continue;
    }
    if (output.blocks[k].text !== expectBytes(base.blocks[bi].text)) {
      return failed({ check: 'untouched-verbatim', baseBlockIndex: bi });
    }
    sources[k] = [
      { document: 'base', index: bi },
      { document: 'ours', index: ourAlignment.sideOfBase[bi] },
      { document: 'theirs', index: theirAlignment.sideOfBase[bi] },
    ];
    nextUntouched++;
  }
  if (nextUntouched < untouched.length) {
    return failed({ check: 'untouched-verbatim', baseBlockIndex: untouched[nextUntouched] });
  }

  const occurrences = collectOccurrences(
    ours,
    ourAlignment,
    theirs,
    theirAlignment,
    !input.dedupSkipped,
    expectBytes,
  );

  const unclaimed: number[] = [];
  for (const k of rest) {
    const candidates = (occurrences.get(output.keys[k]) ?? []).filter(
      (occurrence) => !occurrence.consumed,
    );
    if (candidates.length === 0) {
      unclaimed.push(k);
      continue;
    }
    const bytes = output.blocks[k].text;
    const exact = candidates.find((c) => c.expected.includes(bytes));
    if (!exact) {
      return failed({
        check: 'side-bytes',
        side: candidates[0].side,
        sideBlockIndex: candidates[0].sideBlockIndex,
      });
    }
    exact.consumed = true;
    sources[k] = exact.sources;
  }

  for (const bucket of occurrences.values()) {
    const missing = bucket.find((occurrence) => !occurrence.consumed);
    if (missing) {
      return failed({
        check: 'side-bytes',
        side: missing.side,
        sideBlockIndex: missing.sideBlockIndex,
      });
    }
  }
  if (unclaimed.length > 0) {
    return failed({ check: 'single-occurrence', outputBlockIndex: unclaimed[0] });
  }

  return checkConstructs(
    { base: input.base, ours: input.ours, theirs: input.theirs, output: input.newContent },
    sources,
  );
}

interface RootSpan {
  readonly type: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface ParsedDocument {
  readonly spans: readonly RootSpan[];
  readonly blockLines: readonly (readonly [number, number])[];
}

function parseDocument(md: string): ParsedDocument | null {
  let root: ReturnType<typeof mdManager.parseToMdast>;
  try {
    root = mdManager.parseToMdast(md);
  } catch {
    return null;
  }
  const spans: RootSpan[] = [];
  for (const child of root.children) {
    if (!child.position) continue;
    spans.push({
      type: child.type,
      startLine: child.position.start.line,
      endLine: child.position.end.line,
    });
  }
  return { spans, blockLines: blockLineRanges(md) };
}

const LINE_ENDING_RE = /\r\n|\r|\n/g;

function blockLineRanges(md: string): (readonly [number, number])[] {
  const lineStarts = [0];
  for (const match of md.matchAll(LINE_ENDING_RE)) lineStarts.push(match.index + match[0].length);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const ranges: (readonly [number, number])[] = [];
  let offset = 0;
  for (const block of splitMarkdownDocument(md).blocks) {
    offset += block.separator.length;
    ranges.push([lineOf(offset), lineOf(offset + block.text.length - 1)]);
    offset += block.text.length;
  }
  return ranges;
}

function coveringTypes(
  spans: readonly RootSpan[],
  [startLine, endLine]: readonly [number, number],
): string {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].endLine < startLine) lo = mid + 1;
    else hi = mid;
  }
  const types: string[] = [];
  for (let i = lo; i < spans.length && spans[i].startLine <= endLine; i++)
    types.push(spans[i].type);
  return types.join(' ');
}

function reportConstructCheckSkipped(
  docName: string,
  reason: Exclude<ConstructCheckRun, 'ran'>,
): void {
  incrementReconcileConstructCheckSkipped();
  getLogger('reconcile').info(
    { docName, reason, limitBytes: MAX_CONSTRUCT_CHECK_BYTES },
    `[reconcile] ${docName} construct check skipped (${reason}); the byte checks still ran`,
  );
}

function checkConstructs(
  texts: Readonly<Record<CheckedDocument, string>>,
  sources: readonly (readonly BlockSource[])[],
): MergeVerdict {
  const largestBytes = Math.max(...Object.values(texts).map((text) => Buffer.byteLength(text)));
  if (largestBytes > MAX_CONSTRUCT_CHECK_BYTES) {
    return { failure: null, constructCheck: 'skipped-oversized' };
  }
  const base = parseDocument(texts.base);
  const ours = parseDocument(texts.ours);
  const theirs = parseDocument(texts.theirs);
  if (!base || !ours || !theirs)
    return { failure: null, constructCheck: 'skipped-unparsed-source' };
  const output = parseDocument(texts.output);
  if (!output) return failed({ check: 'parse' });
  const parsed: Readonly<Record<CheckedDocument, ParsedDocument>> = { base, ours, theirs, output };

  const constructAt = (source: BlockSource): string | null => {
    const document = parsed[source.document];
    const lines = document.blockLines[source.index];
    return lines ? coveringTypes(document.spans, lines) : null;
  };

  for (let k = 0; k < sources.length; k++) {
    const merged = constructAt({ document: 'output', index: k });
    const stable =
      merged !== null &&
      sources[k].some((source) => source.index !== -1 && constructAt(source) === merged);
    if (!stable) return failed({ check: 'construct', outputBlockIndex: k });
  }
  return { failure: null, constructCheck: 'ran' };
}
