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

// Sonner is loaded by the SUT — stub to mute its real toaster.
const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

// The rows are fed by `/api/skills` — the same list every other skills surface
// reads. The desktop bridge below is the INTRO's source only, so the two are
// controlled separately here on purpose: a bridgeless render must still produce
// rows.
let skillsState: { status: string; data?: readonly SkillsListEntry[]; message?: string } = {
  status: 'loading',
};
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => skillsState }));

// The row's entire contract is "open the skill's own preview", so the opener is
// spied rather than exercised — the tab machinery behind it is covered where it
// lives.
const openPreviewSpy = vi.fn();
vi.doMock('@/lib/open-managed-artifact-tab', async () => {
  const actual = await vi.importActual<typeof import('@/lib/open-managed-artifact-tab')>(
    '@/lib/open-managed-artifact-tab',
  );
  // Calls THROUGH: a sibling test asserts the real hash this writes, so
  // replacing the implementation would quietly gut it.
  return {
    ...actual,
    openSkillPreviewTab: (target: Parameters<typeof actual.openSkillPreviewTab>[0]) => {
      openPreviewSpy(target);
      actual.openSkillPreviewTab(target);
    },
  };
});

// Spy on the perf-mark instrumentation while keeping the module's other exports.
const markSpy = vi.fn();
vi.doMock('@/lib/perf', async () => {
  const actual = await vi.importActual<typeof import('@/lib/perf')>('@/lib/perf');
  return { ...actual, mark: markSpy };
});

// The store's own fail-soft logic is unit-tested in
// `skills-studio-intro-store.test.ts`; here we only need to CONTROL "seen", and
// happy-dom on Node 26 has no localStorage to control it through.
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

/** Production mounts under the app-level TooltipProvider (main.tsx). */
function renderSection() {
  return render(
    <TooltipProvider>
      <BuiltInSkillsSection />
    </TooltipProvider>,
  );
}

const discovery: SkillsListEntry = {
  name: 'open-knowledge-discovery',
  // The real frontmatter shape: a trigger prompt aimed at an agent, which is
  // exactly why the row renders the human blurb instead.
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

/** An ordinary authored global skill + the project built-in: both must stay out
 *  of this block, which is the user-global built-ins only. */
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

/** The bridge snapshot backs the first-visit intro ONLY — which bundles setup
 *  already asked about (`onboarding`) is knowledge the endpoint does not have. */
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

/** Most tests exercise the page, not the first-visit intro; default to "seen"
 *  so the dialog does not sit over the rows they assert on. */
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
    // An authored global skill belongs to the manager below; the PROJECT
    // built-in belongs to the project block. Both filter the same list, so a
    // slip here puts one skill on the page twice.
    expect(screen.queryByText('grill-me')).toBeNull();
    expect(screen.queryByText('open-knowledge')).toBeNull();
  });

  test('the rows render without the desktop bridge', async () => {
    // They used to come from the bridge, so the whole block vanished in the
    // browser — on a page whose other half rendered there fine. Nothing is
    // installed here, which is exactly when the bridge would have been asked.
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    const rows = screen.getAllByTestId('skill-consent-row-preview');
    expect(rows.length).toBe(2);
    // Zero hosts is the state the row exists FOR (install it back) — a re-added
    // disabled guard would regress that silently.
    for (const row of rows) {
      expect(row.hasAttribute('disabled')).toBe(false);
      expect(row.getAttribute('aria-disabled')).toBeNull();
    }
  });

  test('the row prints the human blurb, never the agent-facing frontmatter description', async () => {
    // `description` is trigger text for a model — discovery's ends in a
    // `Do NOT load` clause — so a settings row that renders it hands the user a
    // prompt written for something else.
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('How to set up new projects with OpenKnowledge.')).toBeTruthy();
    });
    expect(screen.getByText('How to write a new skill and install it.')).toBeTruthy();
    expect(screen.queryByText(/Do NOT load/)).toBeNull();
  });

  test('a bundle the copy module does not know falls back to its description', async () => {
    // A newer server shipping a bundle this build has no localized line for must
    // still render a row that says something.
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
    // Settings owning a second write of the same state is what let one surface
    // say "installed" while the skill's own page said which agents.
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
    // Settings is a hash-driven dialog (#settings); navigating to a preview hash
    // is exactly what dismisses it.
    window.location.hash = '#settings';

    await userEvent.click(screen.getAllByTestId('skill-consent-row-preview')[0]);

    expect(openPreviewSpy).toHaveBeenCalledWith(
      // The bundle DIR, not the SKILL.md the list reports — a preview addressed
      // at the file resolves nothing.
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
    // The row's whole reason to survive uninstall is being the way back in —
    // with no host projection on disk, the preview must address the bundle OK
    // ships (the list's absolutePath), not a home copy that no longer exists.
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
      // First-launch setup no longer offers write-skill. Undiscoverable is not
      // the intended replacement for unwanted, so the offer moves here.
      introSeen = false;
      const { setCalls } = installBridge();
      renderSection();

      const dialog = await screen.findByTestId('skills-studio-intro');
      // Explains the page first — the tab label was the thing that told nobody
      // anything, so the intro leads with what this surface is.
      expect(dialog.textContent).toContain('Skills teach your AI tools repeatable tasks');
      // Then the offer, disclosed as fully as the confirm modal would.
      expect(within(dialog).getByText('open-knowledge-write-skill')).toBeTruthy();
      expect(within(dialog).getByText('How to write a new skill and install it.')).toBeTruthy();
      expect(within(dialog).getByText('~/.agents/skills/open-knowledge-write-skill')).toBeTruthy();
      // Discovery is already installed, so it is not re-offered.
      expect(within(dialog).queryByText('open-knowledge-discovery')).toBeNull();

      await userEvent.click(screen.getByTestId('skills-studio-intro-install'));

      await waitFor(() => {
        expect(setCalls).toEqual([
          { component: { kind: 'skill', id: 'write-skill' }, enabled: true },
        ]);
      });
    });

    test('a bundle setup already asked about is never re-offered, even uninstalled', async () => {
      // Uninstalled + onboarding means the user DECLINED it at first launch.
      // Offering it back in a modal is the app not taking no for an answer.
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
      // Explainer only — discovery is declined, write-skill is installed.
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
      // No silent revert: the rows still report what the endpoint says.
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
      // "Not now" must cost the user nothing — no decision is recorded, and the
      // row underneath still reaches the skill.
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
      // No offer to make, so no Install/Not now pair — one acknowledging button.
      expect(screen.queryByTestId('skills-studio-intro-install')).toBeNull();
      expect(screen.getByTestId('skills-studio-intro-ack')).toBeTruthy();
    });

    test('a bridgeless build shows rows and simply no intro', async () => {
      // The intro is the one bridge-dependent thing left here. Without a bridge
      // it must fail quiet, not take the rows down with it.
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
