import { graphemePrefix } from '@inkeep/open-knowledge-core/utils/grapheme-clip';
import { useOptionalPageList } from '@/components/PageListContext';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import { useLiveDocText } from './live-doc-pool.ts';
import {
  type MdastNodeLike,
  type MdxJsxFlowElementLike,
  mirrorSourceNameOf,
} from './use-mirror-source.ts';

export interface MirrorSourceEntry {
  readonly name: string;
  readonly preview: string;
}

export type MirrorSourceNames =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly entries: readonly MirrorSourceEntry[] };

const PREVIEW_LENGTH = 80;
const UNAVAILABLE_SOURCE_NAMES: MirrorSourceNames = { kind: 'unavailable' };
const EMPTY_SOURCE_NAMES: MirrorSourceNames = { kind: 'ready', entries: [] };
const PHRASING_PARENTS: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell',
  'mdxJsxTextElement',
]);

function plainTextOf(node: MdastNodeLike): string {
  if (typeof node.value === 'string') return node.value;
  const separator = PHRASING_PARENTS.has(node.type) ? '' : ' ';
  return (node.children ?? []).map(plainTextOf).join(separator);
}

function previewOf(element: MdxJsxFlowElementLike): string {
  const text = (element.children ?? []).map(plainTextOf).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= PREVIEW_LENGTH) return text;
  return `${graphemePrefix(text, PREVIEW_LENGTH).trimEnd()}…`;
}

export function listMirrorSources(tree: MdastNodeLike): readonly MirrorSourceEntry[] {
  const entries: MirrorSourceEntry[] = [];
  const seen = new Set<string>();
  const visit = (node: MdastNodeLike) => {
    if (node.type === 'mdxJsxFlowElement' && node.name === 'MirrorSource') {
      const element = node as MdxJsxFlowElementLike;
      const name = mirrorSourceNameOf(element);
      if (name && !seen.has(name)) {
        seen.add(name);
        entries.push({ name, preview: previewOf(element) });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return entries;
}

function mirrorSourcesIn(docName: string, markdown: string): MirrorSourceNames {
  let tree: MdastNodeLike;
  try {
    tree = getSharedMarkdownManager().parseToMdast(markdown) as MdastNodeLike;
  } catch (err) {
    console.warn('[Mirror] parseToMdast failed while listing source names', { docName, err });
    return UNAVAILABLE_SOURCE_NAMES;
  }
  return { kind: 'ready', entries: listMirrorSources(tree) };
}

export function useMirrorSourceNames(docName: string): MirrorSourceNames {
  const pageList = useOptionalPageList();
  const isKnownDoc = docName !== '' && pageList?.pages.has(docName) === true;
  const status = useLiveDocText(isKnownDoc ? docName : null);
  if (!isKnownDoc) return UNAVAILABLE_SOURCE_NAMES;
  switch (status.kind) {
    case 'empty':
      return EMPTY_SOURCE_NAMES;
    case 'ready':
      return mirrorSourcesIn(docName, status.text);
    case 'loading':
    case 'unreachable':
    case 'at-capacity':
      return UNAVAILABLE_SOURCE_NAMES;
  }
}
