import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ALL_EDITOR_IDS, EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Spy on the sonner toast surface so the empty-name submit can be asserted
// deterministically (the e2e can't reliably catch the transient portal toast
// in Electron). Mock before importing the component so its `toast` binding
// resolves to the spy.
const toastErrorSpy = mock((_message: string) => {});
mock.module('sonner', () => ({
  toast: { error: toastErrorSpy, success: () => {}, warning: () => {}, message: () => {} },
}));

import type {
  OkDesktopBridge,
  OkFolderState,
  OkMcpWiringEditorId,
} from '@/lib/desktop-bridge-types';
import { CreateProjectDialog } from './CreateProjectDialog';

type WindowGlobals = {
  NodeFilter?: typeof NodeFilter;
};
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & {
    window?: WindowGlobals;
    ResizeObserver?: unknown;
  };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const PARENT = '/Users/test/Projects';
const PROJECT_NAME = 'Runtime Project';
const SECOND_PARENT = '/Users/test/OtherProjects';

function makeBridge() {
  let pickedParent: string | null = PARENT;
  let defaultRootImpl = (): Promise<string> => Promise.resolve(PARENT);
  let folderStateImpl = async (_path: string): Promise<OkFolderState> => 'free';
  let createNewImpl = (): Promise<void> => Promise.resolve();
  const openFolderArgs: unknown[] = [];
  const folderStateCalls: string[] = [];
  const bannerCalls: string[] = [];
  const createNewCalls: Array<{
    parent: string;
    name: string;
    editors: OkMcpWiringEditorId[];
    sharing: 'shared' | 'local-only';
  }> = [];

  const bridge = {
    fs: {
      defaultProjectsRoot: mock(() => defaultRootImpl()),
      findEnclosingProjectRoot: mock(() => Promise.resolve(null)),
      findEnclosingGitRoot: mock(() => Promise.resolve(null)),
      folderState: mock((path: string) => {
        folderStateCalls.push(path);
        return folderStateImpl(path);
      }),
      removeGitFolder: mock(() => Promise.resolve()),
    },
    dialog: {
      openFolder: mock((options?: unknown) => {
        openFolderArgs.push(options);
        return Promise.resolve(pickedParent);
      }),
    },
    project: {
      recordCreateNewBannerShown: mock((banner: string) => {
        bannerCalls.push(banner);
        return Promise.resolve();
      }),
      createNew: mock(
        (payload: {
          parent: string;
          name: string;
          editors: OkMcpWiringEditorId[];
          sharing: 'shared' | 'local-only';
        }) => {
          createNewCalls.push(payload);
          return createNewImpl();
        },
      ),
      open: mock(() => Promise.resolve()),
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    bannerCalls,
    createNewCalls,
    folderStateCalls,
    openFolderArgs,
    setPickedParent: (next: string | null) => {
      pickedParent = next;
    },
    setDefaultProjectsRootImpl: (next: () => Promise<string>) => {
      defaultRootImpl = next;
    },
    setFolderStateImpl: (next: (path: string) => Promise<OkFolderState>) => {
      folderStateImpl = next;
    },
    setCreateNewImpl: (next: () => Promise<void>) => {
      createNewImpl = next;
    },
  };
}

async function renderDialog(stub = makeBridge()) {
  const onOpenChange = mock(() => {});
  render(<CreateProjectDialog open={true} onOpenChange={onOpenChange} bridge={stub.bridge} />);
  await screen.findByTestId('create-project-dialog');
  return { ...stub, onOpenChange };
}

async function waitForLocationHydrate(expected = PARENT) {
  await waitFor(
    () => {
      expect(screen.getByTestId('create-location-display').textContent).toContain(expected);
    },
    { timeout: 2000 },
  );
}

async function typeProjectName(value: string) {
  const input = screen.getByTestId('create-name') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

async function waitForSubmitEnabled() {
  await waitFor(
    () => {
      expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
    },
    { timeout: 2000 },
  );
}

describe('CreateProjectDialog runtime wiring', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test('name input is first and submit posts {parent, name} derived from the two fields', async () => {
    const stub = await renderDialog();

    const form = screen.getByTestId('create-project-form') as HTMLFormElement;
    const cancel = screen.getByTestId('create-cancel') as HTMLButtonElement;
    const submit = screen.getByTestId('create-submit') as HTMLButtonElement;
    const browse = screen.getByTestId('create-browse') as HTMLButtonElement;
    const nameInput = screen.getByTestId('create-name') as HTMLInputElement;

    expect(cancel.type).toBe('button');
    expect(submit.type).toBe('submit');
    expect(submit.getAttribute('form')).toBe(form.id);
    expect(browse.type).toBe('button');
    expect(nameInput.tagName).toBe('INPUT');

    // The Name input is the FIRST focusable form control: it precedes
    // Browse in document order.
    const formInputs = Array.from(
      form.querySelectorAll('input, button, [role="checkbox"], [role="radio"]'),
    ) as HTMLElement[];
    const nameIndex = formInputs.indexOf(nameInput);
    const browseIndex = formInputs.indexOf(browse);
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(browseIndex).toBeGreaterThan(nameIndex);

    await waitForLocationHydrate();

    // Config sharing and the editor controls both live inside the collapsed
    // "Advanced settings" section (Radix unmounts collapsed content), so
    // neither is in the DOM until the section is expanded.
    expect(screen.queryByTestId('create-sharing')).toBeNull();
    expect(screen.queryByTestId('create-editor-cursor')).toBeNull();
    fireEvent.click(screen.getByTestId('create-advanced-trigger'));
    expect(screen.getByTestId('create-sharing')).not.toBeNull();

    for (const id of ALL_EDITOR_IDS) {
      const checkbox = screen.getByTestId(`create-editor-${id}`);
      expect(checkbox.closest('label')?.textContent).toContain(EDITOR_LABELS[id]);
      expect(checkbox.getAttribute('aria-checked')).toBe('true');
    }

    fireEvent.click(screen.getByTestId('create-editor-cursor'));
    expect(screen.getByTestId('create-editor-cursor').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(cancel);
    expect(stub.onOpenChange).toHaveBeenCalledWith(false);
    expect(stub.createNewCalls).toEqual([]);

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(stub.createNewCalls).toEqual([
        {
          parent: PARENT,
          name: PROJECT_NAME,
          editors: ALL_EDITOR_IDS.filter((id) => id !== 'cursor'),
          sharing: 'shared',
        },
      ]);
    });
    expect(stub.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  test('reopening the dialog re-collapses Advanced so sharing is hidden again', async () => {
    // Sharing now lives inside Advanced, so "the dialog leads with just name +
    // location" depends on the on-open reset collapsing Advanced every time.
    // Guard it: expand once, close, reopen, and assert the sharing control is
    // gone again (not left mounted from the prior expand).
    const stub = makeBridge();
    const onOpenChange = mock(() => {});
    const { rerender } = render(
      <CreateProjectDialog open={true} onOpenChange={onOpenChange} bridge={stub.bridge} />,
    );
    await screen.findByTestId('create-project-dialog');
    await waitForLocationHydrate();

    fireEvent.click(screen.getByTestId('create-advanced-trigger'));
    expect(screen.getByTestId('create-sharing')).not.toBeNull();

    rerender(<CreateProjectDialog open={false} onOpenChange={onOpenChange} bridge={stub.bridge} />);
    rerender(<CreateProjectDialog open={true} onOpenChange={onOpenChange} bridge={stub.bridge} />);
    await screen.findByTestId('create-project-dialog');

    await waitFor(() => {
      expect(screen.queryByTestId('create-sharing')).toBeNull();
    });
    expect(screen.getByTestId('create-advanced-trigger')).not.toBeNull();
  });

  test('Location hydrates from defaultProjectsRoot and Browse picks a fresh parent', async () => {
    const stub = await renderDialog();

    // Hydrated on open.
    await waitForLocationHydrate();
    const displayInitial = screen.getByTestId('create-location-display').textContent ?? '';
    expect(displayInitial).toContain(PARENT);

    // Browse picks the parent — display updates, name is untouched.
    stub.setPickedParent(SECOND_PARENT);
    fireEvent.click(screen.getByTestId('create-browse'));
    await waitFor(
      () => {
        expect(screen.getByTestId('create-location-display').textContent).toContain(SECOND_PARENT);
      },
      { timeout: 2000 },
    );
    expect((screen.getByTestId('create-name') as HTMLInputElement).value).toBe('');

    // Browse passed the prior location as the picker's defaultPath hint.
    expect(stub.openFolderArgs.at(-1)).toEqual({ defaultPath: PARENT });
  });

  test('live caption shows "Will be created at: <location>/<sanitized>" while name non-empty', async () => {
    await renderDialog();
    await waitForLocationHydrate();

    const caption = screen.getByTestId('create-target-caption');
    // Hidden when name is empty.
    expect(caption.textContent ?? '').toBe('');

    await typeProjectName('Plant Care');
    await waitFor(
      () => {
        expect(screen.getByTestId('create-target-caption').textContent).toContain(
          `${PARENT}/Plant Care`,
        );
      },
      { timeout: 2000 },
    );

    // Clearing the name hides the caption again.
    await typeProjectName('');
    await waitFor(
      () => {
        expect(screen.getByTestId('create-target-caption').textContent ?? '').toBe('');
      },
      { timeout: 2000 },
    );
  });

  test('Create stays enabled with an empty name; click toasts hint and does not submit', async () => {
    toastErrorSpy.mockClear();
    const stub = await renderDialog();
    await waitForLocationHydrate();

    const submit = screen.getByTestId('create-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toastErrorSpy).toHaveBeenCalledWith('Enter a project name');
    expect(stub.createNewCalls).toEqual([]);
    expect(stub.onOpenChange).not.toHaveBeenCalled();
  });

  test('selecting Local only carries through to the createNew payload', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();

    // Sharing now lives inside "Advanced settings" — expand it before the radio
    // is in the DOM.
    fireEvent.click(screen.getByTestId('create-advanced-trigger'));
    await userEvent.click(screen.getByTestId('create-sharing-local-only'));

    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.sharing).toBe('local-only');
  });

  test('name resolving to a non-empty folder shows inline name-taken error and disables Create', async () => {
    const stub = makeBridge();
    const TAKEN_NAME = 'Existing Notes';
    stub.setFolderStateImpl(async (path) =>
      path === `${PARENT}/${TAKEN_NAME}` ? 'exists-nonempty' : 'free',
    );
    await renderDialog(stub);
    await waitForLocationHydrate();

    await typeProjectName(TAKEN_NAME);

    await waitFor(
      () => {
        expect(screen.queryByTestId('create-name-error-taken')).not.toBeNull();
        expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
      },
      { timeout: 2000 },
    );
    // No standalone subfolder-rescue mounts.
    expect(screen.queryByTestId('create-subfolder-rescue')).toBeNull();
    // Telemetry still fires for the nonempty banner kind.
    expect(stub.bannerCalls).toContain('nonempty');

    // Typing a different name clears the inline error.
    await typeProjectName('Fresh Name');
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-name-error-taken')).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  test('name that sanitizes to empty shows inline sanitize-erased error and disables Create', async () => {
    await renderDialog();
    await waitForLocationHydrate();

    await typeProjectName('....');
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-name-error-erased')).not.toBeNull();
        expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  test('name field a11y: aria-invalid and aria-describedby compose the validation announcement', async () => {
    const stub = makeBridge();
    const TAKEN = 'Existing Notes';
    stub.setFolderStateImpl(async (path) =>
      path === `${PARENT}/${TAKEN}` ? 'exists-nonempty' : 'free',
    );
    await renderDialog(stub);
    await waitForLocationHydrate();

    const nameInput = screen.getByTestId('create-name') as HTMLInputElement;

    // A valid name is not flagged invalid and is described only by the live
    // resolved-path caption (so AT announces the target path as the user types).
    await typeProjectName('Fresh Name');
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('false');
    });
    const captionId = screen.getByTestId('create-target-caption').id;
    expect(captionId).not.toBe('');
    expect(nameInput.getAttribute('aria-describedby')).toBe(captionId);

    // A name colliding with a non-empty sibling folder is flagged invalid, and
    // describedby appends the role="alert" error so AT announces caption + error.
    await typeProjectName(TAKEN);
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    });
    const takenError = screen.getByTestId('create-name-error-taken');
    expect(takenError.getAttribute('role')).toBe('alert');
    const describedBy = (nameInput.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain(captionId);
    expect(describedBy).toContain(takenError.id);

    // A name that sanitizes to empty is likewise flagged invalid with a
    // role="alert" error.
    await typeProjectName('....');
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByTestId('create-name-error-erased').getAttribute('role')).toBe('alert');
  });

  test('clicking the config-sharing info tooltip does not submit the form', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    // The info trigger lives in the sharing field inside "Advanced settings" —
    // expand the section first so it's in the DOM.
    fireEvent.click(screen.getByTestId('create-advanced-trigger'));
    const info = screen.getByTestId('config-sharing-info') as HTMLButtonElement;
    // A trigger that renders a <button> inside a <form> defaults to
    // type="submit" — it MUST be type="button" or it fires the form.
    expect(info.type).toBe('button');

    fireEvent.click(info);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.createNewCalls).toEqual([]);
    expect(stub.onOpenChange).not.toHaveBeenCalled();
  });

  test('a diverging name shows the non-blocking "Will be saved as" hint and keeps Create enabled', async () => {
    await renderDialog();
    await waitForLocationHydrate();

    // A slash is rewritten to a dash by sanitizeFolderName — valid but
    // diverged, so the muted "Will be saved as <sanitized>" hint appears
    // while Create stays usable (the divergence is informational, not a block).
    await typeProjectName('Plant/Care');

    await waitFor(
      () => {
        const hint = screen.queryByTestId('create-name-hint-diverged');
        expect(hint).not.toBeNull();
        expect(hint?.textContent).toContain('Plant-Care');
      },
      { timeout: 2000 },
    );
    // The caption shows the sanitized target and submit is not blocked.
    expect(screen.getByTestId('create-target-caption').textContent).toContain(
      `${PARENT}/Plant-Care`,
    );
    await waitForSubmitEnabled();

    // The diverged hint is a polite status (non-blocking), NOT a role="alert"
    // error, and is wired into the name input's aria-describedby so AT
    // announces the caption plus the "Will be saved as" hint. aria-invalid
    // stays false — divergence is informational, not a validation failure.
    const divergedHint = screen.getByTestId('create-name-hint-diverged');
    expect(divergedHint.getAttribute('role')).toBe('status');
    const divergedNameInput = screen.getByTestId('create-name') as HTMLInputElement;
    expect(divergedNameInput.getAttribute('aria-invalid')).toBe('false');
    const divergedDescribedBy = (divergedNameInput.getAttribute('aria-describedby') ?? '').split(
      ' ',
    );
    expect(divergedDescribedBy).toContain(divergedHint.id);
    expect(divergedDescribedBy).toContain(screen.getByTestId('create-target-caption').id);

    // Clearing the name removes the hint.
    await typeProjectName('');
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-name-hint-diverged')).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  test('Location shows actionable copy (not a stuck spinner) when defaultProjectsRoot rejects; Browse still works', async () => {
    const stub = makeBridge();
    stub.setDefaultProjectsRootImpl(() => Promise.reject(new Error('no default root')));
    await renderDialog(stub);

    // Once the rejected probe settles, the field must stop claiming it is
    // still "Resolving" — that present-participle implies in-flight work that
    // has actually finished and failed. It shows actionable empty-state copy.
    await waitFor(
      () => {
        const display = screen.getByTestId('create-location-display').textContent ?? '';
        expect(display).not.toContain('Resolving default location');
        expect(display).toContain('No location selected');
      },
      { timeout: 2000 },
    );

    // Browse is still usable from the empty Location and updates the field.
    stub.setPickedParent(SECOND_PARENT);
    fireEvent.click(screen.getByTestId('create-browse'));
    await waitFor(
      () => {
        expect(screen.getByTestId('create-location-display').textContent).toContain(SECOND_PARENT);
      },
      { timeout: 2000 },
    );
  });

  test('createNew failure surfaces the inline error strip, keeps the dialog open, and re-enables Create', async () => {
    const stub = makeBridge();
    // The IPC rejects with a reason-prefixed message — Electron strips the
    // Error subclass over IPC, so the renderer recovers the reason from text.
    stub.setCreateNewImpl(() =>
      Promise.reject(
        new Error(`target-not-empty: Target folder is not empty: ${PARENT}/${PROJECT_NAME}`),
      ),
    );
    const { onOpenChange } = await renderDialog(stub);
    await waitForLocationHydrate();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));

    // The reason-mapped inline strip renders as a role="alert"; the dialog
    // stays open (onOpenChange(false) only fires on the success path).
    await waitFor(() => {
      expect(screen.queryByTestId('create-submit-error')).not.toBeNull();
    });
    expect(screen.getByTestId('create-submit-error').getAttribute('role')).toBe('alert');
    expect(stub.createNewCalls).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Create re-enables for retry — the catch resets `busy`. Without that
    // reset the dialog would freeze with every control disabled and no recovery.
    await waitFor(() => {
      expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test('while createNew is in-flight the busy guard blocks dialog dismissal until it settles', async () => {
    const stub = makeBridge();
    // Hold createNew pending so `busy` stays true after submit; capture the
    // resolver so we can release it and confirm dismissal works again after.
    let releaseCreate: () => void = () => {};
    stub.setCreateNewImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const { onOpenChange } = await renderDialog(stub);
    await waitForLocationHydrate();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));

    // In-flight: the submit button flips to its busy label and disables.
    await waitFor(() => {
      expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
    });

    // Requesting dismissal via the close (X) control is a no-op while busy:
    // onOpenChangeInternal's `if (busy) return` swallows it, so the parent's
    // onOpenChange is never told to close.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Once the in-flight call resolves, the success path closes the dialog —
    // proving the guard gates on `busy`, not a permanent block.
    releaseCreate();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
