import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { OkShareReceivedPayload } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type SharePayload = OkShareReceivedPayload | null;

function createTestStore(initial: SharePayload) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    dismiss: mock(() => {
      current = null;
      for (const listener of listeners) listener();
    }),
    getSnapshot: () => current,
    install: () => undefined,
    set(next: SharePayload) {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function okPayload(
  overrides: Partial<Extract<OkShareReceivedPayload, { kind: 'launcher-miss' }>['share']> = {},
): Extract<OkShareReceivedPayload, { kind: 'launcher-miss' }> {
  return {
    kind: 'launcher-miss',
    share: {
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/guide.md',
      target: { kind: 'doc', docPath: 'docs/guide.md' },
      ...overrides,
    },
  };
}

const toast = {
  error: mock((_message: string, _opts?: unknown) => {}),
  info: mock((_message: string, _opts?: unknown) => {}),
  success: mock((_message: string, _opts?: unknown) => {}),
};

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('sonner', () => ({
  toast,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({
    children,
    className: _className,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
    variant?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    onInteractOutside: _onInteractOutside,
    onPointerDownOutside: _onPointerDownOutside,
    ...props
  }: {
    children?: ReactNode;
    onInteractOutside?: unknown;
    onPointerDownOutside?: unknown;
    [key: string]: unknown;
  }) => <section {...props}>{children}</section>,
  DialogDescription: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

function createBridge() {
  const folderPicks: Array<string | null> = [];
  const validationResults: unknown[] = [];
  return {
    __folderPicks: folderPicks,
    __validationResults: validationResults,
    dialog: {
      openFolder: mock(() => Promise.resolve(folderPicks.shift() ?? null)),
    },
    navigator: {
      open: mock(() => Promise.resolve()),
    },
    project: {
      awaitBranchSwitched: mock(() => Promise.resolve({ ok: true as const })),
      checkDocExists: mock(() => Promise.resolve('exists')),
      fetchBranchInfo: mock(() =>
        Promise.resolve({
          branchIsLocal: true,
          currentBranch: 'main',
          currentHeadSha: null,
          detached: false,
          dirtyConflicts: { conflicts: false, files: [] },
          shareFileExists: true,
        }),
      ),
      listRecent: mock(() => Promise.resolve([])),
      open: mock(() => Promise.resolve()),
      readHeadBranch: mock(() =>
        Promise.resolve({ currentBranch: 'main', detached: false, headSha: null }),
      ),
      runCheckout: mock(() => Promise.resolve({ ok: true as const })),
    },
    share: {
      validateLocalFolder: mock(() =>
        Promise.resolve(validationResults.shift() ?? { kind: 'ok', gitRemoteUrl: '' }),
      ),
    },
  };
}

async function renderDialog({
  bridge = createBridge(),
  cloneController,
  store = createTestStore(okPayload()),
}: {
  bridge?: ReturnType<typeof createBridge>;
  cloneController?: {
    getAuthStatus: () => Promise<{ authenticated: boolean; host: string; login?: string }>;
    runClone: (args: { url: string; branch?: string | null }) => Promise<unknown>;
    startSignIn: () => Promise<{ authenticated: boolean; host: string; login?: string } | null>;
  };
  store?: ReturnType<typeof createTestStore>;
} = {}) {
  const { ShareReceiveDialog } = await import('./ShareReceiveDialog');
  render(
    <ShareReceiveDialog
      bridge={bridge as never}
      cloneController={cloneController as never}
      store={store as never}
    />,
  );
  return { bridge, store };
}

describe('ShareReceiveDialog runtime behavior', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    for (const fn of [toast.error, toast.info, toast.success]) fn.mockClear();
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('exports the named component through a runtime import', async () => {
    const mod = await import('./ShareReceiveDialog');
    expect(typeof mod.ShareReceiveDialog).toBe('function');
  });

  test('clone failure leaves the dialog mounted and the sign-in affordance visible', async () => {
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() => Promise.resolve({ kind: 'error' })),
      startSignIn: mock(() => Promise.resolve(null)),
    };

    await renderDialog({ cloneController });

    // Wait for the auth probe to resolve so the clone CTA becomes enabled.
    await waitFor(() =>
      expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByTestId('share-receive-clone'));
    await waitFor(() => expect(cloneController.runClone).toHaveBeenCalled());

    // After clone error the dialog stays mounted so the user can recover.
    expect(screen.getByTestId('share-receive-dialog')).toBeTruthy();
    // The sign-in affordance must remain visible — it is the primary recovery path
    // when anonymous clone fails (e.g. private fork, token required).
    expect(screen.getByTestId('share-receive-signin')).toBeTruthy();
  });

  test('clone failure surfaces a persistent in-dialog error view with the GitHub error, reasons, and recovery', async () => {
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() =>
        Promise.resolve({
          kind: 'error',
          detail: [
            "Cloning into '/Users/me/Documents/sharing-repo'...",
            'remote: Repository not found.',
            "fatal: repository 'https://github.com/inkeep/open-knowledge.git/' not found",
          ].join('\n'),
        }),
      ),
      startSignIn: mock(() => Promise.resolve(null)),
    };

    await renderDialog({ cloneController });

    await waitFor(() =>
      expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByTestId('share-receive-clone'));
    await waitFor(() => expect(cloneController.runClone).toHaveBeenCalled());

    // The failure is presented in a persistent error region, not a transient toast.
    await screen.findByTestId('share-receive-clone-error');
    // role="alert" is scoped to the concise heading, not the whole block, so AT
    // announces the one-line cause rather than the full card.
    expect(screen.getByRole('alert').textContent).toContain("We couldn't clone this repository");

    // The GitHub error is condensed to its meaningful line — no progress
    // preamble, no leaked local path, no repeated repo URL. The repo + filename
    // already live in the dialog header's metadata rows.
    const message = screen.getByTestId('share-receive-clone-error-message').textContent ?? '';
    expect(message).toContain('Error:');
    expect(message).toContain('Repository not found');
    expect(message).not.toMatch(/Cloning into/i);
    expect(message).not.toContain('/Users/me');
    expect(message).not.toContain('github.com/inkeep/open-knowledge');
    expect(screen.queryByTestId('share-receive-clone-error-url')).toBeNull();
    expect(screen.queryByTestId('share-receive-clone-error-detail')).toBeNull();

    // A list of likely causes, including the private-repo case the bug is about.
    expect(screen.getByTestId('share-receive-clone-error-reasons').textContent).toMatch(/private/i);

    // Recovery affordances stay available: retry + sign-in.
    expect(screen.getByTestId('share-receive-clone-retry')).toBeTruthy();
    expect(screen.getByTestId('share-receive-signin')).toBeTruthy();

    // The dialog (modal) is still mounted, not dismissed.
    expect(screen.getByTestId('share-receive-dialog')).toBeTruthy();
    // No transient error toast — the modal owns the presentation now.
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('clone error with no detail omits the error-message line but still shows the error view', async () => {
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() => Promise.resolve({ kind: 'error' })),
      startSignIn: mock(() => Promise.resolve(null)),
    };

    await renderDialog({ cloneController });
    await waitFor(() =>
      expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('share-receive-clone'));

    // The error view (reasons + recovery) still renders; only the GitHub-message
    // line is omitted when there's no message to show.
    await screen.findByTestId('share-receive-clone-error');
    expect(screen.getByTestId('share-receive-clone-error-reasons')).toBeTruthy();
    expect(screen.queryByTestId('share-receive-clone-error-message')).toBeNull();
  });

  test('"Try again" clears the error view and re-invokes the clone', async () => {
    let call = 0;
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() => {
        call += 1;
        return Promise.resolve(
          call === 1 ? { kind: 'error', detail: 'boom' } : { kind: 'cancelled' },
        );
      }),
      startSignIn: mock(() => Promise.resolve(null)),
    };

    await renderDialog({ cloneController });
    await waitFor(() =>
      expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('share-receive-clone'));

    const retry = await screen.findByTestId('share-receive-clone-retry');
    fireEvent.click(retry);

    await waitFor(() => expect(cloneController.runClone).toHaveBeenCalledTimes(2));
    // Second run returned 'cancelled' → the error view clears.
    await waitFor(() => expect(screen.queryByTestId('share-receive-clone-error')).toBeNull());
  });

  test('error view "I already have it locally" clears the error and opens the folder picker', async () => {
    const bridge = createBridge(); // openFolder returns null by default (user cancels)
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() => Promise.resolve({ kind: 'error', detail: 'boom' })),
      startSignIn: mock(() => Promise.resolve(null)),
    };

    await renderDialog({ bridge, cloneController });
    await waitFor(() =>
      expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('share-receive-clone'));

    const localBtn = await screen.findByTestId('share-receive-error-local');
    fireEvent.click(localBtn);

    // Entering the local path clears the clone-failure banner...
    await waitFor(() => expect(screen.queryByTestId('share-receive-clone-error')).toBeNull());
    // ...opens the native folder picker...
    await waitFor(() => expect(bridge.dialog.openFolder).toHaveBeenCalled());
    // ...and returns the user to the normal two-card view.
    expect(screen.getByTestId('share-receive-clone')).toBeTruthy();
  });

  test('non-ok payloads toast and dismiss without mounting the dialog', async () => {
    const store = createTestStore({ kind: 'invalid' });
    await renderDialog({ store });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid share URL.'));
    expect(store.dismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('share-receive-dialog')).toBeNull();
  });

  test('Q2 miss renders metadata, anonymous clone without sign-in, sign-in affordance, clone success, and local picker recovery', async () => {
    const bridge = createBridge();
    const store = createTestStore(okPayload({ branch: 'feat/share' }));
    const cloneController = {
      getAuthStatus: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
      runClone: mock(() => Promise.resolve({ kind: 'ok', dir: '/cloned/open-knowledge' })),
      startSignIn: mock(() =>
        Promise.resolve({ authenticated: true, host: 'github.com', login: 'alice' }),
      ),
    };
    bridge.__folderPicks.push('/wrong', '/right');
    bridge.__validationResults.push(
      { kind: 'wrong-repo', actualOwner: 'fork', actualRepo: 'repo' },
      { kind: 'ok', gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git' },
    );

    await renderDialog({ bridge, cloneController, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    expect(screen.getByTestId('share-receive-metadata').textContent).toContain(
      'inkeep/open-knowledge',
    );
    expect(screen.getByTestId('share-receive-metadata').textContent).toContain('docs/guide.md');
    expect(screen.getByTestId('share-receive-metadata-branch').textContent).toBe('feat/share');
    // Public repos clone anonymously: the clone CTA is enabled and labeled for
    // an immediate clone even though the auth probe resolved unauthenticated.
    await waitFor(() =>
      expect(screen.getByTestId('share-receive-clone').textContent).toContain(
        'Clone to a new folder',
      ),
    );
    expect((screen.getByTestId('share-receive-clone') as HTMLButtonElement).disabled).toBe(false);
    // The sign-in affordance remains available as the private-repo fallback.
    expect(await screen.findByTestId('share-receive-signin')).toBeTruthy();

    // Clicking Clone proceeds without first signing in.
    fireEvent.click(screen.getByTestId('share-receive-clone'));
    await waitFor(() =>
      expect(cloneController.runClone).toHaveBeenCalledWith({
        branch: 'feat/share',
        url: 'https://github.com/inkeep/open-knowledge.git',
      }),
    );
    await waitFor(() =>
      expect(bridge.project.open).toHaveBeenCalledWith({
        entryPoint: 'share-receive',
        path: '/cloned/open-knowledge',
        pendingDeepLinkTarget: { kind: 'doc', path: 'docs/guide.md' },
        target: 'new-window',
      }),
    );

    act(() => {
      store.set(okPayload({ branch: 'feat/share' }));
    });
    await screen.findByTestId('share-receive-dialog');
    fireEvent.click(screen.getByTestId('share-receive-local'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This folder is a clone of fork/repo, not inkeep/open-knowledge. Pick a different folder?',
      ),
    );
    // The located clone ('/right') is checked out on 'main', but the share is
    // for 'feat/share' — the receive flow must route to the branch-switch
    // surface rather than open the doc directly on the wrong branch.
    await waitFor(() => expect(bridge.project.readHeadBranch).toHaveBeenCalledWith('/right'));
    await waitFor(() => {
      const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
        path?: string;
        pendingDeepLinkTarget?: unknown;
        pendingShareBranchSwitch?: { projectPath?: string; currentBranch?: string | null };
      };
      expect(openArg.path).toBe('/right');
      expect(openArg.pendingShareBranchSwitch?.currentBranch).toBe('main');
      expect(openArg.pendingDeepLinkTarget).toBeUndefined();
    });
  });

  // "I already have it locally" must be branch-aware, symmetric with the
  // recent-projects path: when the located clone is on a different branch than
  // the share, route to the branch-switch surface instead of silently opening
  // the doc on the wrong branch.
  test('I have it locally: branch mismatch routes to the branch-switch surface, not a plain open', async () => {
    const bridge = createBridge();
    // Located clone HEAD is 'main' (createBridge default); the share is for
    // 'feat/share' — a mismatch.
    const store = createTestStore(okPayload({ branch: 'feat/share' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    // The flow must read the located folder's HEAD to make a branch decision.
    await waitFor(() => expect(bridge.project.readHeadBranch).toHaveBeenCalledWith('/local/clone'));

    // On mismatch it must open the project with a branch-switch payload (so the
    // editor window mounts ShareBranchSwitchDialog), NOT a plain deep-link open
    // on the current branch.
    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      path?: string;
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: {
        projectPath?: string;
        currentBranch?: string | null;
        share?: { owner?: string; repo?: string; branch?: string; target?: unknown };
      };
    };
    expect(openArg.path).toBe('/local/clone');
    expect(openArg.pendingShareBranchSwitch).toBeDefined();
    expect(openArg.pendingShareBranchSwitch?.projectPath).toBe('/local/clone');
    expect(openArg.pendingShareBranchSwitch?.currentBranch).toBe('main');
    // The `share` payload is what ShareBranchSwitchDialog uses to resolve the
    // target branch + doc; a dropped or partial share would pass the other
    // assertions while silently breaking the branch-switch UX.
    expect(openArg.pendingShareBranchSwitch?.share).toMatchObject({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat/share',
      target: { kind: 'doc', docPath: 'docs/guide.md' },
    });
    // A plain deep-link target would silently navigate on the wrong branch.
    expect(openArg.pendingDeepLinkTarget).toBeUndefined();
    expect(store.dismiss).toHaveBeenCalled();
  });

  test('I have it locally: branch match opens directly without a branch-switch', async () => {
    const bridge = createBridge();
    // Located clone HEAD is 'main' (createBridge default) and the share is for
    // 'main' — a match, so open straight to the doc with no branch-switch.
    const store = createTestStore(okPayload({ branch: 'main' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: unknown;
    };
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/guide.md' });
    expect(openArg.pendingShareBranchSwitch).toBeUndefined();
    // Guard the success path: a dropped store.dismiss() would leave a ghost
    // dialog over the newly opened project window.
    expect(store.dismiss).toHaveBeenCalled();
  });

  test('I have it locally: detached HEAD with a share branch routes to the branch-switch surface', async () => {
    const bridge = createBridge();
    const store = createTestStore(okPayload({ branch: 'feat/share' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    // Detached HEAD is not on the share's branch -> route to the switch surface.
    bridge.project.readHeadBranch = mock(() =>
      Promise.resolve({ currentBranch: null, detached: true, headSha: '1234567' }),
    );

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: {
        currentBranch?: string | null;
        share?: { branch?: string; target?: unknown };
      };
    };
    expect(openArg.pendingShareBranchSwitch).toBeDefined();
    expect(openArg.pendingShareBranchSwitch?.currentBranch).toBeNull();
    expect(openArg.pendingShareBranchSwitch?.share).toMatchObject({
      branch: 'feat/share',
      target: { kind: 'doc', docPath: 'docs/guide.md' },
    });
    expect(openArg.pendingDeepLinkTarget).toBeUndefined();
  });

  test('I have it locally: unreadable HEAD (all-null sentinel) opens directly, no needless switch', async () => {
    const bridge = createBridge();
    const store = createTestStore(okPayload({ branch: 'feat/share' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    // Graceful-fail sentinel (missing / unreadable .git/HEAD): classify as a
    // match so a single broken clone never forces a needless branch-switch
    // prompt — symmetric with the recents path's silent dispatch.
    bridge.project.readHeadBranch = mock(() =>
      Promise.resolve({ currentBranch: null, detached: false, headSha: null }),
    );

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: unknown;
    };
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/guide.md' });
    expect(openArg.pendingShareBranchSwitch).toBeUndefined();
    expect(store.dismiss).toHaveBeenCalled();
  });

  test('I have it locally: share with no branch opens directly', async () => {
    const bridge = createBridge();
    // Legacy share URL with no branch — always a plain open regardless of HEAD.
    const store = createTestStore(okPayload({ branch: '' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: unknown;
    };
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/guide.md' });
    expect(openArg.pendingShareBranchSwitch).toBeUndefined();
    expect(store.dismiss).toHaveBeenCalled();
  });

  test('I have it locally: readHeadBranch IPC rejection falls back to a plain open', async () => {
    const bridge = createBridge();
    const store = createTestStore(okPayload({ branch: 'feat/share' }));
    bridge.__folderPicks.push('/local/clone');
    bridge.__validationResults.push({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    // Distinct from the graceful-fail sentinel (a resolved all-null value):
    // an IPC-transport rejection hits the catch, which leaves the all-null
    // sentinel in place -> classifies as a match -> plain open, never a dead end.
    bridge.project.readHeadBranch = mock(() => Promise.reject(new Error('ipc channel closed')));

    await renderDialog({ bridge, store });

    expect(await screen.findByTestId('share-receive-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-receive-local'));

    await waitFor(() => expect(bridge.project.open).toHaveBeenCalled());
    const openArg = (bridge.project.open as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
      pendingDeepLinkTarget?: unknown;
      pendingShareBranchSwitch?: unknown;
    };
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/guide.md' });
    expect(openArg.pendingShareBranchSwitch).toBeUndefined();
    expect(store.dismiss).toHaveBeenCalled();
  });
});
