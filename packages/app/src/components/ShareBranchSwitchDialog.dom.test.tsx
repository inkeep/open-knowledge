/**
 * RTL behavioral tests for ShareBranchSwitchDialog.
 *
 * Exercises the actual main → renderer payload delivery seam at the unit
 * layer: emit a `project-branch-switch` payload on an injected store, then
 * assert the dialog mounts, Cancel just dismisses, Switch dispatches
 * runCheckout, and warm-focus dispatch fires after the CC1 ack.
 *
 * Mocks `@lingui/react/macro` so the Trans/useLingui wrapper resolves without
 * a real LinguiProvider (no babel-plugin-macros at test time — same gap
 * AddPropertyRow.dom.test.tsx avoids by stubbing the macro).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BranchInfoResponse, CheckoutResponse } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { OkDesktopBridge, OkShareReceivedPayload } from '@/lib/desktop-bridge-types';

// Radix Dialog (focus-trap) reaches for `NodeFilter` + `ResizeObserver`.
// Shim per the convention in sibling .dom.test.tsx files.
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

// Lingui macros: not transformed in this test substrate. Stub to identity
// renderers so Trans/Plural pass children through and useLingui returns a
// passthrough `t` template tag.
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

// Sonner is loaded by the SUT — stub to mute its real toaster.
const toastError = mock(() => {});
mock.module('sonner', () => ({
  toast: { error: toastError, info: mock(() => {}), success: mock(() => {}) },
}));

const { createShareReceiveStore } = await import('@/lib/share/receive-store');
const { missDialogStore } = await import('@/lib/share/miss-dialog-store');
const { ShareBranchSwitchDialog } = await import('./ShareBranchSwitchDialog');

interface BridgeMock {
  fetchBranchInfo: ReturnType<typeof mock>;
  runCheckout: ReturnType<typeof mock>;
  fetchTargetStatus: ReturnType<typeof mock>;
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
    fetchTargetStatus: overrides.fetchTargetStatus ?? mock(async () => null),
    awaitBranchSwitched: overrides.awaitBranchSwitched ?? mock(async () => ({ ok: true as const })),
    open: overrides.open ?? mock(async () => undefined),
  };
  const bridge = {
    project: {
      fetchBranchInfo: calls.fetchBranchInfo,
      runCheckout: calls.runCheckout,
      fetchTargetStatus: calls.fetchTargetStatus,
      awaitBranchSwitched: calls.awaitBranchSwitched,
      open: calls.open,
    },
  } as unknown as OkDesktopBridge;
  return { bridge, calls };
}

/**
 * branch-info for the "switch to recover" variant with an explicitly-false
 * origin hint — the state that triggers the verdict pivot. `shareTargetExists`
 * false (target missing on the current branch) + a clean tree = variant B;
 * `shareTargetOnOriginBranch: false` = the stale-local-ref hint.
 */
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
  targetStatus: ReturnType<typeof mock>,
  extra: Partial<BridgeMock> = {},
): { bridge: OkDesktopBridge; calls: BridgeMock } {
  return makeBridge({
    fetchBranchInfo: mock(async () => missWithFalseOriginHint()),
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
    // Component should not mount for launcher payloads.
    expect(screen.queryByTestId('share-branch-switch-dialog')).toBeNull();
  });

  test("mounts on a 'project-branch-switch' payload + fetches branch-info from the payload's projectPath", () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      // Pending so we observe the loading state before info arrives.
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
      // Hold the fetch open so we Cancel during loading state.
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

    // Store dismissed → snapshot null → dialog unmounts.
    expect(store.getSnapshot()).toBeNull();
    // must NOT dispatch a project.open call as part of Cancel.
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

    // Branch info is needed before the open-current button shows
    // (shareFileExists + clean tree → openCurrentEnabled).
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
    // Stay-on-current: no share-branch threading.
    expect(firstArg.pendingBranch).toBeUndefined();
    // Store dismissed after dispatch.
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

    // The dialog dismisses synchronously, but the open reject must still reach
    // the user — otherwise they land in the editor with no doc and no feedback.
    // Assert the path-specific message (not a global count) so a stray toast
    // from a sibling test can't make this pass or fail spuriously.
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

    // runCheckout fires synchronously off the click. awaitBranchSwitched
    // and the warm-focus open() fire after the phase transition lands
    // in the next render (the phase-keyed effect).
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
    // Checkout + CC1 ack succeed; only the final warm-focus open() rejects.
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

    // Pump the phase-keyed CC1 gate: runCheckout → awaiting-cc1-recycle effect
    // → awaitBranchSwitched(ok) → warm-focus open() (which rejects here).
    await waitFor(() => {
      expect(calls.open).toHaveBeenCalledTimes(1);
    });

    // After the open reject lands, the user gets a distinct toast rather than a
    // closed dialog with no doc and no signal. Assert the switch-path message
    // specifically — contamination-proof and pins the exact copy for this path.
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

    // Checkout failure is surfaced and the CC1 gate never engages (no nav).
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
    // Checkout succeeds; the CC1 recycle never acks within the window.
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

    // Pump the phase-keyed CC1 gate to its {ok:false} resolution.
    await waitFor(() => {
      expect(calls.awaitBranchSwitched).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Branch switch timed out — try opening the document manually.',
      );
    });
    // CC1 timeout is distinct from success — no warm-focus navigation.
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
    const targetStatus = mock(async () => ({ verdict: 'on-origin' as const }));
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
    const { bridge, calls } = pivotBridge(mock(async () => ({ verdict: 'on-origin' as const })));
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
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'docs/notes.md' });
    expect(openArg.pendingBranch).toBe(payload.share.branch);
  });

  test('renamed offer opens the NEW path with a fast-forward checkout', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(
      mock(async () => ({ verdict: 'renamed' as const, renamedTo: 'guides/notes.md' })),
    );
    const payload = installAndRender(bridge, store);

    // The body names the new path so the receiver sees where it moved.
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
    // Navigation lands on the renamed path, NOT the original share path.
    expect(openArg.pendingDeepLinkTarget).toEqual({ kind: 'doc', path: 'guides/notes.md' });
  });

  test('deleted verdict hands off to the miss dialog (no switch, dismisses this shell)', async () => {
    missDialogStore.dismiss();
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(mock(async () => ({ verdict: 'deleted' as const })));
    installAndRender(bridge, store);

    // A gone-on-the-share-branch target has nothing to switch to — this shell
    // hands off to the dedicated miss dialog (which owns the honest copy + a
    // Browse-folder escape) rather than showing a terminal Cancel-only cell.
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toEqual({
        kind: 'doc',
        path: 'docs/notes.md',
        branch: 'feat/branch-x',
      });
    });
    // This shell dismisses itself and never runs a checkout.
    expect(store.getSnapshot()).toBeNull();
    expect(calls.runCheckout).not.toHaveBeenCalled();
    missDialogStore.dismiss();
  });

  test('never-on-branch hands off to the miss dialog too (nothing to switch to)', async () => {
    missDialogStore.dismiss();
    const store = createShareReceiveStore();
    const { bridge, calls } = pivotBridge(
      mock(async () => ({ verdict: 'never-on-branch' as const })),
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
    // The server refuses the fast-forward only when it is requested; a plain
    // switch (no fastForward) succeeds.
    const runCheckout = mock(async (req: { fastForward?: boolean }) =>
      req.fastForward
        ? { ok: false as const, reason: 'ff-diverged' as const }
        : { ok: true as const },
    );
    const { bridge, calls } = pivotBridge(
      mock(async () => ({ verdict: 'on-origin' as const })),
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

    // The fast-forward was refused → diverged cell, no navigation yet.
    await screen.findByTestId('share-branch-switch-verdict-diverged');
    expect(calls.open).not.toHaveBeenCalled();

    const plainBtn = screen.getByTestId('share-branch-switch-verdict-plain-switch');
    await act(async () => {
      fireEvent.click(plainBtn);
      await Promise.resolve();
    });

    // The plain switch carries NO fastForward — the receive flow never merges.
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
    const targetStatus = mock(async () => ({ verdict: 'unknown' as const }));
    const { bridge, calls } = pivotBridge(targetStatus);
    const payload = installAndRender(bridge, store);

    // Fail-open: once the unknown verdict lands, the dialog re-enables today's
    // plain switch button (it renders disabled during the checking state).
    const switchBtn = await screen.findByTestId('share-branch-switch-switch');
    await waitFor(() => {
      expect((switchBtn as HTMLButtonElement).disabled).toBe(false);
    });
    // Single-fire guard: an `unknown` fallback to `ready` must not re-arm the probe.
    expect(calls.fetchTargetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(switchBtn);
      await Promise.resolve();
    });
    // The plain switch does not fast-forward.
    expect(calls.runCheckout).toHaveBeenCalledWith({
      projectPath: payload.projectPath,
      branch: payload.share.branch,
    });
  });

  test('a missing target with NO origin hint keeps today plain switch (no probe)', async () => {
    const store = createShareReceiveStore();
    const { bridge, calls } = makeBridge({
      fetchBranchInfo: mock(
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
    // Fail-open on the omitted hint: no verdict fetch, today's behavior.
    expect(calls.fetchTargetStatus).not.toHaveBeenCalled();
  });
});
