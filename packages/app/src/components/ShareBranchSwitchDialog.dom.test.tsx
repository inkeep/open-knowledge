import type {
  BranchInfoResponse,
  CheckoutResponse,
  WorktreeCreateResult,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge, OkShareReceivedPayload } from '@/lib/desktop-bridge-types';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
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

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      let out = '';
      strings.forEach((s, i) => {
        out += s;
        if (i < values.length) out += String(values[i]);
      });
      return out;
    },
  }),
  Plural: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const refreshWorktrees = vi.fn(() => {});
vi.doMock('@/lib/worktree-store', () => ({ refreshWorktrees }));

const { createShareReceiveStore } = await import('@/lib/share/receive-store');
const { missDialogStore } = await import('@/lib/share/miss-dialog-store');
const { ShareBranchSwitchDialog } = await import('./ShareBranchSwitchDialog');

interface BridgeMock {
  fetchBranchInfo: ReturnType<typeof vi.fn>;
  runCheckout: ReturnType<typeof vi.fn>;
  fetchTargetStatus: ReturnType<typeof vi.fn>;
  awaitBranchSwitched: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
}

function makeBridge(overrides: Partial<BridgeMock> = {}): {
  bridge: OkDesktopBridge;
  calls: BridgeMock;
} {
  const calls: BridgeMock = {
    fetchBranchInfo:
      overrides.fetchBranchInfo ??
      vi.fn(
        async (): Promise<BranchInfoResponse> => ({
          ok: true,
          currentBranch: 'main',
          currentHeadSha: 'aaaaaaa',
          detached: false,
          shareTargetExists: true,
          dirtyConflicts: { conflicts: false, files: [] },
        }),
      ),
    runCheckout:
      overrides.runCheckout ?? vi.fn(async (): Promise<CheckoutResponse> => ({ ok: true })),
    fetchTargetStatus: overrides.fetchTargetStatus ?? vi.fn(async () => null),
    awaitBranchSwitched:
      overrides.awaitBranchSwitched ?? vi.fn(async () => ({ ok: true as const })),
    open: overrides.open ?? vi.fn(async () => undefined),
    checkout:
      overrides.checkout ??
      vi.fn(async () => ({ ok: true as const, path: '/repo/.ok/worktrees/branch', created: true })),
  };
  const bridge = {
    project: {
      fetchBranchInfo: calls.fetchBranchInfo,
      runCheckout: calls.runCheckout,
      fetchTargetStatus: calls.fetchTargetStatus,
      awaitBranchSwitched: calls.awaitBranchSwitched,
      open: calls.open,
    },
    worktree: {
      checkout: calls.checkout,
    },
  } as unknown as OkDesktopBridge;
  return { bridge, calls };
}

function missWithFalseOriginHint(): BranchInfoResponse {
  return {
    ok: true,
    currentBranch: 'main',
    currentHeadSha: 'aaaaaaa',
    detached: false,
    shareTargetExists: false,
    dirtyConflicts: { conflicts: false, files: [] },
    branchIsLocal: true,
    shareTargetOnOriginBranch: false,
  } as unknown as BranchInfoResponse;
}

function pivotBridge(
  targetStatus: ReturnType<typeof vi.fn>,
  extra: Partial<BridgeMock> = {},
): { bridge: OkDesktopBridge; calls: BridgeMock } {
  return makeBridge({
    fetchBranchInfo: vi.fn(async () => missWithFalseOriginHint()),
    fetchTargetStatus: targetStatus,
    ...extra,
  });
}

function projectBranchSwitchPayload(): Extract<
  OkShareReceivedPayload,
  { kind: 'project-branch-switch' }
> {
  return {
    kind: 'project-branch-switch',
    share: {
      contentRootDepth: null,
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat/branch-x',
      sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/feat/branch-x/docs/notes.md',
      repositoryTarget: { kind: 'doc', docPath: 'docs/notes.md' },
      target: { kind: 'doc', docPath: 'docs/notes.md' },
    },
    projectPath: '/Users/alice/projects/open-knowledge',
    currentBranch: 'main',
  };
}

describe('ShareBranchSwitchDialog — payload gating', () => {
  afterEach(() => {
    cleanup();
    toastError.mockReset();
  });

  test('renders nothing when the store snapshot is null', () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge();
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    expect(screen.queryByTestId('share-branch-switch-dialog')).toBeNull();
  });

  test("renders nothing for non-'project-branch-switch' payload kinds (launcher routes elsewhere)", () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb({
          kind: 'launcher-miss',
          share: {
            contentRootDepth: null,
            owner: 'inkeep',
            repo: 'open-knowledge',
            branch: 'main',
            sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/x.md',
            repositoryTarget: { kind: 'doc', docPath: 'docs/x.md' },
            target: { kind: 'doc', docPath: 'docs/x.md' },
          },
        });
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    expect(screen.queryByTestId('share-branch-switch-dialog')).toBeNull();
  });

  test("mounts on a 'project-branch-switch' payload + fetches branch-info from the payload's projectPath", () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      fetchBranchInfo: vi.fn(() => new Promise<BranchInfoResponse>(() => {})),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    expect(screen.getByTestId('share-branch-switch-dialog')).toBeDefined();
    expect(calls.fetchBranchInfo).toHaveBeenCalledTimes(1);
    expect(calls.fetchBranchInfo).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
      kind: 'doc',
      path: 'docs/notes.md',
    });
  });
});

describe('ShareBranchSwitchDialog — Cancel discipline (OQ2)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  });
  afterEach(() => {
    cleanup();
  });

  test('Cancel dismisses the store snapshot — editor stays open (no bridge.project.open call)', () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      fetchBranchInfo: vi.fn(() => new Promise<BranchInfoResponse>(() => {})),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    expect(screen.getByTestId('share-branch-switch-dialog')).toBeDefined();

    fireEvent.click(screen.getByTestId('share-branch-switch-cancel'));

    expect(store.getSnapshot()).toBeNull();
    expect(calls.open).not.toHaveBeenCalled();
  });
});

describe('ShareBranchSwitchDialog — Open-in-current dispatch', () => {
  afterEach(() => {
    cleanup();
  });

  test('warm-focus dispatch carries pendingDeepLinkDoc but NOT pendingBranch', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge();
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const button = await screen.findByTestId('share-branch-switch-open-current');
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(calls.open).toHaveBeenCalledTimes(1);
    const firstArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstArg).toBeDefined();
    expect(firstArg.path).toBe(payload.projectPath);
    expect(firstArg.pendingDeepLinkTarget).toEqual({
      kind: 'doc',
      path: 'docs/notes.md',
      repositoryPath: 'docs/notes.md',
    });
    expect(firstArg.pendingBranch).toBeUndefined();
    expect(store.getSnapshot()).toBeNull();
  });

  test('open-current open() reject surfaces a toast — no silent swallow', async () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge({
      open: vi.fn(async () => {
        throw new Error('ipc-timeout');
      }),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const button = await screen.findByTestId('share-branch-switch-open-current');
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'The document could not be opened — try navigating to it manually.',
      );
    });
    expect(store.getSnapshot()).toBeNull();
  });
});

describe('ShareBranchSwitchDialog — Switch path (runCheckout + CC1 gate)', () => {
  afterEach(() => {
    cleanup();
  });

  test('dirty conflicts disable Switch and describe the blocking file list', async () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge({
      fetchBranchInfo: vi.fn(
        async (): Promise<BranchInfoResponse> => ({
          ok: true,
          currentBranch: 'main',
          currentHeadSha: 'aaaaaaa',
          detached: false,
          shareTargetExists: true,
          dirtyConflicts: {
            conflicts: true,
            files: ['docs/notes.md', 'package.json'],
          },
        }),
      ),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    const describedBy = switchBtn.getAttribute('aria-describedby');
    expect((switchBtn as HTMLButtonElement).disabled).toBe(true);
    expect(switchBtn.getAttribute('aria-disabled')).toBe('true');
    expect(describedBy).toBe('share-receive-branch-conflict-files');
    const conflictList = document.getElementById(describedBy ?? '');
    expect(conflictList?.textContent).toContain('docs/notes.md');
    expect(conflictList?.textContent).toContain('package.json');
  });

  test('Switch click runs checkout, awaits CC1, then warm-focus-dispatches with pendingDeepLinkDoc + pendingBranch', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge();
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    expect(calls.runCheckout).toHaveBeenCalledTimes(1);
    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
    });

    await waitFor(() => {
      expect(calls.awaitBranchSwitched).toHaveBeenCalledTimes(1);
    });
    expect(calls.awaitBranchSwitched).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
      timeoutMs: 30_000,
    });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    const openArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg).toBeDefined();
    expect(openArg.pendingDeepLinkTarget).toEqual({
      kind: 'doc',
      path: 'docs/notes.md',
      repositoryPath: 'docs/notes.md',
    });
    expect(openArg.pendingBranch).toBe(payload.share.branch);
  });

  test('Switch does not navigate or warm-focus until CC1 resolves', async () => {
    const store = createShareReceiveStore();
    let resolveCc1: (result: { ok: true }) => void = () => {};
    const cc1Promise = new Promise<{ ok: true }>((resolve) => {
      resolveCc1 = resolve;
    });
    const { bridge, calls } = makeBridge({
      awaitBranchSwitched: vi.fn(() => cc1Promise),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    window.location.hash = '#before-switch';
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.awaitBranchSwitched).toHaveBeenCalledTimes(1);
    });
    expect(calls.open).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#before-switch');

    resolveCc1({ ok: true });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
  });

  test('Switch on a branchless share dismisses without waiting on CC1', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge();
    const payload = projectBranchSwitchPayload();
    payload.share.branch = '';
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(store.getSnapshot()).toBeNull();
    });
    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: '',
    });
    expect(calls.awaitBranchSwitched).not.toHaveBeenCalled();
    expect(calls.open).not.toHaveBeenCalled();
  });

  test('Switch warm-focus open() reject surfaces a toast — no silent swallow', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      open: vi.fn(async () => {
        throw new Error('window-manager-error');
      }),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Branch switched but the document could not be opened — try navigating to it manually.',
      );
    });
  });

  test('Switch with runCheckout {ok:false, checkout-failed} toasts and does not navigate', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      runCheckout: vi.fn(async () => ({ ok: false as const, reason: 'checkout-failed' as const })),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Could not switch to feat/branch-x. Try switching manually.',
      );
    });
    expect(calls.awaitBranchSwitched).not.toHaveBeenCalled();
    expect(calls.open).not.toHaveBeenCalled();
  });

  test('Switch with awaitBranchSwitched {ok:false} (CC1 timeout) toasts the timeout copy', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      awaitBranchSwitched: vi.fn(async () => ({ ok: false as const })),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.awaitBranchSwitched).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Branch switch timed out — try opening the document manually.',
      );
    });
    expect(calls.open).not.toHaveBeenCalled();
  });
});

describe('ShareBranchSwitchDialog — verdict pivot (FR9)', () => {
  afterEach(() => {
    cleanup();
    toastError.mockReset();
  });

  function installAndRender(
    bridge: OkDesktopBridge,
    store: ReturnType<typeof createShareReceiveStore>,
  ) {
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    return payload;
  }

  test('a false origin hint fetches target-status and renders the on-origin verdict', async () => {
    const store = createShareReceiveStore();
    const targetStatus = vi.fn(async () => ({ verdict: 'on-origin' as const }));
    const { bridge, calls } = pivotBridge(targetStatus);
    const payload = installAndRender(bridge, store);

    await screen.findByTestId('share-branch-switch-verdict-on-origin');
    expect(calls.fetchTargetStatus).toHaveBeenCalledTimes(1);
    expect(calls.fetchTargetStatus).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
      kind: 'doc',
      path: 'docs/notes.md',
    });
  });

  test('on-origin "Switch and update branch" runs a fast-forward checkout and navigates to the doc', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(vi.fn(async () => ({ verdict: 'on-origin' as const })));
    const payload = installAndRender(bridge, store);

    const btn = await screen.findByTestId('share-branch-switch-verdict-switch-update');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });

    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
      fastForward: true,
    });
    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    const openArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg.pendingDeepLinkTarget).toEqual({
      kind: 'doc',
      path: 'docs/notes.md',
      repositoryPath: 'docs/notes.md',
    });
    expect(openArg.pendingBranch).toBe(payload.share.branch);
  });

  test('renamed offer opens the NEW path with a fast-forward checkout', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(
      vi.fn(async () => ({ verdict: 'renamed' as const, renamedTo: 'guides/notes.md' })),
    );
    const payload = installAndRender(bridge, store);

    const cell = await screen.findByTestId('share-branch-switch-verdict-renamed');
    expect(cell.textContent).toContain('guides/notes.md');

    const btn = await screen.findByTestId('share-branch-switch-verdict-open-renamed');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });

    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
      fastForward: true,
    });
    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    const openArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg.pendingDeepLinkTarget).toEqual({
      kind: 'doc',
      path: 'guides/notes.md',
      repositoryPath: 'guides/notes.md',
    });
  });

  test('deleted verdict hands off to the miss dialog (no switch, dismisses this shell)', async () => {
    missDialogStore.dismiss();
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(vi.fn(async () => ({ verdict: 'deleted' as const })));
    installAndRender(bridge, store);

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toEqual({
        kind: 'doc',
        path: 'docs/notes.md',
        repositoryPath: 'docs/notes.md',
        branch: 'feat/branch-x',
      });
    });
    expect(store.getSnapshot()).toBeNull();
    expect(calls.runCheckout).not.toHaveBeenCalled();
    missDialogStore.dismiss();
  });

  test('never-on-branch hands off to the miss dialog too (nothing to switch to)', async () => {
    missDialogStore.dismiss();
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(
      vi.fn(async () => ({ verdict: 'never-on-branch' as const })),
    );
    installAndRender(bridge, store);

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()?.path).toBe('docs/notes.md');
    });
    expect(store.getSnapshot()).toBeNull();
    expect(calls.runCheckout).not.toHaveBeenCalled();
    missDialogStore.dismiss();
  });

  test('a fast-forward that diverges shows the diverged cell offering a plain switch (no merge)', async () => {
    const store = createShareReceiveStore();
    const runCheckout = vi.fn(async (req: { fastForward?: boolean }) =>
      req.fastForward
        ? { ok: false as const, reason: 'ff-diverged' as const }
        : { ok: true as const },
    );
    const { bridge, calls } = pivotBridge(
      vi.fn(async () => ({ verdict: 'on-origin' as const })),
      {
        runCheckout,
      },
    );
    const payload = installAndRender(bridge, store);

    const updateBtn = await screen.findByTestId('share-branch-switch-verdict-switch-update');
    await act(async () => {
      fireEvent.click(updateBtn);
      await Promise.resolve();
    });

    await screen.findByTestId('share-branch-switch-verdict-diverged');
    expect(calls.open).not.toHaveBeenCalled();

    const plainBtn = screen.getByTestId('share-branch-switch-verdict-plain-switch');
    await act(async () => {
      fireEvent.click(plainBtn);
      await Promise.resolve();
    });

    expect(calls.runCheckout).toHaveBeenLastCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
    });
    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
  });

  test('unknown verdict falls back to today plain switch and does NOT re-probe', async () => {
    const store = createShareReceiveStore();
    const targetStatus = vi.fn(async () => ({ verdict: 'unknown' as const }));
    const { bridge, calls } = pivotBridge(targetStatus);
    const payload = installAndRender(bridge, store);

    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await waitFor(() => {
      expect((switchBtn as HTMLButtonElement).disabled).toBe(false);
    });
    expect(calls.fetchTargetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });
    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
    });
  });

  test('a missing target with NO origin hint keeps today plain switch (no probe)', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      fetchBranchInfo: vi.fn(
        async (): Promise<BranchInfoResponse> =>
          ({
            ok: true,
            currentBranch: 'main',
            currentHeadSha: 'aaaaaaa',
            detached: false,
            shareTargetExists: false,
            dirtyConflicts: { conflicts: false, files: [] },
            branchIsLocal: true,
          }) as unknown as BranchInfoResponse,
      ),
    });
    installAndRender(bridge, store);

    await screen.findByTestId('share-branch-switch-switch');
    expect(calls.fetchTargetStatus).not.toHaveBeenCalled();
  });
});

describe('ShareBranchSwitchDialog — worktree leg', () => {
  beforeEach(() => {
    refreshWorktrees.mockClear();
  });
  afterEach(() => {
    cleanup();
    toastError.mockReset();
  });

  function branchInfoFor(fixture: {
    shareTargetExists: boolean;
    conflictFiles?: readonly string[];
  }): BranchInfoResponse {
    const files = fixture.conflictFiles ?? [];
    return {
      ok: true,
      currentBranch: 'main',
      currentHeadSha: 'aaaaaaa',
      detached: false,
      shareTargetExists: fixture.shareTargetExists,
      dirtyConflicts:
        files.length > 0 ? { conflicts: true, files: [...files] } : { conflicts: false, files: [] },
    };
  }

  function renderDialog(
    bridge: OkDesktopBridge,
    store: ReturnType<typeof createShareReceiveStore>,
    payload = projectBranchSwitchPayload(),
  ) {
    let emitShare: (p: OkShareReceivedPayload) => void = () => {};
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        emitShare = cb;
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);
    return { payload, emit: (p: OkShareReceivedPayload) => emitShare(p) };
  }

  async function findEnabledWorktreeButton(): Promise<HTMLButtonElement> {
    const btn = (await screen.findByTestId('share-branch-switch-worktree')) as HTMLButtonElement;
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    return btn;
  }

  const variantFixtures = [
    { kind: 'A', label: 'target on current branch, clean tree', shareTargetExists: true },
    { kind: 'B', label: 'target missing, clean tree', shareTargetExists: false },
    {
      kind: 'C',
      label: 'target on current branch, dirty conflicts',
      shareTargetExists: true,
      conflictFiles: ['docs/notes.md'],
    },
    {
      kind: 'D',
      label: 'target missing, dirty conflicts',
      shareTargetExists: false,
      conflictFiles: ['docs/notes.md'],
    },
  ] as const;

  for (const fixture of variantFixtures) {
    test(`Open in worktree renders enabled in variant ${fixture.kind} (${fixture.label})`, async () => {
      const store = createShareReceiveStore();
      const { bridge } = makeBridge({
        fetchBranchInfo: vi.fn(async () => branchInfoFor(fixture)),
      });
      renderDialog(bridge, store);
      await findEnabledWorktreeButton();
    });
  }

  test('variant D routes the dead end to the worktree action: new copy, switch disabled with the conflict list', async () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge({
      fetchBranchInfo: vi.fn(async () =>
        branchInfoFor({
          shareTargetExists: false,
          conflictFiles: ['docs/notes.md', 'package.json'],
        }),
      ),
    });
    renderDialog(bridge, store);

    await findEnabledWorktreeButton();

    expect(screen.getByTestId('share-branch-switch-dialog').textContent).toContain(
      'open it in a worktree to leave your changes untouched',
    );

    const switchBtn = screen.getByTestId('share-branch-switch-switch') as HTMLButtonElement;
    expect(switchBtn.disabled).toBe(true);
    const describedBy = switchBtn.getAttribute('aria-describedby');
    expect(describedBy).toBe('share-receive-branch-conflict-files');
    const conflictList = document.getElementById(describedBy ?? '');
    expect(conflictList?.textContent).toContain('docs/notes.md');
    expect(conflictList?.textContent).toContain('package.json');

    expect(screen.queryByTestId('share-branch-switch-open-current')).toBeNull();
  });

  test('a checkout that locates an existing worktree (created:false) still opens that window', async () => {
    const store = createShareReceiveStore();
    const existingPath = '/Users/alice/projects/open-knowledge/.ok/worktrees/feat-branch-x';
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(async () => ({ ok: true as const, path: existingPath, created: false })),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    const openArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg.path).toBe(existingPath);
    expect(openArg.target).toBe('new-window');
    expect(store.getSnapshot()).toBeNull();
  });

  test('an open() rejection after a successful create surfaces the toast; the worktree persists in the switcher', async () => {
    const store = createShareReceiveStore();
    const worktreePath = '/Users/alice/projects/open-knowledge/.ok/worktrees/feat-branch-x';
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(async () => ({ ok: true as const, path: worktreePath, created: true })),
      open: vi.fn(async () => {
        throw new Error('window spawn failed');
      }),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    expect(store.getSnapshot()).toBeNull();
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        `Could not open ${worktreePath}. Try opening it manually.`,
      );
    });
    expect(refreshWorktrees).toHaveBeenCalledTimes(1);
  });

  test('a folder share rides the worktree leg with its target kind passed through', async () => {
    const store = createShareReceiveStore();
    const base = projectBranchSwitchPayload();
    const payload = {
      ...base,
      share: {
        ...base.share,
        repositoryTarget: { kind: 'folder' as const, folderPath: 'docs' },
        target: { kind: 'folder' as const, folderPath: 'docs' },
      },
    };
    const { bridge, calls } = makeBridge();
    renderDialog(bridge, store, payload);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    const openArg = calls.open.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg.pendingDeepLinkTarget).toEqual({
      kind: 'folder',
      path: 'docs',
      repositoryPath: 'docs',
    });
    expect(openArg.pendingBranch).toBe(payload.share.branch);
  });

  test('Open in worktree checks out the share branch and opens its window at the shared target — no CC1 wait', async () => {
    const store = createShareReceiveStore();
    const worktreePath = '/Users/alice/projects/open-knowledge/.ok/worktrees/feat-branch-x';
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(async () => ({ ok: true as const, path: worktreePath, created: true })),
    });
    const payload = projectBranchSwitchPayload();
    const fakeBridgeForStore = {
      onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
        cb(payload);
        return () => {};
      },
    } as unknown as OkDesktopBridge;
    store.install({ bridge: fakeBridgeForStore });
    render(<ShareBranchSwitchDialog bridge={bridge} store={store} />);

    const worktreeBtn = await screen.findByTestId('share-branch-switch-worktree');
    expect((worktreeBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    expect(calls.checkout).toHaveBeenCalledTimes(1);
    expect(calls.checkout).toHaveBeenCalledWith({ branch: payload.share.branch });

    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });
    expect(calls.awaitBranchSwitched).not.toHaveBeenCalled();

    expect(calls.open.mock.calls[0]?.[0]).toEqual({
      path: worktreePath,
      target: 'new-window',
      entryPoint: 'worktree',
      pendingDeepLinkTarget: {
        kind: 'doc',
        path: 'docs/notes.md',
        repositoryPath: 'docs/notes.md',
      },
      pendingBranch: payload.share.branch,
    });

    expect(refreshWorktrees).toHaveBeenCalledTimes(1);

    expect(store.getSnapshot()).toBeNull();
  });

  test('mid-create shows in-place progress with actions disabled and Cancel live; dismissal ignores the late result', async () => {
    const store = createShareReceiveStore();
    let resolveCheckout: (result: WorktreeCreateResult) => void = () => {};
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(
        () =>
          new Promise<WorktreeCreateResult>((resolve) => {
            resolveCheckout = resolve;
          }),
      ),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    const status = screen.getByTestId('share-branch-switch-creating-worktree');
    expect(status.getAttribute('role')).toBe('status');

    expect(worktreeBtn.disabled).toBe(true);
    const switchBtn = screen.getByTestId('share-branch-switch-switch') as HTMLButtonElement;
    expect(switchBtn.disabled).toBe(true);
    const openCurrentBtn = screen.getByTestId(
      'share-branch-switch-open-current',
    ) as HTMLButtonElement;
    expect(openCurrentBtn.disabled).toBe(true);
    const cancelBtn = screen.getByTestId('share-branch-switch-cancel') as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(cancelBtn);
      await Promise.resolve();
    });
    expect(store.getSnapshot()).toBeNull();

    await act(async () => {
      resolveCheckout({ ok: true, path: '/repo/.ok/worktrees/feat-branch-x', created: true });
      await Promise.resolve();
    });
    expect(calls.open).not.toHaveBeenCalled();
    expect(refreshWorktrees).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a fetch failure keeps the dialog open with the connection toast so the user can retry', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(async () => ({ ok: false as const, reason: 'fetch-failed' as const })),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Could not fetch branch. Check your connection.');
    });
    expect(store.getSnapshot()).not.toBeNull();
    expect(screen.getByTestId('share-branch-switch-dialog')).toBeDefined();
    await waitFor(() => {
      expect(
        (screen.getByTestId('share-branch-switch-worktree') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(calls.open).not.toHaveBeenCalled();
  });

  test('a not-found fetch failure shows the not-found copy, not the connection toast', async () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge({
      checkout: vi.fn(async () => ({
        ok: false as const,
        reason: 'fetch-failed' as const,
        notFoundAsIdentity: true as const,
      })),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Repository not found — it may not exist, or the account used may not have access.',
      );
    });
    expect(toastError).not.toHaveBeenCalledWith('Could not fetch branch. Check your connection.');
  });

  test('a branch deleted upstream dismisses the dialog with the no-longer-exists toast', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(async () => ({ ok: false as const, reason: 'branch-not-found' as const })),
    });
    renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Branch feat/branch-x no longer exists on the remote.',
      );
    });
    await waitFor(() => {
      expect(store.getSnapshot()).toBeNull();
    });
    expect(calls.open).not.toHaveBeenCalled();
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });

  test('a second share arriving mid-create supersedes the in-flight create and ignores its result', async () => {
    const store = createShareReceiveStore();
    let resolveCheckout: (result: WorktreeCreateResult) => void = () => {};
    const { bridge, calls } = makeBridge({
      checkout: vi.fn(
        () =>
          new Promise<WorktreeCreateResult>((resolve) => {
            resolveCheckout = resolve;
          }),
      ),
    });
    const { emit } = renderDialog(bridge, store);

    const worktreeBtn = await findEnabledWorktreeButton();
    await act(async () => {
      fireEvent.click(worktreeBtn);
      await Promise.resolve();
    });
    expect(screen.getByTestId('share-branch-switch-creating-worktree')).toBeDefined();

    const second = projectBranchSwitchPayload();
    second.share.branch = 'feat/branch-y';
    await act(async () => {
      emit(second);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId('share-branch-switch-worktree') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.getByTestId('share-branch-switch-metadata-branch').textContent).toContain(
      'feat/branch-y',
    );

    await act(async () => {
      resolveCheckout({ ok: true, path: '/repo/.ok/worktrees/feat-branch-x', created: true });
      await Promise.resolve();
    });
    expect(calls.open).not.toHaveBeenCalled();
    expect(refreshWorktrees).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBeNull();
    expect(screen.getByTestId('share-branch-switch-dialog')).toBeDefined();
    expect(calls.checkout).toHaveBeenCalledTimes(1);
  });
});
