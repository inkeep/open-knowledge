import type { Mark, MarkType, Node, NodeType, Schema, Slice } from '@tiptap/pm/model';
import { Fragment, Slice as SliceCtor } from '@tiptap/pm/model';

export const OK_INTERNAL_CLIPBOARD_MIME = 'application/x-openknowledge-markdown';

const OMIT_ATTR = 'data-clipboard-omit';

interface OmittedTypes {
  marks: Set<MarkType>;
  nodes: Set<NodeType>;
}

const omittedTypesCache = new WeakMap<Schema, OmittedTypes>();

function toDomStampsOmit(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const attrs = spec[1];
  return (
    typeof attrs === 'object' &&
    attrs !== null &&
    !Array.isArray(attrs) &&
    (attrs as Record<string, unknown>)[OMIT_ATTR] === 'true'
  );
}

function getClipboardOmittedTypes(schema: Schema): OmittedTypes {
  const cached = omittedTypesCache.get(schema);
  if (cached) return cached;
  const result: OmittedTypes = { marks: new Set(), nodes: new Set() };
  for (const markType of Object.values(schema.marks)) {
    try {
      const mark = markType.create();
      if (toDomStampsOmit(markType.spec.toDOM?.(mark, true))) result.marks.add(markType);
    } catch {}
  }
  for (const nodeType of Object.values(schema.nodes)) {
    try {
      const node = nodeType.createAndFill();
      if (node && toDomStampsOmit(nodeType.spec.toDOM?.(node))) result.nodes.add(nodeType);
    } catch {}
  }
  omittedTypesCache.set(schema, result);
  return result;
}

function isOmittedNode(node: Node, omitted: OmittedTypes): boolean {
  if (omitted.nodes.has(node.type)) return true;
  return node.marks.some((mark: Mark) => omitted.marks.has(mark.type));
}

function scrubFragment(fragment: Fragment, omitted: OmittedTypes): Fragment {
  const out: Node[] = [];
  let changed = false;
  fragment.forEach((child) => {
    if (isOmittedNode(child, omitted)) {
      changed = true;
      return;
    }
    const scrubbedContent = scrubFragment(child.content, omitted);
    if (scrubbedContent !== child.content) {
      changed = true;
      out.push(child.copy(scrubbedContent));
    } else {
      out.push(child);
    }
  });
  return changed ? Fragment.fromArray(out) : fragment;
}

function fragmentContainsOmitted(fragment: Fragment, omitted: OmittedTypes): boolean {
  let found = false;
  fragment.forEach((child) => {
    if (found) return;
    if (isOmittedNode(child, omitted) || fragmentContainsOmitted(child.content, omitted)) {
      found = true;
    }
  });
  return found;
}

export function sliceContainsClipboardOmitted(slice: Slice, schema: Schema): boolean {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return false;
  return fragmentContainsOmitted(slice.content, omitted);
}

function maxOpenDepth(fragment: Fragment, side: 'first' | 'last'): number {
  let depth = 0;
  let node = side === 'first' ? fragment.firstChild : fragment.lastChild;
  while (node && !node.isLeaf) {
    depth += 1;
    node = side === 'first' ? node.firstChild : node.lastChild;
  }
  return depth;
}

export function stripClipboardOmitted(slice: Slice, schema: Schema): Slice {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return slice;
  const scrubbed = scrubFragment(slice.content, omitted);
  if (scrubbed === slice.content) return slice;
  const openStart = Math.min(slice.openStart, maxOpenDepth(scrubbed, 'first'));
  const openEnd = Math.min(slice.openEnd, maxOpenDepth(scrubbed, 'last'));
  return new SliceCtor(scrubbed, openStart, openEnd);
}

export function stripClipboardOmittedFromNode(node: Node, schema: Schema): Node {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return node;
  const scrubbed = scrubFragment(node.content, omitted);
  return scrubbed === node.content ? node : node.copy(scrubbed);
}

export function stripClipboardOmittedFromFragment(fragment: Fragment, schema: Schema): Fragment {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return fragment;
  return scrubFragment(fragment, omitted);
}
