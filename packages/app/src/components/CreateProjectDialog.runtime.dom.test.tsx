import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const toastErrorSpy = vi.fn((_message: string) => {});
vi.doMock('sonner', () => ({
  toast: { error: toastErrorSpy, success: () => {}, warning: () => {}, message: () => {} },
}));

import type {
  OkDesktopBridge,
  OkFolderState,
  OkMcpWiringEditorId,
  OkSeedPackInfo,
} from '@/lib/desktop-bridge-types';

const PACKS: OkSeedPackInfo[] = [
  {
    id: 'plain-notes',
    name: 'Plain notes',
    description: 'A single flat folder for quick notes.',
    folders: [],
    entryCounts: { files: 2, folders: 1 },
  },
  {
    id: 'knowledge-base',
    name: 'Knowledge base',
    description: 'Structured folders for a team wiki.',
    folders: [],
    entryCounts: { files: 8, folders: 4 },
  },
];

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

const DETECTED: OkMcpWiringEditorId[] = ['claude', 'cursor'];
const UNDETECTED: OkMcpWiringEditorId = 'codex';

function makeBridge() {
  let pickedParent: string | null = PARENT;
  let detectedEditorIdsImpl = (): Promise<OkMcpWiringEditorId[]> => Promise.resolve([...DETECTED]);
  let editorStatesImpl = (): Array<{
    id: OkMcpWiringEditorId;
    label: string;
    detected: boolean;
    state: 'installed' | 'not-installed' | 'foreign' | 'unmanageable';
    configPath: string | null;
    entryLocator: string;
  }> => [];
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
    packId?: string;
  }> = [];

  const bridge = {
    fs: {
      defaultProjectsRoot: vi.fn(() => defaultRootImpl()),
      findEnclosingProjectRoot: vi.fn(() => Promise.resolve(null)),
      findEnclosingGitRoot: vi.fn(() => Promise.resolve(null)),
      folderState: vi.fn((path: string) => {
        folderStateCalls.push(path);
        return folderStateImpl(path);
      }),
      removeGitFolder: vi.fn(() => Promise.resolve()),
    },
    dialog: {
      openFolder: vi.fn((options?: unknown) => {
        openFolderArgs.push(options);
        return Promise.resolve(pickedParent);
      }),
    },
    integrations: {
      status: vi.fn(async () => ({
        available: true,
        editors: editorStatesImpl(),
        path: { shellDetected: false, rcFilesToTouch: [], installed: false },
        skills: [],
        detectedEditorIds: await detectedEditorIdsImpl(),
      })),
      setComponent: vi.fn(),
    },
    project: {
      recordCreateNewBannerShown: vi.fn((banner: string) => {
        bannerCalls.push(banner);
        return Promise.resolve();
      }),
      createNew: vi.fn(
        (payload: {
          parent: string;
          name: string;
          editors: OkMcpWiringEditorId[];
          sharing: 'shared' | 'local-only';
          packId?: string;
        }) => {
          createNewCalls.push(payload);
          return createNewImpl();
        },
      ),
      open: vi.fn(() => Promise.resolve()),
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
    setDetectedEditorsImpl: (next: () => Promise<OkMcpWiringEditorId[]>) => {
      detectedEditorIdsImpl = next;
    },
    setEditorStatesImpl: (next: typeof editorStatesImpl) => {
      editorStatesImpl = next;
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
  const onOpenChange = vi.fn(() => {});
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

const { CreateProjectDialog } = await import('./CreateProjectDialog');

describe('CreateProjectDialog runtime wiring', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test('the AI-tools row is always visible, names the detected tools, and rides along on submit', async () => {
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

    const formInputs = Array.from(
      form.querySelectorAll('input, button, [role="checkbox"], [role="radio"]'),
    ) as HTMLElement[];
    const nameIndex = formInputs.indexOf(nameInput);
    const browseIndex = formInputs.indexOf(browse);
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(browseIndex).toBeGreaterThan(nameIndex);

    await waitForLocationHydrate();

    expect(screen.queryByTestId('create-advanced-trigger')).toBeNull();
    expect(screen.getByTestId('create-sharing')).not.toBeNull();
    expect(screen.getByTestId('create-sharing-local-only').getAttribute('data-state')).toBe(
      'checked',
    );
    await waitFor(() => {
      expect(screen.getByTestId('create-editors-checkbox').getAttribute('aria-checked')).toBe(
        'true',
      );
    });

    expect(screen.getByTestId('create-editors-title').textContent).toBe(
      'Connect your AI tools to this project',
    );

    const summary = screen.getByTestId('create-editors-summary').textContent ?? '';
    for (const id of DETECTED) expect(summary).toContain(EDITOR_LABELS[id]);
    expect(summary).not.toContain(EDITOR_LABELS[UNDETECTED]);
    expect(screen.queryByTestId(`create-editor-${UNDETECTED}`)).toBeNull();

    await userEvent.click(screen.getByTestId('create-editors-details-toggle'));
    const details = await screen.findByTestId('create-editors-details');
    expect(details.tagName).toBe('UL');
    expect(details.querySelectorAll(':scope > li').length).toBe(DETECTED.length);
    expect(details.textContent).toContain('.mcp.json');
    expect(details.textContent).toContain('.claude/skills/open-knowledge/');
    expect(details.textContent).toContain('.cursor/mcp.json');
    await userEvent.keyboard('{Escape}');

    fireEvent.click(cancel);
    expect(stub.onOpenChange).toHaveBeenCalledWith(false);
    expect(stub.createNewCalls).toEqual([]);

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    const submitted = stub.createNewCalls[0];
    expect(submitted?.parent).toBe(PARENT);
    expect(submitted?.name).toBe(PROJECT_NAME);
    expect(submitted?.sharing).toBe('local-only');
    expect([...(submitted?.editors ?? [])].sort()).toEqual([...DETECTED].sort());
    expect(stub.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  test('the straight-through path wires the detected editors', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect([...(stub.createNewCalls[0]?.editors ?? [])].sort()).toEqual([...DETECTED].sort());
  });

  test('unchecking the row creates the project without wiring anything', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    await waitFor(() => {
      expect(screen.queryByTestId('create-editors-checkbox')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('create-editors-checkbox'));

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.editors).toEqual([]);
  });

  test('a detected user-global-only tool is neither named nor submitted', async () => {
    const stub = makeBridge();
    stub.setDetectedEditorsImpl(() => Promise.resolve(['claude', 'claude-desktop']));
    await renderDialog(stub);
    await waitForLocationHydrate();

    await waitFor(() => {
      expect(screen.queryByTestId('create-editors-checkbox')).not.toBeNull();
    });
    const summary = screen.getByTestId('create-editors-summary').textContent ?? '';
    expect(summary).toContain(EDITOR_LABELS.claude);
    expect(summary).not.toContain(EDITOR_LABELS['claude-desktop']);

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.editors).toEqual(['claude']);
  });

  test('Copilot is dropped until its user-global entry exists, then included', async () => {
    const withoutEntry = makeBridge();
    withoutEntry.setDetectedEditorsImpl(() => Promise.resolve(['claude', 'copilot']));
    await renderDialog(withoutEntry);
    await waitForLocationHydrate();
    await waitFor(() => {
      expect(screen.queryByTestId('create-editors-checkbox')).not.toBeNull();
    });
    expect(screen.getByTestId('create-editors-summary').textContent ?? '').not.toContain(
      EDITOR_LABELS.copilot,
    );

    cleanup();

    const withEntry = makeBridge();
    withEntry.setDetectedEditorsImpl(() => Promise.resolve(['claude', 'copilot']));
    withEntry.setEditorStatesImpl(() => [
      {
        id: 'copilot',
        label: EDITOR_LABELS.copilot,
        detected: true,
        state: 'installed',
        configPath: '~/.copilot/mcp-config.json',
        entryLocator: 'mcpServers.open-knowledge',
      },
    ]);
    await renderDialog(withEntry);
    await waitForLocationHydrate();
    await waitFor(() => {
      expect(screen.getByTestId('create-editors-summary').textContent ?? '').toContain(
        EDITOR_LABELS.copilot,
      );
    });

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(withEntry.createNewCalls).toHaveLength(1);
    });
    expect([...(withEntry.createNewCalls[0]?.editors ?? [])].sort()).toEqual(['claude', 'copilot']);
  });

  test('a foreign Copilot entry is treated as not-connected', async () => {
    const stub = makeBridge();
    stub.setDetectedEditorsImpl(() => Promise.resolve(['claude', 'copilot']));
    stub.setEditorStatesImpl(() => [
      {
        id: 'copilot',
        label: EDITOR_LABELS.copilot,
        detected: true,
        state: 'foreign',
        configPath: '~/.copilot/mcp-config.json',
        entryLocator: 'mcpServers.open-knowledge',
      },
    ]);
    await renderDialog(stub);
    await waitForLocationHydrate();

    await waitFor(() => {
      expect(screen.queryByTestId('create-editors-checkbox')).not.toBeNull();
    });
    expect(screen.getByTestId('create-editors-summary').textContent ?? '').not.toContain(
      EDITOR_LABELS.copilot,
    );

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.editors).toEqual(['claude']);
  });

  test('Create stays blocked while detection is in flight, so no project is wired to nothing', async () => {
    let releaseDetection = (): void => {};
    const stub = makeBridge();
    stub.setDetectedEditorsImpl(
      () =>
        new Promise<OkMcpWiringEditorId[]>((resolve) => {
          releaseDetection = () => resolve([...DETECTED]);
        }),
    );
    await renderDialog(stub);
    await waitForLocationHydrate();
    await typeProjectName(PROJECT_NAME);

    await waitFor(() => {
      expect(screen.getByTestId('create-editors-status').getAttribute('data-status')).toBe(
        'probing',
      );
    });
    expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);

    releaseDetection();
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect([...(stub.createNewCalls[0]?.editors ?? [])].sort()).toEqual([...DETECTED].sort());
  });

  test('a failed detection probe settles empty rather than guessing', async () => {
    const stub = makeBridge();
    stub.setDetectedEditorsImpl(() => Promise.reject(new Error('detection blew up')));
    await renderDialog(stub);
    await waitForLocationHydrate();

    await waitFor(() => {
      expect(screen.getByTestId('create-editors-status').getAttribute('data-status')).toBe('none');
    });
    expect(screen.queryByTestId('create-editors-checkbox')).toBeNull();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.editors).toEqual([]);
  });

  test('an in-flight probe shows a checking state, and a late result cannot flip the answer', async () => {
    let releaseDetection = (): void => {};
    const stub = makeBridge();
    stub.setDetectedEditorsImpl(
      () =>
        new Promise<OkMcpWiringEditorId[]>((resolve) => {
          releaseDetection = () => resolve([...DETECTED]);
        }),
    );
    await renderDialog(stub);
    await waitForLocationHydrate();

    expect(screen.getByTestId('create-editors-status').getAttribute('data-status')).toBe('probing');
    expect(screen.queryByTestId('create-editors-checkbox')).toBeNull();

    releaseDetection();
    await waitFor(() => {
      expect(screen.queryByTestId('create-editors-checkbox')).not.toBeNull();
    });
    expect(screen.getByTestId('create-editors-status').getAttribute('data-status')).toBe('ready');
    fireEvent.click(screen.getByTestId('create-editors-checkbox'));
    expect(screen.getByTestId('create-editors-checkbox').getAttribute('aria-checked')).toBe(
      'false',
    );

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.editors).toEqual([]);
  });

  test('reopening the dialog resets sharing to the "Only me" default', async () => {
    const stub = makeBridge();
    const onOpenChange = vi.fn(() => {});
    const { rerender } = render(
      <CreateProjectDialog open={true} onOpenChange={onOpenChange} bridge={stub.bridge} />,
    );
    await screen.findByTestId('create-project-dialog');
    await waitForLocationHydrate();

    await userEvent.click(screen.getByTestId('create-sharing-shared'));
    expect(screen.getByTestId('create-sharing-shared').getAttribute('data-state')).toBe('checked');

    rerender(<CreateProjectDialog open={false} onOpenChange={onOpenChange} bridge={stub.bridge} />);
    rerender(<CreateProjectDialog open={true} onOpenChange={onOpenChange} bridge={stub.bridge} />);
    await screen.findByTestId('create-project-dialog');

    await waitFor(() => {
      expect(screen.getByTestId('create-sharing-local-only').getAttribute('data-state')).toBe(
        'checked',
      );
    });
  });

  test('Location hydrates from defaultProjectsRoot and Browse picks a fresh parent', async () => {
    const stub = await renderDialog();

    await waitForLocationHydrate();
    const displayInitial = screen.getByTestId('create-location-display').textContent ?? '';
    expect(displayInitial).toContain(PARENT);

    stub.setPickedParent(SECOND_PARENT);
    fireEvent.click(screen.getByTestId('create-browse'));
    await waitFor(
      () => {
        expect(screen.getByTestId('create-location-display').textContent).toContain(SECOND_PARENT);
      },
      { timeout: 2000 },
    );
    expect((screen.getByTestId('create-name') as HTMLInputElement).value).toBe('');

    expect(stub.openFolderArgs.at(-1)).toEqual({ defaultPath: PARENT });
  });

  test('live caption shows "Will be created at: <location>/<sanitized>" while name non-empty', async () => {
    await renderDialog();
    await waitForLocationHydrate();

    const caption = screen.getByTestId('create-target-caption');
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

  test('selecting Shared carries through to the createNew payload', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();

    await userEvent.click(screen.getByTestId('create-sharing-shared'));

    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.sharing).toBe('shared');
  });

  test('a pre-selected pack threads packId through to the createNew payload', async () => {
    const stub = makeBridge();
    const onOpenChange = vi.fn(() => {});
    render(
      <CreateProjectDialog
        open={true}
        onOpenChange={onOpenChange}
        bridge={stub.bridge}
        initialPackId="plain-notes"
        packs={PACKS}
      />,
    );
    await screen.findByTestId('create-project-dialog');
    fireEvent.click(await screen.findByTestId('create-review-continue'));
    await waitForLocationHydrate();

    expect(screen.getByTestId('create-project-dialog').textContent).toContain('Plain notes');

    await typeProjectName(PROJECT_NAME);
    await waitForSubmitEnabled();

    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(stub.createNewCalls).toHaveLength(1);
    });
    expect(stub.createNewCalls[0]?.packId).toBe('plain-notes');
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
    expect(screen.queryByTestId('create-subfolder-rescue')).toBeNull();
    expect(stub.bannerCalls).toContain('nonempty');

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

    await typeProjectName('Fresh Name');
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('false');
    });
    const captionId = screen.getByTestId('create-target-caption').id;
    expect(captionId).not.toBe('');
    expect(nameInput.getAttribute('aria-describedby')).toBe(captionId);

    await typeProjectName(TAKEN);
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    });
    const takenError = screen.getByTestId('create-name-error-taken');
    expect(takenError.getAttribute('role')).toBe('alert');
    const describedBy = (nameInput.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain(captionId);
    expect(describedBy).toContain(takenError.id);

    await typeProjectName('....');
    await waitFor(() => {
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByTestId('create-name-error-erased').getAttribute('role')).toBe('alert');
  });

  test('clicking the config-sharing info tooltip does not submit the form', async () => {
    const stub = await renderDialog();
    await waitForLocationHydrate();

    const info = screen.getByTestId('config-sharing-info') as HTMLButtonElement;
    expect(info.type).toBe('button');

    fireEvent.click(info);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.createNewCalls).toEqual([]);
    expect(stub.onOpenChange).not.toHaveBeenCalled();
  });

  test('a diverging name shows the non-blocking "Will be saved as" hint and keeps Create enabled', async () => {
    await renderDialog();
    await waitForLocationHydrate();

    await typeProjectName('Plant/Care');

    await waitFor(
      () => {
        const hint = screen.queryByTestId('create-name-hint-diverged');
        expect(hint).not.toBeNull();
        expect(hint?.textContent).toContain('Plant-Care');
      },
      { timeout: 2000 },
    );
    expect(screen.getByTestId('create-target-caption').textContent).toContain(
      `${PARENT}/Plant-Care`,
    );
    await waitForSubmitEnabled();

    const divergedHint = screen.getByTestId('create-name-hint-diverged');
    expect(divergedHint.getAttribute('role')).toBe('status');
    const divergedNameInput = screen.getByTestId('create-name') as HTMLInputElement;
    expect(divergedNameInput.getAttribute('aria-invalid')).toBe('false');
    const divergedDescribedBy = (divergedNameInput.getAttribute('aria-describedby') ?? '').split(
      ' ',
    );
    expect(divergedDescribedBy).toContain(divergedHint.id);
    expect(divergedDescribedBy).toContain(screen.getByTestId('create-target-caption').id);

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

    await waitFor(
      () => {
        const display = screen.getByTestId('create-location-display').textContent ?? '';
        expect(display).not.toContain('Resolving default location');
        expect(display).toContain('No location selected');
      },
      { timeout: 2000 },
    );

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

    await waitFor(() => {
      expect(screen.queryByTestId('create-submit-error')).not.toBeNull();
    });
    expect(screen.getByTestId('create-submit-error').getAttribute('role')).toBe('alert');
    expect(stub.createNewCalls).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await waitFor(() => {
      expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test('while createNew is in-flight the busy guard blocks dialog dismissal until it settles', async () => {
    const stub = makeBridge();
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

    await waitFor(() => {
      expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    releaseCreate();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
