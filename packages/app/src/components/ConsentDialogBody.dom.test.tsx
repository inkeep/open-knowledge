import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConsentStore } from '@/lib/consent-store';
import type {
  OkDesktopBridge,
  OkOnboardingConfirmRequest,
  OkOnboardingShowPayload,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/core/macro', () => ({ ...actualLinguiMacro, msg: renderLinguiTemplate }));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { default: ConsentDialogBody } = await import('./ConsentDialogBody');

const payload: OkOnboardingShowPayload = {
  pickedPath: '/project',
  projectDir: '/project',
  defaultContentDir: 'docs',
  gitState: 'present',
  gitRootPromoted: false,
  warnings: [],
};

function statusBridge(
  detectedEditorIds: string[],
  opts: { pending?: boolean; editorStates?: Record<string, string> } = {},
) {
  const status = {
    available: true,
    editors: detectedEditorIds.map((id) => ({
      id,
      state: opts.editorStates?.[id] ?? 'installed',
    })),
    path: { shellDetected: false, rcFilesToTouch: [], installed: false },
    skills: [],
    detectedEditorIds,
  };
  return {
    integrations: {
      status: () => (opts.pending ? new Promise(() => {}) : Promise.resolve(status)),
    },
  };
}

function setBridge(bridge: unknown) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

function makeStore() {
  const confirmCalls: OkOnboardingConfirmRequest[] = [];
  const cancelCalls: string[] = [];
  const store: ConsentStore = {
    install: () => undefined,
    getSnapshot: () => payload,
    subscribe: () => () => {},
    confirm: async (request) => {
      confirmCalls.push(request);
      return { ok: true };
    },
    cancel: async () => {
      cancelCalls.push('cancel');
      return { ok: true };
    },
    dismiss: () => {},
  };
  return { store, confirmCalls, cancelCalls };
}

function renderConsentDialog() {
  const harness = makeStore();
  render(<ConsentDialogBody payload={payload} store={harness.store} />);
  return harness;
}

async function awaitDetected() {
  await waitFor(() => {
    expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe('ready');
  });
}

async function expandAdvanced() {
  await userEvent.click(screen.getByTestId('consent-advanced-trigger'));
}

describe('ConsentDialogBody runtime form behavior', () => {
  afterEach(() => {
    cleanup();
    setBridge(undefined);
  });

  test('exports the default component', () => {
    expect(typeof ConsentDialogBody).toBe('function');
  });

  test('advanced controls are collapsed by default and reveal on expand', async () => {
    renderConsentDialog();

    expect(screen.queryByTestId('consent-content-dir')).toBeNull();
    expect(screen.queryByTestId('consent-additional-ignores')).toBeNull();

    await expandAdvanced();

    expect(screen.getByTestId('consent-content-dir')).not.toBeNull();
    expect(screen.getByTestId('consent-additional-ignores')).not.toBeNull();
  });

  test('config sharing is shown at the top level, not inside Advanced settings', async () => {
    renderConsentDialog();

    expect(screen.getByTestId('consent-sharing')).not.toBeNull();
    expect(screen.getByTestId('consent-sharing-shared')).not.toBeNull();
    expect(screen.getByTestId('consent-sharing-local-only').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.queryByTestId('consent-content-dir')).toBeNull();
  });

  test('config-sharing info tooltip stays closed when the dialog first opens', async () => {
    renderConsentDialog();

    expect(screen.queryByText(/Setup files include/i)).toBeNull();
    expect(screen.getByTestId('config-sharing-info')).not.toBe(document.activeElement);
  });

  test('selecting Shared carries through to the confirm payload', async () => {
    const { confirmCalls } = renderConsentDialog();

    await userEvent.click(screen.getByTestId('consent-sharing-shared'));

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(confirmCalls).toHaveLength(1);
    });
    expect(confirmCalls[0]?.sharing).toBe('shared');
  });

  test('the AI-tools row is shown at the top level, not inside Advanced settings', async () => {
    const harness = makeStore();
    setBridge(statusBridge(['claude', 'cursor']));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    await awaitDetected();
    expect(screen.getByTestId('consent-editors-checkbox').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.queryByTestId('consent-content-dir')).toBeNull();
  });

  test('the detected tools are the write set, and the row names them', async () => {
    const harness = makeStore();
    setBridge(statusBridge(['claude', 'cursor']));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);
    await awaitDetected();

    expect(screen.getByTestId('consent-editors-summary').textContent ?? '').toContain('Claude');
    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual(['claude', 'cursor']);
    expect(harness.confirmCalls[0]?.connectEditors).toBe(true);
  });

  test('a detected user-global-only tool is neither named nor submitted', async () => {
    const harness = makeStore();
    setBridge(statusBridge(['claude', 'claude-desktop']));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);
    await awaitDetected();

    const summary = screen.getByTestId('consent-editors-summary').textContent ?? '';
    expect(summary).toContain(EDITOR_LABELS.claude);
    expect(summary).not.toContain(EDITOR_LABELS['claude-desktop']);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual(['claude']);
  });

  test('Copilot is dropped until its user-global entry exists, then included', async () => {
    const withoutEntry = makeStore();
    setBridge(statusBridge(['claude', 'copilot'], { editorStates: { copilot: 'not-installed' } }));
    render(<ConsentDialogBody payload={payload} store={withoutEntry.store} />);
    await awaitDetected();
    expect(screen.getByTestId('consent-editors-summary').textContent ?? '').not.toContain(
      EDITOR_LABELS.copilot,
    );

    cleanup();

    const withEntry = makeStore();
    setBridge(statusBridge(['claude', 'copilot']));
    render(<ConsentDialogBody payload={payload} store={withEntry.store} />);
    await awaitDetected();
    expect(screen.getByTestId('consent-editors-summary').textContent ?? '').toContain(
      EDITOR_LABELS.copilot,
    );

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(withEntry.confirmCalls).toHaveLength(1);
    });
    expect(withEntry.confirmCalls[0]?.editorIds).toEqual(['claude', 'copilot']);
  });

  test('a foreign user-global entry does not satisfy the Copilot prerequisite', async () => {
    const harness = makeStore();
    setBridge(statusBridge(['claude', 'copilot'], { editorStates: { copilot: 'foreign' } }));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);
    await awaitDetected();

    expect(screen.getByTestId('consent-editors-summary').textContent ?? '').not.toContain(
      EDITOR_LABELS.copilot,
    );
  });

  test('unticking the row sends an empty write set and records the decline', async () => {
    const harness = makeStore();
    setBridge(statusBridge(['claude', 'cursor']));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);
    await awaitDetected();

    await userEvent.click(screen.getByTestId('consent-editors-checkbox'));

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual([]);
    expect(harness.confirmCalls[0]?.connectEditors).toBe(false);
  });

  test('Setup is disabled while the detection probe is in flight', async () => {
    const harness = makeStore();
    setBridge(statusBridge([], { pending: true }));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe(
      'probing',
    );
    expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    expect(harness.confirmCalls).toHaveLength(0);
  });

  test('an invalid default content dir force-opens Advanced settings and shows the error without expanding', () => {
    const harness = makeStore();
    const invalidPayload = { ...payload, defaultContentDir: '../secrets' };
    render(<ConsentDialogBody payload={invalidPayload} store={harness.store} />);

    expect(screen.getByTestId('consent-content-dir')).not.toBeNull();
    expect(screen.getByTestId('consent-content-dir-error')).not.toBeNull();
    expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(true);
  });

  test('Cancel is a non-submit button and invokes cancel without confirming', async () => {
    const { confirmCalls, cancelCalls } = renderConsentDialog();

    const cancel = screen.getByTestId('consent-cancel');
    expect(cancel.getAttribute('type')).toBe('button');
    await userEvent.click(cancel);

    await waitFor(() => {
      expect(cancelCalls).toEqual(['cancel']);
    });
    expect(confirmCalls).toEqual([]);
  });

  test('Start is bound to the body form and form submit prevents default before confirming', async () => {
    const { confirmCalls } = renderConsentDialog();

    const form = screen.getByTestId('consent-form') as HTMLFormElement;
    const start = screen.getByTestId('consent-start');
    expect(start.getAttribute('type')).toBe('submit');
    expect(start.getAttribute('form')).toBe(form.id);

    expect(fireEvent.submit(form)).toBe(false);
    await waitFor(() => {
      expect(confirmCalls).toHaveLength(1);
    });
    expect(confirmCalls[0]).toEqual({
      initGit: true,
      contentDir: 'docs',
      additionalIgnores: '',
      editorIds: [],
      connectEditors: true,
      sharing: 'local-only',
    });
  });

  test('invalid contentDir submit is default-prevented and does not confirm', async () => {
    const { confirmCalls } = renderConsentDialog();
    await expandAdvanced();

    fireEvent.change(screen.getByTestId('consent-content-dir'), {
      target: { value: '../secrets' },
    });

    const form = screen.getByTestId('consent-form');
    const start = screen.getByTestId('consent-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(fireEvent.submit(form)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmCalls).toEqual([]);
  });

  test('Browse seeds the folder picker with the project directory', async () => {
    const openFolderCalls: Array<{ defaultPath?: string } | undefined> = [];
    setBridge({
      dialog: {
        openFolder: async (opts?: { defaultPath?: string }) => {
          openFolderCalls.push(opts);
          return '/project/docs/notes';
        },
      },
      onboarding: {
        probeContent: async () => ({ ok: true, count: 0, sample: [], truncated: false }),
      },
      ...statusBridge([]),
    } satisfies Pick<OkDesktopBridge, 'dialog'> & {
      onboarding: Pick<OkDesktopBridge['onboarding'], 'probeContent'>;
    });
    renderConsentDialog();
    await expandAdvanced();

    await userEvent.click(screen.getByTestId('consent-content-dir-browse'));

    await waitFor(() => {
      expect(openFolderCalls).toEqual([{ defaultPath: '/project' }]);
    });
    expect((screen.getByTestId('consent-content-dir') as HTMLInputElement).value).toBe(
      'docs/notes',
    );
  });
});
