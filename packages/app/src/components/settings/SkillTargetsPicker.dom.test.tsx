/**
 * RTL behavioral tests for the per-scope Folders surface. The machine-wide
 * install-mode toggle and the project-wide editor-target picker are both
 * retired — this section renders ONLY the folder rows with their observable
 * state and the SYMLINK (explicit pick) / UNLINK verbs.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      let out = '';
      strings.forEach((sPart, i) => {
        out += sPart;
        if (i < values.length) out += String(values[i]);
      });
      return out;
    },
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
  });

  test('the row you act on survives; the folder you pick becomes the symlink', async () => {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) calls.push(JSON.parse(init.body).folderAction);
      return { ok: true, status: 200, json: async () => FOLDERS_PAYLOAD };
    }) as unknown as typeof fetch;

    render(<SkillTargetsPicker scope="project" />);
    await waitFor(() => expect(screen.getByTestId('skill-folder-link-claude')).toBeDefined());

    await userEvent.click(screen.getByTestId('skill-folder-link-claude'));
    await userEvent.click(await screen.findByTestId('skill-folder-link-claude-to-.agents/skills'));

    // `.agents` was PICKED, so `.agents` is the one that merges in and becomes
    // the symlink; the clicked `.claude` row stays the real folder. Running it
    // the other way round was the inverted direction people read backwards.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      action: 'link',
      root: '.agents/skills',
      target: '.claude/skills',
    });
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
