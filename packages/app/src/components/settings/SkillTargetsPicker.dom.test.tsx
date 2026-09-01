import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const translate = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
  if (typeof strings === 'string') return strings;
  let out = '';
  strings.forEach((sPart, i) => {
    out += sPart;
    if (i < values.length) out += String(values[i]);
  });
  return out;
};

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  t: translate,
  useLingui: () => ({
    i18n: { locale: 'en' },
    t: translate,
  }),
}));

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(() => {}), info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { SkillTargetsPicker } = await import('./SkillTargetsPicker');

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const FOLDERS_PAYLOAD = {
  targets: ['claude'],
  configured: false,
  folders: [
    { scope: 'project', host: 'claude', root: '.claude/skills', state: 'own' },
    {
      scope: 'project',
      host: 'codex',
      root: '.codex/skills',
      state: 'linked',
      target: '.agents/skills',
    },
    { scope: 'project', host: 'agents', root: '.agents/skills', state: 'own' },
    { scope: 'global', host: 'claude', root: '.claude/skills', state: 'absent' },
  ],
};

describe('SkillTargetsPicker (folders)', () => {
  test("renders ONLY this scope's folder rows with state + verbs; no toggles", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => FOLDERS_PAYLOAD,
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);

    await waitFor(() => expect(screen.getByTestId('skill-folder-row-claude')).toBeDefined());
    expect(screen.getAllByTestId(/^skill-folder-row-/)).toHaveLength(2);
    expect(screen.queryByTestId('skill-folder-row-codex')).toBeNull();
    const agentsFollowers = screen.getByTestId('skill-folder-followers-agents');
    expect(agentsFollowers.textContent).toContain('.codex/skills');
    expect(agentsFollowers.contains(screen.getByTestId('skill-folder-unlink-codex'))).toBe(true);
    expect(screen.getByTestId('skill-folder-link-claude')).toBeDefined();
    expect(screen.queryByTestId('skill-install-mode-user')).toBeNull();
    expect(screen.queryByTestId('skill-install-mode-project')).toBeNull();
    expect(screen.queryByTestId('skill-target-claude')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Custom skills folder path' })).toBeDefined();
  });

  function captureFolderActions(preview?: Record<string, unknown>): Array<Record<string, unknown>> {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const action = init?.body
        ? (JSON.parse(init.body).folderAction as Record<string, unknown>)
        : undefined;
      if (action) calls.push(action);
      return {
        ok: true,
        status: 200,
        json: async () =>
          action?.preview === true && preview ? { ...FOLDERS_PAYLOAD, preview } : FOLDERS_PAYLOAD,
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  const EMPTY_PREVIEW = {
    moves: [],
    drops: [],
    removes: [],
    replaces: [],
    conflicts: [],
    strays: [],
  };

  async function pickAgentsIntoClaude(): Promise<void> {
    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-link-claude')).toBeDefined());
    await userEvent.click(screen.getByTestId('skill-folder-link-claude'));
    await userEvent.click(await screen.findByTestId('skill-folder-link-claude-to-.agents/skills'));
  }

  test('the row you act on survives; the folder you pick becomes the symlink', async () => {
    const calls = captureFolderActions(EMPTY_PREVIEW);
    await pickAgentsIntoClaude();

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({
      action: 'link',
      root: '.agents/skills',
      target: '.claude/skills',
      preview: true,
    });
    expect(calls[1]).toMatchObject({
      action: 'link',
      root: '.agents/skills',
      target: '.claude/skills',
    });
    expect(calls[1].preview).toBeUndefined();
  });

  test('a pure-duplicate merge never asks — it costs the user nothing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const calls = captureFolderActions({ ...EMPTY_PREVIEW, drops: ['a', 'b', 'c'] });
    await pickAgentsIntoClaude();

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.queryByTestId('skill-folder-link-confirm')).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls[1].preview).toBeUndefined();
    confirmSpy.mockRestore();
  });

  test('a link that moves or destroys asks first, and a decline writes nothing', async () => {
    const calls = captureFolderActions({
      ...EMPTY_PREVIEW,
      moves: ['only-here'],
      drops: ['both'],
      removes: ['.system'],
    });
    await pickAgentsIntoClaude();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('skill-folder-link-direction').textContent).toContain(
      '.agents/skills',
    );
    expect(within(dialog).getByTestId('skill-folder-link-moves').textContent).toContain(
      'only-here',
    );
    expect(within(dialog).getByTestId('skill-folder-link-drops').textContent).toContain('both');
    expect(within(dialog).getByTestId('skill-folder-link-removes').textContent).toContain(
      '.system',
    );

    await userEvent.click(within(dialog).getByText('Cancel'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.preview).toBe(true);
  });

  test('a delivery link the merge overwrites in the SURVIVOR is disclosed too', async () => {
    const calls = captureFolderActions({
      ...EMPTY_PREVIEW,
      moves: ['shared'],
      replaces: ['shared'],
    });
    await pickAgentsIntoClaude();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('skill-folder-link-replaces').textContent).toContain(
      'shared',
    );
    expect(calls).toHaveLength(1);
  });

  test('accepting the disclosure performs the link', async () => {
    const calls = captureFolderActions({ ...EMPTY_PREVIEW, moves: ['only-here'] });
    await pickAgentsIntoClaude();

    await userEvent.click(await screen.findByTestId('skill-folder-link-confirm'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].preview).toBeUndefined();
  });

  test('conflicting skills block before the write, not as a 409 after it', async () => {
    const calls = captureFolderActions({ ...EMPTY_PREVIEW, conflicts: ['fork'] });
    await pickAgentsIntoClaude();

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).toContain('fork');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('non-skill entries block before the write, not as a 409 after it', async () => {
    const calls = captureFolderActions({ ...EMPTY_PREVIEW, strays: ['notes.md'] });
    await pickAgentsIntoClaude();

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(message).toContain('notes.md');
    expect(message).toContain('Remove or move them from the folder and try again.');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('a preview whose plan cannot be read fails closed — no unwitnessed write', async () => {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const action = init?.body
        ? (JSON.parse(init.body).folderAction as Record<string, unknown>)
        : undefined;
      if (action) calls.push(action);
      if (action?.preview === true) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('unparseable');
          },
        };
      }
      return { ok: true, status: 200, json: async () => FOLDERS_PAYLOAD };
    }) as unknown as typeof fetch;
    await pickAgentsIntoClaude();

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.preview).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('a structurally malformed preview fails closed at the HTTP boundary', async () => {
    const calls = captureFolderActions({ ...EMPTY_PREVIEW, conflicts: null });
    await pickAgentsIntoClaude();

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).toContain(
      'Server returned a malformed response.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.preview).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('an absent preview plan is refused again at the component boundary', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => FOLDERS_PAYLOAD,
    })) as unknown as typeof fetch;
    const skillsApi = await import('../../lib/skills-api');
    const actionSpy = vi.spyOn(skillsApi, 'putSkillFolderAction').mockResolvedValue({ ok: true });

    await pickAgentsIntoClaude();

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).toContain(
      'Could not classify the merge',
    );
    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('a folder that is already a symlink is not offered as a pick', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => FOLDERS_PAYLOAD,
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-link-claude')).toBeDefined());
    await userEvent.click(screen.getByTestId('skill-folder-link-claude'));

    expect(await screen.findByTestId('skill-folder-link-claude-to-.agents/skills')).toBeDefined();
    expect(screen.queryByTestId('skill-folder-link-claude-to-.codex/skills')).toBeNull();
  });
});

describe('the .agents hub row', () => {
  const withHub = (state: string) => ({
    targets: ['claude'],
    configured: false,
    folders: [
      { scope: 'project', host: 'claude', root: '.claude/skills', state: 'own' },
      { scope: 'project', host: 'agents', root: '.agents/skills', state },
    ],
  });

  test('an ABSENT hub offers no Link verb and says why', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => withHub('absent'),
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-row-agents')).toBeDefined());

    expect(screen.queryByTestId('skill-folder-link-agents')).toBeNull();
    expect(screen.getByTestId('skill-folder-hub-destination-only')).toBeDefined();
  });

  test('an ABSENT hub is not offered as a merge target on another row either', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => withHub('absent'),
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-row-claude')).toBeDefined());

    expect(screen.queryByTestId('skill-folder-link-claude')).toBeNull();
  });

  test('once the hub EXISTS it behaves like any other root', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => withHub('own'),
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-row-agents')).toBeDefined());

    expect(screen.getByTestId('skill-folder-link-agents')).toBeDefined();
    expect(screen.queryByTestId('skill-folder-hub-destination-only')).toBeNull();
  });
});
