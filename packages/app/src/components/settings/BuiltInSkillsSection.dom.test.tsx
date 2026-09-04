import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  OkIntegrationsSetRequest,
  OkIntegrationsSetResult,
  OkIntegrationsStatus,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

let skillsState: { status: string; data?: readonly SkillsListEntry[]; message?: string } = {
  status: 'loading',
};
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => skillsState }));

const openPreviewSpy = vi.fn();
vi.doMock('@/lib/open-managed-artifact-tab', async () => {
  const actual = await vi.importActual<typeof import('@/lib/open-managed-artifact-tab')>(
    '@/lib/open-managed-artifact-tab',
  );
  return {
    ...actual,
    openSkillPreviewTab: (target: Parameters<typeof actual.openSkillPreviewTab>[0]) => {
      openPreviewSpy(target);
      actual.openSkillPreviewTab(target);
    },
  };
});

const markSpy = vi.fn();
vi.doMock('@/lib/perf', async () => {
  const actual = await vi.importActual<typeof import('@/lib/perf')>('@/lib/perf');
  return { ...actual, mark: markSpy };
});

let introSeen = true;
vi.doMock('@/lib/skills-studio-intro-store', () => ({
  SKILLS_STUDIO_INTRO_KEY: 'ok-skills-studio-intro-seen-v1',
  hasSeenSkillsStudioIntro: () => introSeen,
  markSkillsStudioIntroSeen: () => {
    introSeen = true;
  },
}));

const { BuiltInSkillsSection } = await import('./BuiltInSkillsSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderSection() {
  return render(
    <TooltipProvider>
      <BuiltInSkillsSection />
    </TooltipProvider>,
  );
}

const discovery: SkillsListEntry = {
  name: 'open-knowledge-discovery',
  description:
    'Read when the user asks what OpenKnowledge is, wants to install it on a repository. Do NOT load to perform OpenKnowledge reads/writes.',
  scope: 'global',
  path: '.claude/skills/open-knowledge-discovery/SKILL.md',
  absolutePath: '/home/.claude/skills/open-knowledge-discovery/SKILL.md',
  installed: true,
  hosts: ['claude'],
  managed: true,
  size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
};

const writeSkill: SkillsListEntry = {
  name: 'open-knowledge-write-skill',
  description:
    'Use when the user wants to create, author, write, or design a new Agent Skill (a SKILL.md).',
  scope: 'global',
  path: 'bundles/open-knowledge-write-skill/SKILL.md',
  absolutePath: '/bundles/open-knowledge-write-skill/SKILL.md',
  installed: false,
  hosts: [],
  managed: true,
  size: { alwaysOn: 156, onTrigger: 3218, onDemand: 916 },
};

const authored: SkillsListEntry = {
  name: 'grill-me',
  scope: 'global',
  path: '.claude/skills/grill-me/SKILL.md',
  absolutePath: '/home/.claude/skills/grill-me/SKILL.md',
  installed: true,
  hosts: ['claude'],
};
const projectBuiltin: SkillsListEntry = {
  name: 'open-knowledge',
  scope: 'project',
  path: '.claude/skills/open-knowledge/SKILL.md',
  absolutePath: '/proj/.claude/skills/open-knowledge/SKILL.md',
  installed: true,
  hosts: ['claude'],
  managed: true,
};

const baseStatus: OkIntegrationsStatus = {
  available: true,
  editors: [],
  path: { shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: false },
  skills: [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      description: discovery.description ?? '',
      installed: true,
      onboarding: true,
      paths: [
        '~/.agents/skills/open-knowledge-discovery',
        '~/.claude/skills/open-knowledge-discovery',
      ],
      size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
      sourceDir: '/bundles/open-knowledge-discovery',
      resolvedHosts: [{ editor: 'claude', skillsRoot: '.claude/skills', custom: false }],
    },
    {
      id: 'write-skill',
      name: 'open-knowledge-write-skill',
      description: writeSkill.description ?? '',
      installed: false,
      onboarding: false,
      paths: ['~/.agents/skills/open-knowledge-write-skill'],
      size: { alwaysOn: 156, onTrigger: 3218, onDemand: 916 },
      sourceDir: '/bundles/open-knowledge-write-skill',
      resolvedHosts: [{ editor: 'claude', skillsRoot: '.claude/skills', custom: false }],
    },
  ],
};

interface HarnessOpts {
  status?: OkIntegrationsStatus;
  setResult?: (request: OkIntegrationsSetRequest) => OkIntegrationsSetResult;
}

function installBridge({ status = baseStatus, setResult }: HarnessOpts = {}) {
  const setCalls: OkIntegrationsSetRequest[] = [];
  const bridge = {
    integrations: {
      status: async () => status,
      setComponent: async (request: OkIntegrationsSetRequest) => {
        setCalls.push(request);
        return setResult ? setResult(request) : { ok: true as const, status };
      },
    },
  };
  Object.defineProperty(window, 'okDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return { setCalls };
}

beforeEach(() => {
  introSeen = true;
  skillsState = { status: 'ready', data: [authored, discovery, writeSkill, projectBuiltin] };
});

afterEach(() => {
  cleanup();
  toastError.mockClear();
  markSpy.mockClear();
  openPreviewSpy.mockClear();
  window.location.hash = '';
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('BuiltInSkillsSection', () => {
  test('renders one row per user-global built-in, and nothing else from the list', async () => {
    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
    expect(screen.queryByText('grill-me')).toBeNull();
    expect(screen.queryByText('open-knowledge')).toBeNull();
  });

  test('the rows render without the desktop bridge', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    const rows = screen.getAllByTestId('skill-consent-row-preview');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.hasAttribute('disabled')).toBe(false);
      expect(row.getAttribute('aria-disabled')).toBeNull();
    }
  });

  test('the row prints the human blurb, never the agent-facing frontmatter description', async () => {
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('How to set up new projects with OpenKnowledge.')).toBeTruthy();
    });
    expect(screen.getByText('How to write a new skill and install it.')).toBeTruthy();
    expect(screen.queryByText(/Do NOT load/)).toBeNull();
  });

  test('a bundle the copy module does not know falls back to its description', async () => {
    skillsState = {
      status: 'ready',
      data: [{ ...writeSkill, name: 'open-knowledge-future' }],
    };
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/Use when the user wants to create/)).toBeTruthy();
    });
  });

  test('the row is the control — there is no separate button to write from', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    expect(screen.queryByTestId('skills-studio-skill-manage-discovery')).toBeNull();
    expect(screen.queryByTestId('skills-studio-skill-install-write-skill')).toBeNull();
    expect(screen.queryByTestId('skills-studio-skill-checkbox-discovery')).toBeNull();
  });

  test('the block states that installing reaches every AI tool on the machine', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-builtin-skills').textContent).toContain(
      'every AI tool on this machine',
    );
  });

  test('clicking the row body opens the built-in preview addressed by its bundle dir', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
    });
    window.location.hash = '#settings';

    await userEvent.click(screen.getAllByTestId('skill-consent-row-preview')[0]);

    expect(openPreviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        flavor: 'builtin',
        name: 'open-knowledge-discovery',
        source: '/home/.claude/skills/open-knowledge-discovery',
        level: 'global',
      }),
    );
    expect(window.location.hash.startsWith('#/__skill-preview__/')).toBe(true);
    expect(window.location.hash).not.toBe('#settings');
  });

  test('an UNINSTALLED built-in row still opens the preview, addressed at the shipped bundle', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
    });

    await userEvent.click(screen.getAllByTestId('skill-consent-row-preview')[1]);

    expect(openPreviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        flavor: 'builtin',
        name: 'open-knowledge-write-skill',
        source: '/bundles/open-knowledge-write-skill',
        level: 'global',
      }),
    );
    expect(window.location.hash.startsWith('#/__skill-preview__/')).toBe(true);
  });

  test('a skill installed nowhere still states the reason on the row', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skill-consent-row-no-hosts')).toBeTruthy();
    });
    expect(screen.getByTestId('skill-consent-row-no-hosts').textContent).toContain(
      'No AI tools detected',
    );
  });

  test('a failed list keeps the heading and says what could not be read', async () => {
    skillsState = { status: 'error', message: 'boom' };
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('builtin-skills-unavailable')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-builtin-skills').textContent).toContain(
      'Skills from OpenKnowledge',
    );
  });

  test('the loading state announces itself rather than showing a silent skeleton', async () => {
    skillsState = { status: 'loading' };
    renderSection();
    const loading = await screen.findByTestId('builtin-skills-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Loading skills');
  });

  test('a list with no built-ins renders nothing, leaving the folders block below', async () => {
    skillsState = { status: 'ready', data: [authored] };
    const { container } = renderSection();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-builtin-skills"]')).toBeNull();
    });
  });

  describe('first-visit intro', () => {
    test('offers the skill setup no longer installs, and installs it on confirm', async () => {
      introSeen = false;
      const { setCalls } = installBridge();
      renderSection();

      const dialog = await screen.findByTestId('skills-studio-intro');
      expect(dialog.textContent).toContain('Skills teach your AI tools repeatable tasks');
      expect(within(dialog).getByText('open-knowledge-write-skill')).toBeTruthy();
      expect(within(dialog).getByText('How to write a new skill and install it.')).toBeTruthy();
      expect(within(dialog).getByText('~/.agents/skills/open-knowledge-write-skill')).toBeTruthy();
      expect(within(dialog).queryByText('open-knowledge-discovery')).toBeNull();

      await userEvent.click(screen.getByTestId('skills-studio-intro-install'));

      await waitFor(() => {
        expect(setCalls).toEqual([
          { component: { kind: 'skill', id: 'write-skill' }, enabled: true },
        ]);
      });
    });

    test('a bundle setup already asked about is never re-offered, even uninstalled', async () => {
      introSeen = false;
      installBridge({
        status: {
          ...baseStatus,
          skills: baseStatus.skills.map((s) =>
            s.id === 'discovery' ? { ...s, installed: false } : { ...s, installed: true },
          ),
        },
      });
      renderSection();

      const dialog = await screen.findByTestId('skills-studio-intro');
      expect(screen.queryByTestId('skills-studio-intro-install')).toBeNull();
      expect(within(dialog).queryByText('open-knowledge-discovery')).toBeNull();
      expect(screen.getByTestId('skills-studio-intro-ack')).toBeTruthy();
    });

    test('an install that fails for every host stays uninstalled and surfaces the failure', async () => {
      introSeen = false;
      installBridge({
        setResult: () => ({
          ok: false as const,
          error: "Couldn't write ~/.claude/skills/open-knowledge-write-skill",
          status: baseStatus,
        }),
      });
      renderSection();
      await userEvent.click(await screen.findByTestId('skills-studio-intro-install'));

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(
          "Couldn't write ~/.claude/skills/open-knowledge-write-skill",
        );
      });
      expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
    });

    test('a confirmed install marks an event carrying the originating surface and host count', async () => {
      introSeen = false;
      const { setCalls } = installBridge();
      renderSection();
      await userEvent.click(await screen.findByTestId('skills-studio-intro-install'));
      await waitFor(() => {
        expect(setCalls.length).toBe(1);
      });

      expect(markSpy).toHaveBeenCalledWith(
        'ok/skill/install',
        expect.objectContaining({ surface: 'skills-studio-intro', mode: 'install', hostCount: 1 }),
      );
    });

    test('shows once — a dismissal is remembered across mounts', async () => {
      introSeen = false;
      installBridge();
      const first = renderSection();
      await userEvent.click(await screen.findByTestId('skills-studio-intro-dismiss'));
      expect(screen.queryByTestId('skills-studio-intro')).toBeNull();
      first.unmount();

      renderSection();
      await waitFor(() => {
        expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
      });
      expect(screen.queryByTestId('skills-studio-intro')).toBeNull();
    });

    test('declining leaves the offer standing on the page', async () => {
      introSeen = false;
      const { setCalls } = installBridge();
      renderSection();
      await userEvent.click(await screen.findByTestId('skills-studio-intro-dismiss'));

      expect(setCalls).toEqual([]);
      expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
    });

    test('with everything installed it explains and gets out of the way', async () => {
      introSeen = false;
      installBridge({
        status: {
          ...baseStatus,
          skills: baseStatus.skills.map((sk) => ({ ...sk, installed: true })),
        },
      });
      renderSection();

      const dialog = await screen.findByTestId('skills-studio-intro');
      expect(dialog.textContent).toContain('Skills teach your AI tools repeatable tasks');
      expect(screen.queryByTestId('skills-studio-intro-install')).toBeNull();
      expect(screen.getByTestId('skills-studio-intro-ack')).toBeTruthy();
    });

    test('a bridgeless build shows rows and simply no intro', async () => {
      introSeen = false;
      renderSection();
      await waitFor(() => {
        expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
      });
      expect(screen.queryByTestId('skills-studio-intro')).toBeNull();
    });

    test('a bridge that fails to answer costs the offer, not the section', async () => {
      introSeen = false;
      Object.defineProperty(window, 'okDesktop', {
        value: { integrations: { status: async () => Promise.reject(new Error('no main')) } },
        configurable: true,
        writable: true,
      });
      renderSection();
      await waitFor(() => {
        expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(2);
      });
      expect(screen.queryByTestId('skills-studio-intro')).toBeNull();
    });
  });
});
