import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
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

const { AiToolsSection } = await import('./AiToolsSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

/** Production mounts under the app-level TooltipProvider (main.tsx). */
function renderSection() {
  return render(
    <TooltipProvider>
      <AiToolsSection />
    </TooltipProvider>,
  );
}

const baseStatus: OkIntegrationsStatus = {
  available: true,
  editors: [
    {
      id: 'claude',
      label: 'Claude',
      detected: true,
      state: 'installed',
      configPath: '~/.claude.json',
      entryLocator: 'mcpServers.open-knowledge',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: false,
      state: 'not-installed',
      configPath: '~/.cursor/mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
    },
    {
      id: 'codex',
      label: 'Codex',
      detected: true,
      state: 'foreign',
      configPath: '~/.codex/config.toml',
      entryLocator: '[mcp_servers.open-knowledge]',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      detected: false,
      state: 'unmanageable',
      configPath: null,
      entryLocator: 'mcp.open-knowledge',
    },
  ],
  path: { shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: false },
  skills: [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      description: 'Helps your agent recognize OpenKnowledge projects.',
      installed: true,
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
      description: 'Adds a guided workflow for authoring new Agent Skills.',
      installed: false,
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

/** Open the MCP-connections fold. Rows that are neither configured nor detected
 *  sit below it now, so a test asserting on one has to expand first. */
async function expandEditors(): Promise<void> {
  await userEvent.click(await screen.findByTestId('ai-tools-editors-show-more'));
}

afterEach(() => {
  cleanup();
  toastError.mockClear();
  markSpy.mockClear();
  window.location.hash = '';
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('AiToolsSection', () => {
  test('renders the three component groups from the status snapshot', async () => {
    installBridge();
    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-path-checkbox')).toBeTruthy();
    });
    // PATH row: not installed → names the rc file a grant would touch.
    expect(screen.getByTestId('ai-tools-path-status').textContent).toContain('~/.zshrc');

    // Editors: checked reflects installed/foreign, per-state status copy.
    expect(screen.getByTestId('ai-tools-editor-checkbox-claude').getAttribute('data-state')).toBe(
      'checked',
    );
    // Cursor is neither configured nor detected, so it starts below the fold.
    expect(screen.queryByTestId('ai-tools-editor-checkbox-cursor')).toBeNull();
    await expandEditors();
    expect(screen.getByTestId('ai-tools-editor-checkbox-cursor').getAttribute('data-state')).toBe(
      'unchecked',
    );
    expect(screen.getByTestId('ai-tools-editor-checkbox-codex').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByTestId('ai-tools-editor-status-codex').textContent).toContain(
      'not managed by OpenKnowledge',
    );
    // Undetected, never-configured tools link to their setup guide instead of
    // a dead-end "Not detected" — same contract as the first-launch dialog.
    const cursorLink = screen.getByTestId('ai-tools-editor-status-cursor');
    expect(cursorLink.tagName).toBe('A');
    expect(cursorLink.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/integrations/cursor',
    );
    // Unmanageable rows render disabled and keep their status text (no link).
    expect(screen.getByTestId('ai-tools-editor-checkbox-opencode').hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByTestId('ai-tools-editor-status-opencode').tagName).toBe('SPAN');

    // Skills: no checkbox — installed drives an Uninstall button, uninstalled an
    // Install button. The row shows the skill's own frontmatter description.
    expect(screen.queryByTestId('ai-tools-skill-checkbox-discovery')).toBeNull();
    expect(screen.getByTestId('ai-tools-skill-uninstall-discovery')).toBeTruthy();
    expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    expect(screen.getByText('Adds a guided workflow for authoring new Agent Skills.')).toBeTruthy();
  });

  test('detection orders a row but never claims presence on it', async () => {
    // One rule across the agent lists: the probe may pick a row's position, and
    // on the external-apps group its default, but no row prints an assertion of
    // presence. The signal answers "is this tool on the machine", not "is it set
    // up with us", so ranking is all it earns — the row still reads
    // "How to set up", never "Detected on this machine".
    const detectedButUnwired: OkIntegrationsStatus = {
      ...baseStatus,
      editors: baseStatus.editors.map((e) =>
        e.id === 'cursor' ? { ...e, detected: true, state: 'not-installed' as const } : e,
      ),
    };
    installBridge({ status: detectedButUnwired });
    renderSection();

    // Ordered up: above the fold without expanding.
    await screen.findByTestId('ai-tools-editor-checkbox-cursor');
    expect(screen.queryByTestId('ai-tools-editors-show-more')).toBeNull();

    // But making no claim.
    const status = screen.getByTestId('ai-tools-editor-status-cursor');
    expect(status.textContent).not.toContain('Detected on this machine');
    expect(status.textContent).toContain('How to set up');
  });

  test('clicking a checkbox sends the matching install/uninstall and re-renders from the result', async () => {
    const flipped: OkIntegrationsStatus = {
      ...baseStatus,
      editors: baseStatus.editors.map((e) =>
        e.id === 'cursor' ? { ...e, state: 'installed' as const } : e,
      ),
    };
    const { setCalls } = installBridge({
      setResult: () => ({ ok: true as const, status: flipped }),
    });
    renderSection();
    // Cursor is neither configured nor detected in the fixture, so reaching its
    // checkbox means opening the fold first.
    await expandEditors();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-editor-checkbox-cursor')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-editor-checkbox-cursor'));
    await waitFor(() => {
      expect(setCalls).toEqual([{ component: { kind: 'editor', id: 'cursor' }, enabled: true }]);
    });
    // The fresh snapshot from the result drives the re-render.
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-editor-checkbox-cursor').getAttribute('data-state')).toBe(
        'checked',
      );
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  test('unchecking an installed component sends enabled: false', async () => {
    const { setCalls } = installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-editor-checkbox-claude')).toBeTruthy();
    });

    // Claude is installed → unchecking it removes the MCP entry. (Skill
    // uninstall is the Install/Uninstall button flow, covered separately.)
    await userEvent.click(screen.getByTestId('ai-tools-editor-checkbox-claude'));
    await waitFor(() => {
      expect(setCalls).toEqual([{ component: { kind: 'editor', id: 'claude' }, enabled: false }]);
    });
  });

  test('a refused toggle surfaces the main-process error as a toast and keeps the truthful state', async () => {
    installBridge({
      setResult: () => ({
        ok: false as const,
        error: 'left unchanged',
        status: baseStatus,
      }),
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-editor-checkbox-codex')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-editor-checkbox-codex'));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('left unchanged');
    });
    // Status snapshot from the refused result still applies — checkbox stays checked.
    expect(screen.getByTestId('ai-tools-editor-checkbox-codex').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  test('available: false renders the read-only note and disables every checkbox', async () => {
    installBridge({ status: { ...baseStatus, available: false } });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-read-only')).toBeTruthy();
    });
    expect(screen.getByTestId('ai-tools-path-checkbox').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('ai-tools-editor-checkbox-claude').hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByTestId('ai-tools-skill-uninstall-discovery').hasAttribute('disabled')).toBe(
      true,
    );
  });

  test('without the desktop bridge the section explains itself instead of crashing', () => {
    renderSection();
    expect(screen.getByTestId('ai-tools-unavailable')).toBeTruthy();
  });

  test('the row info tooltip discloses the exact file and entry the checkbox touches', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-editor-info-claude')).toBeTruthy();
    });

    // Radix tooltips open on trigger focus (keyboard path — also the stable
    // one under happy-dom). Content portals to the body.
    screen.getByTestId('ai-tools-editor-info-claude').focus();
    const paths = await screen.findAllByText('~/.claude.json');
    expect(paths.length).toBeGreaterThan(0);
    const locators = await screen.findAllByText('mcpServers.open-knowledge');
    expect(locators.length).toBeGreaterThan(0);
  });

  test('the skills group states that skill reach is independent of the MCP selection', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-skill-fanout-note')).toBeTruthy();
    });
    expect(screen.getByTestId('ai-tools-skill-fanout-note').textContent).toContain(
      'independent of the MCP connections',
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
      expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    });
    // No checkbox in the skills group any more — the control is an explicit button.
    expect(screen.queryByTestId('ai-tools-skill-checkbox-write-skill')).toBeNull();

    await userEvent.click(screen.getByTestId('ai-tools-skill-install-write-skill'));

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
      expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    });

    expect(screen.getByTestId('ai-tools-skill-install-write-skill').hasAttribute('disabled')).toBe(
      true,
    );
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
      expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-skill-install-write-skill'));
    await userEvent.click(await screen.findByTestId('skill-confirm-primary'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't write ~/.claude/skills/open-knowledge-write-skill",
      );
    });
    // No silent revert: the control still reads Install (uninstalled).
    expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    expect(screen.queryByTestId('ai-tools-skill-uninstall-write-skill')).toBeNull();
  });

  test('a confirmed install marks an event carrying the originating surface and host count', async () => {
    const { setCalls } = installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-skill-install-write-skill'));
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
      expect(screen.getByTestId('ai-tools-skill-install-write-skill')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-skill-install-write-skill'));
    await userEvent.click(await screen.findByTestId('skill-confirm-primary'));

    // The fresh status flips the control to Uninstall — treated as installed —
    // and no failure is surfaced.
    await waitFor(() => {
      expect(screen.getByTestId('ai-tools-skill-uninstall-write-skill')).toBeTruthy();
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});
