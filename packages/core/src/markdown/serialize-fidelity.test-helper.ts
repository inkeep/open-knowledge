import type { JSONContent } from '@tiptap/core';
import type { Nodes } from 'mdast';
import { expect } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from './index.ts';
import { isInlineWhitespaceNumericCharRef } from './whitespace-char-ref.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

const NUMERIC_CHAR_REF_SCAN = /&#(?:x[0-9A-Fa-f]+|X[0-9A-Fa-f]+|[0-9]+);/g;

export function assertFragmentSerializesTo(fragment: JSONContent, expectedBytes: string): void {
  expect(md.serialize(fragment)).toBe(expectedBytes);
}

export function assertNoBoundaryLeak(fragment: JSONContent): void {
  const out = md.serialize(fragment);
  const leaked = (out.match(NUMERIC_CHAR_REF_SCAN) ?? []).filter(isInlineWhitespaceNumericCharRef);
  expect(leaked).toEqual([]);
}

export function assertMarkSurvives(fragment: JSONContent, markType: string): void {
  const out = md.serialize(fragment);
  expect(mdastNodeTypes(out)).toContain(markType);
}

function mdastNodeTypes(markdown: string): string[] {
  const out: string[] = [];
  const walk = (node: Nodes): void => {
    out.push(node.type);
    if ('children' in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(md.parseToMdast(markdown));
  return out;
}
