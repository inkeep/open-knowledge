import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The per-agent install path: the user picks an agent in the INSTALL menu, the
 * hook imports the bundle and reports `importedName`, and the preview tab must
 * replace itself with the real skill. The existing suite only covers the BULK
 * path (`bulkInstalledName`), so this branch shipped uncovered — and it is the
 * one that strands on the preview in the app.
 */
vi.doMock('@/components/SkillBundlePreview', () => ({
  SkillBundlePreview: ({
    headerActions,
    banner,
    onPreviewMeta,
  }: {
    headerActions: ReactNode;
    banner?: ReactNode;
    onPreviewMeta?: (p: unknown) => void;
  }) => {
    useEffect(() => {
      onPreviewMeta?.({});
    }, [onPreviewMeta]);
    return (
      <>
        <div data-testid="preview-body">preview</div>
        {headerActions}
        {banner}
      </>
    );
  },
}));
vi.doMock('@/components/SkillPluginBundleBanner', () => ({
  SkillPluginBundleBanner: () => null,
}));
vi.doMock('@/components/SkillInstallMenu', () => ({
  SKILL_INSTALL_MENU_WIDTH: '',
  SkillInstallMenuItems: () => null,
}));
vi.doMock('@/components/skill-actions', () => ({ useSkillActions: () => ({}) }));
vi.doMock('@/lib/skill-scope', () => ({
  useSkillScopeLabels: () => ({ project: 'Project', global: 'Global' }),
  SKILL_SCOPE_ORDER: ['project', 'global'],
}));
vi.doMock('@/lib/skills-api', () => ({
  fetchSkillDetail: vi.fn(async () => ({ ok: false, error: 'n/a' })),
  // The post-toggle redirect re-resolves the bundle's CURRENT location with
  // this per-skill read (an install can relocate a just-imported bundle).
  getSkillCurrentPath: vi.fn(async () => '.claude/skills/grill-me/SKILL.md'),
  placeSkill: vi.fn(),
  discoverSkillsInSource: vi.fn(async () => ({ ok: false, error: 'n/a' })),
  importSkillsBulk: vi.fn(),
  installSkill: vi.fn(),
}));

// The redirect waits for the skill to appear in the list, since that is what
// `useOpenSkill` resolves the doc from.
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({
    status: 'ready',
    data: [
      {
        scope: 'project',
        name: 'grill-me',
        path: '.claude/skills/grill-me/SKILL.md',
        installed: true,
        hosts: ['claude'],
      },
    ],
  }),
}));
const closeTab = vi.fn();
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    openTabs: [
      'skill-preview:explore:grill-me:project',
      'skill-preview:explore:grill-with-docs:project',
    ],
    closeTab,
  }),
}));
const openSkill = vi.fn();
vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => openSkill }));

// The import has landed at PROJECT scope — exactly what the app reports after a
// per-agent install (`.claude/skills/<name>/SKILL.md`, host claude).
vi.doMock('@/hooks/use-explore-preview-install', () => ({
  useExplorePreviewInstall: () => ({
    scope: 'project',
    importedScope: 'project',
    importedName: 'grill-me',
    setScope: vi.fn(),
    scopeLocked: true,
    importNow: vi.fn(),
    toggles: {
      hostSet: new Set(['claude']),
      installed: true,
      installing: false,
      toggleEditor: vi.fn(),
      installAll: vi.fn(),
      linkMode: false,
      setLinkMode: vi.fn(),
      setSource: vi.fn(),
      placeAt: vi.fn(),
    },
  }),
}));

const { SkillPreviewTab } = await import('./SkillPreviewTab');

describe('SkillPreviewTab per-agent install redirect', () => {
  test('replaces the preview with the real skill once the import lands', async () => {
    render(<SkillPreviewTab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');

    // Host toggles ran, so the redirect re-resolves the current location
    // (async) before opening.
    await waitFor(() =>
      expect(openSkill).toHaveBeenCalledWith('project', 'grill-me', {
        path: '.claude/skills/grill-me/SKILL.md',
        replaceActive: true,
        // This open supersedes the preview the user is standing on, so it takes
        // that history entry rather than stacking a second one for the same skill.
        replaceHistory: true,
      }),
    );
  });

  test('fires off the import result even while the skills list still lags', async () => {
    // The redirect no longer waits for the skills list: on large content
    // roots the list lags an install by seconds, and gating on it made the
    // preview sit un-redirected ("install didn't open the skill"). The open
    // resolves by the import's own path report, so a lagging list is safe.
    vi.resetModules();
    const lateOpen = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => lateOpen }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    await waitFor(() =>
      expect(lateOpen).toHaveBeenCalledWith('project', 'grill-me', {
        path: '.claude/skills/grill-me/SKILL.md',
        replaceActive: true,
        replaceHistory: true,
      }),
    );
  });

  test('does not fire before any import has landed', async () => {
    vi.resetModules();
    const lateOpen = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => lateOpen }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    vi.doMock('@/hooks/use-explore-preview-install', () => ({
      useExplorePreviewInstall: () => ({
        scope: 'project',
        importedScope: null,
        importedName: null,
        importedPath: null,
        setScope: vi.fn(),
        scopeLocked: false,
        importNow: vi.fn(),
        toggles: {
          hostSet: new Set<string>(),
          installed: false,
          installing: false,
          toggleEditor: vi.fn(),
          installAll: vi.fn(),
          linkMode: false,
          setLinkMode: vi.fn(),
          setSource: vi.fn(),
          placeAt: vi.fn(),
        },
      }),
    }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    expect(lateOpen).not.toHaveBeenCalled();
  });

  test('holds the redirect while an install is still in flight', async () => {
    // An install toggle can RELOCATE the just-imported bundle (set-exact
    // fan-out picks the canonical dir). A redirect fired mid-install opens a
    // doc whose dir is about to move; the server auth-rejects it and the
    // cleanup closes the tab, landing the user on Home with nothing open.
    vi.resetModules();
    const lateOpen = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => lateOpen }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    vi.doMock('@/hooks/use-explore-preview-install', () => ({
      useExplorePreviewInstall: () => ({
        scope: 'project',
        importedScope: 'project',
        importedName: 'grill-me',
        importedPath: '.agents/skills/grill-me/SKILL.md',
        setScope: vi.fn(),
        scopeLocked: true,
        importNow: vi.fn(),
        toggles: {
          hostSet: new Set(['claude']),
          installed: true,
          installing: true,
          toggleEditor: vi.fn(),
          installAll: vi.fn(),
          linkMode: false,
          setLinkMode: vi.fn(),
          setSource: vi.fn(),
          placeAt: vi.fn(),
        },
      }),
    }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    expect(lateOpen).not.toHaveBeenCalled();
  });

  test('re-resolves the current path once an install toggle ran', async () => {
    // The import reported where the bundle FIRST landed; the install moved it.
    // Opening by that stale path auth-rejects server-side and the tab
    // self-closes — so with any host toggled, the open re-resolves the
    // bundle's CURRENT location (per-skill detail read, never the laggy
    // skills list) and only falls back to the import-time path if that fails.
    vi.resetModules();
    const lateOpen = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => lateOpen }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    vi.doMock('@/hooks/use-explore-preview-install', () => ({
      useExplorePreviewInstall: () => ({
        scope: 'project',
        importedScope: 'project',
        importedName: 'grill-me',
        importedPath: '.agents/skills/grill-me/SKILL.md',
        setScope: vi.fn(),
        scopeLocked: true,
        importNow: vi.fn(),
        toggles: {
          hostSet: new Set(['claude']),
          installed: true,
          installing: false,
          toggleEditor: vi.fn(),
          installAll: vi.fn(),
          linkMode: false,
          setLinkMode: vi.fn(),
          setSource: vi.fn(),
          placeAt: vi.fn(),
        },
      }),
    }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    await waitFor(() =>
      expect(lateOpen).toHaveBeenCalledWith('project', 'grill-me', {
        path: '.claude/skills/grill-me/SKILL.md',
        replaceActive: true,
        replaceHistory: true,
      }),
    );
    expect(lateOpen).not.toHaveBeenCalledWith(
      'project',
      'grill-me',
      expect.objectContaining({ path: '.agents/skills/grill-me/SKILL.md' }),
    );
  });

  test('the install destination menu never pointer-locks the page', async () => {
    // The menu's owner tab is REPLACED by the post-install auto-open, which
    // unmounts the menu mid-close. A modal Radix menu sets
    // `body{pointer-events:none}` while open and that abrupt unmount skips the
    // unlock — the whole app then ignores every click until reload (caught
    // live). Non-modal never locks, so this asserts the lock never appears.
    vi.resetModules();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => vi.fn() }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    vi.doMock('@/hooks/use-explore-preview-install', () => ({
      useExplorePreviewInstall: () => ({
        scope: 'project',
        importedScope: null,
        importedName: null,
        importedPath: null,
        setScope: vi.fn(),
        scopeLocked: false,
        importNow: vi.fn(),
        toggles: {
          hostSet: new Set<string>(),
          installed: false,
          installing: false,
          toggleEditor: vi.fn(),
          installAll: vi.fn(),
          linkMode: false,
          setLinkMode: vi.fn(),
          setSource: vi.fn(),
          placeAt: vi.fn(),
        },
      }),
    }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    const { fireEvent } = await import('@testing-library/react');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    const trigger = screen.getByRole('button', { name: /install/i });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  });
});
