import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  ptyAvailable?: boolean;
}

function installBridge({ status = baseStatus, setResult, ptyAvailable = true }: HarnessOpts = {}) {
  const setCalls: OkIntegrationsSetRequest[] = [];
  const bridge = {
    config: { ptyAvailable },
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
  test('renders the two component groups from the status snapshot', async () => {
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

    // Skills are NOT here any more — they live in Skills Studio, and
    // this page says so rather than leaving the reader to find out.
    expect(screen.queryByTestId('ai-tools-skill-uninstall-discovery')).toBeNull();
    expect(screen.queryByTestId('skills-studio-skill-install-write-skill')).toBeNull();
    expect(screen.getByTestId('ai-tools-skills-moved').textContent).toContain('Skills Studio');
  });

  test('does not promise the built-in terminal when PTY support is unavailable', async () => {
    installBridge({
      ptyAvailable: false,
      status: { ...baseStatus, path: { ...baseStatus.path, installed: true } },
    });
    renderSection();

    const status = await screen.findByTestId('ai-tools-path-status');
    expect(status.textContent).toContain('your AI tools keep working');
    expect(status.textContent).not.toContain('built-in terminal');
  });

  test('promises the built-in terminal when PTY support is available', async () => {
    installBridge({
      status: { ...baseStatus, path: { ...baseStatus.path, installed: true } },
    });
    renderSection();

    const status = await screen.findByTestId('ai-tools-path-status');
    expect(status.textContent).toContain('built-in terminal');
    expect(status.textContent).not.toContain('your AI tools keep working');
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

  test('the editor disclosure exposes its expand and collapse state', async () => {
    installBridge();
    renderSection();

    const disclosure = await screen.findByTestId('ai-tools-editors-show-more');
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    const user = userEvent.setup();
    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('ai-tools-editor-checkbox-cursor')).toBeTruthy();

    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('ai-tools-editor-checkbox-cursor')).toBeNull();
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
});
