import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { __resetPageListCacheForTests, setPageListCache } from '@/editor/page-list-cache';
import {
  countRenderedDiffAnchors,
  RENDERED_DIFF_CHANGE_SELECTOR,
} from '@/lib/rendered-diff/diff-decorations';
import { computeRenderedDiff, RenderedDiffView } from './RenderedDiffView';

afterEach(() => {
  cleanup();
  __resetPageListCacheForTests();
});

async function mountDiff(before: string, after: string, docName = 'notes'): Promise<HTMLElement> {
  const diff = computeRenderedDiff(before, after);
  if (!diff.ok) throw new Error(`engine returned not-ok: ${diff.reason}`);
  render(<RenderedDiffView diff={diff} docName={docName} />);
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

  test('a relative link resolves against the changed document, not the project root', async () => {
    setPageListCache({
      pages: new Set(['projects/ok-cloud/log', 'projects/ok-cloud/launch-scope', 'launch-dev']),
      folderPaths: new Set(['projects', 'projects/ok-cloud']),
      pagesBySlug: new Map(),
    });
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\nSee [scope](launch-scope.md) and [dev](launch-dev.md).',
      'projects/ok-cloud/log',
    );

    const stateOf = (text: string) =>
      Array.from(pane.querySelectorAll<HTMLElement>('[data-resolution-state]'))
        .find((el) => el.textContent === text)
        ?.getAttribute('data-resolution-state');
    await waitFor(() => expect(stateOf('scope')).toBe('resolved'));
    expect(stateOf('dev')).toBe('unresolved');
  });

  test('a relative inline image resolves against the changed document folder', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\nSee ![diagram](diagram.png) here.',
      'projects/ok-cloud/log',
    );

    await waitFor(() =>
      expect(pane.querySelector('img')?.getAttribute('src')).toBe('/projects/ok-cloud/diagram.png'),
    );
  });

  test('an inserted standalone image renders the image inside the highlighted block', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n![diagram](diagram.png)',
      'projects/ok-cloud/log',
    );

    await waitFor(() =>
      expect(
        pane
          .querySelector('.ok-diff-ins-block [data-component-name="CommonMarkImage"] img')
          ?.getAttribute('src'),
      ).toBe('/projects/ok-cloud/diagram.png'),
    );
  });

  test('a deleted standalone image renders the image inside the struck widget', async () => {
    const pane = await mountDiff(
      'Intro.\n\n![diagram](diagram.png)',
      'Intro.',
      'projects/ok-cloud/log',
    );

    await waitFor(() =>
      expect(pane.querySelector('[data-diff-deleted] img')?.getAttribute('src')).toBe(
        '/projects/ok-cloud/diagram.png',
      ),
    );
  });

  test('an inserted Callout renders its callout box around the changed text', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n<Callout type="warning">\n\nMind the gap.\n\n</Callout>',
    );

    const callout = await waitFor(() => {
      const el = pane.querySelector('.ok-diff-ins-block .callout');
      if (!el) throw new Error('callout not rendered');
      return el;
    });
    expect(callout.getAttribute('data-callout-type')).toBe('warning');
    expect(callout.textContent).toContain('Mind the gap.');
  });

  test('a deleted Callout renders its callout box inside the struck widget', async () => {
    const pane = await mountDiff(
      'Intro.\n\n<Callout type="warning">\n\nMind the gap.\n\n</Callout>',
      'Intro.',
    );

    const callout = await waitFor(() => {
      const el = pane.querySelector('[data-diff-deleted] .callout');
      if (!el) throw new Error('callout not rendered');
      return el;
    });
    expect(callout.textContent).toContain('Mind the gap.');
  });

  test('a Mirror renders as a static reference to its source, not a live embed', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n<Mirror src="specs/shared-intro" anchor="overview" />',
    );

    const reference = await waitFor(() => {
      const el = pane.querySelector('.ok-diff-ins-block [data-diff-jsx-reference]');
      if (!el) throw new Error('reference not rendered');
      return el;
    });
    expect(reference.textContent).toContain('specs/shared-intro#overview');
  });

  test('an unregistered component renders its source', async () => {
    const pane = await mountDiff('Intro.', 'Intro.\n\n<Widget size="2" />');

    const source = await waitFor(() => {
      const el = pane.querySelector('.ok-diff-ins-block [data-diff-jsx-source]');
      if (!el) throw new Error('source not rendered');
      return el;
    });
    expect(source.textContent).toContain('Unknown component: Widget');
    expect(source.querySelector('code')?.textContent).toBe('<Widget size="2" />');
  });

  test('an edit inside an unregistered wrapper renders its children in the changed blocks', async () => {
    const before = '<Widget tone="calm">\n\nOld wrapped text.\n\n</Widget>';
    const after = '<Widget tone="loud">\n\nNew wrapped text.\n\n</Widget>';
    const pane = await mountDiff(before, after);

    await waitFor(() =>
      expect(pane.querySelector('.ok-diff-ins-block [data-diff-jsx-source] p')?.textContent).toBe(
        'New wrapped text.',
      ),
    );
    await waitFor(() =>
      expect(pane.querySelector('[data-diff-deleted] [data-diff-jsx-source] p')?.textContent).toBe(
        'Old wrapped text.',
      ),
    );
    expect(pane.querySelector('.ok-diff-ins-block [data-diff-jsx-source] code')?.textContent).toBe(
      '<Widget tone="loud">',
    );
    expect(pane.querySelector('[data-diff-deleted] [data-diff-jsx-source] code')?.textContent).toBe(
      '<Widget tone="calm">',
    );
    const diff = computeRenderedDiff(before, after);
    if (!diff.ok) throw new Error(`engine not-ok: ${diff.reason}`);
    expect(pane.querySelectorAll(RENDERED_DIFF_CHANGE_SELECTOR).length).toBe(
      countRenderedDiffAnchors(diff),
    );
  });

  test('a deleted Tabs keeps its labelled tabs', async () => {
    const tabs =
      '<Tabs>\n\n<Tab label="One">\n\nFirst panel.\n\n</Tab>\n\n<Tab label="Two">\n\nSecond panel.\n\n</Tab>\n\n</Tabs>';
    const pane = await mountDiff(`Intro.\n\n${tabs}`, 'Intro.');

    await waitFor(() =>
      expect(
        Array.from(pane.querySelectorAll('[data-diff-deleted] [role="tab"]')).map(
          (tab) => tab.textContent,
        ),
      ).toEqual(['One', 'Two']),
    );
    expect(pane.querySelector('[data-diff-deleted]')?.textContent).toContain('Second panel.');
  });

  test('a collapsible block renders open so its changed content is visible', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n<Accordion title="Details">\n\nHidden detail.\n\n</Accordion>',
    );

    const details = await waitFor(() => {
      const el = pane.querySelector<HTMLDetailsElement>('.ok-diff-ins-block details.accordion');
      if (!el) throw new Error('accordion not rendered');
      return el;
    });
    expect(details.open).toBe(true);
  });

  test('a video in a diff never autoplays or loops and always shows controls', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n<video src="clip.mp4" autoplay loop controls={false} />',
    );

    const video = await waitFor(() => {
      const el = pane.querySelector<HTMLVideoElement>('.ok-diff-ins-block video');
      if (!el) throw new Error('video not rendered');
      return el;
    });
    expect(video.autoplay).toBe(false);
    expect(video.loop).toBe(false);
    expect(video.controls).toBe(true);
  });

  test('a diff carries no editing chrome on its components', async () => {
    const pane = await mountDiff(
      'Intro.',
      'Intro.\n\n<Callout type="warning">\n\nMind the gap.\n\n</Callout>',
    );

    await waitFor(() => expect(pane.querySelector('.callout')).toBeTruthy());
    expect(pane.querySelector('.jsx-component-chrome')).toBeNull();
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
      render(<RenderedDiffView diff={diff} docName="notes" />);
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
