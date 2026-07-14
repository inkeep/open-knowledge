/**
 * Unchanged-block detection must be writer-blind but round-trip-artifact
 * tolerant: a block the fragment did NOT edit must stay outside the splice
 * even when its parse captures data the serializer cannot replay (blockquote
 * lazy continuation), and a same-container edit must not rewrite sibling
 * children whose bytes the editor never touched.
 */

import { describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function applySplice(
  oldBody: string,
  splice: { spliceStart: number; spliceEnd: number; newSlice: string },
): string {
  return oldBody.slice(0, splice.spliceStart) + splice.newSlice + oldBody.slice(splice.spliceEnd);
}

/** Append ` EDITWORD` to the first PM text node containing `marker`. */
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
    // Drives tryNarrowIntoContainer into its own-fields-inequality bail: the
    // list's data.bulletMarker differs while every item's text is identical,
    // so the splice must cover the entire container — narrowing here would
    // silently drop the marker change.
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
    // The fragment carries a delimiter-row padding change (source-form data
    // difference with identical cell text). The splice must treat the table
    // as changed — skipping it would silently drop the concurrent edit.
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
