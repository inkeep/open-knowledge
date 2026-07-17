import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type {
  OkIntegrationsSetRequest,
  OkIntegrationsSetResult,
  OkIntegrationsStatus,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// Sonner is loaded by the SUT — stub to mute its real toaster.
const toastError = mock(() => {});
mock.module('sonner', () => ({
  toast: { error: toastError, info: mock(() => {}), success: mock(() => {}) },
}));

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
      installed: true,
      paths: [
        '~/.agents/skills/open-knowledge-discovery',
        '~/.claude/skills/open-knowledge-discovery',
      ],
    },
    {
      id: 'write-skill',
      name: 'open-knowledge-write-skill',
      installed: false,
      paths: ['~/.agents/skills/open-knowledge-write-skill'],
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

afterEach(() => {
  cleanup();
  toastError.mockClear();
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

    // Skills: installed state drives the checkbox.
    expect(screen.getByTestId('ai-tools-skill-checkbox-discovery').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(
      screen.getByTestId('ai-tools-skill-checkbox-write-skill').getAttribute('data-state'),
    ).toBe('unchecked');
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
      expect(screen.getByTestId('ai-tools-skill-checkbox-discovery')).toBeTruthy();
    });

    await userEvent.click(screen.getByTestId('ai-tools-skill-checkbox-discovery'));
    await waitFor(() => {
      expect(setCalls).toEqual([{ component: { kind: 'skill', id: 'discovery' }, enabled: false }]);
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
    expect(screen.getByTestId('ai-tools-skill-checkbox-discovery').hasAttribute('disabled')).toBe(
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
