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

/**
 * Minimal `integrations.status()` stub. The dialog reads exactly two fields:
 * `detectedEditorIds` (what is on this machine) and `editors[].state` (whether
 * OK's user-global entry is installed, which gates Copilot's project skill).
 */
function statusBridge(
  detectedEditorIds: string[],
  opts: { pending?: boolean; editorStates?: Record<string, string> } = {},
) {
  const status = {
    available: true,
    // `state` is the USER-GLOBAL entry's state, which is what gates Copilot's
    // project skill — distinct from `detectedEditorIds` (is the tool on this
    // machine at all). Default `installed` keeps the simple cases terse.
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

/** Wait for the editor-detection probe to settle into its checkbox state. */
async function awaitDetected() {
  await waitFor(() => {
    expect(screen.getByTestId('consent-editors-status').getAttribute('data-status')).toBe('ready');
  });
}

/**
 * The content.dir / ignore controls live inside the collapsed "Advanced
 * settings" section, which Radix unmounts while closed. Expand it before
 * interacting with those fields. (Config sharing and the AI-tools row are NOT
 * here — both sit at the top level.)
 */
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

    // Visible without expanding Advanced, defaulting to "Only me".
    expect(screen.getByTestId('consent-sharing')).not.toBeNull();
    expect(screen.getByTestId('consent-sharing-shared')).not.toBeNull();
    expect(screen.getByTestId('consent-sharing-local-only').getAttribute('data-state')).toBe(
      'checked',
    );
    // ...while the Advanced-only fields stay collapsed.
    expect(screen.queryByTestId('consent-content-dir')).toBeNull();
  });

  test('config-sharing info tooltip stays closed when the dialog first opens', async () => {
    // Radix Dialog autofocuses the first focusable descendant on open. The
    // file-count probe is async, so ProbePreview renders a non-focusable
    // placeholder at mount — which would make the sharing-info TooltipTrigger
    // the first focusable element. A Radix Tooltip opens immediately on focus
    // (delayDuration 0), so the info popover would pop open unbidden. The
    // dialog redirects initial focus away from the trigger; assert the tooltip
    // content (portaled only while open) is absent on mount.
    renderConsentDialog();

    expect(screen.queryByText(/Setup files include/i)).toBeNull();
    expect(screen.getByTestId('config-sharing-info')).not.toBe(document.activeElement);
  });

  test('selecting Shared carries through to the confirm payload', async () => {
    // "Only me" is the default, so exercise the non-default pick.
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
    // ...while the Advanced-only fields stay collapsed.
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
    // Claude Desktop has no project MCP config and no project skill root, so
    // every project writer returns `skipped-unsupported` for it. Detection
    // still finds it, which is exactly why the filter has to be on what gets
    // WRITTEN rather than on what was detected.
    //
    // Asserts on the summary, not on the per-tool `<li>` ids: those live inside
    // `RowDisclosure`'s Radix popover, which is unmounted while collapsed, so
    // every item id reads null here whether or not it is in the write set.
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
    // Copilot's project skill (`.github/skills`) is refused by
    // `isProjectSkillPrerequisiteMet` until Copilot's USER-GLOBAL OpenKnowledge
    // entry is present, and it has no project MCP config — so before that, a
    // setup writes nothing for it and must not say otherwise.
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
    // `foreign` means an entry sits under OpenKnowledge's server name but is
    // not ours, so OK's MCP is not actually registered. The renderer's check is
    // deliberately stricter than the write path's, which also passes on
    // `foreign` — a skill installed here would point the agent at tools that
    // are not there.
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
    // Submitting mid-probe would send `editorIds: []` — a project wired to
    // nothing while the row still reads "Checking which AI tools you have".
    //
    // `detectionPending` also guards on `connectEditors`, mirroring
    // `CreateProjectDialog`. That half is unreachable from the UI: the row
    // early-returns its status region while probing, so there is no checkbox to
    // untick until detection settles. Kept for symmetry with the sibling copy,
    // not asserted here, because no test can reach it.
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
    // Regression guard for `advancedExpanded = advancedOpen || !contentDirSafe`
    // — an invalid content dir must auto-open the section so its inline error
    // is reachable, WITHOUT any expand interaction.
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
      // No bridge in this harness, so detection settles empty. `connectEditors`
      // stays true: the user declined nothing, there was nothing to offer.
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
      // The dialog probes editor detection on mount through the same bridge; a
      // stub missing it is a shape the real preload never has.
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
