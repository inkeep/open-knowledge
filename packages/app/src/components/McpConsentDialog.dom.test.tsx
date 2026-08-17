import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  globalSkills: [],
};

/** Same editors, zero detected — exercises the Add-enable matrix. */
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
  globalSkills: [],
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
  skills?: readonly string[];
}

/** Payload variant that offers both skill rows — exercises the skills section. */
const skillsPayload: OkMcpWiringShowPayload = {
  detectedEditors: [
    {
      id: 'claude',
      label: 'Claude',
      detected: true,
      willReplace: false,
      configPath: '~/.claude.json',
      entryLocator: 'mcpServers.open-knowledge',
    },
  ],
  pathInstall: { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false },
  globalSkills: [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      alreadyInstalled: false,
      description: 'Recognize OpenKnowledge projects and route reads and writes through it.',
      size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
      hosts: ['claude', 'cursor'],
      paths: [
        '~/.agents/skills/open-knowledge-discovery',
        '~/.claude/skills/open-knowledge-discovery',
      ],
    },
    {
      id: 'write-skill',
      name: 'open-knowledge-write-skill',
      alreadyInstalled: true,
      description: 'A guided workflow for authoring new Agent Skills.',
      size: { alwaysOn: 156, onTrigger: 3218, onDemand: 916 },
      hosts: ['claude', 'cursor'],
      paths: [
        '~/.agents/skills/open-knowledge-write-skill',
        '~/.claude/skills/open-knowledge-write-skill',
      ],
    },
  ],
};

/** Same two bundles, zero resolved hosts — exercises the disabled/unchecked
 *  state and the row's no-hosts copy (nothing can land). */
const skillsNoHostsPayload: OkMcpWiringShowPayload = {
  ...skillsPayload,
  globalSkills: skillsPayload.globalSkills.map((s) => ({ ...s, hosts: [], paths: [] })),
};

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
        skills: request.skills ? [...request.skills] : undefined,
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
  // and the dialog's per-row info tooltips rely on it rather than each wrapping
  // their own — so the isolated render must supply it too.
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

describe('McpConsentDialog runtime behavior', () => {
  afterEach(() => cleanup());

  test('renders willReplace disclosure and preselects detected editors only', async () => {
    await renderDialog();

    expect(
      screen.getByRole('dialog', { name: 'Connect your AI tools to OpenKnowledge' }),
    ).toBeTruthy();
    expect(screen.getByTestId('mcp-consent-status-claude').textContent).toBe(
      'Will replace existing OpenKnowledge entry',
    );
    // Detected tools carry no status line — the checked box conveys it.
    expect(screen.queryByTestId('mcp-consent-status-cursor')).toBeNull();
    // Progressive disclosure: undetected codex starts hidden behind the toggle.
    expect(screen.queryByTestId('mcp-consent-checkbox-codex')).toBeNull();
    expect(screen.getByTestId('mcp-consent-checkbox-claude').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('mcp-consent-checkbox-cursor').getAttribute('aria-checked')).toBe(
      'true',
    );

    // Reveal the undetected tools — codex links to its setup guide, unchecked.
    await userEvent.click(screen.getByTestId('mcp-consent-editors-toggle'));
    const codexStatus = screen.getByTestId('mcp-consent-status-codex');
    expect(codexStatus.tagName).toBe('A');
    expect(codexStatus.textContent).toContain('How to set up');
    expect(codexStatus.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/integrations/codex',
    );
    expect(screen.getByTestId('mcp-consent-checkbox-codex').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('consent integrity: a checked undetected tool stays visible after collapse', async () => {
    // Two undetected tools so a toggle still exists after one is checked.
    await renderDialog(
      makeHarness({
        snapshot: {
          detectedEditors: [
            {
              id: 'claude',
              label: 'Claude',
              detected: true,
              willReplace: false,
              configPath: '~/.claude.json',
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
            {
              id: 'opencode',
              label: 'OpenCode',
              detected: false,
              willReplace: false,
              configPath: '~/.config/opencode/opencode.json',
              entryLocator: 'mcp.open-knowledge',
            },
          ],
          pathInstall: { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false },
          globalSkills: [],
        },
      }),
    );
    // Both undetected tools hidden until expanded.
    expect(screen.queryByTestId('mcp-consent-checkbox-codex')).toBeNull();

    await userEvent.click(screen.getByTestId('mcp-consent-editors-toggle'));
    await userEvent.click(screen.getByTestId('mcp-consent-checkbox-codex'));
    expect(screen.getByTestId('mcp-consent-checkbox-codex').getAttribute('aria-checked')).toBe(
      'true',
    );

    // Collapse: checked codex stays visible (still in the write set); unchecked
    // opencode hides again, so the toggle persists.
    await userEvent.click(screen.getByTestId('mcp-consent-editors-toggle'));
    expect(screen.getByTestId('mcp-consent-checkbox-codex').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.queryByTestId('mcp-consent-checkbox-opencode')).toBeNull();
  });

  test('location tooltip discloses the config file and entry locator on focus', async () => {
    await renderDialog();
    // Content is portaled — mounts only once the info trigger is focused. Radix
    // renders it twice when open (visible + a11y mirror), so assert getAllByText.
    screen.getByTestId('mcp-consent-editor-info-claude').focus();
    await waitFor(() => {
      expect(screen.getAllByText('~/.claude.json').length).toBeGreaterThan(0);
      expect(screen.getAllByText('mcpServers.open-knowledge').length).toBeGreaterThan(0);
    });
  });

  test('location tooltip shows the null-configPath fallback', async () => {
    // claude-desktop has no user-global config on this platform (configPath null).
    await renderDialog(
      makeHarness({
        snapshot: {
          detectedEditors: [
            {
              id: 'claude-desktop',
              label: 'Claude Desktop',
              detected: false,
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
    screen.getByTestId('mcp-consent-editor-info-claude-desktop').focus();
    await waitFor(() => {
      expect(screen.getAllByText('unavailable on this platform').length).toBeGreaterThan(0);
    });
  });

  test('undetected claude-desktop links to the shared claude-code guide (aliased slug)', async () => {
    // claude-desktop → claude-code is the only non-1:1 entry in
    // EDITOR_SETUP_DOC_SLUG; a regression to `editor.id` in the URL would 404.
    await renderDialog(
      makeHarness({
        snapshot: {
          detectedEditors: [
            {
              id: 'claude-desktop',
              label: 'Claude Desktop',
              detected: false,
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

    const status = screen.getByTestId('mcp-consent-status-claude-desktop');
    expect(status.tagName).toBe('A');
    expect(status.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/integrations/claude-code',
    );
  });

  test('failed Add resets busy state, reports the error, and allows retry', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const outcomes = [first, second];
    const harness = makeHarness({
      confirmResult: async () => outcomes.shift()?.promise ?? { ok: true },
    });
    await renderDialog(harness);

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    const skip = screen.getByTestId('mcp-consent-skip') as HTMLButtonElement;

    await userEvent.click(add);
    expect(add.disabled).toBe(true);
    expect(skip.disabled).toBe(true);
    expect(add.textContent).toBe('Working');

    first.resolve({ ok: false, error: 'Could not write Claude config' });
    await waitFor(() => {
      expect(add.disabled).toBe(false);
    });

    expect(skip.disabled).toBe(false);
    expect(add.textContent).toBe('Connect');
    expect(harness.confirmCalls).toEqual([{ editorIds: ['claude', 'cursor'], pathInstall: true }]);
    expect(harness.toastErrors).toEqual(['Could not write Claude config']);

    await userEvent.click(add);
    second.resolve({ ok: false, error: 'Still unwritable' });
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: true },
        { editorIds: ['claude', 'cursor'], pathInstall: true },
      ]);
    });
  });

  test('failed Skip resets busy state, reports the error, and allows retry', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const outcomes = [first, second];
    const harness = makeHarness({
      skipResult: async () => outcomes.shift()?.promise ?? { ok: true },
    });
    await renderDialog(harness);

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    const skip = screen.getByTestId('mcp-consent-skip') as HTMLButtonElement;

    await userEvent.click(skip);
    expect(add.disabled).toBe(true);
    expect(skip.disabled).toBe(true);

    first.resolve({ ok: false, error: 'Could not write marker' });
    await waitFor(() => {
      expect(skip.disabled).toBe(false);
    });

    expect(add.disabled).toBe(false);
    expect(harness.skipCalls).toEqual(['skip']);
    expect(harness.toastErrors).toEqual(['Could not write marker']);

    await userEvent.click(skip);
    second.resolve({ ok: false, error: 'Still cannot write marker' });
    await waitFor(() => {
      expect(harness.skipCalls).toEqual(['skip', 'skip']);
    });
  });

  test('successful Skip points the user at the Settings surface via a toast', async () => {
    const harness = makeHarness();
    await renderDialog(harness);

    await userEvent.click(screen.getByTestId('mcp-consent-skip'));

    await waitFor(() => {
      expect(harness.toastMessages).toEqual([
        'This can be configured in Settings > AI tools & CLI',
      ]);
    });
    expect(harness.toastErrors).toEqual([]);
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

  test('unchecking the toggle sends pathInstall:false on Add', async () => {
    const harness = await renderDialog();

    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    await userEvent.click(screen.getByTestId('mcp-consent-add'));

    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude', 'cursor'], pathInstall: false },
      ]);
    });
  });

  test('FR8: zero editors selected + PATH checked keeps Add enabled and confirms PATH-only', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: noneDetectedPayload }));

    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);

    await userEvent.click(add);
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([{ editorIds: [], pathInstall: true }]);
    });
  });

  test('FR8: zero editors + PATH unchecked disables Add', async () => {
    await renderDialog(makeHarness({ snapshot: noneDetectedPayload }));

    await userEvent.click(screen.getByTestId('mcp-consent-path-checkbox'));
    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
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
        { editorIds: ['claude', 'cursor'], pathInstall: undefined },
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
        { editorIds: ['claude', 'cursor'], pathInstall: undefined },
      ]);
    });
  });
});

describe('McpConsentDialog skills section', () => {
  afterEach(() => cleanup());

  test('FR2: renders one pre-checked row per bundle', async () => {
    await renderDialog(makeHarness({ snapshot: skillsPayload }));
    for (const id of ['discovery', 'write-skill']) {
      expect(
        screen.getByTestId(`mcp-consent-skill-checkbox-${id}`).getAttribute('aria-checked'),
      ).toBe('true');
    }
  });

  test('FR9: unchecking write-skill sends only the checked bundle on Add', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: skillsPayload }));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox-write-skill'));
    // Unchecking an already-installed bundle surfaces the removal warning.
    expect(screen.getByTestId('mcp-consent-skill-warning-write-skill')).toBeTruthy();
    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude'], pathInstall: undefined, skills: ['discovery'] },
      ]);
    });
  });

  test('declining every skill keeps Add enabled and confirms an empty skill set', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: skillsPayload }));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox-discovery'));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox-write-skill'));
    // Uncheck the only detected editor too — Add stays enabled because skills
    // were offered (declining is itself an action).
    await userEvent.click(screen.getByTestId('mcp-consent-checkbox-claude'));
    const add = screen.getByTestId('mcp-consent-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([{ editorIds: [], pathInstall: undefined, skills: [] }]);
    });
  });

  test("renders each skill's own frontmatter description, not hand-written subtext", async () => {
    await renderDialog(makeHarness({ snapshot: skillsPayload }));
    expect(screen.getByText('A guided workflow for authoring new Agent Skills.')).toBeTruthy();
  });

  test('states skill reach is independent of the MCP editor selection', async () => {
    await renderDialog(makeHarness({ snapshot: skillsPayload }));
    expect(screen.getByTestId('mcp-consent-skill-fanout-note').textContent).toContain(
      'independent of the MCP',
    );
  });

  test('clicking a row expands it in place with the full cost and destination list', async () => {
    await renderDialog(makeHarness({ snapshot: skillsPayload }));
    // Collapsed: no expansion mounted.
    expect(screen.queryByTestId('mcp-consent-skill-expansion-write-skill')).toBeNull();

    // The row body is the expand affordance (first launch expands; it never
    // navigates away). Clicking the skill name bubbles to its row button.
    await userEvent.click(screen.getByText('open-knowledge-write-skill'));

    const expansion = screen.getByTestId('mcp-consent-skill-expansion-write-skill');
    // Full three-tier cost — the on-demand tier appears only here, never on the
    // compact row above it.
    expect(expansion.textContent).toContain('on demand');
    // Every destination path is disclosed, including the ~/.agents hub — the
    // same list the Settings confirm modal carries.
    const paths = within(expansion).getByTestId('skill-destination-list');
    expect(paths.textContent).toContain('~/.agents/skills/open-knowledge-write-skill');
    expect(paths.textContent).toContain('~/.claude/skills/open-knowledge-write-skill');
    // The dialog is never left.
    expect(
      screen.getByRole('dialog', { name: 'Connect your AI tools to OpenKnowledge' }),
    ).toBeTruthy();
  });

  test('checking a skill stages it — nothing is written until Connect', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: skillsPayload }));
    // Toggle discovery off then on — the checkbox itself never confirms.
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox-discovery'));
    await userEvent.click(screen.getByTestId('mcp-consent-skill-checkbox-discovery'));
    expect(harness.confirmCalls).toEqual([]);
    // Only Connect commits the staged set.
    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
  });

  test('zero resolved hosts unchecks and disables the skill checkboxes with a reason', async () => {
    await renderDialog(makeHarness({ snapshot: skillsNoHostsPayload }));
    for (const id of ['discovery', 'write-skill']) {
      const box = screen.getByTestId(`mcp-consent-skill-checkbox-${id}`);
      expect(box.getAttribute('aria-checked')).toBe('false');
      expect(box.hasAttribute('disabled')).toBe(true);
    }
    // Each row states what would make it installable — the shared no-hosts copy.
    expect(screen.getAllByTestId('skill-consent-row-no-hosts')).toHaveLength(2);
  });

  test('a staged skill with zero hosts is never sent on Connect', async () => {
    const harness = await renderDialog(makeHarness({ snapshot: skillsNoHostsPayload }));
    // Skills were offered, so Add stays enabled; confirming sends an empty set
    // (nothing can land nowhere) rather than the pre-checked default.
    await userEvent.click(screen.getByTestId('mcp-consent-add'));
    await waitFor(() => {
      expect(harness.confirmCalls).toEqual([
        { editorIds: ['claude'], pathInstall: undefined, skills: [] },
      ]);
    });
  });
});
