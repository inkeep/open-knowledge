import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function applySplice(
  oldBody: string,
  splice: { spliceStart: number; spliceEnd: number; newSlice: string },
): string {
  return oldBody.slice(0, splice.spliceStart) + splice.newSlice + oldBody.slice(splice.spliceEnd);
}

function editTextNode(pm: JSONContent, marker: string): JSONContent {
  const clone = JSON.parse(JSON.stringify(pm)) as JSONContent;
  let done = false;
  const walk = (node: JSONContent): void => {
    if (done) return;
    if (node.type === 'text' && typeof node.text === 'string' && node.text.includes(marker)) {
      node.text = `${node.text} EDITWORD`;
      done = true;
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(clone);
  if (!done) throw new Error(`marker not found in PM doc: ${marker}`);
  return clone;
}

describe('computeMapDrivenBodySplice unchanged-block detection', () => {
  test('lazy-continuation blockquote untouched by the edit stays outside the splice', () => {
    const oldBody = '> lazy first line\nlazy continuation stays\n\nSeparate paragraph.\n';
    const pm = editTextNode(mdManager.parse(oldBody), 'Separate paragraph.');

    const splice = computeMapDrivenBodySplice(oldBody, pm, mdManager);
    expect(splice).not.toBeNull();
    if (!splice) return;

    const result = applySplice(oldBody, splice);
    expect(result).toBe(
      '> lazy first line\nlazy continuation stays\n\nSeparate paragraph. EDITWORD\n',
    );
  });

  test('same-list edit preserves a sibling item containing a multi-blank run', () => {
    const oldBody = '- item one\n\n  para in item\n\n\n  wide gap para\n- item two editable\n';
    const pm = editTextNode(mdManager.parse(oldBody), 'item two editable');

    const splice = computeMapDrivenBodySplice(oldBody, pm, mdManager);
    expect(splice).not.toBeNull();
    if (!splice) return;

    const result = applySplice(oldBody, splice);
    expect(result).toBe(
      '- item one\n\n  para in item\n\n\n  wide gap para\n- item two editable EDITWORD\n',
    );
  });

  test('same-blockquote edit preserves a sibling lazy-continuation paragraph', () => {
    const oldBody = '> lazy first line\nlazy continuation stays\n>\n> editable second para\n';
    const pm = editTextNode(mdManager.parse(oldBody), 'editable second para');

    const splice = computeMapDrivenBodySplice(oldBody, pm, mdManager);
    expect(splice).not.toBeNull();
    if (!splice) return;

    const result = applySplice(oldBody, splice);
    expect(result).toBe(
      '> lazy first line\nlazy continuation stays\n>\n> editable second para EDITWORD\n',
    );
  });

  test('container-data-only change blocks narrowing: bullet-marker flip rewrites the whole list', () => {
    const oldBody = '* item one\n* item two\n';
    const pm = JSON.parse(JSON.stringify(mdManager.parse(oldBody))) as JSONContent;
    const list = pm.content?.find((n) => n.type === 'list');
    if (!list?.attrs) throw new Error('list node with attrs not found');
    expect(list.attrs.bulletMarker).toBe('*');
    list.attrs.bulletMarker = '-';

    const splice = computeMapDrivenBodySplice(oldBody, pm, mdManager);
    expect(splice).not.toBeNull();
    if (!splice) return;

    const result = applySplice(oldBody, splice);
    expect(result).toBe('- item one\n- item two\n');
  });

  test('a REAL source-form change on an otherwise text-identical block is still detected (dash-count tripwire twin)', () => {
    const oldBody = '| A | B |\n| - | - |\n| x | y |\n';
    const newBody = '| A | B |\n| --- | --- |\n| x | y |\n';
    const pm = mdManager.parse(newBody);

    const splice = computeMapDrivenBodySplice(oldBody, pm, mdManager);
    expect(splice).not.toBeNull();
    if (!splice) return;

    const result = applySplice(oldBody, splice);
    expect(result).toBe(newBody);
  });
});
