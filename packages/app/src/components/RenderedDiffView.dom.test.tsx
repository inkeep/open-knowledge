import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  countRenderedDiffAnchors,
  RENDERED_DIFF_CHANGE_SELECTOR,
} from '@/lib/rendered-diff/diff-decorations';
import { computeRenderedDiff, RenderedDiffView } from './RenderedDiffView';

afterEach(() => {
  cleanup();
});

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
    expect(lists.length).toBe(1);
    expect(pane.querySelectorAll('.ProseMirror ol > li').length).toBe(3);
  });

  test('a pure insertion produces a scroll/stepper anchor', async () => {
    const pane = await mountDiff('Kept paragraph.', 'Kept paragraph.\n\nA newly added paragraph.');
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

    const marked = Array.from(pane.querySelectorAll(RENDERED_DIFF_CHANGE_SELECTOR))
      .map((el) => el.textContent ?? '')
      .join(' ');
    expect(marked).toContain('third item');
    expect(marked).not.toContain('Proposal');
    expect(marked).not.toContain('Spec');
  });

  test('a formatting-only change (bold removed) renders without content churn', async () => {
    const pane = await mountDiff('one **two three** four', 'one two three four');
    expect(pane.querySelector('.ProseMirror')).toBeTruthy();
    expect(pane.querySelector('.ok-diff-ins-block')).toBeNull();
  });

  test('countRenderedDiffAnchors matches the real DOM anchor count (incl. mark changes)', async () => {
    for (const [before, after] of [
      ['one **two three** four', 'one two three four'],
      ['Kept paragraph.', 'Kept paragraph.\n\nAdded paragraph.'],
      ['Old bullet only.', 'Reworded bullet only.'],
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
