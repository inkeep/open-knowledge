import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  OkProjectIntegrationsSetRequest,
  OkProjectIntegrationsSetResult,
  OkProjectIntegrationsStatus,
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
      detected: true,
      state: 'installed',
      configPath: '.mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
      followUp: 'approve-once',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: false,
      state: 'not-installed',
      configPath: '.cursor/mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
      followUp: 'enable-manually',
    },
    {
      id: 'codex',
      label: 'Codex',
      detected: true,
      state: 'foreign',
      configPath: '.codex/config.toml',
      entryLocator: '[mcp_servers.open-knowledge]',
      followUp: 'auto-connect',
    },
  ],
  skill: {
    installed: true,
    paths: ['.claude/skills/open-knowledge/SKILL.md', '.codex/skills/open-knowledge/SKILL.md'],
    description:
      'Authoritative agent-runtime contract for working inside an OpenKnowledge project — a markdown-CRDT knowledge base exposed over MCP.',
    blurb: 'How to use OpenKnowledge and its MCP tools.',
    hosts: ['claude', 'codex'],
    size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
    sourceDir: '/bundled/project',
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

async function expandEditors(): Promise<void> {
  await userEvent.click(await screen.findByTestId('project-ai-tools-editors-show-more'));
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

  test('renders each project MCP row, and points at where the skill went', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-claude')).toBeTruthy();
    });
    expect(screen.queryByTestId('project-ai-tools-editor-checkbox-cursor')).toBeNull();
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-codex')).toBeTruthy();
    await expandEditors();
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-cursor')).toBeTruthy();
    expect(screen.queryByTestId('project-ai-tools-skill-uninstall')).toBeNull();
    expect(screen.getByTestId('project-ai-tools-skills-moved').textContent).toContain(
      'Skills Studio',
    );
  });

  test('installed/foreign rows are checked; not-installed rows are not', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-ai-tools-editor-checkbox-claude')).toBeTruthy();
    });
    expect(
      screen.getByTestId('project-ai-tools-editor-checkbox-claude').getAttribute('aria-checked'),
    ).toBe('true');
    await expandEditors();
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
    expect(screen.getByTestId('project-ai-tools-editor-followup-codex')).toBeTruthy();
    await expandEditors();
    expect(screen.queryByTestId('project-ai-tools-editor-followup-cursor')).toBeNull();
  });

  test('checking a not-installed editor calls setComponent(install)', async () => {
    const { setCalls } = installBridge();
    renderSection();
    const user = userEvent.setup();
    await expandEditors();
    await user.click(screen.getByTestId('project-ai-tools-editor-checkbox-cursor'));
    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'editor', id: 'cursor' }, enabled: true });
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
    await expandEditors();
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
  });

  test('detection keeps an unwired editor above the fold without claiming presence', async () => {
    installBridge({
      status: {
        ...baseStatus,
        editors: baseStatus.editors.map((editor) =>
          editor.id === 'cursor' ? { ...editor, detected: true } : editor,
        ),
      },
    });
    renderSection();

    await screen.findByTestId('project-ai-tools-editor-checkbox-cursor');
    expect(screen.queryByTestId('project-ai-tools-editors-show-more')).toBeNull();
    expect(document.body.textContent).not.toContain('Detected on this machine');
  });

  test('the editor disclosure expands and collapses the hidden rows', async () => {
    installBridge();
    renderSection();

    const disclosure = await screen.findByTestId('project-ai-tools-editors-show-more');
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('project-ai-tools-editor-checkbox-cursor')).toBeNull();

    const user = userEvent.setup();
    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-cursor')).toBeTruthy();

    await user.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('project-ai-tools-editor-checkbox-cursor')).toBeNull();
  });

  test('shows the full list when nothing is configured or detected', async () => {
    installBridge({
      status: {
        ...baseStatus,
        editors: baseStatus.editors.map((editor) => ({
          ...editor,
          detected: false,
          state: 'not-installed' as const,
        })),
      },
    });
    renderSection();

    await screen.findByTestId('project-ai-tools-editor-checkbox-cursor');
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-claude')).toBeTruthy();
    expect(screen.getByTestId('project-ai-tools-editor-checkbox-codex')).toBeTruthy();
    expect(screen.queryByTestId('project-ai-tools-editors-show-more')).toBeNull();
  });
});
