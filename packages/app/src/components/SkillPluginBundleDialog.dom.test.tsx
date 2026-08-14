import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const discoverSkillsInSource = vi.fn(async () => ({
  ok: true as const,
  skills: [
    { name: 'alpha', description: 'Alpha guidance' },
    { name: 'beta', description: 'Beta guidance' },
  ],
}));
const importSkillsBulk = vi.fn(async () => ({
  ok: true as const,
  imported: 1,
  alreadyImported: 0,
  failed: 0,
  results: [{ requested: 'alpha', name: 'alpha', status: 'imported' as const }],
}));
const installSkill = vi.fn();

vi.doMock('@/hooks/use-skill-targets', () => ({
  useSkillTargets: () => ({
    state: { status: 'ready', data: { configured: true, targets: [] } },
    saving: false,
    folderAction: vi.fn(),
  }),
}));

vi.doMock('@/lib/skills-api', () => ({
  discoverSkillsInSource,
  importSkillsBulk,
  installSkill,
}));

vi.doMock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { SkillPluginBundleDialog } = await import('./SkillPluginBundleDialog');

afterEach(() => {
  cleanup();
  discoverSkillsInSource.mockClear();
  importSkillsBulk.mockClear();
  installSkill.mockClear();
});

describe('SkillPluginBundleDialog', () => {
  test('keeps the existing remote bundle import and explicit selection path', async () => {
    const user = userEvent.setup();
    const onInstalled = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SkillPluginBundleDialog
        bundle={{ plugin: 'Example', names: ['alpha', 'beta'] }}
        source="https://example.com/plugin"
        defaultScope="project"
        onInstalled={onInstalled}
        onOpenChange={onOpenChange}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Install from Example' });
    const install = within(dialog).getByRole('button', { name: 'Install selected' });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    expect(discoverSkillsInSource).toHaveBeenCalledWith(
      'https://example.com/plugin',
      expect.any(AbortSignal),
    );

    await user.click(await within(dialog).findByRole('checkbox', { name: /alpha/i }));
    await user.click(install);

    await waitFor(() =>
      expect(importSkillsBulk).toHaveBeenCalledWith({
        source: 'https://example.com/plugin',
        skills: ['alpha'],
        scope: 'project',
        install: false,
        marketplace: true,
      }),
    );
    expect(installSkill).not.toHaveBeenCalled();
    expect(onInstalled).toHaveBeenCalledWith(new Map([['alpha', 'alpha']]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
