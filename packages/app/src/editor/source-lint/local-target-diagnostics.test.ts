/**
 * Unit tests for the pure server-assessment → CodeMirror diagnostic mapping.
 *
 * The source-mode target-existence layer takes the server's authoritative
 * `source: 'links'` findings (already policy-gated by `validation.links`) and
 * projects them onto CodeMirror lint diagnostics, widening each collapsed
 * occurrence point to the enclosing link/image span via the Lezer tree so the
 * squiggle covers the whole authored occurrence. Tested headless with an
 * `EditorState` carrying the markdown language (for the syntax tree) — no DOM,
 * matching the sibling `markdown-lint-source` + `source-polish` conventions.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { ValidationDocResult } from '@inkeep/open-knowledge-core';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';
import { mapLocalTargetDiagnostics } from './local-target-diagnostics.ts';

type LinkFinding = ValidationDocResult['diagnostics'][number];

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

/** A collapsed server finding: point range at (line, column), like the wire. */
function finding(over: Partial<LinkFinding> & { line: number; column: number }): LinkFinding {
  const { line, column, ...rest } = over;
  return {
    range: { start: { line, character: column }, end: { line, character: column } },
    severity: 'warning',
    source: 'links',
    code: 'dead-link',
    message: 'Link target "./x" does not resolve to an existing file.',
    ...rest,
  } as LinkFinding;
}

describe('mapLocalTargetDiagnostics', () => {
  test('widens a missing-file link finding to span the whole authored link', () => {
    const doc = 'See [the report](./missing.pdf) now.\n';
    const state = stateOf(doc);
    const linkStart = doc.indexOf('[the report]');
    const linkEnd = doc.indexOf(')') + 1;
    const [d] = mapLocalTargetDiagnostics(state, [
      finding({
        line: 0,
        column: linkStart,
        severity: 'error',
        message: 'Link target "./missing.pdf" does not resolve to an existing file.',
      }),
    ]);
    // The server collapses the range to the occurrence start; the source layer
    // widens it to the enclosing Link node so the squiggle covers `[..](..)`.
    expect(d?.from).toBe(linkStart);
    expect(d?.to).toBe(linkEnd);
    expect(d?.severity).toBe('error');
    expect(d?.message).toBe('Link target "./missing.pdf" does not resolve to an existing file.');
    expect(d?.source).toBe('links/dead-link');
  });

  test('widens a markdown image finding to span the whole authored image', () => {
    const doc = 'A ![alt text](./missing.png) here.\n';
    const state = stateOf(doc);
    const imgStart = doc.indexOf('![alt text]');
    const imgEnd = doc.indexOf(')') + 1;
    const [d] = mapLocalTargetDiagnostics(state, [
      finding({
        line: 0,
        column: imgStart,
        message: 'Image target "./missing.png" does not resolve to an existing file.',
      }),
    ]);
    expect(d?.from).toBe(imgStart);
    expect(d?.to).toBe(imgEnd);
  });

  test('widens a bare HTML img finding to span the whole tag', () => {
    const doc = 'Inline <img src="./missing.png"> image.\n';
    const state = stateOf(doc);
    const tagStart = doc.indexOf('<img');
    const tagEnd = doc.indexOf('>') + 1;
    const [d] = mapLocalTargetDiagnostics(state, [
      finding({
        line: 0,
        column: tagStart,
        message: 'Image target "./missing.png" does not resolve to an existing file.',
      }),
    ]);
    // HTML img must land a real span, not a point — it is the form the ticket
    // names and the one no prior source-mode treatment covered.
    expect(d?.from).toBe(tagStart);
    expect(d?.to).toBeGreaterThan(tagStart);
    expect(d?.to).toBe(tagEnd);
  });

  test('positions every reference-style use independently over the same label', () => {
    const doc = 'First [one][r] and second [two][r].\n\n[r]: ./missing.pdf\n';
    const state = stateOf(doc);
    const firstUse = doc.indexOf('[one][r]');
    const secondUse = doc.indexOf('[two][r]');
    const diagnostics = mapLocalTargetDiagnostics(state, [
      finding({
        line: 0,
        column: firstUse,
        message: 'Link target "./missing.pdf" does not resolve to an existing file.',
        localTarget: {
          href: './missing.pdf',
          targetKind: 'file',
          role: 'link',
          sourceForm: 'markdown-reference',
          resolvedTarget: 'missing.pdf',
          reason: 'no-such-file',
          resolutionMethod: 'source-relative',
          definition: { line: 2, label: 'r' },
        },
      }),
      finding({
        line: 0,
        column: secondUse,
        message: 'Link target "./missing.pdf" does not resolve to an existing file.',
        localTarget: {
          href: './missing.pdf',
          targetKind: 'file',
          role: 'link',
          sourceForm: 'markdown-reference',
          resolvedTarget: 'missing.pdf',
          reason: 'no-such-file',
          resolutionMethod: 'source-relative',
          definition: { line: 2, label: 'r' },
        },
      }),
    ]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.from).toBe(firstUse);
    expect(diagnostics[1]?.from).toBe(secondUse);
    // Two distinct positioned diagnostics — the two uses never collapse to one.
    expect(diagnostics[0]?.from).not.toBe(diagnostics[1]?.from);
  });

  test('widens a graph document dead-link (no local-target evidence) to its link span', () => {
    const doc = 'See [the page](./gone) here.\n';
    const state = stateOf(doc);
    const linkStart = doc.indexOf('[the page]');
    const [d] = mapLocalTargetDiagnostics(state, [
      finding({
        line: 0,
        column: linkStart,
        message: 'Link target "gone" does not resolve to an existing document.',
      }),
    ]);
    expect(d?.from).toBe(linkStart);
    expect(d?.to).toBe(doc.indexOf(')') + 1);
  });

  test('falls back to a positioned point when no link/image node encloses the occurrence', () => {
    const doc = 'A [[Wiki Target]] embed.\n';
    const state = stateOf(doc);
    const wikiStart = doc.indexOf('[[Wiki Target]]');
    const [d] = mapLocalTargetDiagnostics(state, [
      finding({ line: 0, column: wikiStart, message: 'x' }),
    ]);
    // Wiki forms have no Lezer Link node; the diagnostic stays positioned at the
    // occurrence rather than mis-widening onto unrelated text.
    expect(d?.from).toBe(wikiStart);
    expect(d?.to).toBe(wikiStart);
  });

  test('skips non-links findings (they belong to their own surfaces)', () => {
    const doc = 'plain text\n';
    const state = stateOf(doc);
    expect(
      mapLocalTargetDiagnostics(state, [
        finding({ line: 0, column: 0, source: 'markdownlint', code: 'MD010' }),
        finding({ line: 0, column: 0, source: 'frontmatter', code: 'required' }),
      ]),
    ).toHaveLength(0);
  });

  test('clamps an out-of-range occurrence instead of throwing', () => {
    const doc = 'one line\n';
    const state = stateOf(doc);
    expect(() =>
      mapLocalTargetDiagnostics(state, [finding({ line: 998, column: 40, message: 'x' })]),
    ).not.toThrow();
    expect(
      mapLocalTargetDiagnostics(state, [finding({ line: 998, column: 40, message: 'x' })]),
    ).toHaveLength(1);
  });

  test('maps severities: error, warning, and info', () => {
    const doc = '[a](./x) [b](./y) [c](./z)\n';
    const state = stateOf(doc);
    const diagnostics = mapLocalTargetDiagnostics(state, [
      finding({ line: 0, column: 0, severity: 'error' }),
      finding({ line: 0, column: doc.indexOf('[b]'), severity: 'warning' }),
      finding({ line: 0, column: doc.indexOf('[c]'), severity: 'info' }),
    ]);
    expect(diagnostics.map((d) => d.severity)).toEqual(['error', 'warning', 'info']);
  });
});
