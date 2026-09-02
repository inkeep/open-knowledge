import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useSkillOriginMock = vi.fn();
vi.mock('@/hooks/use-skill-origin', () => ({
  useSkillOrigin: (args: unknown) => useSkillOriginMock(args),
}));

vi.mock('@/components/SkillEditorActions', () => ({
  SkillEditorActions: ({ showNewFile }: { showNewFile?: boolean }) => (
    <div data-testid="install-control" data-show-new-file={String(showNewFile)} />
  ),
}));

import { BuiltinHeaderActions } from './SkillPreviewTab';

interface OriginState {
  origin: unknown;
  github: string | null;
  updateAvailable: boolean;
  reimport: () => Promise<void>;
  reimporting: boolean;
}

function mockOrigin(overrides: Partial<OriginState> = {}): OriginState {
  const state: OriginState = {
    origin: { source: 'inkeep/open-knowledge-skills', importedAt: '2026-07-30T00:00:00.000Z' },
    github: 'https://github.com/inkeep/open-knowledge-skills',
    updateAvailable: false,
    reimport: vi.fn().mockResolvedValue(undefined),
    reimporting: false,
    ...overrides,
  };
  useSkillOriginMock.mockReturnValue(state);
  return state;
}

afterEach(() => {
  cleanup();
  useSkillOriginMock.mockReset();
});

describe('BuiltinHeaderActions', () => {
  test('still offers the install control when provenance has not resolved', () => {
    mockOrigin({ origin: null, github: null });
    render(<BuiltinHeaderActions scope="global" name="x" />);
    expect(screen.getByTestId('install-control')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
  });

  test('offers the install control alongside provenance, without New file', () => {
    mockOrigin({ updateAvailable: true });
    render(<BuiltinHeaderActions scope="global" name="open-knowledge-discovery" />);
    expect(screen.getByTestId('install-control').getAttribute('data-show-new-file')).toBe('false');
  });

  test('shows the source link but NO Update button when up to date', () => {
    mockOrigin({ updateAvailable: false });
    render(<BuiltinHeaderActions scope="global" name="open-knowledge-discovery" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://github.com/inkeep/open-knowledge-skills',
    );
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
  });

  test('shows Update when upstream differs, and clicking it re-pulls', async () => {
    const state = mockOrigin({ updateAvailable: true });
    render(<BuiltinHeaderActions scope="global" name="open-knowledge-discovery" />);
    const button = screen.getByRole('button', { name: /^update$/i });
    await userEvent.click(button);
    expect(state.reimport).toHaveBeenCalledTimes(1);
  });

  test('disables the button while a re-pull is in flight', () => {
    mockOrigin({ updateAvailable: true, reimporting: true });
    render(<BuiltinHeaderActions scope="global" name="open-knowledge-discovery" />);
    expect((screen.getByRole('button', { name: /updating/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test('omits the link when no source URL resolves', () => {
    mockOrigin({ github: null, updateAvailable: true });
    render(<BuiltinHeaderActions scope="global" name="open-knowledge-discovery" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: /^update$/i })).toBeTruthy();
  });

  test('addresses the hook by the skill it was given', () => {
    mockOrigin();
    render(<BuiltinHeaderActions scope="project" name="open-knowledge" />);
    expect(useSkillOriginMock).toHaveBeenCalledWith({ scope: 'project', name: 'open-knowledge' });
  });
});
