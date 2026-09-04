import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { Root, RootContent } from 'mdast';

export interface MapDrivenSplice {
  readonly spliceStart: number;
  readonly spliceEnd: number;
  readonly newSlice: string;
}

export interface EditorMdastMemo {
  entry: { readonly body: string; readonly tree: Root } | null;
}

export function createEditorMdastMemo(): EditorMdastMemo {
  return { entry: null };
}

function parseEditorMdastMemoized(
  mdManager: MarkdownManager,
  body: string,
  memo: EditorMdastMemo | undefined,
): Root {
  if (memo?.entry?.body === body) return memo.entry.tree;
  const tree = mdManager.parseToEditorMdast(body);
  if (memo !== undefined) memo.entry = { body, tree };
  return tree;
}

export function computeMapDrivenBodySplice(
  oldBody: string,
  newPmJson: JSONContent,
  mdManager: MarkdownManager,
  onFallback?: (reason: 'parse-error' | 'missing-position', err?: unknown) => void,
  memo?: EditorMdastMemo,
): MapDrivenSplice | null {
  let oldChildren: readonly RootContent[];
  let newBody: string;
  let newChildren: readonly RootContent[];
  try {
    oldChildren = parseEditorMdastMemoized(mdManager, oldBody, memo).children;
    newBody = mdManager.serialize(newPmJson);
    newChildren = parseEditorMdastMemoized(mdManager, newBody, memo).children;
  } catch (err) {
    onFallback?.('parse-error', err);
    return null;
  }

  if (!allBlocksCarryPositions(oldChildren) || !allBlocksCarryPositions(newChildren)) {
    onFallback?.('missing-position');
    return null;
  }

  try {
    return computeChildrenSplice(
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
}

interface ByteRegion {
  readonly start: number;
  readonly end: number;
}

const NARROWABLE_CONTAINER_TYPES = new Set(['blockquote', 'list', 'listItem']);

function computeChildrenSplice(
  oldChildren: readonly RootContent[],
  newChildren: readonly RootContent[],
  oldRegion: ByteRegion,
  newRegion: ByteRegion,
  newBody: string,
): MapDrivenSplice {
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
    if (narrowed) return narrowed;
  }

  const spliceStart = prefixLen > 0 ? blockEndOffset(oldChildren[prefixLen - 1]) : oldRegion.start;
  const spliceEnd =
    suffixLen > 0 ? blockStartOffset(oldChildren[oldChildren.length - suffixLen]) : oldRegion.end;

  const newSliceStart =
    prefixLen > 0 ? blockEndOffset(newChildren[prefixLen - 1]) : newRegion.start;
  const newSliceEnd =
    suffixLen > 0 ? blockStartOffset(newChildren[newChildren.length - suffixLen]) : newRegion.end;

  return {
    spliceStart,
    spliceEnd,
    newSlice: newBody.slice(newSliceStart, newSliceEnd),
  };
}

function tryNarrowIntoContainer(
  oldNode: RootContent,
  newNode: RootContent,
  newBody: string,
): MapDrivenSplice | null {
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
