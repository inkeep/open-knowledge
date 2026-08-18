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

const { ProjectSkillSection } = await import('./ProjectSkillSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderSection() {
  return render(
    <TooltipProvider>
      <ProjectSkillSection />
    </TooltipProvider>,
  );
}

/** `editors` is required by the status contract but belongs to the AI tools
 *  page; this section reads only `skill`, `hasProject` and `available`. */
const baseStatus: OkProjectIntegrationsStatus = {
  available: true,
  hasProject: true,
  projectDir: '~/proj',
  editors: [],
  skill: {
    installed: true,
    paths: ['.claude/skills/open-knowledge/SKILL.md', '.codex/skills/open-knowledge/SKILL.md'],
    description:
      'Authoritative agent-runtime contract for working inside an OpenKnowledge project — a markdown-CRDT knowledge base exposed over MCP.',
    hosts: ['claude', 'codex'],
    size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
    sourceDir: '/bundled/project',
  },
};

/** Non-null narrowing once, so the tests below don't each assert it. */
const uninstallableSkill = baseStatus.skill ?? {
  installed: false,
  paths: [],
  description: '',
  blurb: '',
  hosts: [],
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

describe('ProjectSkillSection', () => {
  test('renders the project skill row with its human blurb, not the frontmatter description', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-uninstall')).toBeTruthy();
    });
    expect(screen.getByText('How to use OpenKnowledge and its MCP tools.')).toBeTruthy();
    expect(screen.queryByText(/markdown-CRDT knowledge base/)).toBeNull();
  });

  test('leads with what the skill is for, then that it is committed to the repo', async () => {
    installBridge();
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    const block = screen.getByTestId('settings-project-skill').textContent ?? '';
    // Same provenance heading as the user-scope block — both are skills OK
    // ships, so the heading must not split them across two axes.
    expect(block).toContain('Skills from OpenKnowledge');
    expect(block).toContain('how to work with OpenKnowledge');
    expect(block).toContain('everyone who opens the project');
  });

  test('no project open → renders nothing, leaving the folders block below', async () => {
    installBridge({
      status: { available: true, hasProject: false, projectDir: null, editors: [], skill: null },
    });
    const { container } = renderSection();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-project-skill"]')).toBeNull();
    });
  });

  test('an uninstalled skill with no capable editor disables Install', async () => {
    installBridge({
      status: {
        ...baseStatus,
        skill: { ...uninstallableSkill, installed: false, hosts: [] },
      },
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-install')).toBeTruthy();
    });
    expect(screen.getByTestId('project-skill-install').hasAttribute('disabled')).toBe(true);
  });

  test('read-only build disables the control', async () => {
    installBridge({ status: { ...baseStatus, available: false } });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-uninstall')).toBeTruthy();
    });
    expect(screen.getByTestId('project-skill-uninstall').hasAttribute('disabled')).toBe(true);
  });

  test('the skill row confirms before uninstalling, then fans out via one component ref', async () => {
    const { setCalls } = installBridge();
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-uninstall')).toBeTruthy();
    });

    // The control alone writes nothing — it opens the consent screen. This is
    // the whole point of the change: the project skill lands in the repo for
    // everyone, so it must not move on a single click.
    await user.click(screen.getByTestId('project-skill-uninstall'));
    expect(setCalls.length).toBe(0);

    // The confirm names every project-relative destination before acting.
    const destinations = await screen.findByTestId('skill-destination-list');
    expect(destinations.textContent).toContain('.claude/skills/open-knowledge/SKILL.md');
    expect(destinations.textContent).toContain('.codex/skills/open-knowledge/SKILL.md');

    await user.click(screen.getByTestId('skill-confirm-primary'));
    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'skill' }, enabled: false });
  });

  test('a refused uninstall surfaces the error and leaves the control truthful', async () => {
    // The spy was wired but never asserted: if the `!result.ok` branch is
    // inverted or the catch is dropped, a failed write goes silent and the row
    // still reads as though it worked.
    installBridge({
      setResult: () => ({
        ok: false as const,
        error: 'read-only project — left unchanged',
        status: baseStatus,
      }),
    });
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-uninstall')).toBeTruthy();
    });

    await user.click(screen.getByTestId('project-skill-uninstall'));
    await user.click(await screen.findByTestId('skill-confirm-primary'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('read-only project — left unchanged'),
    );
    // No silent flip: the skill is still installed, so the control still offers
    // Uninstall.
    expect(screen.getByTestId('project-skill-uninstall')).toBeTruthy();
    expect(screen.queryByTestId('project-skill-install')).toBeNull();
  });

  test('installing an absent project skill confirms, then writes enabled: true', async () => {
    // The sibling covers Install and this file covered only Uninstall, so the
    // enabled:true direction of the shared applyToggle was unverified here.
    const { setCalls } = installBridge({
      status: { ...baseStatus, skill: { ...uninstallableSkill, installed: false } },
    });
    renderSection();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-install')).toBeTruthy();
    });

    await user.click(screen.getByTestId('project-skill-install'));
    expect(setCalls.length).toBe(0);
    await user.click(await screen.findByTestId('skill-confirm-primary'));

    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'skill' }, enabled: true });
  });
});
