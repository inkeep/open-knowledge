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

/** `editors` and `path` are required by the status contract but belong to the AI
 *  tools page; this section reads only `skills` + `available`. */
const baseStatus: OkIntegrationsStatus = {
  available: true,
  editors: [],
  path: { shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: false },
  skills: [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      // The real frontmatter shape: a trigger prompt aimed at an agent, which is
      // exactly why the row renders `blurb` instead.
      description:
        'Read when the user asks what OpenKnowledge is, wants to install it on a repository. Do NOT load to perform OpenKnowledge reads/writes.',
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
      description:
        'Use when the user wants to create, author, write, or design a new Agent Skill (a SKILL.md).',
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
});

afterEach(() => {
  cleanup();
  toastError.mockClear();
  markSpy.mockClear();
  window.location.hash = '';
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('BuiltInSkillsSection', () => {
  test('renders one row per shipped bundle, installed state driving the control', async () => {
    installBridge();
    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-uninstall-discovery')).toBeTruthy();
    });
    // No checkbox: a single click never writes.
    expect(screen.queryByTestId('skills-studio-skill-checkbox-discovery')).toBeNull();
    expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
  });

  test('the row prints the human blurb, never the agent-facing frontmatter description', async () => {
    // The bug this section was moved to fix: `description` is trigger text for a
    // model — discovery's ends in a `Do NOT load` clause — so a settings row that
    // renders it hands the user a prompt written for something else.
    installBridge();
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('How to set up new projects with OpenKnowledge.')).toBeTruthy();
    });
    expect(screen.getByText('How to write a new skill and install it.')).toBeTruthy();
    expect(screen.queryByText(/Do NOT load/)).toBeNull();
  });

  test('a bundle the copy module does not know falls back to its description', async () => {
    // A newer main process shipping a bundle this build has no localized line
    // for must still render a row that says something.
    installBridge({
      status: {
        ...baseStatus,
        skills: [{ ...baseStatus.skills[1], id: 'future-bundle', name: 'open-knowledge-future' }],
      },
    });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/Use when the user wants to create/)).toBeTruthy();
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

  test('without the desktop bridge the section renders nothing, leaving the page usable', async () => {
    // Skills Studio also renders in the browser, where the folders block below
    // still works — a whole-page "desktop only" fallback would be a lie there.
    const { container } = renderSection();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-builtin-skills"]')).toBeNull();
    });
  });

  test('the block states that installing reaches every AI tool on the machine', async () => {
    // The old copy said "independent of the MCP connections you chose above",
    // which only parsed while this block sat under the MCP list. On Skills
    // Studio there is nothing above it, so the fact stands on its own.
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-builtin-skills')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-builtin-skills').textContent).toContain(
      'every AI tool on this machine',
    );
  });

  test('clicking the row body opens the built-in preview, which dismisses the settings surface', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getAllByTestId('skill-consent-row-preview').length).toBeGreaterThan(0);
    });
    // Settings is a hash-driven dialog (#settings); navigating to a preview hash
    // is exactly what dismisses it.
    window.location.hash = '#settings';

    await userEvent.click(screen.getAllByTestId('skill-consent-row-preview')[0]);

    expect(window.location.hash.startsWith('#/__skill-preview__/')).toBe(true);
    expect(window.location.hash).not.toBe('#settings');
  });

  test('Install opens a confirm modal naming the skill and its destinations; nothing writes until confirmed', async () => {
    const withCustomRoot: OkIntegrationsStatus = {
      ...baseStatus,
      skills: baseStatus.skills.map((s) =>
        s.id === 'write-skill'
          ? {
              ...s,
              paths: [
                '~/.agents/skills/open-knowledge-write-skill',
                '~/my-agent/skills/open-knowledge-write-skill',
              ],
              resolvedHosts: [
                { editor: 'claude', skillsRoot: '.claude/skills', custom: false },
                {
                  editor: '~/my-agent/skills',
                  skillsRoot: '~/my-agent/skills',
                  custom: true,
                },
              ],
            }
          : s,
      ),
    };
    const { setCalls } = installBridge({ status: withCustomRoot });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    });
    // No checkbox in the skills group any more — the control is an explicit button.
    expect(screen.queryByTestId('skills-studio-skill-checkbox-write-skill')).toBeNull();

    await userEvent.click(screen.getByTestId('skills-studio-skill-install-write-skill'));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Install open-knowledge-write-skill')).toBeTruthy();
    // Every destination is listed, including the declared custom root, verbatim.
    expect(within(dialog).getByText('~/.agents/skills/open-knowledge-write-skill')).toBeTruthy();
    expect(within(dialog).getByText('~/my-agent/skills/open-knowledge-write-skill')).toBeTruthy();
    // Nothing is written before the user confirms.
    expect(setCalls).toEqual([]);

    await userEvent.click(within(dialog).getByTestId('skill-confirm-primary'));
    await waitFor(() => {
      expect(setCalls).toEqual([
        { component: { kind: 'skill', id: 'write-skill' }, enabled: true },
      ]);
    });
  });

  test('a skill with zero resolved hosts disables Install and states the reason on the row', async () => {
    const noHosts: OkIntegrationsStatus = {
      ...baseStatus,
      skills: baseStatus.skills.map((s) =>
        s.id === 'write-skill' ? { ...s, resolvedHosts: [] } : s,
      ),
    };
    installBridge({ status: noHosts });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    });

    expect(
      screen.getByTestId('skills-studio-skill-install-write-skill').hasAttribute('disabled'),
    ).toBe(true);
    // The row states what would make it clickable (exactly the zero-host skill).
    expect(screen.getByTestId('skill-consent-row-no-hosts').textContent).toContain(
      'No AI tools detected',
    );
  });

  test('an install that fails for every host stays uninstalled and surfaces the failure', async () => {
    installBridge({
      setResult: () => ({
        ok: false as const,
        error: "Couldn't write ~/.claude/skills/open-knowledge-write-skill",
        status: baseStatus,
      }),
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('skills-studio-skill-install-write-skill'));
    await userEvent.click(await screen.findByTestId('skill-confirm-primary'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't write ~/.claude/skills/open-knowledge-write-skill",
      );
    });
    // No silent revert: the control still reads Install (uninstalled).
    expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    expect(screen.queryByTestId('skills-studio-skill-uninstall-write-skill')).toBeNull();
  });

  test('a confirmed install marks an event carrying the originating surface and host count', async () => {
    const { setCalls } = installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('skills-studio-skill-install-write-skill'));
    await userEvent.click(await screen.findByTestId('skill-confirm-primary'));
    await waitFor(() => {
      expect(setCalls.length).toBe(1);
    });

    expect(markSpy).toHaveBeenCalledWith(
      'ok/skill/install',
      expect.objectContaining({ surface: 'settings', mode: 'install', hostCount: 1 }),
    );
  });

  test('a partial install is treated as installed with the reach the fresh status reports', async () => {
    // Fresh snapshot after a partial install: write-skill now installed, its
    // reach reflecting only the host that actually took the copy.
    const landed: OkIntegrationsStatus = {
      ...baseStatus,
      skills: baseStatus.skills.map((s) =>
        s.id === 'write-skill'
          ? {
              ...s,
              installed: true,
              resolvedHosts: [{ editor: 'claude', skillsRoot: '.claude/skills', custom: false }],
            }
          : s,
      ),
    };
    installBridge({ setResult: () => ({ ok: true as const, status: landed }) });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('skills-studio-skill-install-write-skill'));
    await userEvent.click(await screen.findByTestId('skill-confirm-primary'));

    // The fresh status flips the control to Uninstall — treated as installed —
    // and no failure is surfaced.
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-uninstall-write-skill')).toBeTruthy();
    });
    expect(toastError).not.toHaveBeenCalled();
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
      // row underneath still installs.
      introSeen = false;
      const { setCalls } = installBridge();
      renderSection();
      await userEvent.click(await screen.findByTestId('skills-studio-intro-dismiss'));

      expect(setCalls).toEqual([]);
      expect(screen.getByTestId('skills-studio-skill-install-write-skill')).toBeTruthy();
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
  });

  test('uninstalling an installed skill confirms, then writes enabled: false', async () => {
    // This file covered Install in detail; the opposite direction of the shared
    // applyToggle was only covered in the sibling section.
    const { setCalls } = installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skills-studio-skill-uninstall-discovery')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('skills-studio-skill-uninstall-discovery'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Uninstall open-knowledge-discovery')).toBeTruthy();
    expect(setCalls).toEqual([]);

    await userEvent.click(within(dialog).getByTestId('skill-confirm-primary'));
    await waitFor(() => {
      expect(setCalls).toEqual([{ component: { kind: 'skill', id: 'discovery' }, enabled: false }]);
    });
  });
});
