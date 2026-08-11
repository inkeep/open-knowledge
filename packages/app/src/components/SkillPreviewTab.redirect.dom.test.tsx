import { render, screen } from '@testing-library/react';
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

    expect(openSkill).toHaveBeenCalledWith('project', 'grill-me', {
      replaceActive: true,
      // This open supersedes the preview the user is standing on, so it takes
      // that history entry rather than stacking a second one for the same skill.
      replaceHistory: true,
    });
  });

  test('does not burn its one attempt while the list still lags the import', async () => {
    // The fire-once ref is set BEFORE the open resolves, so redirecting before
    // the entry is resolvable strands the preview permanently. Mount with an
    // empty list and assert we hold rather than fire.
    vi.resetModules();
    const lateOpen = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => lateOpen }));
    vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
    const { SkillPreviewTab: Tab } = await import('./SkillPreviewTab');
    render(<Tab flavor="explore" source="mattpocock/skills" name="grill-me" />);
    await screen.findByTestId('preview-body');
    expect(lateOpen).not.toHaveBeenCalled();
  });
});
