import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';

const previewMeta: { pluginBundle?: { plugin: string | null; bundledSkills: string[] } } = {};

vi.doMock('@/components/SkillBundlePreview', () => ({
  SkillBundlePreview: ({
    headerActions,
    banner,
    onPreviewMeta,
  }: {
    headerActions: ReactNode;
    banner?: ReactNode;
    onPreviewMeta?: (preview: {
      plugin?: {
        provider: string;
        plugin: string;
        version?: string;
        marketplace?: string;
        repositoryUrl?: string;
      };
      pluginBundle?: { plugin: string | null; bundledSkills: string[] };
    }) => void;
  }) => {
    useEffect(() => {
      onPreviewMeta?.({
        plugin: {
          provider: 'claude',
          plugin: 'ponytail',
          version: '4.8.4',
          marketplace: 'ponytail',
          repositoryUrl: 'https://github.com/acme/ponytail',
        },
        pluginBundle: previewMeta.pluginBundle,
      });
    }, [onPreviewMeta]);
    return (
      <>
        {headerActions}
        {banner}
      </>
    );
  },
}));

vi.doMock('@/components/SkillPluginBundleBanner', () => ({
  SkillPluginBundleBanner: ({
    onInstalled,
  }: {
    onInstalled?: (landed: ReadonlyMap<string, string>) => void;
  }) => (
    <button
      type="button"
      data-testid="bulk-install-finished"
      onClick={() => onInstalled?.(new Map([['grill-me', 'grill-me']]))}
    >
      bulk install
    </button>
  ),
}));
vi.doMock('@/components/SkillInstallMenu', () => ({
  SkillInstallMenuItems: () => <div data-testid="destination-choices">Destinations</div>,
  SKILL_INSTALL_MENU_WIDTH: 'min-w-[24rem]',
  INSTALL_EDITORS: ['claude', 'cursor', 'codex'],
}));
vi.doMock('@/components/skill-actions', () => ({
  SkillPlaceDialog: () => null,
}));
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({
    status: 'ready',
    data: [
      {
        scope: 'global',
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
vi.doMock('@/hooks/use-open-skill', () => ({
  useOpenSkill: () => openSkill,
}));
vi.doMock('@/lib/skill-scope', () => ({
  useSkillScopeLabels: () => ({ project: 'Project', global: 'Global' }),
  SKILL_SCOPE_ORDER: ['project', 'global'],
}));
vi.doMock('@/lib/skills-api', () => ({
  fetchSkillDetail: vi.fn(),
  placeSkill: vi.fn(),
  discoverSkillsInSource: vi.fn(async () => ({ ok: false, error: 'not in this test' })),
  importSkillsBulk: vi.fn(),
  installSkill: vi.fn(),
}));

const setScope = vi.fn();
vi.doMock('@/hooks/use-explore-preview-install', () => ({
  useExplorePreviewInstall: () => ({
    scope: 'global',
    setScope,
    scopeLocked: false,
    importedName: null,
    importNow: vi.fn(),
    toggles: {
      hostSet: new Set(),
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

const skillsApi = await import('@/lib/skills-api');
const { SkillPreviewTab } = await import('./SkillPreviewTab');

describe('SkillPreviewTab plugin copy', () => {
  test('opens destination and level choices before creating the editable copy', async () => {
    const user = userEvent.setup();
    render(
      <SkillPreviewTab
        flavor="detected"
        source="/Users/test/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail-audit"
        name="ponytail-audit"
        subtitle="claude"
        level="global"
      />,
    );

    await user.click(screen.getByTestId('skill-preview-edit-a-copy'));

    expect(await screen.findByText('Where')).toBeTruthy();
    expect(screen.getByText('This project')).toBeTruthy();
    expect(screen.getByText('This machine')).toBeTruthy();
    expect(screen.getByTestId('skill-scope-consequence').textContent).toContain('home folder');
    expect(screen.getByTestId('destination-choices')).toBeTruthy();
  });
});

describe('SkillPreviewTab marketplace links', () => {
  test('labels a website publisher as a source without inventing a GitHub repository', async () => {
    vi.mocked(skillsApi.fetchSkillDetail).mockResolvedValue({
      ok: true,
      title: 'lark-attendance',
      description: 'Attendance tools',
      image: null,
      skillsUrl: 'https://www.skills.sh/site/open.feishu.cn/lark-attendance',
      sourceKind: 'site',
      sourceUrl: 'https://open.feishu.cn',
    });

    render(
      <SkillPreviewTab
        flavor="explore"
        source="open.feishu.cn"
        name="lark-attendance"
        subtitle="open.feishu.cn"
      />,
    );

    expect((await screen.findByRole('link', { name: 'Source' })).getAttribute('href')).toBe(
      'https://open.feishu.cn',
    );
    expect(screen.getByRole('link', { name: 'skills.sh' }).getAttribute('href')).toBe(
      'https://www.skills.sh/site/open.feishu.cn/lark-attendance',
    );
    expect(screen.queryByRole('link', { name: 'Repository' })).toBeNull();
  });
});

describe('SkillPreviewTab bulk plugin install', () => {
  test('leaves the preview for the real skill once a bundle install lands it', async () => {
    const user = userEvent.setup();
    openSkill.mockClear();
    previewMeta.pluginBundle = { plugin: 'ponytail', bundledSkills: ['grill-me', 'grilling'] };
    vi.mocked(skillsApi.fetchSkillDetail).mockResolvedValue({
      ok: true,
      title: 'grill-me',
      description: null,
      image: null,
      skillsUrl: null,
      sourceKind: 'git',
      sourceUrl: null,
    });

    render(
      <SkillPreviewTab
        flavor="explore"
        source="acme/ponytail"
        name="grill-me"
        subtitle="ponytail"
      />,
    );

    await user.click(await screen.findByTestId('bulk-install-finished'));

    expect(openSkill).toHaveBeenCalledWith('global', 'grill-me', {
      replaceActive: true,
      replaceHistory: true,
    });
    previewMeta.pluginBundle = undefined;
  });
});
