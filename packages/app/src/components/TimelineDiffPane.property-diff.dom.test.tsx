import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { openTimelineDiff, type TimelineDiffView } from '@/lib/timeline-diff-store';

const { TimelineDiffPane } = await import('./TimelineDiffPane');

const VERSION_SHA = 'c'.repeat(40);
const PARENT_SHA = 'p'.repeat(40);

const view: TimelineDiffView = {
  docName: 'notes',
  sha: VERSION_SHA,
  parentSha: PARENT_SHA,
  laterEdits: 0,
  authorName: 'Alice',
  relativeTime: '2 hours ago',
  absoluteTime: '2026-04-17 00:00',
};

function mockVersions(parent: string, version: string): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const content = url.includes(`/api/history/${PARENT_SHA}`)
      ? parent
      : url.includes(`/api/history/${VERSION_SHA}`)
        ? version
        : null;
    if (content === null) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify({ content }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as never;
}

function renderPane() {
  openTimelineDiff(view);
  return render(
    <TooltipProvider>
      <TimelineDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
    </TooltipProvider>,
  );
}

async function waitForDiffBody() {
  await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
}

async function showSourceMode() {
  await userEvent.click(screen.getByTestId('timeline-diff-render-source'));
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.restoreAllMocks();
});

describe('TimelineDiffPane — property changes', () => {
  test('names the changed property when only frontmatter moved', async () => {
    mockVersions('---\nstatus: draft\n---\nSame body.\n', '---\nstatus: ready\n---\nSame body.\n');
    renderPane();
    await waitForDiffBody();

    const rows = await screen.findAllByTestId('property-diff-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-key')).toBe('status');
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
  });

  test('does not claim there were no content changes when properties changed', async () => {
    mockVersions('---\nstatus: draft\n---\nSame body.\n', '---\nstatus: ready\n---\nSame body.\n');
    renderPane();
    await waitForDiffBody();
    await screen.findAllByTestId('property-diff-row');

    expect(screen.queryByText('No content changes in this version')).toBeNull();
  });

  test('still claims no content changes when nothing changed at all', async () => {
    const same = '---\nstatus: draft\n---\nSame body.\n';
    mockVersions(same, same);
    renderPane();
    await waitForDiffBody();
    await showSourceMode();

    await waitFor(() =>
      expect(screen.getByText('No content changes in this version')).toBeTruthy(),
    );
    expect(screen.queryAllByTestId('property-diff-row')).toHaveLength(0);
  });

  test('says the body is unchanged, not the version, when only properties moved', async () => {
    mockVersions('---\nstatus: draft\n---\nSame body.\n', '---\nstatus: ready\n---\nSame body.\n');
    renderPane();
    await waitForDiffBody();
    await showSourceMode();

    await waitFor(() => expect(screen.getByText('No body changes in this version')).toBeTruthy());
    expect(screen.queryByText('No content changes in this version')).toBeNull();
  });

  test('renders no property block for a body-only edit', async () => {
    mockVersions('---\nstatus: draft\n---\nOne.\n', '---\nstatus: draft\n---\nOne.\n\nTwo.\n');
    renderPane();
    await waitForDiffBody();

    expect(screen.queryAllByTestId('property-diff-row')).toHaveLength(0);
    expect(screen.queryByTestId('timeline-diff-property-stat')).toBeNull();
  });

  test('reports nothing when the frontmatter was only reordered', async () => {
    mockVersions(
      '---\ntitle: Notes\nstatus: draft\n---\nSame body.\n',
      '---\nstatus: draft\ntitle: Notes\n---\nSame body.\n',
    );
    renderPane();
    await waitForDiffBody();
    await showSourceMode();

    await waitFor(() =>
      expect(screen.getByText('No content changes in this version')).toBeTruthy(),
    );
    expect(screen.queryAllByTestId('property-diff-row')).toHaveLength(0);
  });

  test('caps the stepper denominator at the rows the block renders', async () => {
    const keys = (suffix: string) =>
      Array.from({ length: 60 }, (_, i) => `key${i}: value${i}${suffix}`).join('\n');
    mockVersions(`---\n${keys('')}\n---\nSame body.\n`, `---\n${keys('-new')}\n---\nSame body.\n`);
    renderPane();
    await waitForDiffBody();
    await screen.findAllByTestId('property-diff-row');

    expect(screen.getAllByTestId('property-diff-row')).toHaveLength(50);
    expect(screen.getByText('10 more property changes not shown')).toBeTruthy();
    expect(screen.getByText('1 / 50')).toBeTruthy();
  });

  test('drops the collapsed property rows from the stepper denominator', async () => {
    mockVersions(
      '---\na: 1\nb: 1\nc: 1\n---\nA\n\nB\n\nC\n',
      '---\na: 2\nb: 2\nc: 2\n---\nA2\n\nB\n\nC2\n',
    );
    renderPane();
    await waitForDiffBody();
    await showSourceMode();
    await screen.findAllByTestId('property-diff-row');

    await waitFor(() => expect(screen.getByText('1 / 5')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Properties/ }));

    await waitFor(() => expect(screen.queryAllByTestId('property-diff-row')).toHaveLength(0));
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  test('hides the stepper when collapsing leaves nothing to step through', async () => {
    mockVersions(
      '---\na: 1\nb: 1\nc: 1\n---\nSame body.\n',
      '---\na: 2\nb: 2\nc: 2\n---\nSame body.\n',
    );
    renderPane();
    await waitForDiffBody();
    await screen.findAllByTestId('property-diff-row');

    await waitFor(() => expect(screen.getByText('1 / 3')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Properties/ }));

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-next')).toBeNull());
  });

  test('counts properties separately from the body line stat', async () => {
    mockVersions(
      '---\nstatus: draft\n---\nOne.\n',
      '---\nstatus: ready\nowner: shagun\n---\nOne.\n\nTwo.\n',
    );
    renderPane();
    await waitForDiffBody();

    const stat = await screen.findByTestId('timeline-diff-property-stat');
    expect(stat.textContent).toBe('2 properties');
    const bodyStat = screen.getByTestId('timeline-diff-stat');
    expect(bodyStat.getAttribute('aria-label')).toBe('2 added, 0 removed');
  });
});
