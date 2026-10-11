import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const constructed: string[] = [];

class FakeProvider {
  constructor(opts: { name: string }) {
    constructed.push(opts.name);
  }
  on() {}
  off() {}
  destroy() {}
}

vi.doMock('@hocuspocus/provider', () => ({ HocuspocusProvider: FakeProvider }));
vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: 'ws://test/collab' }),
}));

const { computeRenderedDiff, RenderedDiffView } = await import('./RenderedDiffView');

afterEach(() => {
  cleanup();
  constructed.length = 0;
});

async function mountDiff(before: string, after: string): Promise<HTMLElement> {
  const diff = computeRenderedDiff(before, after);
  if (!diff.ok) throw new Error(`engine returned not-ok: ${diff.reason}`);
  render(<RenderedDiffView diff={diff} docName="notes" />);
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="rendered-diff-view"]');
    if (!el?.querySelector('.ProseMirror')) throw new Error('editor not mounted yet');
    return el;
  });
}

describe('RenderedDiffView live documents', () => {
  test.each([
    ['Mirror', '<Mirror src="specs/shared-intro" />'],
    ['Excalidraw', '<Excalidraw src="/boards/plan.excalidraw" />'],
  ])('an inserted and a deleted %s open no live document', async (name, block) => {
    const inserted = await mountDiff('Intro.', `Intro.\n\n${block}`);
    await waitFor(() =>
      expect(
        inserted.querySelector(`.ok-diff-ins-block [data-component-name="${name}"] > *`),
      ).toBeTruthy(),
    );
    cleanup();
    const deleted = await mountDiff(`Intro.\n\n${block}`, 'Intro.');
    await waitFor(() =>
      expect(
        deleted.querySelector(`[data-diff-deleted] [data-component-name="${name}"] > *`),
      ).toBeTruthy(),
    );
    expect(constructed).toEqual([]);
  });
});
