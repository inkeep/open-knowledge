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
    onboarding: {
      probeContent: async () => ({ ok: true, count: 0, sample: [], truncated: false }),
    },
  };
}

function deferredStatusBridge(detectedEditorIds: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const status = {
    available: true,
    editors: detectedEditorIds.map((id) => ({ id, state: 'installed' })),
    path: { shellDetected: false, rcFilesToTouch: [], installed: false },
    skills: [],
    detectedEditorIds,
  };
  return {
    bridge: {
      integrations: {
        status: async () => {
          await gate;
          return status;
        },
      },
      onboarding: {
        probeContent: async () => ({ ok: true, count: 0, sample: [], truncated: false }),
      },
    },
    release,
  };
}

function setBridge(bridge: unknown) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

function makeStore(opts: { cancelError?: string; confirmError?: string } = {}) {
  const confirmCalls: OkOnboardingConfirmRequest[] = [];
  const cancelCalls: string[] = [];
  const store: ConsentStore = {
    install: () => undefined,
    getSnapshot: () => payload,
    subscribe: () => () => {},
    confirm: async (request) => {
      confirmCalls.push(request);
      return opts.confirmError === undefined
        ? { ok: true }
        : { ok: false, error: opts.confirmError };
    },
    cancel: async () => {
      cancelCalls.push('cancel');
      return opts.cancelError === undefined ? { ok: true } : { ok: false, error: opts.cancelError };
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
    vi.restoreAllMocks();
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

  test('a never-settling detection probe keeps Cancel live and degrades to no wiring', async () => {
    const harness = makeStore();
    setBridge(statusBridge([], { pending: true }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);

    expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe(
      'probing',
    );
    expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);

    await waitFor(() => {
      expect(
        (screen.getByTestId('consent-start') as HTMLButtonElement).getAttribute('aria-busy'),
      ).toBe('true');
    });
    expect((screen.getByTestId('consent-cancel') as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual([]);
    expect(harness.confirmCalls[0]?.connectEditors).toBe(true);
  });

  test('Escape during the detection wait cancels instead of being swallowed', async () => {
    const harness = makeStore();
    setBridge(statusBridge([], { pending: true }));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(
        (screen.getByTestId('consent-start') as HTMLButtonElement).getAttribute('aria-busy'),
      ).toBe('true');
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });
  });

  test('a rejected detection probe does not hang the submit', async () => {
    const harness = makeStore();
    let reject!: (err: Error) => void;
    const gate = new Promise<never>((_resolve, r) => {
      reject = (err) => r(err);
    });
    setBridge({
      integrations: { status: () => gate },
      onboarding: {
        probeContent: async () => ({ ok: true, count: 0, sample: [], truncated: false }),
      },
    });
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    reject(new Error('detection blew up'));

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual([]);
    expect(harness.confirmCalls[0]?.connectEditors).toBe(true);
  });

  test('a failed cancel leaves the dialog usable — the next Setup still confirms', async () => {
    const harness = makeStore({ cancelError: 'nope' });
    setBridge(statusBridge(['claude']));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);
    await awaitDetected();

    fireEvent.click(screen.getByTestId('consent-cancel'));
    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });
    await waitFor(() => {
      expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
  });

  test('two rapid cancels during the detection wait issue a single cancel', async () => {
    const harness = makeStore();
    setBridge(statusBridge([], { pending: true }));
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(
        (screen.getByTestId('consent-start') as HTMLButtonElement).getAttribute('aria-busy'),
      ).toBe('true');
    });

    fireEvent.click(screen.getByTestId('consent-cancel'));
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.cancelCalls).toEqual(['cancel']);
  });

  test('a cancel during the detection wait suppresses the parked confirm, even if the cancel fails', async () => {
    const harness = makeStore({ cancelError: 'nope' });
    setBridge(statusBridge([], { pending: true }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    expect(
      (screen.getByTestId('consent-start') as HTMLButtonElement).getAttribute('aria-busy'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('consent-cancel'));

    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });

    await waitFor(() => {
      expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe('none');
    });
    expect(harness.confirmCalls).toEqual([]);
  });

  test('the detection grace is anchored at mount, so a resubmit does not restart it', async () => {
    const harness = makeStore({ cancelError: 'nope' });
    setBridge(statusBridge([], { pending: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    fireEvent.click(screen.getByTestId('consent-cancel'));
    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });
    await waitFor(() => {
      expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const graceWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('did not settle within'),
    );
    expect(graceWarnings).toHaveLength(1);
  });

  test('a successful cancel during the wait suppresses the parked confirm', async () => {
    const harness = makeStore();
    const detection = deferredStatusBridge(['claude']);
    setBridge(detection.bridge);
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    await waitFor(() => {
      expect(
        (screen.getByTestId('consent-start') as HTMLButtonElement).getAttribute('aria-busy'),
      ).toBe('true');
    });

    fireEvent.click(screen.getByTestId('consent-cancel'));
    await waitFor(() => {
      expect(harness.cancelCalls).toEqual(['cancel']);
    });

    detection.release();
    await waitFor(() => {
      expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe(
        'ready',
      );
    });
    expect(harness.confirmCalls).toEqual([]);
  });

  test('a probe that settles after the grace still wires the editors the dialog is showing', async () => {
    const harness = makeStore();
    const detection = deferredStatusBridge(['claude']);
    setBridge(detection.bridge);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);

    await waitFor(() => {
      expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe('none');
    });

    detection.release();
    await awaitDetected();

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual(['claude']);
  });

  test('a probe that settles inside the grace does not warn', async () => {
    const harness = makeStore();
    const detection = deferredStatusBridge(['claude']);
    setBridge(detection.bridge);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);
    detection.release();
    await awaitDetected();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const graceWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('did not settle within'),
    );
    expect(graceWarnings).toEqual([]);
  });

  test('grace expiry stops the row claiming it is still checking', async () => {
    const harness = makeStore();
    setBridge(statusBridge([], { pending: true }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ConsentDialogBody payload={payload} store={harness.store} detectionGraceMs={150} />);

    expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe(
      'probing',
    );

    await waitFor(() => {
      expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe('none');
    });
  });

  test('a failed confirm re-arms the dialog and surfaces the error', async () => {
    const harness = makeStore({ confirmError: 'main said no' });
    const errors: string[] = [];
    setBridge(statusBridge(['claude']));
    render(
      <ConsentDialogBody
        payload={payload}
        store={harness.store}
        toast={{ error: (message) => errors.push(message) }}
      />,
    );
    await awaitDetected();

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect((screen.getByTestId('consent-start') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(errors).toEqual(['main said no']);
    expect((screen.getByTestId('consent-cancel') as HTMLButtonElement).disabled).toBe(false);
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
  test('a submit raised while detection is in flight still confirms', async () => {
    const harness = makeStore();
    const detection = deferredStatusBridge(['claude']);
    setBridge(detection.bridge);
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    fireEvent.submit(screen.getByTestId('consent-form') as HTMLFormElement);
    detection.release();

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    expect(harness.confirmCalls[0]?.editorIds).toEqual(['claude']);
    expect(harness.confirmCalls[0]?.connectEditors).toBe(true);
  });

  test('a second submit while the first is in flight is ignored', async () => {
    const harness = makeStore();
    const detection = deferredStatusBridge([]);
    setBridge(detection.bridge);
    render(<ConsentDialogBody payload={payload} store={harness.store} />);

    const form = screen.getByTestId('consent-form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    detection.release();

    await waitFor(() => {
      expect(harness.confirmCalls).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.confirmCalls).toHaveLength(1);
  });
});
