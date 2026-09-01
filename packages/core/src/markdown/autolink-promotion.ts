import type { Link, Parent, Text } from 'mdast';
import { deriveFragmentPosition } from './promoter-position.ts';

const AUTOLINK_IN_TEXT_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]+)>/g;

export function promoteInParent(parent: Parent, source: string = ''): void {
  const newChildren: Parent['children'] = [];
  let changed = false;

  for (const child of parent.children) {
    if (child.type !== 'text') {
      newChildren.push(child);
      continue;
    }

    const text = (child as Text).value;
    AUTOLINK_IN_TEXT_RE.lastIndex = 0;

    const segments: Parent['children'] = [];
    let lastIndex = 0;

    for (;;) {
      const match = AUTOLINK_IN_TEXT_RE.exec(text);
      if (match === null) break;
      const fullMatch = match[0];
      const uri = match[1];
      const matchStart = match.index;

      if (matchStart > lastIndex) {
        const lead: Text = { type: 'text', value: text.slice(lastIndex, matchStart) };
        const pos = deriveFragmentPosition(source, child as Text, lastIndex, matchStart);
        if (pos) lead.position = pos;
        segments.push(lead);
      }

      const innerText: Text = { type: 'text', value: uri };
      const innerPos = deriveFragmentPosition(
        source,
        child as Text,
        matchStart + 1,
        matchStart + 1 + uri.length,
      );
      if (innerPos) innerText.position = innerPos;
      const linkNode: Link & { data: { sourceStyle: string } } = {
        type: 'link',
        url: uri,
        title: null,
        children: [innerText],
        data: { sourceStyle: 'autolink' },
      };
      const linkPos = deriveFragmentPosition(
        source,
        child as Text,
        matchStart,
        matchStart + fullMatch.length,
      );
      if (linkPos) linkNode.position = linkPos;
      segments.push(linkNode);

      lastIndex = matchStart + fullMatch.length;
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
