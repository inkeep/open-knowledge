import type { Parent, Text } from 'mdast';
import type { TagMdast } from './mdast-augmentation.ts';
import {
  deriveFragmentPosition,
  escapedValueOffsets,
  isEscapeDerivedRun,
  sliceTextWithProvenance,
} from './promoter-position.ts';

export const TAG_IN_TEXT_PATTERN_SOURCE = '(^|\\s)#([a-zA-Z][\\w/-]*)';
export function createTagInTextRegex(): RegExp {
  return new RegExp(TAG_IN_TEXT_PATTERN_SOURCE, 'g');
}
const TAG_IN_TEXT_RE = createTagInTextRegex();

export const INLINE_TAG_VALUE_RE = /^[a-zA-Z][\w/-]*$/;

export function promoteTagsInParent(parent: Parent, source: string = ''): void {
  const newChildren: Parent['children'] = [];
  let changed = false;

  for (const child of parent.children) {
    if (child.type !== 'text') {
      newChildren.push(child);
      continue;
    }

    const text = (child as Text).value;
    const escaped = escapedValueOffsets(child as Text);
    TAG_IN_TEXT_RE.lastIndex = 0;

    const segments: Parent['children'] = [];
    let lastIndex = 0;

    for (;;) {
      const match = TAG_IN_TEXT_RE.exec(text);
      if (match === null) break;
      const boundary = match[1] ?? '';
      const tagValue = match[2] ?? '';
      const tagStart = match.index + boundary.length;

      if (isEscapeDerivedRun(escaped, tagStart, 1)) continue;

      if (tagStart > lastIndex) {
        segments.push(sliceTextWithProvenance(source, child as Text, lastIndex, tagStart));
      }

      const tagNode: TagMdast = { type: 'tag', value: tagValue };
      const tagPos = deriveFragmentPosition(
        source,
        child as Text,
        tagStart,
        tagStart + 1 + tagValue.length,
      );
      if (tagPos) tagNode.position = tagPos;
      segments.push(tagNode as unknown as Parent['children'][number]);

      lastIndex = tagStart + 1 + tagValue.length;
      changed = true;
    }

    if (segments.length === 0) {
      newChildren.push(child);
    } else {
      if (lastIndex < text.length) {
        segments.push(sliceTextWithProvenance(source, child as Text, lastIndex, text.length));
      }
      newChildren.push(...segments);
    }
  }

  if (changed) {
    parent.children = newChildren;
  }
}
