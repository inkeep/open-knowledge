import type { PhrasingContent, Root, Text } from 'mdast';
import type { InlineMath } from 'mdast-util-math';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { deriveFragmentPosition } from './promoter-position.ts';

const SINGLE_DOLLAR_MATH_RE = /(?<!\\)\$(?=\S)([^$\n]*?[^\s$])\$(?!\d)/g;

export function singleDollarMathPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;

      const value = node.value;
      if (value.indexOf('$') === -1) return;

      SINGLE_DOLLAR_MATH_RE.lastIndex = 0;
      const matches: RegExpExecArray[] = [];
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
      while ((m = SINGLE_DOLLAR_MATH_RE.exec(value)) !== null) {
        matches.push(m);
      }
      if (matches.length === 0) return;

      const replacements: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > cursor) {
          const lead: Text = { type: 'text', value: value.slice(cursor, start) };
          const pos = deriveFragmentPosition(source, node, cursor, start);
          if (pos) lead.position = pos;
          replacements.push(lead);
        }
        const mathNode: InlineMath = { type: 'inlineMath', value: match[1] };
        const fullPos = deriveFragmentPosition(source, node, start, end);
        if (fullPos) mathNode.position = fullPos;
        replacements.push(mathNode as unknown as PhrasingContent);
        cursor = end;
      }
      if (cursor < value.length) {
        const tail: Text = { type: 'text', value: value.slice(cursor) };
        const pos = deriveFragmentPosition(source, node, cursor, value.length);
        if (pos) tail.position = pos;
        replacements.push(tail);
      }

      const arr = (parent as { children: PhrasingContent[] }).children;
      arr.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });
  };
}
