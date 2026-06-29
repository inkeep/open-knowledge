
import type { Nodes, Parent, PhrasingContent, Root, Text } from 'mdast';
import type { MdxJsxTextElement } from 'mdast-util-mdx';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import type { MarkMdast } from './mdast-augmentation.ts';
import { deriveFragmentPosition } from './promoter-position.ts';

const HIGHLIGHT_RE = /(?<!=)==(?=\S)([^\n]*?[^\s=])==(?!=)/g;

type FlankableInline =
  | { type: 'strong'; children: PhrasingContent[] }
  | { type: 'emphasis'; children: PhrasingContent[] }
  | { type: 'delete'; children: PhrasingContent[] }
  | { type: 'inlineCode'; value: string };

function isFlankableInline(node: PhrasingContent): node is FlankableInline {
  return (
    node.type === 'strong' ||
    node.type === 'emphasis' ||
    node.type === 'delete' ||
    node.type === 'inlineCode'
  );
}

function getFirstChar(node: PhrasingContent): string | null {
  if (node.type === 'text') return node.value.length > 0 ? node.value.charAt(0) : null;
  if (node.type === 'inlineCode') return node.value.length > 0 ? node.value.charAt(0) : null;
  if ('children' in node && Array.isArray(node.children) && node.children.length > 0) {
    return getFirstChar(node.children[0] as PhrasingContent);
  }
  return null;
}

function getLastChar(node: PhrasingContent): string | null {
  if (node.type === 'text') return node.value.length > 0 ? node.value.slice(-1) : null;
  if (node.type === 'inlineCode') return node.value.length > 0 ? node.value.slice(-1) : null;
  if ('children' in node && Array.isArray(node.children) && node.children.length > 0) {
    const arr = node.children as PhrasingContent[];
    return getLastChar(arr[arr.length - 1]);
  }
  return null;
}

function promoteCrossChildren(parent: Parent): void {
  const children = parent.children as PhrasingContent[];
  let outerI = 0;
  while (outerI < children.length) {
    const openChild = children[outerI];
    if (openChild.type !== 'text') {
      outerI++;
      continue;
    }

    const openValue = openChild.value;
    let openPos = -1;
    for (let n = 0; n <= openValue.length - 2; n++) {
      if (openValue.charCodeAt(n) !== 61 || openValue.charCodeAt(n + 1) !== 61) continue; // 61 = '='
      if (n > 0 && openValue.charCodeAt(n - 1) === 61) continue;
      let charAfter: string | null;
      if (n + 2 < openValue.length) {
        charAfter = openValue.charAt(n + 2);
      } else {
        const next = children[outerI + 1];
        if (!next) continue;
        charAfter = getFirstChar(next);
      }
      if (charAfter === null || /\s/.test(charAfter)) continue;
      openPos = n;
      break;
    }
    if (openPos === -1) {
      outerI++;
      continue;
    }

    let closeChildIdx = -1;
    let closePos = -1;
    let bodyCrossesInline = false;

    for (let n2 = openPos + 3; n2 <= openValue.length - 2; n2++) {
      if (openValue.charCodeAt(n2) !== 61 || openValue.charCodeAt(n2 + 1) !== 61) continue;
      const before = openValue.charAt(n2 - 1);
      if (/[\s=]/.test(before)) continue;
      let after: string | null;
      if (n2 + 2 < openValue.length) {
        after = openValue.charAt(n2 + 2);
      } else {
        const next = children[outerI + 1];
        after = next ? (next.type === 'text' ? (next.value[0] ?? null) : getFirstChar(next)) : null;
      }
      if (after === '=') continue;
      closeChildIdx = -2;
      break;
    }
    if (closeChildIdx === -2) {
      outerI++;
      continue;
    }

    for (let j = outerI + 1; j < children.length; j++) {
      const sib = children[j];
      if (sib.type === 'text') {
        for (let n2 = 0; n2 <= sib.value.length - 2; n2++) {
          if (sib.value.charCodeAt(n2) !== 61 || sib.value.charCodeAt(n2 + 1) !== 61) continue;
          let before: string | null;
          if (n2 > 0) {
            before = sib.value.charAt(n2 - 1);
          } else {
            const prev = children[j - 1];
            before = getLastChar(prev);
          }
          if (before === null || /[\s=]/.test(before)) continue;
          let after: string | null;
          if (n2 + 2 < sib.value.length) {
            after = sib.value.charAt(n2 + 2);
          } else {
            const next = children[j + 1];
            after = next
              ? next.type === 'text'
                ? (next.value[0] ?? null)
                : getFirstChar(next)
              : null;
          }
          if (after === '=') continue;
          closeChildIdx = j;
          closePos = n2;
          bodyCrossesInline = true;
          break;
        }
        if (closeChildIdx >= 0) break;
      } else if (isFlankableInline(sib)) {
      } else {
        break;
      }
    }

    if (closeChildIdx < 0) {
      outerI++;
      continue;
    }

    const closeChild = children[closeChildIdx] as Text;
    const leadValue = openValue.slice(0, openPos);
    const openTrailing = openValue.slice(openPos + 2);
    const closeLeading = closeChild.value.slice(0, closePos);
    const tailValue = closeChild.value.slice(closePos + 2);

    const bodyChildren: PhrasingContent[] = [];
    if (openTrailing.length > 0) bodyChildren.push({ type: 'text', value: openTrailing });
    for (let k = outerI + 1; k < closeChildIdx; k++) bodyChildren.push(children[k]);
    if (closeLeading.length > 0) bodyChildren.push({ type: 'text', value: closeLeading });

    if (!bodyCrossesInline) {
      outerI++;
      continue;
    }

    const markNode: MarkMdast = {
      type: 'mark',
      children: bodyChildren as Nodes[],
    };

    const replacement: PhrasingContent[] = [];
    if (leadValue.length > 0) replacement.push({ type: 'text', value: leadValue });
    replacement.push(markNode as unknown as PhrasingContent);
    if (tailValue.length > 0) replacement.push({ type: 'text', value: tailValue });

    children.splice(outerI, closeChildIdx - outerI + 1, ...replacement);
    outerI += (leadValue.length > 0 ? 1 : 0) + 1;
  }
}

function walkPromote(node: Nodes): void {
  if ('children' in node && Array.isArray(node.children)) {
    promoteCrossChildren(node as Parent);
    for (const child of node.children) {
      walkPromote(child as Nodes);
    }
  }
}

export function highlightPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;

      const value = node.value;
      if (value.indexOf('==') === -1) return;

      HIGHLIGHT_RE.lastIndex = 0;
      const matches: RegExpExecArray[] = [];
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
      while ((m = HIGHLIGHT_RE.exec(value)) !== null) {
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
        const innerText: Text = { type: 'text', value: match[1] };
        const innerPos = deriveFragmentPosition(source, node, start + 2, end - 2);
        if (innerPos) innerText.position = innerPos;
        const markNode: MarkMdast = {
          type: 'mark',
          children: [innerText],
        };
        const markPos = deriveFragmentPosition(source, node, start, end);
        if (markPos) markNode.position = markPos;
        replacements.push(markNode as unknown as PhrasingContent);
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

    walkPromote(tree);

    visit(tree, 'mdxJsxTextElement', (node: MdxJsxTextElement, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;
      if (node.name !== 'mark') return;

      const markNode: MarkMdast = {
        type: 'mark',
        children: (node.children as Nodes[]) ?? [],
      };

      const arr = (parent as Parent).children;
      arr.splice(index, 1, markNode as unknown as (typeof arr)[number]);
      return index + 1;
    });
  };
}
