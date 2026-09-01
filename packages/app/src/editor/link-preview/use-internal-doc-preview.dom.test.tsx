import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const realDataLayer = await import('./internal-doc-preview.ts');

vi.doMock('./internal-doc-preview.ts', () => ({
  ...realDataLayer,
  loadDocContent: (docName: string) => Promise.resolve(`# Heading\n\nBody of ${docName}.`),
  loadBacklinkCount: (docName: string) => Promise.resolve(docName === 'a.md' ? 3 : 5),
}));

vi.doMock('../../components/PageListContext', () => ({
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

    expect(renderLog[0]).toEqual({ title: 'Doc B', excerpt: undefined, backlinkCount: undefined });

    await flushAsyncFields();
    expect(getByTestId('excerpt').textContent).toBe('Body of b.md.');

    const mixed = renderLog.filter(
      (frame) =>
        frame.title === 'Doc B' && (frame.excerpt === 'Body of a.md.' || frame.backlinkCount === 3),
    );
    expect(mixed).toHaveLength(0);
  });
});
