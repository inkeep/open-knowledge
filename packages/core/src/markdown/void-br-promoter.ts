import type { Break, Parent, Root, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { deriveFragmentPosition } from './promoter-position.ts';

const VOID_BR_IN_TEXT_RE = /(?<!\uE102)<br[ \t]*\/?>/g;

const SKIP_SUBTREE_TYPES = new Set(['mdxJsxTextElement', 'mdxJsxFlowElement']);

function promoteVoidBrInParent(parent: Parent, source: string): void {
  const newChildren: Parent['children'] = [];
  let changed = false;

  for (const child of parent.children) {
    if (child.type !== 'text') {
      newChildren.push(child);
      continue;
    }

    const text = (child as Text).value;
    VOID_BR_IN_TEXT_RE.lastIndex = 0;

    const segments: Parent['children'] = [];
    let lastIndex = 0;

    for (;;) {
      const match = VOID_BR_IN_TEXT_RE.exec(text);
      if (match === null) break;
      const matchStart = match.index;

      if (matchStart > lastIndex) {
        const lead: Text = { type: 'text', value: text.slice(lastIndex, matchStart) };
        const pos = deriveFragmentPosition(source, child as Text, lastIndex, matchStart);
        if (pos) lead.position = pos;
        segments.push(lead);
      }

      const brNode: Break = {
        type: 'break',
        data: { sourceStyle: 'html', sourceRaw: match[0] },
      };
      const brPos = deriveFragmentPosition(
        source,
        child as Text,
        matchStart,
        matchStart + match[0].length,
      );
      if (brPos) brNode.position = brPos;
      segments.push(brNode);

      lastIndex = matchStart + match[0].length;
      changed = true;
    }

    if (segments.length === 0) {
      newChildren.push(child);
    } else {
      if (lastIndex < text.length) {
        const tail: Text = { type: 'text', value: text.slice(lastIndex) };
        const pos = deriveFragmentPosition(source, child as Text, lastIndex, text.length);
        if (pos) tail.position = pos;
        segments.push(tail);
      }
      newChildren.push(...segments);
    }
  }

  if (changed) {
    parent.children = newChildren;
  }
}

export function voidBrPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    visit(tree, (node) => {
      if (SKIP_SUBTREE_TYPES.has(node.type)) return SKIP;
      const maybeParent = node as Partial<Parent>;
      if (Array.isArray(maybeParent.children)) {
        promoteVoidBrInParent(node as Parent, source);
      }
      return undefined;
    });
  };
}
