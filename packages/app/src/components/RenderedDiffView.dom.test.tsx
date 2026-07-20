/**
 * RTL mount tests for the rendered (WYSIWYG) Timeline diff. The engine ranges
 * are unit-tested in `lib/rendered-diff/build-rendered-diff.test.ts`; this file
 * locks the parts that only exist once the decorations are painted into a real
 * read-only editor — which is where three real bugs hid:
 *
 *   - decorations must anchor to a real `.ProseMirror` DOM (editor fidelity),
 *   - a pure INSERTION must still produce a scroll/stepper anchor
 *     (`.ok-diff-ins-block`) — a missing selector once left additions unscrolled,
 *   - editing one list item must NOT highlight its siblings — the `list` vs
 *     `bulletList` node-name bug once flagged the whole list.
 *
 * Invocation: `bun run test:dom src/components/RenderedDiffView.dom.test.tsx`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  countRenderedDiffAnchors,
  RENDERED_DIFF_CHANGE_SELECTOR,
} from '@/lib/rendered-diff/diff-decorations';
import { computeRenderedDiff, RenderedDiffView } from './RenderedDiffView';

afterEach(() => {
  cleanup();
});

/** Compute + mount a rendered diff; resolve once the ProseMirror DOM exists. */
async function mountDiff(before: string, after: string): Promise<HTMLElement> {
  const diff = computeRenderedDiff(before, after);
  if (!diff.ok) throw new Error(`engine returned not-ok: ${diff.reason}`);
  render(<RenderedDiffView diff={diff} />);
  const pane = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="rendered-diff-view"]');
    if (!el?.querySelector('.ProseMirror')) throw new Error('editor not mounted yet');
    return el;
  });
  return pane;
}

describe('RenderedDiffView', () => {
  test('renders the diff as real .ProseMirror editor DOM', async () => {
    const pane = await mountDiff('Alpha paragraph.', 'Alpha paragraph, extended.');
    expect(pane.querySelector('.ProseMirror')).toBeTruthy();
  });

  test('an ordered list renders as one <ol> with all its items (not per-line lists)', async () => {
    const body = '1. first\n2. second\n3. third';
    const pane = await mountDiff(body, body);
    const lists = pane.querySelectorAll('.ProseMirror ol');
    // One ordered list containing all three items — the pre-fix per-line renderer
    // produced three separate <ol>s (each restarting at "1.").
    expect(lists.length).toBe(1);
    expect(pane.querySelectorAll('.ProseMirror ol > li').length).toBe(3);
  });

  test('a pure insertion produces a scroll/stepper anchor', async () => {
    const pane = await mountDiff('Kept paragraph.', 'Kept paragraph.\n\nA newly added paragraph.');
    // The added block must be findable by the EXACT selector the pane uses to
    // scroll-to-first-change and drive the stepper — shared const, so a class
    // rename can't desync the two (the original "additions don't scroll" bug).
    const anchor = pane.querySelector(RENDERED_DIFF_CHANGE_SELECTOR);
    expect(anchor).toBeTruthy();
    expect(pane.querySelector('.ok-diff-ins-block')?.textContent).toContain('newly added');
  });

  test('a deletion produces a struck [data-diff-deleted] widget', async () => {
    const pane = await mountDiff('Keep this.\n\nDrop this one.', 'Keep this.');
    const deleted = pane.querySelector('[data-diff-deleted]');
    expect(deleted).toBeTruthy();
    expect(deleted?.textContent).toContain('Drop this one');
  });

  test('editing one list item leaves sibling items un-highlighted', async () => {
    const before =
      '- [[proposals/0001|Proposal 0001]] vision.\n- [[specs/x/spec|Spec A]] tasks.\n- Old third item.';
    const after =
      '- [[proposals/0001|Proposal 0001]] vision.\n- [[specs/x/spec|Spec A]] tasks.\n- Reworded third item.';
    const pane = await mountDiff(before, after);

    // Only the third item may carry a change decoration; the untouched siblings
    // must not appear inside any highlighted/struck element (the list-node bug).
    const marked = Array.from(pane.querySelectorAll(RENDERED_DIFF_CHANGE_SELECTOR))
      .map((el) => el.textContent ?? '')
      .join(' ');
    expect(marked).toContain('third item');
    expect(marked).not.toContain('Proposal');
    expect(marked).not.toContain('Spec');
  });

  test('a formatting-only change (bold removed) renders without content churn', async () => {
    // Text is byte-identical; only a mark toggles. Must mount cleanly and mark
    // the phrase (via the mark-change replacement path), not the whole block.
    const pane = await mountDiff('one **two three** four', 'one two three four');
    expect(pane.querySelector('.ProseMirror')).toBeTruthy();
    // No whole-block insertion highlight — the block text did not change.
    expect(pane.querySelector('.ok-diff-ins-block')).toBeNull();
  });

  // The stepper's "N / M" must equal the real number of navigable anchors, or
  // navigation wraps past the displayed M. A mark change paints TWO anchors
  // (struck before + highlighted after), which the naive `changes.length +
  // markChanges.length` undercounts.
  test('countRenderedDiffAnchors matches the real DOM anchor count (incl. mark changes)', async () => {
    for (const [before, after] of [
      ['one **two three** four', 'one two three four'], // mark-only → 2 anchors
      ['Kept paragraph.', 'Kept paragraph.\n\nAdded paragraph.'], // insertion → 1
      ['Old bullet only.', 'Reworded bullet only.'], // reworded → del + ins = 2
    ] as const) {
      const diff = computeRenderedDiff(before, after);
      if (!diff.ok) throw new Error(`engine not-ok: ${diff.reason}`);
      cleanup();
      render(<RenderedDiffView diff={diff} />);
      const pane = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="rendered-diff-view"]');
        if (!el?.querySelector('.ProseMirror')) throw new Error('not mounted');
        return el;
      });
      const domAnchors = pane.querySelectorAll(RENDERED_DIFF_CHANGE_SELECTOR).length;
      expect(countRenderedDiffAnchors(diff)).toBe(domAnchors);
    }
  });
});
