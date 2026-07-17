import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type {
  OkProjectIntegrationsSetRequest,
  OkProjectIntegrationsSetResult,
  OkProjectIntegrationsStatus,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastError = mock(() => {});
mock.module('sonner', () => ({
  toast: { error: toastError, info: mock(() => {}), success: mock(() => {}) },
}));

const { ProjectAiToolsSection } = await import('./ProjectAiToolsSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderSection() {
  return render(
    <TooltipProvider>
      <ProjectAiToolsSection />
    </TooltipProvider>,
  );
}

const baseStatus: OkProjectIntegrationsStatus = {
  available: true,
  hasProject: true,
  projectDir: '~/proj',
  editors: [
    {
      id: 'claude',
      label: 'Claude Code',
      state: 'installed',
      configPath: '.mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
      followUp: 'approve-once',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      state: 'not-installed',
      configPath: '.cursor/mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
      followUp: 'enable-manually',
    },
    {
      id: 'codex',
      label: 'Codex',
      state: 'foreign',
      configPath: '.codex/config.toml',
      entryLocator: '[mcp_servers.open-knowledge]',
      followUp: 'auto-connect',
    },
  ],
  skill: {
    installed: true,
    paths: ['.claude/skills/open-knowledge/SKILL.md', '.codex/skills/open-knowledge/SKILL.md'],
  },
};

interface HarnessOpts {
  status?: OkProjectIntegrationsStatus;
  setResult?: (request: OkProjectIntegrationsSetRequest) => OkProjectIntegrationsSetResult;
}

function installBridge({ status = baseStatus, setResult }: HarnessOpts = {}) {
  const setCalls: OkProjectIntegrationsSetRequest[] = [];
  const bridge = {
    projectIntegrations: {
      status: async () => status,
      setComponent: async (request: OkProjectIntegrationsSetRequest) => {
        setCalls.push(request);
        return setResult ? setResult(request) : { ok: true as const, status };
      },
    },
  };
  Object.defineProperty(window, 'okDesktop', { value: bridge, configurable: true, writable: true });
  return { setCalls };
}

afterEach(() => {
  cleanup();
  toastError.mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('ProjectAiToolsSection', () => {
  test('renders the desktop-only fallback when no bridge is present', () => {
    renderSection();
    expect(screen.getByTestId('project-ai-tools-unavailable')).toBeTruthy();
  });

  test('shows the unavailable fallback (not a stuck skeleton) when the status fetch rejects', async () => {
    // A rejecting status() must land on the loadFailed branch, not hang in the
    // loading skeleton — otherwise the section silently dead-ends with no signal.
    const bridge = {
      projectIntegrations: {
        status: async () => {
          throw new Error('IPC error');
        },
        setComponent: async () => ({ ok: true as const, status: baseStatus }),
      },
    };
    Object.defineProperty(window, 'okDesktop', {
      value: bridge,
      configurable: true,
      writable: true,
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-unavailable')).toBeTruthy();
    });
    expect(screen.queryByTestId('project-ai-tools-loading')).toBeNull();
  });

  test('renders each project MCP row + the single skill row', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-claude')).toBeTruthy();
    });
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-cursor')).toBeTruthy();
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-codex')).toBeTruthy();
    expect(screen.getByTestId('project-ai-tools-skill-checkbox')).toBeTruthy();
  });

  test('installed/foreign rows are checked; not-installed rows are not', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-claude')).toBeTruthy();
    });
    // Radix Checkbox reflects state via aria-checked.
    expect(
      screen.getByTestId('project-ai-tools-editor-checkbox-claude').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByTestId('project-ai-tools-editor-checkbox-cursor').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByTestId('project-ai-tools-editor-checkbox-codex').getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('shows the per-editor follow-up hint on installed/foreign rows only', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-followup-claude')).toBeTruthy();
    });
    // Foreign row (checked) also carries its follow-up.
    expect(screen.getByTestId('project-ai-tools-editor-followup-codex')).toBeTruthy();
    // not-installed cursor row has no follow-up yet.
    expect(screen.queryByTestId('project-ai-tools-editor-followup-cursor')).toBeNull();
  });

  test('checking a not-installed editor calls setComponent(install)', async () => {
    const { setCalls } = installBridge();
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-cursor')).toBeTruthy();
    });
    await user.click(screen.getByTestId('project-ai-tools-editor-checkbox-cursor'));
    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'editor', id: 'cursor' }, enabled: true });
  });

  test('toggling the skill row fans out via a single skill component ref', async () => {
    const { setCalls } = installBridge();
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-skill-checkbox')).toBeTruthy();
    });
    // Installed → unchecking uninstalls.
    await user.click(screen.getByTestId('project-ai-tools-skill-checkbox'));
    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'skill' }, enabled: false });
  });

  test('a refused toggle surfaces the error as a toast', async () => {
    installBridge({
      setResult: () => ({
        ok: false as const,
        error: 'guest config — left unchanged',
        status: baseStatus,
      }),
    });
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-cursor')).toBeTruthy();
    });
    await user.click(screen.getByTestId('project-ai-tools-editor-checkbox-cursor'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('guest config — left unchanged'));
  });

  test('no project open → empty state, no rows', async () => {
    installBridge({
      status: { available: true, hasProject: false, projectDir: null, editors: [], skill: null },
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-no-project')).toBeTruthy();
    });
    expect(screen.queryByTestId('project-ai-tools-skill-checkbox')).toBeNull();
  });

  test('read-only build shows the banner and disables the checkboxes', async () => {
    installBridge({ status: { ...baseStatus, available: false } });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-read-only')).toBeTruthy();
    });
    expect(
      screen.getByTestId('project-ai-tools-skill-checkbox').getAttribute('data-disabled'),
    ).not.toBeNull();
  });
});
