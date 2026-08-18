/**
 * RTL behavioral tests for the per-scope Folders surface. The machine-wide
 * install-mode toggle and the project-wide editor-target picker are both
 * retired — this section renders ONLY the folder rows with their observable
 * state and the SYMLINK (explicit pick) / UNLINK verbs.
 */

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
    // Production's useLingui always carries `i18n`; the picker reads
    // `i18n.locale` to format the shared-folder sentence with Intl.ListFormat.
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
    // `.codex` is a symlink to `.agents`, so it is a READER of that folder, not a
    // peer: it nests under its target instead of taking a row. Rows are the
    // folders that own skills — `.claude` and `.agents`. The global-scope row
    // stays off the project page (scope split).
    expect(screen.getAllByTestId(/^skill-folder-row-/)).toHaveLength(2);
    expect(screen.queryByTestId('skill-folder-row-codex')).toBeNull();
    const agentsFollowers = screen.getByTestId('skill-folder-followers-agents');
    expect(agentsFollowers.textContent).toContain('.codex/skills');
    // A symlinked folder keeps UNLINK where it now lives — nested under its
    // target — and a real folder offers the SYMLINK picker.
    expect(agentsFollowers.contains(screen.getByTestId('skill-folder-unlink-codex'))).toBe(true);
    expect(screen.getByTestId('skill-folder-link-claude')).toBeDefined();
    // Retired controls are GONE.
    expect(screen.queryByTestId('skill-install-mode-user')).toBeNull();
    expect(screen.queryByTestId('skill-install-mode-project')).toBeNull();
    expect(screen.queryByTestId('skill-target-claude')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Custom skills folder path' })).toBeDefined();
  });

  /** Record every folderAction sent, answering the preview request with `preview`. */
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

    // `.agents` was PICKED, so `.agents` is the one that merges in and becomes
    // the symlink; the clicked `.claude` row stays the real folder. Running it
    // the other way round was the inverted direction people read backwards.
    // Nothing to disclose, so the write follows the classification with no
    // question in between — a clean link stays one click.
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
    // Every name is byte-identical in both folders. After the link the picked
    // folder IS a symlink to the one holding those copies, so every agent reads
    // exactly what it read before. Nothing to consent to.
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
    // Direction is drawn, not described — the picked folder becomes the link,
    // the acted-on row keeps the skills. Reading it backwards is the mistake
    // this surface keeps producing.
    expect(within(dialog).getByTestId('skill-folder-link-direction').textContent).toContain(
      '.agents/skills',
    );
    expect(within(dialog).getByTestId('skill-folder-link-moves').textContent).toContain(
      'only-here',
    );
    expect(within(dialog).getByTestId('skill-folder-link-drops').textContent).toContain('both');
    // The dot-entries no move covers go away with the folder — say so before
    // the write, not never.
    expect(within(dialog).getByTestId('skill-folder-link-removes').textContent).toContain(
      '.system',
    );

    await userEvent.click(within(dialog).getByText('Cancel'));
    // Declined: the classification was the only request.
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
    // Listed only under "moves" the name reads as a pure addition, when the
    // survivor is in fact losing a working delivery.
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
    // Never asked, never written — the link could only have been refused.
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
    // Same shape as the conflicts refusal: the classification is the only
    // request, no dialog, no write.
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
      // The preview PUT answers with an unreadable body — the plan is lost in
      // transit. The write must NOT fire on the strength of "nothing came back".
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
    // The classification was the only request — the merge never ran unwitnessed.
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

    // `.codex` is already linked into `.agents` — picking it could only fail.
    expect(await screen.findByTestId('skill-folder-link-claude-to-.agents/skills')).toBeDefined();
    expect(screen.queryByTestId('skill-folder-link-claude-to-.codex/skills')).toBeNull();
  });
});
