/**
 * The scope-to-block wiring, pinned.
 *
 * `SkillsManagerSection` is the only place mapping scope to which block renders,
 * and the section suites mount `BuiltInSkillsSection` / `ProjectSkillSection`
 * directly — so inverting the ternary left every test green. These mount the
 * real page, with a bridge, at both scopes.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ i18n: { locale: 'en' }, t: renderLinguiTemplate }),
}));

// The intro dialog is not what these assert on; keep it out of the way.
vi.doMock('@/lib/skills-studio-intro-store', () => ({
  SKILLS_STUDIO_INTRO_KEY: 'ok-skills-studio-intro-seen-v1',
  hasSeenSkillsStudioIntro: () => true,
  markSkillsStudioIntroSeen: () => {},
}));

// The folders block does its own fetching; it is not under test here.
vi.doMock('@/hooks/use-skill-targets', () => ({
  useSkillTargets: () => ({
    state: { status: 'ready', data: { folders: [] } },
    saving: false,
    folderAction: async () => {},
  }),
}));

const { SkillsManagerSection } = await import('./SkillsManagerSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function installBridge() {
  const userStatus = {
    available: true,
    editors: [],
    path: { shellDetected: false, rcFilesToTouch: [], installed: false },
    skills: [
      {
        id: 'discovery',
        name: 'open-knowledge-discovery',
        description: 'trigger text',
        installed: true,
        onboarding: true,
        paths: ['~/.agents/skills/open-knowledge-discovery'],
        sourceDir: '/bundles/discovery',
        resolvedHosts: [{ editor: 'claude', skillsRoot: '.claude/skills', custom: false }],
      },
    ],
  };
  const projectStatus = {
    available: true,
    hasProject: true,
    projectDir: '~/proj',
    editors: [],
    skill: {
      installed: true,
      paths: ['.claude/skills/open-knowledge/SKILL.md'],
      description: 'trigger text',
      hosts: ['claude'],
      sourceDir: '/bundles/project',
    },
  };
  Object.defineProperty(window, 'okDesktop', {
    value: {
      integrations: { status: async () => userStatus, setComponent: async () => ({ ok: true }) },
      projectIntegrations: {
        status: async () => projectStatus,
        setComponent: async () => ({ ok: true }),
      },
    },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('SkillsManagerSection scope wiring', () => {
  test('user scope renders the machine-wide bundles, not the project skill', async () => {
    installBridge();
    render(
      <TooltipProvider>
        <SkillsManagerSection scope="global" />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-project-skill')).toBeNull();
  });

  test('project scope renders the project skill, not the machine-wide bundles', async () => {
    installBridge();
    render(
      <TooltipProvider>
        <SkillsManagerSection scope="project" />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-builtin-skills')).toBeNull();
  });
});
