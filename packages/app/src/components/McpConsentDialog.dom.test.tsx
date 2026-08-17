import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkMcpWiringResult, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import type { McpConsentStore } from '@/lib/mcp-consent-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { ToastImpl } from './McpConsentDialogBody';

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

/** Same shell state, zero detected tools — exercises the empty state. */
const noneDetectedPayload: OkMcpWiringShowPayload = {
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
  globalSkills: [DISCOVERY_SKILL],
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
}: {
  confirmResult?: (editorIds: readonly string[]) => Promise<OkMcpWiringResult>;
  skipResult?: () => Promise<OkMcpWiringResult>;
  snapshot?: OkMcpWiringShowPayload;
} = {}) {
  const confirmCalls: RecordedConfirm[] = [];
  const skipCalls: string[] = [];
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
    dismiss: () => {},
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
  return { confirmCalls, skipCalls, store, toast, toastErrors, toastMessages, snapshot };
}

async function renderDialog(harness = makeHarness()) {
  const { McpConsentDialogBody } = await import('./McpConsentDialogBody');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  // Mirror production: the app mounts a single root TooltipProvider (main.tsx),
  // and the PATH row's info tooltip relies on it rather than wrapping its own —
  // so the isolated render must supply it too.
  render(
    <TooltipProvider>
      <McpConsentDialogBody
        payload={harness.snapshot}
        store={harness.store}
        toast={harness.toast}
      />
    </TooltipProvider>,
  );
  return harness;
}

describe('McpConsentDialog AI-tools decision', () => {
  afterEach(() => cleanup());

  test('one pre-checked box whose label names every tool in the write set', async () => {
    await renderDialog();

    expect(
      screen.getByRole('dialog', { name: 'Connect your AI tools to OpenKnowledge' }),
    ).toBeTruthy();
    expect(screen.getByTestId('mcp-consent-connect-checkbox').getAttribute('aria-checked')).toBe(
      'true',
    );
    // Consent integrity: collapsed, the summary still discloses the write set.
    const summary = screen.getByTestId('mcp-consent-connect-summary').textContent ?? '';
    expect(summary).toContain('Claude');
    expect(summary).toContain('Cursor');
    // Undetected tools are not in the write set and are not named.
    expect(summary).not.toContain('Codex');
  });

  test('consent integrity: the overwrite warning shows without expanding anything', async () => {
    await renderDialog();

    // Claude carries willReplace; the warning must be visible while the
    // disclosure is still collapsed, naming the tool whose entry is replaced.
    expect(screen.queryByTestId('mcp-consent-details')).toBeNull();
    const warning = screen.getByTestId('mcp-consent-connect-replace-warning').textContent ?? '';
    expect(warning).toContain('Claude');
    expect(warning).not.toContain('Cursor');
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

  test('the disclosure lists every config file, entry and skill destination', async () => {
    await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-details-toggle'));
    const details = screen.getByTestId('mcp-consent-details');

    expect(details.textContent).toContain('~/.claude.json');
    expect(details.textContent).toContain('mcpServers.open-knowledge');
    expect(details.textContent).toContain('~/.cursor/mcp.json');
    // Undetected tools get no row — nothing is written for them.
    expect(screen.queryByTestId('mcp-consent-detail-codex')).toBeNull();

    // Skill destinations come from the payload (main computes them from the
    // installer's own gates), never re-derived in the renderer.
    const skillDetail = screen.getByTestId('mcp-consent-detail-skill-discovery');
    expect(skillDetail.textContent).toContain('~/.agents/skills/open-knowledge-discovery');
    expect(skillDetail.textContent).toContain('~/.claude/skills/open-knowledge-discovery');

    await userEvent.click(screen.getByTestId('mcp-consent-details-toggle'));
    expect(screen.queryByTestId('mcp-consent-details')).toBeNull();
  });

  test('the null-configPath fallback renders in the disclosure', async () => {
    // claude-desktop has no user-global config on this platform (configPath null).
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

    await userEvent.click(screen.getByTestId('mcp-consent-details-toggle'));
    expect(screen.getByTestId('mcp-consent-detail-claude-desktop').textContent).toContain(
      'unavailable on this platform',
    );
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
    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      // `skills: undefined`, not `[]`: main reads an array as "decline every
      // offered bundle and tear down any that is installed", which this screen
      // must never do.
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

  test('no skills offered: subtext claims only MCP, and confirm sends no skill decision', async () => {
    // `skillsOffered = false` drives two things a consent screen must not get
    // wrong: the subtext must stop promising the discovery skill, and the
    // confirm must send `skills: undefined` rather than an array — an array
    // would record a decline for bundles that were never offered.
    const harness = await renderDialog(makeHarness({ snapshot: { ...payload, globalSkills: [] } }));

    const row = screen.getByTestId('mcp-consent-connect-checkbox').closest('label');
    expect(row?.textContent ?? '').not.toContain('discovery');
    expect(row?.textContent ?? '').not.toContain('skill');

    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: true, skills: undefined },
      ]);
    });
  });

  test('the overwrite warning disappears when the box is unchecked', async () => {
    // "Replaces …" is present tense. Leaving it up after an uncheck states a
    // consequence that will not happen, and reads as the uncheck not taking.
    await renderDialog();
    expect(screen.getByTestId('mcp-consent-connect-replace-warning')).toBeTruthy();
    await userEvent.click(screen.getByTestId('mcp-consent-connect-checkbox'));
    expect(screen.queryByTestId('mcp-consent-connect-replace-warning')).toBeNull();
  });

  test('no detected tools: no checkbox, an explanatory line, and a PATH-only confirm', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: noneDetectedPayload }));

    expect(screen.queryByTestId('mcp-consent-connect-checkbox')).toBeNull();
    expect(screen.getByTestId('mcp-consent-no-tools').textContent).toContain(
      'No AI tools detected',
    );

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
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

    expect(add.textContent).toBe('Continue');
    expect(harness.toastErrors).toEqual(['Could not write Claude config']);

    await userEvent.click(add);
    second.resolve({ ok: false, error: 'Still unwritable' });
    await waitFor(() => {
      expect(harness.confirmCalls.length).toBe(2);
    });
  });
});

describe('McpConsentDialog PATH consent row', () => {
  afterEach(() => cleanup());

  test('renders pre-checked with the rc-file disclosure; warning appears only when unchecked', async () => {
    await renderDialog();

    const checkbox = screen.getByTestId('mcp-consent-path-checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('disabled')).toBe(false);
    // The rc-file disclosure is behind an info tooltip; it mounts (portaled)
    // only once the trigger is focused/hovered.
    expect(screen.queryAllByTestId('mcp-consent-path-status')).toHaveLength(0);
    screen.getByTestId('mcp-consent-path-info').focus();
    // Radix renders TooltipContent twice when open — the visible portal copy
    // plus a visually-hidden mirror for the aria-describedby association — so
    // both carry the testid. Assert against the first match, not getByTestId.
    await waitFor(() => {
      const [status] = screen.getAllByTestId('mcp-consent-path-status');
      expect(status?.textContent).toBe(
        'Adds a managed block to ~/.zshrc, ~/.config/fish/conf.d/open-knowledge.fish',
      );
    });
    // Warning is uncheck-scoped: it names the real degradation (external
    // terminals only) at the moment the user is making that choice.
    expect(screen.queryByTestId('mcp-consent-path-warning')).toBeNull();

    await userEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('mcp-consent-path-warning').textContent).toContain(
      'external terminals',
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
});
