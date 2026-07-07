import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { OkMcpWiringResult, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import type { McpConsentStore } from '@/lib/mcp-consent-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { ToastImpl } from './McpConsentDialogBody';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const payload: OkMcpWiringShowPayload = {
  detectedEditors: [
    { id: 'claude', label: 'Claude', detected: true, willReplace: true },
    { id: 'cursor', label: 'Cursor', detected: true, willReplace: false },
    { id: 'codex', label: 'Codex', detected: false, willReplace: false },
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
  detectedEditors: [{ id: 'codex', label: 'Codex', detected: false, willReplace: false }],
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
  detectedEditors: [{ id: 'claude', label: 'Claude', detected: true, willReplace: false }],
  pathInstall: { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false },
  globalSkills: [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      alreadyInstalled: false,
    },
    {
      id: 'write-skill',
      name: 'open-knowledge-write-skill',
      alreadyInstalled: true,
    },
  ],
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
  };
  return { confirmCalls, skipCalls, store, toast, toastErrors, snapshot };
}

async function renderDialog(harness = makeHarness()) {
  const { McpConsentDialogBody } = await import('./McpConsentDialogBody');
  render(
    <McpConsentDialogBody payload={harness.snapshot} store={harness.store} toast={harness.toast} />,
  );
  return harness;
}

describe('McpConsentDialog runtime behavior', () => {
  afterEach(() => cleanup());

  test('renders willReplace disclosure and preselects detected editors only', async () => {
    await renderDialog();

    expect(screen.getByRole('dialog', { name: 'Add OpenKnowledge to your AI tools' })).toBeTruthy();
    expect(screen.getByTestId('mcp-consent-status-claude').textContent).toBe(
      'Will replace existing OpenKnowledge entry',
    );
    expect(screen.getByTestId('mcp-consent-status-cursor').textContent).toBe(
      'Detected on this machine',
    );
    expect(screen.getByTestId('mcp-consent-status-codex').textContent).toBe('Not detected');
    expect(screen.getByTestId('mcp-consent-checkbox-claude').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('mcp-consent-checkbox-cursor').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('mcp-consent-checkbox-codex').getAttribute('aria-checked')).toBe(
      'false',
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
    expect(add.textContent).toBe('Add');
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
});

describe('McpConsentDialog PATH consent row', () => {
  afterEach(() => cleanup());

  test('PATH section is pinned outside the scrollable editor list', async () => {
    // The editor list can outgrow the dialog (DialogBody is the overflow
    // container); the PATH toggle must stay visible without scrolling, so
    // it lives in its own section ABOVE that container.
    await renderDialog();

    const pathCheckbox = screen.getByTestId('mcp-consent-path-checkbox');
    expect(pathCheckbox.closest('[class*="overflow-y-auto"]')).toBeNull();
    const editorCheckbox = screen.getByTestId('mcp-consent-checkbox-claude');
    expect(editorCheckbox.closest('[class*="overflow-y-auto"]')).not.toBeNull();
  });

  test('renders pre-checked with the rc-file disclosure; warning appears only when unchecked', async () => {
    await renderDialog();

    const checkbox = screen.getByTestId('mcp-consent-path-checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('mcp-consent-path-status').textContent).toBe(
      'Adds a managed block to ~/.zshrc, ~/.config/fish/conf.d/open-knowledge.fish',
    );
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
});
