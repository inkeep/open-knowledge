import type { MarkdownManager, SerializeCallOptions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { RootContent } from 'mdast';
import type { MapDrivenSpliceMemoSkipReason } from './metrics.ts';

export interface MapDrivenSplice {
  readonly spliceStart: number;
  readonly spliceEnd: number;
  readonly newSlice: string;
}

export interface SerializedEditorBody {
  readonly json: JSONContent;
  readonly body: string;
  readonly opts: SerializeCallOptions | undefined;
}

export function serializeEditorBody(
  mdManager: MarkdownManager,
  json: JSONContent,
  opts?: SerializeCallOptions,
): SerializedEditorBody {
  return { json, body: mdManager.serialize(json, opts), opts };
}

function reusableBodyFrom(
  serializedNewPm: SerializedEditorBody | undefined,
  newPmJson: JSONContent,
): string | undefined {
  if (serializedNewPm === undefined) return undefined;
  if (serializedNewPm.json !== newPmJson) return undefined;
  if (serializedNewPm.opts?.skipFreshnessDerive === true) return undefined;
  return serializedNewPm.body;
}

export interface MapDrivenSpliceOptions {
  readonly onFallback?: (reason: 'parse-error' | 'missing-position', err?: unknown) => void;
  readonly onMemoHit?: () => void;
  readonly onMemoSkip?: (reason: MapDrivenSpliceMemoSkipReason, err?: unknown) => void;
  readonly memo?: EditorMdastMemo;
  readonly serializedNewPm?: SerializedEditorBody;
}

export interface EditorMdastMemo {
  entry: { readonly body: string; readonly children: readonly RootContent[] } | null;
}

export function createEditorMdastMemo(): EditorMdastMemo {
  return { entry: null };
}

function editorMdastChildren(
  mdManager: MarkdownManager,
  body: string,
  memo: EditorMdastMemo | undefined,
  onHit?: () => void,
): readonly RootContent[] {
  if (memo?.entry?.body === body) {
    onHit?.();
    return memo.entry.children;
  }
  const children = mdManager.parseToEditorMdast(body).children;
  if (memo !== undefined) memo.entry = { body, children };
  return children;
}

export function computeMapDrivenBodySplice(
  oldBody: string,
  newPmJson: JSONContent,
  mdManager: MarkdownManager,
  options: MapDrivenSpliceOptions = {},
): MapDrivenSplice | null {
  const { onFallback, onMemoHit, onMemoSkip, memo, serializedNewPm } = options;
  let oldChildren: readonly RootContent[];
  let newBody: string;
  let newChildren: readonly RootContent[];
  try {
    oldChildren = editorMdastChildren(mdManager, oldBody, memo, onMemoHit);
    newBody = reusableBodyFrom(serializedNewPm, newPmJson) ?? mdManager.serialize(newPmJson);
    newChildren = editorMdastChildren(mdManager, newBody, memo);
  } catch (err) {
    onFallback?.('parse-error', err);
    return null;
  }

  if (!allBlocksCarryPositions(oldChildren) || !allBlocksCarryPositions(newChildren)) {
    onFallback?.('missing-position');
    return null;
  }

  let walked: ChildrenSplice;
  try {
    walked = computeChildrenSplice(
      oldChildren,
      newChildren,
      {
        start: oldChildren.length > 0 ? blockStartOffset(oldChildren[0]) : 0,
        end: oldBody.length,
      },
      {
        start: newChildren.length > 0 ? blockStartOffset(newChildren[0]) : 0,
        end: newBody.length,
      },
      newBody,
    );
  } catch (err) {
    onFallback?.('missing-position', err);
    return null;
  }

  if (memo !== undefined) {
    try {
      memoizeSplicedBody(memo, { oldBody, oldChildren, newBody, newChildren, walked }, onMemoSkip);
    } catch (err) {
      onMemoSkip?.('compose-failed', err);
    }
  }
  return walked.splice;
}

interface ByteRegion {
  readonly start: number;
  readonly end: number;
}

type ChildrenSplice =
  | { readonly narrowed: true; readonly splice: MapDrivenSplice }
  | {
      readonly narrowed: false;
      readonly splice: MapDrivenSplice;
      readonly prefixLen: number;
      readonly suffixLen: number;
      readonly newSliceStart: number;
    };

const NARROWABLE_CONTAINER_TYPES = new Set(['blockquote', 'list', 'listItem']);

function computeChildrenSplice(
  oldChildren: readonly RootContent[],
  newChildren: readonly RootContent[],
  oldRegion: ByteRegion,
  newRegion: ByteRegion,
  newBody: string,
): ChildrenSplice {
  let prefixLen = 0;
  while (
    prefixLen < oldChildren.length &&
    prefixLen < newChildren.length &&
    structurallyEqual(oldChildren[prefixLen], newChildren[prefixLen])
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldChildren.length - prefixLen &&
    suffixLen < newChildren.length - prefixLen &&
    structurallyEqual(
      oldChildren[oldChildren.length - 1 - suffixLen],
      newChildren[newChildren.length - 1 - suffixLen],
    )
  ) {
    suffixLen++;
  }

  if (
    oldChildren.length - prefixLen - suffixLen === 1 &&
    newChildren.length - prefixLen - suffixLen === 1
  ) {
    const oldChanged = oldChildren[prefixLen];
    const newChanged = newChildren[prefixLen];
    const narrowed = tryNarrowIntoContainer(oldChanged, newChanged, newBody);
    if (narrowed) return { narrowed: true, splice: narrowed.splice };
  }

  const spliceStart = prefixLen > 0 ? blockEndOffset(oldChildren[prefixLen - 1]) : oldRegion.start;
  const spliceEnd =
    suffixLen > 0 ? blockStartOffset(oldChildren[oldChildren.length - suffixLen]) : oldRegion.end;

  const newSliceStart =
    prefixLen > 0 ? blockEndOffset(newChildren[prefixLen - 1]) : newRegion.start;
  const newSliceEnd =
    suffixLen > 0 ? blockStartOffset(newChildren[newChildren.length - suffixLen]) : newRegion.end;

  return {
    splice: {
      spliceStart,
      spliceEnd,
      newSlice: newBody.slice(newSliceStart, newSliceEnd),
    },
    prefixLen,
    suffixLen,
    newSliceStart,
    narrowed: false,
  };
}

function tryNarrowIntoContainer(
  oldNode: RootContent,
  newNode: RootContent,
  newBody: string,
): ChildrenSplice | null {
  if (oldNode.type !== newNode.type || !NARROWABLE_CONTAINER_TYPES.has(oldNode.type)) return null;
  if (!('children' in oldNode) || !('children' in newNode)) return null;
  const oldKids = oldNode.children as readonly RootContent[];
  const newKids = newNode.children as readonly RootContent[];
  if (oldKids.length === 0 || newKids.length === 0) return null;
  if (!allBlocksCarryPositions(oldKids) || !allBlocksCarryPositions(newKids)) return null;
  if (
    stringifyIgnorePosition({ ...oldNode, children: [] }) !==
    stringifyIgnorePosition({ ...newNode, children: [] })
  ) {
    return null;
  }
  return computeChildrenSplice(
    oldKids,
    newKids,
    { start: blockStartOffset(oldNode), end: blockEndOffset(oldNode) },
    { start: blockStartOffset(newNode), end: blockEndOffset(newNode) },
    newBody,
  );
}

interface SplicedBodyInputs {
  readonly oldBody: string;
  readonly oldChildren: readonly RootContent[];
  readonly newBody: string;
  readonly newChildren: readonly RootContent[];
  readonly walked: ChildrenSplice;
}

function memoizeSplicedBody(
  memo: EditorMdastMemo,
  inputs: SplicedBodyInputs,
  onSkip: ((reason: MapDrivenSpliceMemoSkipReason, err?: unknown) => void) | undefined,
): void {
  const { oldBody, oldChildren, newBody, newChildren, walked } = inputs;
  if (walked.narrowed) {
    onSkip?.('narrowed');
    return;
  }
  if (oldChildren.length === 0 || newChildren.length === 0) {
    onSkip?.('empty-children');
    return;
  }

  const { splice, prefixLen, suffixLen, newSliceStart } = walked;
  const applied =
    oldBody.slice(0, splice.spliceStart) + splice.newSlice + oldBody.slice(splice.spliceEnd);
  if (applied === newBody) {
    onSkip?.('entry-already-current');
    return;
  }

  const mid = cloneShifted(
    newChildren.slice(prefixLen, newChildren.length - suffixLen),
    splice.spliceStart - newSliceStart,
    countNewlines(oldBody, 0, splice.spliceStart) - countNewlines(newBody, 0, newSliceStart),
  );
  if (mid === null) {
    onSkip?.('position-not-numeric');
    return;
  }

  const tail = cloneShifted(
    oldChildren.slice(oldChildren.length - suffixLen),
    applied.length - oldBody.length,
    countNewlines(splice.newSlice, 0, splice.newSlice.length) -
      countNewlines(oldBody, splice.spliceStart, splice.spliceEnd),
  );
  if (tail === null) {
    onSkip?.('position-not-numeric');
    return;
  }

  memo.entry = { body: applied, children: [...oldChildren.slice(0, prefixLen), ...mid, ...tail] };
}

function cloneShifted(
  nodes: readonly RootContent[],
  byteDelta: number,
  lineDelta: number,
): RootContent[] | null {
  const cloned = structuredClone(nodes) as RootContent[];
  return shiftPositions(cloned, byteDelta, lineDelta) ? cloned : null;
}

function shiftPositions(value: unknown, byteDelta: number, lineDelta: number): boolean {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!shiftPositions(entry, byteDelta, lineDelta)) return false;
    }
    return true;
  }
  if (value === null || typeof value !== 'object') return true;
  const node = value as Record<string, unknown>;
  const position = node.position as
    | { start?: { offset?: number; line?: number }; end?: { offset?: number; line?: number } }
    | undefined;
  if (position !== undefined) {
    for (const point of [position.start, position.end]) {
      if (point === undefined) continue;
      if (typeof point.offset !== 'number' || typeof point.line !== 'number') return false;
      point.offset += byteDelta;
      point.line += lineDelta;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'position') continue;
    if (!shiftPositions(node[key], byteDelta, lineDelta)) return false;
  }
  return true;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return count;
}

function allBlocksCarryPositions(children: readonly RootContent[]): boolean {
  for (const child of children) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return false;
  }
  return true;
}

function blockStartOffset(node: RootContent): number {
  const offset = node.position?.start?.offset;
  if (typeof offset !== 'number') {
    throw new Error('mdast node missing position.start.offset');
  }
  return offset;
}

function blockEndOffset(node: RootContent): number {
  const offset = node.position?.end?.offset;
  if (typeof offset !== 'number') {
    throw new Error('mdast node missing position.end.offset');
  }
  return offset;
}

function structurallyEqual(a: RootContent, b: RootContent): boolean {
  return stringifyIgnorePosition(a) === stringifyIgnorePosition(b);
}

function stringifyIgnorePosition(node: unknown): string {
  return JSON.stringify(node, (key, value) => (key === 'position' ? undefined : value));
}
