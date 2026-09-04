import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkMcpWiringResult, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import type { McpConsentStore } from '@/lib/mcp-consent-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { ToastImpl } from './McpConsentDialogBody';

const themeState = {
  theme: 'system' as string,
  resolvedTheme: 'dark' as string,
  setTheme: vi.fn<(next: string) => void>(),
};

vi.doMock('next-themes', () => ({
  useTheme: () => ({
    theme: themeState.theme,
    resolvedTheme: themeState.resolvedTheme,
    setTheme: themeState.setTheme,
  }),
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const DISCOVERY_SKILL = {
  id: 'discovery',
  name: 'open-knowledge-discovery',
  paths: ['~/.agents/skills/open-knowledge-discovery', '~/.claude/skills/open-knowledge-discovery'],
};

const payload: OkMcpWiringShowPayload = {
  origin: 'first-run',
  detectedEditors: [
    {
      id: 'claude',
      label: 'Claude',
      detected: true,
      willReplace: true,
      configPath: '~/.claude.json',
      entryLocator: 'mcpServers.open-knowledge',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: true,
      willReplace: false,
      configPath: '~/.cursor/mcp.json',
      entryLocator: 'mcpServers.open-knowledge',
    },
    {
      id: 'codex',
      label: 'Codex',
      detected: false,
      willReplace: false,
      configPath: '~/.codex/config.toml',
      entryLocator: '[mcp_servers.open-knowledge]',
    },
  ],
  pathInstall: {
    shellDetected: true,
    rcFilesToTouch: ['~/.zshrc', '~/.config/fish/conf.d/open-knowledge.fish'],
    alreadyInstalled: false,
  },
  globalSkills: [DISCOVERY_SKILL],
};

const noneDetectedPayload: OkMcpWiringShowPayload = {
  origin: 'first-run',
  detectedEditors: [
    {
      id: 'codex',
      label: 'Codex',
      detected: false,
      willReplace: false,
      configPath: '~/.codex/config.toml',
      entryLocator: '[mcp_servers.open-knowledge]',
    },
  ],
  pathInstall: payload.pathInstall,
  globalSkills: [{ ...DISCOVERY_SKILL, paths: [] }],
};

function deferredResult() {
  let resolve!: (result: OkMcpWiringResult) => void;
  const promise = new Promise<OkMcpWiringResult>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

interface RecordedConfirm {
  editorIds: readonly string[];
  pathInstall: boolean | undefined;
  skills: readonly string[] | undefined;
}

function makeHarness({
  confirmResult = async () => ({ ok: true as const }),
  skipResult = async () => ({ ok: true as const }),
  snapshot = payload,
  userBinding,
}: {
  confirmResult?: (editorIds: readonly string[]) => Promise<OkMcpWiringResult>;
  skipResult?: () => Promise<OkMcpWiringResult>;
  snapshot?: OkMcpWiringShowPayload;
  userBinding?: { patch: (patch: unknown) => unknown } | null;
} = {}) {
  const confirmCalls: RecordedConfirm[] = [];
  const skipCalls: string[] = [];
  const dismissCalls: string[] = [];
  const toastErrors: string[] = [];
  const toastMessages: string[] = [];
  const store: McpConsentStore = {
    confirm: async (request) => {
      confirmCalls.push({
        editorIds: [...request.editorIds],
        pathInstall: request.pathInstall,
        skills: request.skills ? [...request.skills] : request.skills,
      });
      return confirmResult(request.editorIds);
    },
    dismiss: () => {
      dismissCalls.push('dismiss');
    },
    getSnapshot: () => snapshot,
    install: () => undefined,
    skip: async () => {
      skipCalls.push('skip');
      return skipResult();
    },
    subscribe: () => () => {},
  };
  const toast: ToastImpl = {
    error: (message) => toastErrors.push(message),
    message: (message) => toastMessages.push(message),
  };
  return {
    confirmCalls,
    skipCalls,
    dismissCalls,
    store,
    toast,
    toastErrors,
    toastMessages,
    snapshot,
    userBinding,
  };
}

function allReplacingHarness() {
  return makeHarness({
    snapshot: {
      ...payload,
      detectedEditors: payload.detectedEditors.map((e) => ({ ...e, willReplace: e.detected })),
    },
  });
}

async function renderDialog(harness = makeHarness()) {
  const { McpConsentDialogBody } = await import('./McpConsentDialogBody');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { ConfigContext } = await import('@/lib/config-context');
  const body = (
    <TooltipProvider>
      <McpConsentDialogBody
        payload={harness.snapshot}
        store={harness.store}
        toast={harness.toast}
      />
    </TooltipProvider>
  );
  render(
    harness.userBinding === undefined ? (
      body
    ) : (
      <ConfigContext.Provider value={{ userBinding: harness.userBinding } as never}>
        {body}
      </ConfigContext.Provider>
    ),
  );
  return harness;
}

describe('McpConsentDialog AI-tools decision', () => {
  afterEach(() => cleanup());

  test('the MCP row names every tool in the write set without opening anything', async () => {
    await renderDialog();

    const row = screen.getByTestId('mcp-consent-connect-checkbox').closest('label');
    const text = row?.textContent ?? '';
    expect(text).toContain('Claude');
    expect(text).toContain('Cursor');
    expect(text).not.toContain('Codex');
  });

  test('both AI-tool rows start checked', async () => {
    await renderDialog();

    expect(screen.getByRole('alertdialog', { name: /Let's get set up/ })).toBeTruthy();
    expect(screen.getByTestId('mcp-consent-connect-checkbox').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('mcp-consent-skill-checkbox').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test('consent integrity: the overwrite warning shows without expanding anything', async () => {
    await renderDialog();

    expect(screen.queryByTestId('mcp-consent-connect-details')).toBeNull();
    const warning = screen.getByTestId('mcp-consent-connect-replace-warning').textContent ?? '';
    expect(warning).toContain('Claude');
    expect(warning).not.toContain('Cursor');
  });

  test('when every tool is a replacement, the warning does not repeat the list', async () => {
    await renderDialog(allReplacingHarness());

    const warning = screen.getByTestId('mcp-consent-connect-replace-warning').textContent ?? '';
    expect(warning).not.toContain('Claude');
    expect(warning).not.toContain('Cursor');
    const row = screen.getByTestId('mcp-consent-connect-checkbox').closest('label');
    expect(row?.textContent ?? '').toContain('Claude');
  });

  test('a partial replacement still names its subset', async () => {
    await renderDialog();

    const warning = screen.getByTestId('mcp-consent-connect-replace-warning').textContent ?? '';
    expect(warning).toContain('Claude');
    expect(warning).not.toContain('Cursor');
  });

  test('toggling the row changes only the warning, never the subtext', async () => {
    await renderDialog(allReplacingHarness());
    const row = () => screen.getByTestId('mcp-consent-connect-checkbox').closest('label');
    const subtextOf = (el: Element | null | undefined) =>
      [...(el?.querySelectorAll('span') ?? [])]
        .map((n) => n.textContent ?? '')
        .find((text) => text.startsWith('Adds an OpenKnowledge MCP entry to'));

    const before = subtextOf(row());
    expect(before).toBeTruthy();

    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));

    expect(screen.queryByTestId('mcp-consent-connect-replace-warning')).toBeNull();
    expect(subtextOf(row())).toBe(before);
  });

  test('no overwrite warning when nothing will be replaced', async () => {
    await renderDialog(
      makeHarness({
        snapshot: {
          ...payload,
          detectedEditors: payload.detectedEditors.map((e) => ({ ...e, willReplace: false })),
        },
      }),
    );
    expect(screen.queryByTestId('mcp-consent-connect-replace-warning')).toBeNull();
  });

  test("each row's disclosure names the exact files that row writes", async () => {
    await renderDialog();

    expect(screen.queryByTestId('mcp-consent-connect-details')).toBeNull();
    await userEvent.click(screen.getByTestId('mcp-consent-connect-info'));
    const mcpDetails = await screen.findByTestId('mcp-consent-connect-details');
    const mcpText = mcpDetails.textContent ?? '';
    expect(mcpText).toContain('Claude');
    expect(mcpText).toContain('~/.claude.json');
    expect(mcpText).toContain('~/.cursor/mcp.json');
    expect(mcpText).not.toContain('Codex');

    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByTestId('mcp-consent-skill-info'));
    const skillDetails = await screen.findByTestId('mcp-consent-skill-details');
    const skillText = skillDetails.textContent ?? '';
    expect(skillText).toContain('~/.agents/skills/open-knowledge-discovery');
    expect(skillText).toContain('~/.claude/skills/open-knowledge-discovery');
  });

  test('opening a disclosure does not toggle the row it sits in', async () => {
    await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-connect-info'));

    expect(screen.getByTestId('mcp-consent-connect-checkbox').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test("the null-configPath fallback renders in the row's disclosure", async () => {
    await renderDialog(
      makeHarness({
        snapshot: {
          detectedEditors: [
            {
              id: 'claude-desktop',
              label: 'Claude Desktop',
              detected: true,
              willReplace: false,
              configPath: null,
              entryLocator: 'mcpServers.open-knowledge',
            },
          ],
          pathInstall: { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false },
          globalSkills: [],
        },
      }),
    );

    await userEvent.click(screen.getByTestId('mcp-consent-connect-info'));
    const details = await screen.findByTestId('mcp-consent-connect-details');
    expect(details.textContent).toContain('unavailable on this platform');
  });

  test('Continue sends every detected tool plus the offered skill bundles', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: true, skills: ['discovery'] },
      ]);
    });
  });

  test('unchecking sends no editors AND no skill decision — declining never removes', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: [], pathInstall: true, skills: undefined },
      ]);
    });
    expect(harness.toastMessages).toEqual(['This can be configured in Settings > AI tools & CLI']);
  });

  test('connecting does not fire the Settings pointer toast', async () => {
    const harness = await renderDialog();
    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls.length).toBe(1);
    });
    expect(harness.toastMessages).toEqual([]);
  });

  test('no skills offered: no skill row, and confirm sends no skill decision', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: { ...payload, globalSkills: [] } }));

    expect(screen.queryByTestId('mcp-consent-skill-checkbox')).toBeNull();

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: true, skills: undefined },
      ]);
    });
  });

  test('the overwrite warning disappears when the box is unchecked', async () => {
    await renderDialog();
    expect(screen.getByTestId('mcp-consent-connect-replace-warning')).toBeTruthy();
    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));
    expect(screen.queryByTestId('mcp-consent-connect-replace-warning')).toBeNull();
  });

  test('no detected tools: the whole AI-tools section is gone', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: noneDetectedPayload }));

    expect(screen.queryByTestId('mcp-consent-connect-checkbox')).toBeNull();
    expect(screen.queryByTestId('mcp-consent-skill-checkbox')).toBeNull();
    expect(screen.queryByTestId('mcp-consent-no-tools')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Connect your AI tools');

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: [], pathInstall: true, skills: undefined },
      ]);
    });
  });

  test('no detected tools: the section drops its description too', async () => {
    await renderDialog(makeHarness({ snapshot: noneDetectedPayload }));

    const body = document.body.textContent ?? '';
    expect(body).not.toContain('Globally install the OpenKnowledge skills and MCP');
  });

  test('a destination but no detected tool: the skill row and the note both show', async () => {
    await renderDialog(
      makeHarness({ snapshot: { ...noneDetectedPayload, globalSkills: [DISCOVERY_SKILL] } }),
    );

    expect(screen.queryByTestId('mcp-consent-connect-checkbox')).toBeNull();
    expect(screen.getByTestId('mcp-consent-skill-checkbox')).toBeTruthy();
    expect(screen.getByTestId('mcp-consent-no-tools').textContent).toContain(
      'No AI tools detected',
    );
  });

  test('neither tools nor skills: the section is absent, and confirm is empty', async () => {
    const harness = await renderDialog(
      makeHarness({ snapshot: { ...noneDetectedPayload, globalSkills: [] } }),
    );

    expect(screen.queryByTestId('mcp-consent-connect-checkbox')).toBeNull();
    expect(screen.queryByTestId('mcp-consent-skill-checkbox')).toBeNull();
    expect(screen.queryByTestId('mcp-consent-no-tools')).toBeNull();

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: [], pathInstall: true, skills: undefined },
      ]);
    });
  });

  test('Continue stays enabled with nothing selected — it always records a decision', async () => {
    await renderDialog();
    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    expect((screen.getByTestId('mcp-consent-add') as HTMLButtonElement).disabled).toBe(false);
  });

  test('failed Continue resets busy state, reports the error, and allows retry', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const outcomes = [first, second];
    const harness = makeHarness({
      confirmResult: async () => outcomes.shift()?.promise ?? { ok: true },
    });
    await renderDialog(harness);

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;

    await userEvent.click(add);
    expect(add.disabled).toBe(true);
    expect(add.textContent).toBe('Working');

    first.resolve({ ok: false, error: 'Could not write Claude config' });
    await waitFor(() => {
      expect(add.disabled).toBe(false);
    });

    expect(add.textContent).toBe('Finish setup');
    expect(harness.toastErrors).toEqual(['Could not write Claude config']);

    await userEvent.click(add);
    second.resolve({ ok: false, error: 'Still unwritable' });
    await waitFor(() => {
      expect(harness.confirmCalls.length).toBe(2);
    });
  });
});

describe('McpConsentDialog PATH consent row', () => {
  afterEach(() => {
    cleanup();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('renders pre-checked with the rc-file disclosure; warning appears only when unchecked', async () => {
    await renderDialog();

    const checkbox = screen.getByTestId('mcp-consent-path-checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('mcp-consent-path-status')).toBeNull();
    await userEvent.click(screen.getByTestId('mcp-consent-path-info'));
    const status = await screen.findByTestId('mcp-consent-path-status');
    const text = status.textContent ?? '';
    expect(text).toContain('~/.zshrc');
    expect(text).toContain('~/.config/fish/conf.d/open-knowledge.fish');
    expect(screen.queryByTestId('mcp-consent-path-warning')).toBeNull();

    await userEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('mcp-consent-path-warning').textContent).toContain(
      'external terminals',
    );
    expect(screen.getByTestId('mcp-consent-path-warning').textContent).not.toContain(
      'built-in terminal',
    );
  });

  test('mentions the built-in terminal only when the desktop bridge reports PTY support', async () => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
    };
    await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    expect(screen.getByTestId('mcp-consent-path-warning').textContent).toContain(
      'built-in terminal',
    );
  });

  test('unchecking the toggle sends pathInstall:false on Continue', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: false, skills: ['discovery'] },
      ]);
    });
  });

  test('alreadyInstalled renders an informational row and solicits no decision', async () => {
    const harness = await renderDialog(
      makeHarness({
        snapshot: {
          ...payload,
          pathInstall: { ...payload.pathInstall, alreadyInstalled: true },
        },
      }),
    );

    const checkbox = screen.getByTestId('mcp-consent-path-checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('mcp-consent-path-status').textContent).toBe(
      'Already set up — ok is available in your terminal',
    );

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: undefined, skills: ['discovery'] },
      ]);
    });
  });

  test('shellDetected:false hides the row entirely and sends no PATH decision', async () => {
    const harness = await renderDialog(
      makeHarness({
        snapshot: {
          ...payload,
          pathInstall: { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false },
        },
      }),
    );

    expect(screen.queryByTestId('mcp-consent-path-checkbox')).toBeNull();

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: undefined, skills: ['discovery'] },
      ]);
    });
  });
});

describe('McpConsentDialog dismissal', () => {
  afterEach(() => cleanup());

  test('Escape skips without recording any decision and points at Settings', async () => {
    const harness = await renderDialog();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(harness.skipCalls).toEqual(['skip']);
    });
    expect(harness.confirmCalls).toEqual([]);
    expect(harness.toastMessages).toEqual(['This can be configured in Settings > AI tools & CLI']);
  });

  test('failed skip resets busy state and reports the error', async () => {
    const first = deferredResult();
    const harness = makeHarness({ skipResult: async () => first.promise });
    await renderDialog(harness);

    await userEvent.keyboard('{Escape}');
    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    await waitFor(() => {
      expect(add.disabled).toBe(true);
    });

    first.resolve({ ok: false, error: 'Could not write marker' });
    await waitFor(() => {
      expect(add.disabled).toBe(false);
    });
    expect(harness.toastErrors).toEqual(['Could not write marker']);
  });

  test('opens with focus on Skip, so the focus trap is live', async () => {
    await renderDialog();

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('mcp-consent-skip'));
    });
  });

  test('Skip for now records no decision, unlike an all-unchecked Finish', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-skip'));

    await waitFor(() => {
      expect(harness.skipCalls).toEqual(['skip']);
    });
    expect(harness.confirmCalls).toEqual([]);
    expect(harness.toastMessages).toEqual(['This can be configured in Settings > AI tools & CLI']);
  });

  test('Finish with everything unchecked still records the declines', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]).toEqual({
      editorIds: [],
      pathInstall: false,
      skills: undefined,
    });
    expect(harness.skipCalls).toEqual([]);
  });
});

describe('McpConsentDialog surface by origin', () => {
  afterEach(() => cleanup());

  const reconfigureHarness = () => makeHarness({ snapshot: { ...payload, origin: 'reconfigure' } });

  async function armOutsideDismissal() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function clickOutside() {
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
  }

  test('first-run is an alertdialog that an outside click cannot dismiss', async () => {
    const harness = await renderDialog();

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    await armOutsideDismissal();
    clickOutside();

    expect(harness.skipCalls).toEqual([]);
    expect(harness.confirmCalls).toEqual([]);
  });

  test('a user-opened one is an ordinary dialog with a close X', async () => {
    await renderDialog(reconfigureHarness());

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  test('the footer action reads Cancel when the user opened it, Skip when it opened itself', async () => {
    await renderDialog();
    expect(screen.getByTestId('mcp-consent-skip').textContent).toBe('Skip for now');

    cleanup();

    await renderDialog(reconfigureHarness());
    expect(screen.getByTestId('mcp-consent-skip').textContent).toBe('Cancel');
  });

  test.each([
    ['the close X', async () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
    [
      'an outside click',
      async () => {
        await armOutsideDismissal();
        clickOutside();
      },
    ],
    ['the footer Cancel', async () => userEvent.click(screen.getByTestId('mcp-consent-skip'))],
    ['Escape', async () => userEvent.keyboard('{Escape}')],
  ])('%s leaves a finished setup untouched', async (_label, dismiss) => {
    const harness = await renderDialog(reconfigureHarness());

    await dismiss();

    await waitFor(() => {
      expect(harness.dismissCalls).toEqual(['dismiss']);
    });
    expect(harness.skipCalls).toEqual([]);
    expect(harness.confirmCalls).toEqual([]);
    expect(harness.toastMessages).toEqual([]);
  });

  test('first-run still writes the skip marker — dismiss is the reopen path only', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-skip'));

    await waitFor(() => {
      expect(harness.skipCalls).toEqual(['skip']);
    });
    expect(harness.dismissCalls).toEqual([]);
  });

  test('the footer Cancel dismisses once per click, not twice', async () => {
    const harness = await renderDialog(reconfigureHarness());

    await userEvent.click(screen.getByTestId('mcp-consent-skip'));

    await waitFor(() => {
      expect(harness.dismissCalls).toEqual(['dismiss']);
    });
  });

  test('no dismiss surface can fire while a request is in flight', async () => {
    const pending = deferredResult();
    const harness = await renderDialog(
      makeHarness({
        snapshot: { ...payload, origin: 'reconfigure' },
        confirmResult: async () => pending.promise,
      }),
    );

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect((screen.getByTestId('mcp-consent-add') as HTMLButtonElement).disabled).toBe(true);
    });

    await userEvent.keyboard('{Escape}');
    await armOutsideDismissal();
    clickOutside();
    await userEvent.click(screen.getByTestId('mcp-consent-skip'));

    pending.resolve({ ok: true });
    await waitFor(() => {
      expect(harness.confirmCalls.length).toBe(1);
    });
    expect(harness.dismissCalls).toEqual([]);
    expect(harness.skipCalls).toEqual([]);
  });

  test('the close X is visibly inert while a request is in flight', async () => {
    const pending = deferredResult();
    await renderDialog(
      makeHarness({
        snapshot: { ...payload, origin: 'reconfigure' },
        confirmResult: async () => pending.promise,
      }),
    );

    const content = screen.getByRole('dialog');
    expect(content.className).not.toContain('[&_[data-slot=dialog-close]]:pointer-events-none');

    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(content.className).toContain('[&_[data-slot=dialog-close]]:pointer-events-none');
    });
    expect(content.className).toContain('[&_[data-slot=dialog-close]]:opacity-50');
    pending.resolve({ ok: true });
  });

  test('a user-opened one still offers Finish setup', async () => {
    const harness = await renderDialog(reconfigureHarness());

    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(harness.confirmCalls.length).toBe(1);
    });
    expect(harness.skipCalls).toEqual([]);
  });
});

describe('McpConsentDialog payload replacement', () => {
  afterEach(() => cleanup());

  function makeStoreBridge() {
    let handler: ((next: OkMcpWiringShowPayload) => void) | null = null;
    const confirm = vi.fn(() => Promise.resolve({ ok: true as const }));
    const bridge = {
      mcpWiring: {
        onShow: (cb: (next: OkMcpWiringShowPayload) => void) => {
          handler = cb;
          return () => {
            handler = null;
          };
        },
        signalReady: () => {},
        confirm,
        skip: () => Promise.resolve({ ok: true as const }),
      },
    };
    return {
      bridge,
      confirm,
      fireShow: (next: OkMcpWiringShowPayload) => handler?.(next),
    };
  }

  async function renderAgainstStore(harnessBridge: ReturnType<typeof makeStoreBridge>) {
    const { McpConsentDialogBody } = await import('./McpConsentDialogBody');
    const { createMcpConsentStore } = await import('@/lib/mcp-consent-store');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const store = createMcpConsentStore();
    store.install({ bridge: harnessBridge.bridge as never });
    const toastMessages: string[] = [];
    render(
      <TooltipProvider>
        <McpConsentDialogBody
          store={store}
          toast={{ error: (m) => toastMessages.push(m), message: (m) => toastMessages.push(m) }}
        />
      </TooltipProvider>,
    );
    return { store, toastMessages };
  }

  test('a reconfigure arriving over an open first-run swaps the shell', async () => {
    const b = makeStoreBridge();
    await renderAgainstStore(b);

    act(() => b.fireShow({ ...payload, origin: 'first-run' }));
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });

    act(() => b.fireShow({ ...payload, origin: 'reconfigure' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('mcp-consent-skip').textContent).toBe('Cancel');
  });

  test('a replacement remounts the form rather than inheriting its state', async () => {
    const b = makeStoreBridge();
    let releaseConfirm!: () => void;
    b.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseConfirm = () => resolve({ ok: true });
        }),
    );
    await renderAgainstStore(b);

    act(() => b.fireShow({ ...payload, origin: 'first-run' }));
    await waitFor(() => {
      expect(screen.getByTestId('mcp-consent-add')).toBeTruthy();
    });
    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect((screen.getByTestId('mcp-consent-add') as HTMLButtonElement).disabled).toBe(true);
    });

    act(() => b.fireShow({ ...payload, origin: 'reconfigure' }));

    await waitFor(() => {
      expect((screen.getByTestId('mcp-consent-add') as HTMLButtonElement).disabled).toBe(false);
    });
    expect((screen.getByTestId('mcp-consent-skip') as HTMLButtonElement).disabled).toBe(false);

    releaseConfirm();
  });
});

describe('McpConsentDialog theme picker', () => {
  afterEach(() => {
    cleanup();
    themeState.theme = 'system';
    themeState.resolvedTheme = 'dark';
    themeState.setTheme.mockClear();
  });

  test('checks the stored preference, not the mode it resolves to', async () => {
    themeState.theme = 'system';
    themeState.resolvedTheme = 'dark';
    await renderDialog();

    expect(screen.getByTestId('theme-picker-system').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('theme-picker-dark').getAttribute('aria-checked')).toBe('false');
  });

  test('offers the cards in the one order every surface uses', async () => {
    await renderDialog();

    expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
  });

  test('applies a pick immediately rather than deferring it to Finish', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('theme-picker-light'));

    expect(themeState.setTheme).toHaveBeenCalledWith('light');
    expect(harness.confirmCalls).toEqual([]);
  });

  test('canonicalizes the pick into user config when a binding is mounted', async () => {
    const patch = vi.fn(() => ({ ok: true as const, value: { effective: {}, appliedPaths: [] } }));
    await renderDialog(makeHarness({ userBinding: { patch } }));

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(patch).toHaveBeenCalledWith({ appearance: { theme: 'dark' } });
  });

  test('a failed config write is reported without taking the dialog down', async () => {
    const patch = vi.fn(() => ({ ok: false as const, error: { message: 'read-only' } }));
    const harness = await renderDialog(makeHarness({ userBinding: { patch } }));

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(themeState.setTheme).toHaveBeenCalledWith('dark');
    expect(harness.toastErrors).toEqual(["Couldn't save your theme preference."]);
    expect(screen.getByTestId('mcp-consent-add')).toBeTruthy();
  });

  test('a pick still applies in a window with no config binding', async () => {
    await renderDialog(makeHarness({ userBinding: null }));

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(themeState.setTheme).toHaveBeenCalledWith('dark');
  });
});
