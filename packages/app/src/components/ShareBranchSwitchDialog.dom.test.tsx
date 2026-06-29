import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BranchInfoResponse, CheckoutResponse } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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

mock.module('@lingui/react/macro', () => ({
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

const toastError = mock(() => {});
mock.module('sonner', () => ({
  toast: { error: toastError, info: mock(() => {}), success: mock(() => {}) },
}));

const { createShareReceiveStore } = await import('@/lib/share/receive-store');
const { ShareBranchSwitchDialog } = await import('./ShareBranchSwitchDialog');

interface BridgeMock {
  fetchBranchInfo: ReturnType<typeof mock>;
  runCheckout: ReturnType<typeof mock>;
  awaitBranchSwitched: ReturnType<typeof mock>;
  open: ReturnType<typeof mock>;
}

function makeBridge(overrides: Partial<BridgeMock> = {}): {
  bridge: OkDesktopBridge;
  calls: BridgeMock;
} {
  const calls: BridgeMock = {
    fetchBranchInfo:
      overrides.fetchBranchInfo ??
      mock(
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
      overrides.runCheckout ?? mock(async (): Promise<CheckoutResponse> => ({ ok: true })),
    awaitBranchSwitched: overrides.awaitBranchSwitched ?? mock(async () => ({ ok: true as const })),
    open: overrides.open ?? mock(async () => undefined),
  };
  const bridge = {
    project: {
      fetchBranchInfo: calls.fetchBranchInfo,
      runCheckout: calls.runCheckout,
      awaitBranchSwitched: calls.awaitBranchSwitched,
      open: calls.open,
    },
  } as unknown as OkDesktopBridge;
  return { bridge, calls };
}

function projectBranchSwitchPayload(): Extract<
  OkShareReceivedPayload,
  { kind: 'project-branch-switch' }
> {
  return {
    kind: 'project-branch-switch',
    share: {
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat/branch-x',
      sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/feat/branch-x/docs/notes.md',
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
            owner: 'inkeep',
            repo: 'open-knowledge',
            branch: 'main',
            sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/x.md',
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
      fetchBranchInfo: mock(() => new Promise<BranchInfoResponse>(() => {})),
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
      fetchBranchInfo: mock(() => new Promise<BranchInfoResponse>(() => {})),
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
    expect(firstArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/notes.md' });
    expect(firstArg.pendingBranch).toBeUndefined();
    expect(store.getSnapshot()).toBeNull();
  });

  test('open-current open() reject surfaces a toast — no silent swallow', async () => {
    const store = createShareReceiveStore();
    const { bridge } = makeBridge({
      open: mock(async () => {
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
      fetchBranchInfo: mock(
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
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/notes.md' });
    expect(openArg.pendingBranch).toBe(payload.share.branch);
  });

  test('Switch does not navigate or warm-focus until CC1 resolves', async () => {
    const store = createShareReceiveStore();
    let resolveCc1: (result: { ok: true }) => void = () => {};
    const cc1Promise = new Promise<{ ok: true }>((resolve) => {
      resolveCc1 = resolve;
    });
    const { bridge, calls } = makeBridge({
      awaitBranchSwitched: mock(() => cc1Promise),
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
      open: mock(async () => {
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
      runCheckout: mock(async () => ({ ok: false as const, reason: 'checkout-failed' as const })),
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
      awaitBranchSwitched: mock(async () => ({ ok: false as const })),
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
