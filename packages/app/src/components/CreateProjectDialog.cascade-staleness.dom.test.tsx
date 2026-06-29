import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  OkDesktopBridge,
  OkFindEnclosingGitRootResult,
  OkFindEnclosingProjectRootResult,
  OkFolderState,
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

const ASYNC_TIMEOUT_MS = 2000;

const PARENT = '/Users/test/Projects';
const PROJECT_NAME = 'Andrew Brain';
const FIRST_GIT_RESULT: OkFindEnclosingGitRootResult = {
  gitRoot: '/Users/test',
  distance: 1,
};

interface ProgrammableBridgeStub {
  bridge: OkDesktopBridge;
  setEnclosingGitResult(result: OkFindEnclosingGitRootResult | null): void;
  setRemoveGitFolderImpl(impl: (gitRoot: string) => Promise<void>): void;
  setPickedParent(picked: string | null): void;
  setFindEnclosingProjectRootImpl(
    impl: (path: string) => Promise<OkFindEnclosingProjectRootResult | null>,
  ): void;
  setFindEnclosingGitRootImpl(
    impl: (path: string) => Promise<OkFindEnclosingGitRootResult | null>,
  ): void;
  readonly findGitCalls: ReadonlyArray<string>;
  readonly folderStateCalls: ReadonlyArray<string>;
  readonly removeGitCalls: ReadonlyArray<string>;
  readonly openFolderCalls: ReadonlyArray<number>;
}

function makeStubBridge(
  initialGit: OkFindEnclosingGitRootResult | null,
  initialPickedParent: string | null,
): ProgrammableBridgeStub {
  const findGitCalls: string[] = [];
  const folderStateCalls: string[] = [];
  const removeGitCalls: string[] = [];
  const openFolderCalls: number[] = [];
  let currentGitResult: OkFindEnclosingGitRootResult | null = initialGit;
  let currentPickedParent: string | null = initialPickedParent;
  let removeGitImpl: (gitRoot: string) => Promise<void> = async () => undefined;
  let findEnclosingProjectImpl: (path: string) => Promise<OkFindEnclosingProjectRootResult | null> =
    async () => null;
  let findEnclosingGitImpl: (path: string) => Promise<OkFindEnclosingGitRootResult | null> = async (
    path,
  ) => {
    findGitCalls.push(path);
    return currentGitResult;
  };

  const bridge = {
    fs: {
      defaultProjectsRoot: async (): Promise<string> => PARENT,
      folderState: async (path: string): Promise<OkFolderState> => {
        folderStateCalls.push(path);
        return 'free';
      },
      findEnclosingProjectRoot: (path: string) => findEnclosingProjectImpl(path),
      findEnclosingGitRoot: (path: string) => findEnclosingGitImpl(path),
      removeGitFolder: async (gitRoot: string) => {
        removeGitCalls.push(gitRoot);
        return removeGitImpl(gitRoot);
      },
    },
    dialog: {
      openFolder: async (): Promise<string | null> => {
        openFolderCalls.push(openFolderCalls.length + 1);
        return currentPickedParent;
      },
    },
    project: {
      recordCreateNewBannerShown: async () => undefined,
      createNew: async () => undefined,
      open: async () => undefined,
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    setEnclosingGitResult: (result) => {
      currentGitResult = result;
    },
    setRemoveGitFolderImpl: (impl) => {
      removeGitImpl = impl;
    },
    setPickedParent: (picked) => {
      currentPickedParent = picked;
    },
    setFindEnclosingProjectRootImpl: (impl) => {
      findEnclosingProjectImpl = impl;
    },
    setFindEnclosingGitRootImpl: (impl) => {
      findEnclosingGitImpl = impl;
    },
    findGitCalls,
    folderStateCalls,
    removeGitCalls,
    openFolderCalls,
  };
}

async function typeName(value: string) {
  fireEvent.change(screen.getByTestId('create-name'), { target: { value } });
}

async function waitForLocation(expected = PARENT) {
  await waitFor(
    () => {
      expect(screen.getByTestId('create-location-display').textContent).toContain(expected);
    },
    { timeout: ASYNC_TIMEOUT_MS },
  );
}

describe('CreateProjectDialog cascade staleness (Tier-3 mount)', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('S1: re-typing the same name after an FS mutation produces a fresh probe', async () => {
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);

    const nameInput = await screen.findByTestId('create-name', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(nameInput.tagName).toBe('INPUT');

    await waitForLocation();

    await typeName(PROJECT_NAME);
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    stub.setEnclosingGitResult(null);

    const probesBeforeRetype = stub.findGitCalls.length;
    await typeName('');
    await typeName(PROJECT_NAME);

    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - probesBeforeRetype;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await waitFor(
      () => {
        const stillShowingStaleBanner = screen.queryByTestId('create-banner-git-confirm') !== null;
        expect(stillShowingStaleBanner).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('S2: window focus event triggers a re-probe — banner clears when FS resolves while dialog stays open', async () => {
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName(PROJECT_NAME);
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    stub.setEnclosingGitResult(null);
    const callCountBeforeFocus = stub.findGitCalls.length;

    fireEvent(window, new Event('focus'));

    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - callCountBeforeFocus;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        const stillShowing = screen.queryByTestId('create-banner-git-confirm') !== null;
        expect(stillShowing).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('S3: remove-.git button: confirm → IPC called → re-probe → banner clears (terminal case, no higher .git)', async () => {
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);
    stub.setRemoveGitFolderImpl(async () => {
      stub.setEnclosingGitResult(null);
    });

    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName(PROJECT_NAME);
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(screen.getByTestId('create-banner-git-remove'));
    expect(screen.queryByTestId('create-banner-git-remove-confirm')).not.toBeNull();
    expect(stub.removeGitCalls.length).toBe(0);

    const findGitCallCountBeforeRemove = stub.findGitCalls.length;
    fireEvent.click(screen.getByTestId('create-banner-git-remove-confirm-button'));
    await waitFor(
      () => {
        expect(stub.removeGitCalls).toEqual([FIRST_GIT_RESULT.gitRoot]);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - findGitCallCountBeforeRemove;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('S4: remove-.git button: when a higher .git exists, banner repaints with the new gitRoot and the user can climb', async () => {
    const FIRST = { gitRoot: '/Users/test', distance: 1 } as const;
    const HIGHER = { gitRoot: '/Users', distance: 2 } as const;

    const stub = makeStubBridge(FIRST, PARENT);
    stub.setRemoveGitFolderImpl(async (gitRoot) => {
      if (gitRoot === FIRST.gitRoot) {
        stub.setEnclosingGitResult(HIGHER);
      } else if (gitRoot === HIGHER.gitRoot) {
        stub.setEnclosingGitResult(null);
      }
    });

    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();
    await typeName(PROJECT_NAME);

    await waitFor(
      () => {
        const banner = screen.queryByTestId('create-banner-git-confirm');
        expect(banner?.textContent?.includes(FIRST.gitRoot)).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    const findGitCallCountBeforeRemove1 = stub.findGitCalls.length;
    fireEvent.click(screen.getByTestId('create-banner-git-remove'));
    fireEvent.click(screen.getByTestId('create-banner-git-remove-confirm-button'));
    await waitFor(
      () => {
        expect(stub.removeGitCalls).toEqual([FIRST.gitRoot]);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - findGitCallCountBeforeRemove1;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        const banner = screen.queryByTestId('create-banner-git-confirm');
        expect(banner?.textContent?.includes(HIGHER.gitRoot)).toBe(true);
        expect(banner?.textContent?.includes(FIRST.gitRoot)).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    expect(screen.queryByTestId('create-banner-git-remove-confirm')).toBeNull();
    expect(screen.queryByTestId('create-banner-git-remove')).not.toBeNull();

    const findGitCallCountBeforeRemove2 = stub.findGitCalls.length;
    fireEvent.click(screen.getByTestId('create-banner-git-remove'));
    fireEvent.click(screen.getByTestId('create-banner-git-remove-confirm-button'));
    await waitFor(
      () => {
        expect(stub.removeGitCalls).toEqual([FIRST.gitRoot, HIGHER.gitRoot]);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - findGitCallCountBeforeRemove2;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('S6: cascade probes folderState against the sanitized creation target, not the raw typed name', async () => {
    const RAW_NAME = '.hidden-notes';
    const EXPECTED_SANITIZED_TARGET = `${PARENT}/hidden-notes`;

    const stub = makeStubBridge(null, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName(RAW_NAME);

    await waitFor(
      () => {
        expect(stub.folderStateCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    expect(stub.folderStateCalls).toContain(EXPECTED_SANITIZED_TARGET);
    expect(stub.folderStateCalls).not.toContain(`${PARENT}/${RAW_NAME}`);
  });

  test('S5: remove-.git button: IPC failure surfaces inline error, banner stays, retry path remains', async () => {
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);
    stub.setRemoveGitFolderImpl(async () => {
      throw new Error('EACCES: permission denied');
    });

    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();
    await typeName(PROJECT_NAME);
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(screen.getByTestId('create-banner-git-remove'));
    fireEvent.click(screen.getByTestId('create-banner-git-remove-confirm-button'));
    await waitFor(
      () => {
        const errorNode = screen.queryByTestId('create-banner-git-remove-error');
        expect(errorNode?.textContent?.includes('EACCES')).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
    expect(screen.queryByTestId('create-banner-git-remove')).not.toBeNull();
  });

  test('PRD-6649: banner DOM identity is stable across name keystrokes that re-probe to the same verdict', async () => {
    const stub = makeStubBridge(null, PARENT);
    const nestedRoot = '/Users/test/existing-project';
    stub.setFindEnclosingProjectRootImpl(async (_path) => ({ rootPath: nestedRoot }));

    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName('Plant');
    const initialBanner = await screen.findByTestId('create-banner-nested', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const bannerParent = initialBanner.parentElement;
    expect(bannerParent !== null).toBe(true);

    let bannerWasRemoved = false;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const removed of Array.from(m.removedNodes)) {
          if (removed === initialBanner) {
            bannerWasRemoved = true;
          }
        }
      }
    });
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    observer.observe(bannerParent!, { childList: true, subtree: true });

    const probesBefore = stub.findGitCalls.length;

    await typeName('Plant Care Notes');

    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - probesBefore;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-nested')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    observer.disconnect();

    expect(bannerWasRemoved).toBe(false);
    expect(initialBanner.isConnected).toBe(true);
    expect(screen.getByTestId('create-banner-nested') === initialBanner).toBe(true);
  });

  test('PRD-6649: canSubmit is gated by probeLifecycle: disabled while a probe is in-flight, re-enabled when settled', async () => {
    const stub = makeStubBridge(null, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName('Plant Care');
    const submitButton = screen.getByTestId('create-submit') as HTMLButtonElement;
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    let probeCallCount = 0;
    let resolveDeferred: (value: OkFindEnclosingGitRootResult | null) => void = () => {};
    stub.setFindEnclosingGitRootImpl((_path) => {
      probeCallCount += 1;
      return new Promise<OkFindEnclosingGitRootResult | null>((r) => {
        resolveDeferred = r;
      });
    });

    const probesBefore = probeCallCount;
    await typeName('Plant Care Notes');

    await waitFor(
      () => {
        expect(probeCallCount).toBeGreaterThan(probesBefore);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    resolveDeferred(null);
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('PRD-6649: 5 s polling skips probeNonce bump while a probe is in-flight (race-prevention gate)', async () => {
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);

    const setIntervalSpy = spyOn(globalThis, 'setInterval');

    try {
      render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
      await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
      await waitForLocation();

      await typeName(PROJECT_NAME);
      await waitFor(
        () => {
          expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      const pollingCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 5_000);
      expect(pollingCalls.length).toBeGreaterThanOrEqual(1);
      const pollingCallback = pollingCalls[pollingCalls.length - 1]?.[0] as
        | (() => void)
        | undefined;
      expect(typeof pollingCallback).toBe('function');
      if (typeof pollingCallback !== 'function') return;

      let probeCallCount = 0;
      let resolveDeferred: (value: OkFindEnclosingGitRootResult | null) => void = () => {};
      stub.setFindEnclosingGitRootImpl((_path) => {
        probeCallCount += 1;
        return new Promise<OkFindEnclosingGitRootResult | null>((r) => {
          resolveDeferred = r;
        });
      });

      await typeName(`${PROJECT_NAME} (v2)`);
      await waitFor(
        () => {
          expect(probeCallCount).toBeGreaterThanOrEqual(1);
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );
      const probeCountWhileInFlight = probeCallCount;

      pollingCallback();

      await new Promise((r) => setTimeout(r, 250));

      expect(probeCallCount).toBe(probeCountWhileInFlight);

      resolveDeferred(FIRST_GIT_RESULT);

      await waitFor(
        () => {
          expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      const probeCountBeforeIdleTick = probeCallCount;
      pollingCallback();

      await waitFor(
        () => {
          expect(probeCallCount).toBeGreaterThan(probeCountBeforeIdleTick);
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      resolveDeferred(FIRST_GIT_RESULT);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test('PRD-6649: probeLifecycle resets to idle on IPC-failure catch arm (canSubmit recovers after transient failure)', async () => {
    const stub = makeStubBridge(null, PARENT);
    stub.setFindEnclosingGitRootImpl(async (_path) => {
      throw new Error('Simulated IPC failure');
    });
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName(PROJECT_NAME);

    const submitButton = screen.getByTestId('create-submit') as HTMLButtonElement;

    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });
});
