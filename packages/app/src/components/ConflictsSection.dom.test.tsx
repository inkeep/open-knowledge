/**
 * RTL behavioral tests for `ConflictsSection`.
 *
 * Pins:
 *   - Renders null when the conflict list is empty (auto-hide at zero).
 *   - Renders header `⚠ Conflicts` + a count badge equal to `conflicts.length`,
 *     plus one row per entry.
 *   - Each row uses a shadcn `Button` (NOT raw `<button>`); clicking it
 *     navigates to the doc by setting `window.location.hash` to
 *     `#/<docName-without-md-extension>`. This is the same primitive the
 *     existing FileTree and EditorTabs use, so the doc becomes the active
 *     tab and the editor-area DiffViewBoundary mounts via the lifecycle
 *     observer.
 *   - The section is NO-quick-action: no [Keep mine] / [Keep theirs] buttons.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface MockConflictsResult {
  conflicts: Array<{ file: string; detectedAt: string }>;
  loading: boolean;
  error: 'network' | 'server' | null;
}

let mockResult: MockConflictsResult = { conflicts: [], loading: false, error: null };

mock.module('@/hooks/use-conflicts', () => ({
  useConflicts: () => mockResult,
}));

const { ConflictsSection } = await import('./ConflictsSection');

describe('ConflictsSection', () => {
  beforeEach(() => {
    mockResult = { conflicts: [], loading: false, error: null };
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  });

  afterEach(() => {
    cleanup();
  });

  test('renders nothing when there are no conflicts (auto-hide at zero)', () => {
    mockResult = { conflicts: [], loading: false, error: null };
    const { container } = render(<ConflictsSection />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('conflicts-section')).toBeNull();
  });

  test('renders the section with header + count + one row per conflict when count > 0', () => {
    mockResult = {
      conflicts: [
        { file: 'docs/notes.md', detectedAt: '2026-05-20T10:00:00.000Z' },
        { file: 'team/draft.md', detectedAt: '2026-05-20T10:01:00.000Z' },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);

    expect(screen.getByTestId('conflicts-section')).not.toBeNull();
    expect(screen.getByTestId('conflicts-section-count').textContent).toBe('2');
    expect(screen.getByText(/Conflicts/i)).not.toBeNull();

    const rows = screen.getAllByTestId('conflicts-section-row');
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute('data-file')).toBe('docs/notes.md');
    expect(rows[1]?.getAttribute('data-file')).toBe('team/draft.md');
  });

  test('clicking a row navigates by setting window.location.hash (strips .md)', () => {
    mockResult = {
      conflicts: [{ file: 'docs/notes.md', detectedAt: '2026-05-20T10:00:00.000Z' }],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);

    const row = screen.getByTestId('conflicts-section-row');
    fireEvent.click(row);
    expect(window.location.hash).toBe('#/docs/notes');
  });

  test('clicking a row also strips .mdx extension', () => {
    mockResult = {
      conflicts: [{ file: 'docs/page.mdx', detectedAt: '2026-05-20T10:00:00.000Z' }],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);
    fireEvent.click(screen.getByTestId('conflicts-section-row'));
    expect(window.location.hash).toBe('#/docs/page');
  });

  test('section has NO quick-action buttons ([Keep mine] / [Keep theirs])', () => {
    mockResult = {
      conflicts: [{ file: 'docs/notes.md', detectedAt: '2026-05-20T10:00:00.000Z' }],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);
    expect(screen.queryByRole('button', { name: /Keep mine/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep theirs/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep team/i })).toBeNull();
  });

  test('row count matches the conflicts length (parity input)', () => {
    mockResult = {
      conflicts: [
        { file: 'a.md', detectedAt: 't' },
        { file: 'b.md', detectedAt: 't' },
        { file: 'c.md', detectedAt: 't' },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);
    expect(screen.getAllByTestId('conflicts-section-row').length).toBe(3);
    expect(screen.getByTestId('conflicts-section-count').textContent).toBe('3');
  });

  // The hook tracks `error: 'server' | 'network'` so consumers can branch
  // on the failure shape. `'server'` means the conflicts endpoint failed
  // while the rest of the app may still be loading — hiding the section
  // would mask real tracked conflicts (a user with conflicts sees an empty
  // sidebar identical to the resolved state). Surface the visible band.
  test('renders an error band when the hook reports a server-side fetch error', () => {
    mockResult = { conflicts: [], loading: false, error: 'server' };
    render(<ConflictsSection />);
    const errorBand = screen.getByTestId('conflicts-section-error');
    expect(errorBand).not.toBeNull();
    expect(errorBand.textContent ?? '').toMatch(/Couldn't load conflicts/i);
  });

  // `'network'` means the server is entirely unreachable. FileTree owns the
  // global "Could not reach server" signal in that case; a second amber
  // band claiming the conflicts subsystem specifically failed is redundant
  // noise that misframes the failure. The masking concern that motivates
  // the band on `'server'` doesn't apply — nothing is editable, so a user
  // cannot accidentally write into a conflicted doc.
  test('returns null on a network-level fetch error (FileTree owns the global signal)', () => {
    mockResult = { conflicts: [], loading: false, error: 'network' };
    const { container } = render(<ConflictsSection />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('conflicts-section')).toBeNull();
    expect(screen.queryByTestId('conflicts-section-error')).toBeNull();
  });

  test('returns null while the initial fetch is still loading', () => {
    mockResult = { conflicts: [], loading: true, error: null };
    const { container } = render(<ConflictsSection />);
    expect(container.firstChild).toBeNull();
  });
});
