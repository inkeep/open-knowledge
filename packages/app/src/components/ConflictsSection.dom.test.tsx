import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface MockConflictsResult {
  conflicts: Array<{ file: string; detectedAt: string; docName: string | null }>;
  loading: boolean;
  error: 'network' | 'server' | null;
}

let mockResult: MockConflictsResult = { conflicts: [], loading: false, error: null };

vi.doMock('@/hooks/use-conflicts', () => ({
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
    render(<ConflictsSection />);
    expect(screen.queryByTestId('conflicts-section')).toBeNull();
  });

  test('renders the section with header + count + one row per conflict when count > 0', () => {
    mockResult = {
      conflicts: [
        {
          file: 'docs/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/notes',
        },
        {
          file: 'team/draft.md',
          detectedAt: '2026-05-20T10:01:00.000Z',
          docName: 'team/draft',
        },
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

  test('a row whose entry has no docName is present but not navigable', () => {
    mockResult = {
      conflicts: [
        {
          file: 'outside/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: null,
        },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);

    const row = screen.getByTestId('conflicts-section-row');
    expect(row.getAttribute('data-navigable')).toBe('false');
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(window.location.hash).toBe('');
  });

  test('a row navigates to the entry docName, not to a path-derived guess', () => {
    mockResult = {
      conflicts: [
        {
          file: 'content/docs/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/notes',
        },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);

    fireEvent.click(screen.getByTestId('conflicts-section-row'));
    expect(window.location.hash).toBe('#/docs/notes');
  });

  test('clicking a row navigates by setting window.location.hash (strips .md)', () => {
    mockResult = {
      conflicts: [
        {
          file: 'docs/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/notes',
        },
      ],
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
      conflicts: [
        {
          file: 'docs/page.mdx',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/page',
        },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);
    fireEvent.click(screen.getByTestId('conflicts-section-row'));
    expect(window.location.hash).toBe('#/docs/page');
  });

  test('section has NO quick-action buttons ([Keep mine] / [Keep theirs])', () => {
    mockResult = {
      conflicts: [
        {
          file: 'docs/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/notes',
        },
      ],
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
        {
          file: 'a.md',
          detectedAt: 't',
          docName: 'a',
        },
        {
          file: 'b.md',
          detectedAt: 't',
          docName: 'b',
        },
        {
          file: 'c.md',
          detectedAt: 't',
          docName: 'c',
        },
      ],
      loading: false,
      error: null,
    };
    render(<ConflictsSection />);
    expect(screen.getAllByTestId('conflicts-section-row').length).toBe(3);
    expect(screen.getByTestId('conflicts-section-count').textContent).toBe('3');
  });

  test('renders an error band when the hook reports a server-side fetch error', () => {
    mockResult = { conflicts: [], loading: false, error: 'server' };
    render(<ConflictsSection />);
    const errorBand = screen.getByTestId('conflicts-section-error');
    expect(errorBand).not.toBeNull();
    expect(errorBand.textContent ?? '').toMatch(/Couldn't load conflicts/i);
  });

  test('renders nothing on a connectivity-level fetch error (FileTree carries that signal)', () => {
    mockResult = { conflicts: [], loading: false, error: 'network' };
    render(<ConflictsSection />);
    expect(screen.queryByTestId('conflicts-section')).toBeNull();
    expect(screen.queryByTestId('conflicts-section-error')).toBeNull();
  });

  test('renders nothing while the initial fetch is still loading', () => {
    mockResult = { conflicts: [], loading: true, error: null };
    render(<ConflictsSection />);
    expect(screen.queryByTestId('conflicts-section')).toBeNull();
  });

  test('keeps the retained rows and shows no band on a network fetch error', () => {
    mockResult = {
      conflicts: [
        {
          file: 'docs/notes.md',
          detectedAt: '2026-05-20T10:00:00.000Z',
          docName: 'docs/notes',
        },
      ],
      loading: false,
      error: 'network',
    };
    render(<ConflictsSection />);

    expect(screen.getAllByTestId('conflicts-section-row').length).toBe(1);
    expect(screen.queryByTestId('conflicts-section-error')).toBeNull();
  });
});
