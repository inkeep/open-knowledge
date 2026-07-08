/**
 * `replaceYText` splices new content into an existing `Y.Text` using the
 * smallest edit that spans the change — the prefix/suffix shrink is the
 * primary WYSIWYG write path (`commitChart → replaceYText`) so its
 * boundary logic needs targeted coverage. A bug in the `start` /
 * `endCur` / `endNext` interactions would produce incorrect splices,
 * manifesting as corrupted diagram labels after a click-edit.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { replaceYText } from './MermaidDocEditor.tsx';

function makeYText(initial: string): { doc: Y.Doc; ytext: Y.Text; events: Y.YTextEvent[] } {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  ytext.insert(0, initial);
  const events: Y.YTextEvent[] = [];
  ytext.observe((ev) => events.push(ev));
  return { doc, ytext, events };
}

describe('replaceYText', () => {
  test('identical strings — no-op (no event fires)', () => {
    const { ytext, events } = makeYText('graph LR\n  A --> B\n');
    replaceYText(ytext, 'graph LR\n  A --> B\n');
    expect(ytext.toString()).toBe('graph LR\n  A --> B\n');
    expect(events.length).toBe(0);
  });

  test('prefix-only change splices at the start, preserves the trailing suffix', () => {
    const { ytext, events } = makeYText('OldPrefix middle suffix');
    replaceYText(ytext, 'NewPrefix middle suffix');
    expect(ytext.toString()).toBe('NewPrefix middle suffix');
    // Exactly one splice — the prefix region.
    expect(events.length).toBe(1);
  });

  test('suffix-only change splices at the end, preserves the leading prefix', () => {
    const { ytext, events } = makeYText('prefix middle OldSuffix');
    replaceYText(ytext, 'prefix middle NewSuffix');
    expect(ytext.toString()).toBe('prefix middle NewSuffix');
    expect(events.length).toBe(1);
  });

  test('middle change splices only the differing interior', () => {
    const { ytext } = makeYText('prefix OLD suffix');
    replaceYText(ytext, 'prefix NEW suffix');
    expect(ytext.toString()).toBe('prefix NEW suffix');
  });

  test('complete replacement splices the whole doc', () => {
    const { ytext } = makeYText('graph LR\n  A --> B');
    replaceYText(ytext, 'sequenceDiagram\n  A->>B: hi');
    expect(ytext.toString()).toBe('sequenceDiagram\n  A->>B: hi');
  });

  test('empty → content inserts the whole string', () => {
    const { ytext } = makeYText('');
    replaceYText(ytext, 'graph LR\n  A --> B');
    expect(ytext.toString()).toBe('graph LR\n  A --> B');
  });

  test('content → empty deletes the whole string', () => {
    const { ytext } = makeYText('graph LR\n  A --> B');
    replaceYText(ytext, '');
    expect(ytext.toString()).toBe('');
  });

  test('overlapping prefix/suffix (identical surrounding text) locates the middle change', () => {
    // The classic diff-boundary trap: prefix/suffix common runs meet in
    // the middle. If the algorithm shrinks suffix too aggressively, it
    // will delete or insert the wrong characters.
    const { ytext } = makeYText('abcXabc');
    replaceYText(ytext, 'abcYabc');
    expect(ytext.toString()).toBe('abcYabc');
  });

  test('insertion in a symmetrical repeat preserves both ends', () => {
    const { ytext } = makeYText('abcabc');
    replaceYText(ytext, 'abcZabc');
    expect(ytext.toString()).toBe('abcZabc');
  });

  test('single-character change at the boundary between prefix + suffix', () => {
    const { ytext } = makeYText('aaXaa');
    replaceYText(ytext, 'aaYaa');
    expect(ytext.toString()).toBe('aaYaa');
  });

  test('multi-line mermaid label rewrite (real WYSIWYG shape)', () => {
    // What the WYSIWYG click-edit actually produces: replace one node
    // label mid-chart, everything else unchanged.
    const before = 'graph LR\n  Shopper --> Storefront\n  Storefront --> Cart\n';
    const after = 'graph LR\n  Buyer --> Storefront\n  Storefront --> Cart\n';
    const { ytext } = makeYText(before);
    replaceYText(ytext, after);
    expect(ytext.toString()).toBe(after);
  });

  test('splice runs inside a Y.Doc transaction so cursors + peers see one update', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    ytext.insert(0, 'prefix OLD suffix');
    let transactionCount = 0;
    doc.on('afterTransaction', () => {
      transactionCount += 1;
    });
    replaceYText(ytext, 'prefix NEW suffix');
    expect(transactionCount).toBe(1);
    expect(ytext.toString()).toBe('prefix NEW suffix');
  });
});
