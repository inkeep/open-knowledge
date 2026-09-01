import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const exportToSvg = vi.fn(async (_opts: Record<string, unknown>) =>
  document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
);
const restore = vi.fn((data: unknown) => ({
  elements: (data as { elements?: unknown[] })?.elements ?? [],
  appState: {},
  files: {},
}));

vi.doMock('@excalidraw/excalidraw', () => ({ exportToSvg, restore }));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type LiveStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string }
  | { kind: 'empty' }
  | { kind: 'unreachable' }
  | { kind: 'at-capacity' };
let liveStatus: LiveStatus = { kind: 'loading' };
const useLiveDocText = vi.fn((_docName: string | null, _retryToken?: number) => liveStatus);
vi.doMock('./live-doc-pool.ts', () => ({ useLiveDocText, LIVE_DOC_POOL_MAX: 30 }));

const panzoomInstance = {
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  pan: vi.fn(),
  reset: vi.fn(),
  destroy: vi.fn(),
  zoomWithWheel: vi.fn(),
  getScale: vi.fn(() => 1),
};
vi.doMock('@panzoom/panzoom', () => ({ default: vi.fn(() => panzoomInstance) }));

const { boardDocNameFromSrc, ExcalidrawEmbed } = await import('./ExcalidrawEmbed');
const { __resetSnapshotUrlPoolForTests } = await import('./snapshot-url-pool.ts');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const BOARD_JSON = JSON.stringify({ elements: [{ id: 'a' }] });

let blobUrlCounter = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++blobUrlCounter}`);
const revokeObjectURL = vi.fn();

function renderEmbed(props: Parameters<typeof ExcalidrawEmbed>[0]) {
  return render(
    <TooltipProvider>
      <ExcalidrawEmbed {...props} />
    </TooltipProvider>,
  );
}

function snapshotImg(): HTMLImageElement | null {
  return screen.queryByTestId('excalidraw-embed-snapshot')?.querySelector('img') ?? null;
}

describe('ExcalidrawEmbed', () => {
  beforeEach(() => {
    exportToSvg.mockClear();
    restore.mockClear();
    useLiveDocText.mockClear();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    __resetSnapshotUrlPoolForTests();
    revokeObjectURL.mockClear();
    liveStatus = { kind: 'ready', text: BOARD_JSON };
  });
  afterEach(() => {
    document.documentElement.classList.remove('dark', 'light');
    cleanup();
  });

  test('subscribes to the board doc and mounts the snapshot as a blob-backed <img>', async () => {
    renderEmbed({ src: '/tests/board.excalidraw', title: 'Flow board' });

    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    expect(useLiveDocText).toHaveBeenCalledWith('tests/board.excalidraw', 0);
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ elements: [{ id: 'a' }] }),
      null,
      null,
    );
    expect(exportToSvg.mock.calls.at(-1)?.[0]?.appState).toMatchObject({
      exportBackground: false,
      exportWithDarkMode: false,
    });
    expect(screen.getByRole('img', { name: 'Flow board' })).not.toBeNull();
    expect(snapshotImg()?.src).toMatch(/^blob:/);
    expect(screen.getByTestId('excalidraw-embed-snapshot').querySelector('svg')).toBeNull();
  });

  test('a theme toggle re-exports in place with dark mode, without re-parsing', async () => {
    renderEmbed({ src: '/tests/board.excalidraw' });
    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    const exportsBefore = exportToSvg.mock.calls.length;
    const parsesBefore = restore.mock.calls.length;
    const firstUrl = snapshotImg()?.src;

    act(() => {
      document.documentElement.classList.add('dark');
    });

    await waitFor(() => expect(exportToSvg.mock.calls.length).toBe(exportsBefore + 1));
    expect(exportToSvg.mock.calls.at(-1)?.[0]?.appState).toMatchObject({
      exportWithDarkMode: true,
    });
    expect(restore.mock.calls.length).toBe(parsesBefore);
    expect(snapshotImg()).not.toBeNull();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl));
  });

  test('a live edit to the board re-exports the snapshot without a reload', async () => {
    const { rerender } = renderEmbed({ src: '/tests/board.excalidraw' });
    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    const exportsBefore = exportToSvg.mock.calls.length;

    liveStatus = { kind: 'ready', text: JSON.stringify({ elements: [{ id: 'a' }, { id: 'b' }] }) };
    rerender(
      <TooltipProvider>
        <ExcalidrawEmbed src="/tests/board.excalidraw" />
      </TooltipProvider>,
    );

    await waitFor(() => expect(exportToSvg.mock.calls.length).toBeGreaterThan(exportsBefore));
    const scene = restore.mock.calls.at(-1)?.[0] as { elements?: unknown[] };
    expect(scene.elements?.length).toBe(2);
  });

  test('an unreachable board surfaces the banner with fixed copy and a working retry', async () => {
    liveStatus = { kind: 'unreachable' };
    renderEmbed({ src: '/tests/missing.excalidraw' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Excalidraw board failed to load.');
    expect(alert.textContent).toContain('could not be reached');
    expect(alert.textContent).toContain('tests/missing.excalidraw');

    act(() => {
      screen.getByTestId('excalidraw-embed-retry').click();
    });
    await waitFor(() => {
      expect(useLiveDocText).toHaveBeenLastCalledWith('tests/missing.excalidraw', 1);
    });
  });

  test('a retry after an EXPORT-stage failure genuinely re-exports (no dead click)', async () => {
    exportToSvg.mockRejectedValueOnce(new Error('export blew up'));
    renderEmbed({ src: '/tests/board.excalidraw' });
    const retry = await screen.findByTestId('excalidraw-embed-retry');
    const exportsBefore = exportToSvg.mock.calls.length;

    act(() => {
      retry.click();
    });

    await waitFor(() => expect(exportToSvg.mock.calls.length).toBeGreaterThan(exportsBefore));
    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an Activity show cycle re-runs effects without re-parsing or re-exporting', async () => {
    const { Activity } = await import('react');
    const view = (hidden: boolean) => (
      <TooltipProvider>
        <Activity mode={hidden ? 'hidden' : 'visible'}>
          <ExcalidrawEmbed src="/tests/board.excalidraw" />
        </Activity>
      </TooltipProvider>
    );
    const { rerender } = render(view(false));
    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    const parses = restore.mock.calls.length;
    const exports = exportToSvg.mock.calls.length;
    const urls = createObjectURL.mock.calls.length;

    rerender(view(true));
    rerender(view(false));
    rerender(view(true));
    rerender(view(false));
    await act(async () => {});

    expect(restore.mock.calls.length).toBe(parses);
    expect(exportToSvg.mock.calls.length).toBe(exports);
    expect(createObjectURL.mock.calls.length).toBe(urls);
    expect(snapshotImg()).not.toBeNull();
  });

  test('a confirmed-empty board renders the passive empty card, not an error', () => {
    liveStatus = { kind: 'empty' };
    renderEmbed({ src: '/tests/blank.excalidraw' });
    expect(screen.getByText('Empty board')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('no src renders the not-configured card, which names the next step', () => {
    renderEmbed({});
    expect(screen.getByText(/No board selected. Enter the path/)).not.toBeNull();
    expect(screen.queryByText('Empty board')).toBeNull();
    expect(screen.queryByTestId('excalidraw-embed-open')).toBeNull();
  });

  test('an at-capacity refusal shows capacity copy with no retry affordance', async () => {
    liveStatus = { kind: 'at-capacity' };
    renderEmbed({ src: '/tests/board.excalidraw' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many live references');
    expect(alert.textContent).not.toContain('could not be reached');
    expect(screen.queryByTestId('excalidraw-embed-retry')).toBeNull();
  });

  test("a failed board's error card does not follow a src change onto the next board", async () => {
    liveStatus = { kind: 'ready', text: '{not json' };
    const { rerender } = renderEmbed({ src: '/tests/a.excalidraw' });
    await screen.findByRole('alert');

    liveStatus = { kind: 'loading' };
    rerender(
      <TooltipProvider>
        <ExcalidrawEmbed src="/tests/b.excalidraw" />
      </TooltipProvider>,
    );

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(snapshotImg()).toBeNull();
  });

  test('a retry that resolves moves focus to the card, not document.body', async () => {
    liveStatus = { kind: 'ready', text: '{not json' };
    const { rerender } = renderEmbed({ src: '/tests/board.excalidraw' });
    const retry = await screen.findByTestId('excalidraw-embed-retry');

    act(() => {
      retry.focus();
      retry.click();
    });
    liveStatus = { kind: 'ready', text: BOARD_JSON };
    rerender(
      <TooltipProvider>
        <ExcalidrawEmbed src="/tests/board.excalidraw" />
      </TooltipProvider>,
    );

    await waitFor(() => expect(snapshotImg()).not.toBeNull());
    const card = document.querySelector('.excalidraw-embed');
    expect(document.activeElement).toBe(card);
  });

  test('updates landing mid-export coalesce into one trailing re-export with the newest scene', async () => {
    const resolvers: Array<(svg: SVGSVGElement) => void> = [];
    exportToSvg.mockImplementation(
      () => new Promise<SVGSVGElement>((resolve) => resolvers.push(resolve)),
    );
    const svgNode = () => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
      const { rerender } = renderEmbed({ src: '/tests/board.excalidraw' });
      await waitFor(() => expect(resolvers.length).toBe(1));

      let parses = restore.mock.calls.length;
      for (const text of [
        JSON.stringify({ elements: [{ id: 'a' }, { id: 'b' }] }),
        JSON.stringify({ elements: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      ]) {
        liveStatus = { kind: 'ready', text };
        rerender(
          <TooltipProvider>
            <ExcalidrawEmbed src="/tests/board.excalidraw" />
          </TooltipProvider>,
        );
        await waitFor(() => expect(restore.mock.calls.length).toBe(parses + 1));
        parses += 1;
      }
      expect(resolvers.length).toBe(1);

      act(() => {
        resolvers[0]?.(svgNode());
      });
      await waitFor(() => expect(resolvers.length).toBe(2));
      const lastExported = exportToSvg.mock.calls.at(-1)?.[0] as { elements?: unknown[] };
      expect(lastExported.elements?.length).toBe(3);
      act(() => {
        resolvers[1]?.(svgNode());
      });
      await waitFor(() => expect(snapshotImg()).not.toBeNull());
      expect(resolvers.length).toBe(2);
    } finally {
      exportToSvg.mockImplementation(async (_opts: Record<string, unknown>) => svgNode());
    }
  });

  test('a malformed board errors with fixed copy, and a theme toggle cannot erase the error', async () => {
    liveStatus = { kind: 'ready', text: '{not json' };
    renderEmbed({ src: '/tests/board.excalidraw' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not a valid Excalidraw scene');
    expect(alert.textContent).not.toMatch(/Unexpected|JSON/);

    act(() => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(snapshotImg()).toBeNull();
  });

  test('valid JSON that is not a scene errors rather than rendering an empty board', async () => {
    liveStatus = { kind: 'ready', text: JSON.stringify({ foo: 1 }) };
    renderEmbed({ src: '/tests/board.excalidraw' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not a valid Excalidraw scene');
    expect(screen.queryByText('Empty board')).toBeNull();
  });

  test('a src change never paints the previous board', async () => {
    const { rerender } = renderEmbed({ src: '/tests/a.excalidraw' });
    await waitFor(() => expect(snapshotImg()).not.toBeNull());

    liveStatus = { kind: 'loading' };
    rerender(
      <TooltipProvider>
        <ExcalidrawEmbed src="/tests/b.excalidraw" />
      </TooltipProvider>,
    );

    await waitFor(() => expect(snapshotImg()).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the open affordance is a real anchor to the board doc', async () => {
    renderEmbed({ src: '/tests/board.excalidraw' });
    const open = await screen.findByTestId('excalidraw-embed-open');
    expect(open.tagName).toBe('A');
    expect(open.getAttribute('href')).toBe('#/tests/board.excalidraw');
  });

  test('an expand requested during the load window stays pending, then opens', async () => {
    liveStatus = { kind: 'loading' };
    const onExpandOpenChange = vi.fn((_open: boolean) => {});
    const { rerender } = renderEmbed({
      src: '/tests/board.excalidraw',
      title: 'Flow board',
      expandOpen: true,
      onExpandOpenChange,
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onExpandOpenChange).not.toHaveBeenCalled();

    liveStatus = { kind: 'ready', text: BOARD_JSON };
    rerender(
      <TooltipProvider>
        <ExcalidrawEmbed
          src="/tests/board.excalidraw"
          title="Flow board"
          expandOpen
          onExpandOpenChange={onExpandOpenChange}
        />
      </TooltipProvider>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Flow board' });
    await waitFor(() => {
      expect(
        within(dialog).getByTestId('excalidraw-lightbox-canvas').querySelector('img'),
      ).not.toBeNull();
    });
    expect(within(dialog).getByRole('toolbar', { name: 'Board controls' })).not.toBeNull();
    expect(within(dialog).getByText('View only')).not.toBeNull();
  });

  test('an expand requested while the board is unreachable reports itself back closed', async () => {
    liveStatus = { kind: 'unreachable' };
    const onExpandOpenChange = vi.fn((_open: boolean) => {});
    renderEmbed({
      src: '/tests/missing.excalidraw',
      expandOpen: true,
      onExpandOpenChange,
    });

    await waitFor(() => {
      expect(onExpandOpenChange).toHaveBeenCalledWith(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('boardDocNameFromSrc', () => {
  test('recovers the docName from relative and same-origin srcs', () => {
    expect(boardDocNameFromSrc('/tests/board.excalidraw')).toBe('tests/board.excalidraw');
    expect(boardDocNameFromSrc('http://localhost:5173/a/b.excalidraw')).toBe('a/b.excalidraw');
    expect(boardDocNameFromSrc('/sp%20ace/x.excalidraw')).toBe('sp ace/x.excalidraw');
    expect(boardDocNameFromSrc('/')).toBeNull();
  });

  test('rejects foreign origins and traversal instead of rewriting them', () => {
    expect(boardDocNameFromSrc('https://cdn.example.com/x.excalidraw')).toBeNull();
    expect(boardDocNameFromSrc('/%2e%2e%2f%2e%2e%2fetc/x.excalidraw')).toBeNull();
    expect(boardDocNameFromSrc('/a/%2e%2e/b.excalidraw')).toBe('b.excalidraw');
  });

  test('a resolver-rejected src gets the banner but no retry button', async () => {
    liveStatus = { kind: 'unreachable' };
    renderEmbed({ src: '/notes/plain.md' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be reached');
    expect(screen.queryByTestId('excalidraw-embed-retry')).toBeNull();
  });

  test('only .excalidraw docNames are addressable', () => {
    expect(boardDocNameFromSrc('/notes/plain.md')).toBeNull();
    expect(boardDocNameFromSrc('/notes/plain')).toBeNull();
    expect(boardDocNameFromSrc('/__config__/project')).toBeNull();
    expect(boardDocNameFromSrc('/__user__/config.yml')).toBeNull();
    expect(boardDocNameFromSrc('/__system__')).toBeNull();
  });

  test('rejects non-http(s)/file schemes and control characters outright', () => {
    expect(boardDocNameFromSrc('blob:http://localhost:5173/x.excalidraw')).toBeNull();
    expect(boardDocNameFromSrc('data:image/svg+xml,<svg/>')).toBeNull();
    expect(boardDocNameFromSrc('/a%00b.excalidraw')).toBeNull();
    expect(boardDocNameFromSrc('/a%0ab.excalidraw')).toBeNull();
  });

  test('handles a file: document base the way client-fetch does', () => {
    const fileBase = 'file:///Users/x/app/index.html';
    expect(boardDocNameFromSrc('/boards/b.excalidraw', fileBase)).toBe('boards/b.excalidraw');
    expect(boardDocNameFromSrc('https://cdn.example.com/x.excalidraw', fileBase)).toBeNull();
    expect(boardDocNameFromSrc('file:///etc/x.excalidraw', 'http://localhost:5173/')).toBeNull();
  });
});
