/**
 * DOM test for the internal doc-preview reader hook's target binding. The hover
 * panel is a reused singleton, so `docName` changes without a remount; the
 * async fields (excerpt / tags / backlink count) must be bound to the target
 * they were loaded for and matched at render, or a chip-to-chip focus move
 * paints doc A's excerpt under doc B's title for the frame(s) before a reset
 * effect runs.
 *
 * The probe records every render's output, so the assertion covers the exact
 * mixed frame a screen-level query would race past. Only the data loaders
 * (`loadDocContent` / `loadBacklinkCount`) are stubbed — the derive helpers and
 * the hook itself run for real.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';

const realDataLayer = await import('./internal-doc-preview.ts');

mock.module('./internal-doc-preview.ts', () => ({
  ...realDataLayer,
  loadDocContent: (docName: string) => Promise.resolve(`# Heading\n\nBody of ${docName}.`),
  loadBacklinkCount: (docName: string) => Promise.resolve(docName === 'a.md' ? 3 : 5),
}));

mock.module('../../components/PageListContext', () => ({
  usePageList: () => ({
    pageTitles: new Map<string, string>([
      ['a.md', 'Doc A'],
      ['b.md', 'Doc B'],
    ]),
    pageMeta: new Map(),
  }),
}));

const { useInternalDocPreview } = await import('./use-internal-doc-preview.ts');

interface RenderFrame {
  title: string | undefined;
  excerpt: string | undefined;
  backlinkCount: number | undefined;
}

const renderLog: RenderFrame[] = [];

function Probe({ docName }: { docName: string | null }) {
  const preview = useInternalDocPreview({ docName, anchor: null, enabled: true });
  renderLog.push({
    title: preview?.title,
    excerpt: preview?.excerpt,
    backlinkCount: preview?.backlinkCount,
  });
  return <output data-testid="excerpt">{preview?.excerpt ?? '(none)'}</output>;
}

/** Let the loaders' already-resolved promises flush their setState calls. */
const flushAsyncFields = () => act(async () => {});

describe('useInternalDocPreview target binding', () => {
  beforeEach(() => {
    renderLog.length = 0;
  });
  afterEach(cleanup);

  test('async fields fill in for the bound target', async () => {
    const { getByTestId } = render(<Probe docName="a.md" />);
    await flushAsyncFields();
    expect(getByTestId('excerpt').textContent).toBe('Body of a.md.');
    const last = renderLog.at(-1);
    expect(last).toEqual({ title: 'Doc A', excerpt: 'Body of a.md.', backlinkCount: 3 });
  });

  test('a chip-to-chip target change never mixes the new title with stale async fields', async () => {
    const { rerender, getByTestId } = render(<Probe docName="a.md" />);
    await flushAsyncFields();
    expect(getByTestId('excerpt').textContent).toBe('Body of a.md.');

    renderLog.length = 0;
    rerender(<Probe docName="b.md" />);

    // The very first post-change frame: B's synchronous title with NO stale
    // async fields (a post-paint reset effect would be one frame too late).
    expect(renderLog[0]).toEqual({ title: 'Doc B', excerpt: undefined, backlinkCount: undefined });

    await flushAsyncFields();
    expect(getByTestId('excerpt').textContent).toBe('Body of b.md.');

    // No frame anywhere in the transition mixed B's title with A's data.
    const mixed = renderLog.filter(
      (frame) =>
        frame.title === 'Doc B' && (frame.excerpt === 'Body of a.md.' || frame.backlinkCount === 3),
    );
    expect(mixed).toHaveLength(0);
  });
});
