/**
 * Tier-3 RTL mount test for the cascade-banner staleness contract.
 *
 * Pins the user-visible behavioral contract: the rendered cascade banner
 * reflects live filesystem state on every cascade-probe-triggering input
 * change. A user who edits the name (or re-Browses the same parent) within
 * a single dialog open MUST see a banner that matches what the filesystem
 * says NOW, not what it said the first time the user typed that name.
 *
 * The dialog renders a Project name Input as the first focusable form
 * control, plus a Location field hydrated from `defaultProjectsRoot()`.
 * Cascade staleness is driven by typing into the name field (effective
 * target = joinPathPreview(location, sanitize(name))), Browse re-picking
 * the parent, window focus, and the 5 s confirm-git poll. The invariants
 * the suite pins are unchanged:
 *
 *   (S1) Re-typing the same name after an FS mutation produces a fresh
 *        probe and a banner that reflects the new FS state.
 *   (S2) Window focus re-probes against the current (parent, name).
 *   (S3) Inline remove-.git success re-probes; banner clears or
 *        repaints with the next-higher git root.
 *   (S4) Remove-.git invalidates inline confirmation state when the
 *        targeted gitRoot shifts under it.
 *   (S5) Remove-.git IPC failure surfaces inline; banner stays so the
 *        user can retry.
 *   (S6) Cascade probes folderState against the sanitized creation
 *        target, not the raw typed name.
 *
 * Invocation: `bun run test:dom` from `packages/app/`. Lives as a sibling
 * of `CreateProjectDialog.test.tsx` (which pins pure helpers + structural
 * source-text guards) — this file pins the runtime DOM contract that
 * pure-helper tests cannot reach because the staleness behavior lives in
 * the cascade-probe effect's dep-change handling, not in `computeCascade`
 * itself.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  OkDesktopBridge,
  OkFindEnclosingGitRootResult,
  OkFindEnclosingProjectRootResult,
  OkFolderState,
} from '@/lib/desktop-bridge-types';
import { CreateProjectDialog } from './CreateProjectDialog';

// Radix UI primitives (used by shadcn `Dialog`) reach for DOM globals at
// mount time. `MutationObserver` is pervasive across every Radix
// focus-scope (Dialog, DropdownMenu, Popover, Tooltip), so it lives in
// the shared `tests/dom/jsdom-preload.ts` alongside the other
// broadly-needed DOM constructors. The two below are genuinely
// test-specific — the shared preload deliberately does not ship them —
// so hoist them locally:
//
//   - `NodeFilter` — jsdom ships it on `window`; `react-focus-scope`
//     calls `document.createTreeWalker(..., NodeFilter.SHOW_ELEMENT, ...)`.
//   - `ResizeObserver` — jsdom does NOT ship one. `react-use-size`
//     constructs a bare `new ResizeObserver(...)`. The size value is
//     not load-bearing for this test (we never assert layout); a
//     minimal no-op shim is enough to clear the constructor call.
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

// Wide enough timeouts to absorb the dialog's internal 180 ms cascade
// debounce + jsdom microtask drain + React batch settle, without making
// a healthy run drag.
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
  /**
   * Replace `findEnclosingProjectRoot`'s impl. The test owns the new
   * impl's body entirely (count tracking, deferred resolution, etc.).
   * Use this instead of casting `bridge.fs` — a rename of the bridge
   * method would silently break ad-hoc casts; a typed setter trips
   * TypeScript at the setter site.
   */
  setFindEnclosingProjectRootImpl(
    impl: (path: string) => Promise<OkFindEnclosingProjectRootResult | null>,
  ): void;
  /**
   * Replace `findEnclosingGitRoot`'s impl. Same shape as
   * `setFindEnclosingProjectRootImpl` — call tracking + return value are
   * the test's responsibility. Use this when you need per-call control
   * (deferred resolution, throwing one call but not the next, etc.);
   * use `setEnclosingGitResult` for the simpler stable-result case.
   */
  setFindEnclosingGitRootImpl(
    impl: (path: string) => Promise<OkFindEnclosingGitRootResult | null>,
  ): void;
  readonly findGitCalls: ReadonlyArray<string>;
  readonly folderStateCalls: ReadonlyArray<string>;
  readonly removeGitCalls: ReadonlyArray<string>;
  readonly openFolderCalls: ReadonlyArray<number>;
}

/**
 * Programmable bridge stub. `findEnclosingGitRoot`'s return value is
 * read out of a closure cell each call so the test can mutate it
 * mid-flight to simulate the user deleting `.git` on disk between the
 * first probe and a subsequent re-probe. `removeGitFolder` is
 * customizable so tests can pin success / error / "delete one .git,
 * reveal a higher one" paths. `dialog.openFolder` returns a programmable
 * parent string so the test can drive Browse re-picks.
 */
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
  // Defaults use the closure-cell pattern (`currentGitResult` etc.) so the
  // simpler `setEnclosingGitResult` setter keeps working for tests that
  // just need to swap the return value mid-test. Tests that need per-call
  // control (deferred resolution, throwing one call but not the next)
  // call the typed-impl setters below to fully replace the default.
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
    // The dialog's `defaultProjectsRoot` catch + cascade-probe `catch`
    // arms log via console.warn; suppress to keep test output clean.
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('S1: re-typing the same name after an FS mutation produces a fresh probe', async () => {
    // Step 1. Mount the dialog. The Name input is the source of truth for
    // the project name; Location is hydrated from defaultProjectsRoot.
    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);

    // The Name input is the new contract. Pin its presence here so a
    // regression that drops it surfaces immediately.
    const nameInput = await screen.findByTestId('create-name', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(nameInput.tagName).toBe('INPUT');

    await waitForLocation();

    // Type the name → cascade probes → confirm-git banner appears.
    await typeName(PROJECT_NAME);
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // Step 2. Mutate the live FS (in-test): the user has just deleted
    // `.git` outside the app. Subsequent live probes return null.
    stub.setEnclosingGitResult(null);

    // Step 3. Snapshot the probe count, then clear and re-type the SAME
    // name. The contract: a fresh probe must fire — otherwise the banner
    // gets stuck on the stale confirm-git state. The mechanism (deps
    // change → debounced effect re-run) is an implementation detail; the
    // test pins the outcome only.
    const probesBeforeRetype = stub.findGitCalls.length;
    await typeName('');
    await typeName(PROJECT_NAME);

    // Precondition pin: a fresh probe actually fired. Without this, the
    // banner-absent assertion below is ambiguous — "absent because the
    // fresh probe returned null" looks identical to "absent because the
    // cascade is still in idle/pending and no probe fired at all."
    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - probesBeforeRetype;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // The contract assertion. Live FS no longer has `.git`, so the
    // cascade should now be `free` → banner absent. A stale-cache or
    // deps-bailout regression would leave the confirm-git banner up.
    //
    // Coerce the queried node to a boolean before the assertion. A bare
    // `expect(node).toBeNull()` makes Bun's diff renderer recurse into
    // the rejected jsdom `HTMLDivElement` and walk its `_globalObject`
    // back-reference, producing tens of thousands of lines of dump that
    // wall-clock at 30+ seconds even though the assertion itself is
    // sub-millisecond. Boolean coercion keeps the failure message a
    // single line.
    await waitFor(
      () => {
        const stillShowingStaleBanner = screen.queryByTestId('create-banner-git-confirm') !== null;
        expect(stillShowingStaleBanner).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('S2: window focus event triggers a re-probe — banner clears when FS resolves while dialog stays open', async () => {
    // The user opens the dialog, types a name, sees the .git banner,
    // switches to Finder/Terminal to `rm -rf .git`, then comes back. The
    // form is unchanged, but the banner must clear because the user's
    // interaction is unmistakably "I expect the app to recheck the world
    // right now."
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

    // FS mutates underneath; form is untouched.
    stub.setEnclosingGitResult(null);
    const callCountBeforeFocus = stub.findGitCalls.length;

    // Window focus — the listener bumps probeNonce → cascade-probe useEffect
    // re-runs against the same (location, name) but with the new probeNonce dep.
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
    // removeGitFolder both pretends to delete on disk AND mutates the stub
    // so the post-remove re-probe sees no enclosing .git anywhere up the tree.
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

    // Stage 1: click the inline "Remove" button → confirmation flips on.
    fireEvent.click(screen.getByTestId('create-banner-git-remove'));
    expect(screen.queryByTestId('create-banner-git-remove-confirm')).not.toBeNull();
    expect(stub.removeGitCalls.length).toBe(0);

    // Stage 2: click "Delete <path>" → IPC fires, then re-probe runs
    // against the freshly-null FS and the banner clears.
    //
    // Event-driven settle wait — wait for the re-probe to actually fire
    // BEFORE checking banner-null. Under the SettledCascade + ProbeLifecycle
    // split, cascade transitions from 'confirm-git' directly to 'free'
    // (~180 ms after probeNonce bumps); pre-split it transitioned through
    // 'pending' which was null-rendered, making banner-null immediate.
    // The bare banner-null waitFor races the 180 ms debounce on slower
    // CI runners. Same pattern as S1's probe-delta wait.
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
    // Two stacked git roots: `/Users/test` first (distance 1), then
    // `/Users` (distance 2) once the first is removed. The user has to
    // click Remove twice to clear them both — banner state must update
    // to the new root after each delete, not stick on the old one.
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

    // Banner shows pointing at the first (lowest) gitRoot.
    await waitFor(
      () => {
        const banner = screen.queryByTestId('create-banner-git-confirm');
        expect(banner?.textContent?.includes(FIRST.gitRoot)).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // First Remove → reveals the higher gitRoot in a fresh banner.
    // Same event-driven settle wait as S3 — wait for the re-probe to fire
    // before checking banner content (the SettledCascade split made the
    // post-remove transition async).
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
        // The probe must have actually settled to HIGHER — not still
        // showing FIRST. `'/Users/test'.includes('/Users')` is true, so
        // the positive substring above alone is satisfied even when the
        // banner still reflects FIRST. Add a negative assertion to
        // disambiguate: under the SettledCascade + ProbeLifecycle split,
        // cascade transitions FIRST → HIGHER directly (no intermediate
        // null-render via 'pending'), so this waitFor needs a strict
        // discriminator.
        expect(banner?.textContent?.includes(FIRST.gitRoot)).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // The inline confirmation must be RESET — the user is now looking at
    // a different gitRoot, so they should see the initial "Remove" button
    // again, not stale "Confirm deletion of /Users/test/.git" copy.
    expect(screen.queryByTestId('create-banner-git-remove-confirm')).toBeNull();
    expect(screen.queryByTestId('create-banner-git-remove')).not.toBeNull();

    // Second Remove → climbs above the last .git → banner clears entirely.
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
    // The server-side handler creates the project at `resolve(parent,
    // sanitizeFolderName(name))` — when the typed name is rewritten by
    // `sanitizeFolderName` (leading-dot names are the simplest
    // reproducer; `sanitizeFolderName('.hidden-notes')` → `'hidden-notes'`),
    // probing the raw name silently checks a different folder than the
    // one that will actually be created. The cascade banner can then
    // falsely permit (raw path empty, sanitized target non-empty → server
    // throws `target-not-empty` on submit) or falsely block (raw path
    // non-empty, sanitized target free → user is blocked from creating a
    // valid project). Pin the invariant: cascade probes the sanitized
    // join, the same path the server lands at.
    const RAW_NAME = '.hidden-notes';
    const EXPECTED_SANITIZED_TARGET = `${PARENT}/hidden-notes`;

    const stub = makeStubBridge(null, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    await typeName(RAW_NAME);

    // Wait until folderState fires at least once. The cascade must probe
    // the sanitized target, not the raw typed path — the server creates
    // the project at `resolve(parent, sanitized)`, so probing the raw
    // would folderState-check a different directory than the one created.
    await waitFor(
      () => {
        expect(stub.folderStateCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // The cascade probed the sanitized target — same path the server-side
    // handler creates the project at via `resolve(parent, sanitized)`.
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
    // The .git is still there; the banner is still up. The user can click
    // Remove again to retry. (The two-stage flow resets so they re-confirm.)
    expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
    expect(screen.queryByTestId('create-banner-git-remove')).not.toBeNull();
  });

  test('PRD-6649: banner DOM identity is stable across name keystrokes that re-probe to the same verdict', async () => {
    // Invariant: while the cascade-probe verdict is unchanged, the
    // CascadeBanner DOM subtree must NOT unmount/remount between probe
    // re-runs. If the probe lifecycle were allowed to snap `cascade` to
    // a non-terminal kind, CascadeBanner's early-return would drop the
    // banner to null, then ~180 ms later the debounced probe would
    // re-settle to the same terminal verdict and re-create the banner
    // div — a per-keystroke layout-reflow flash.
    //
    // The new dialog drives this contract via name keystrokes (each
    // keystroke changes the cascade-probe deps). Set up: name resolves
    // to a path inside an enclosing OK project so the probe returns
    // block-nested. findEnclosingProjectRoot returns a stable non-null
    // result, so the probe verdict is genuinely unchanged across both
    // keystroke rounds.
    const stub = makeStubBridge(null, PARENT);
    const nestedRoot = '/Users/test/existing-project';
    stub.setFindEnclosingProjectRootImpl(async (_path) => ({ rootPath: nestedRoot }));

    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    // Step 1: type a name → block-nested banner appears. This is the
    // steady state the user is "looking at" when they keep typing.
    await typeName('Plant');
    const initialBanner = await screen.findByTestId('create-banner-nested', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const bannerParent = initialBanner.parentElement;
    expect(bannerParent !== null).toBe(true);

    // Step 2: install a MutationObserver on the banner's parent (subtree:
    // true) so any removal of the banner div during subsequent name edits
    // is observable directly. The observer captures every childList
    // removal synchronously, so it doesn't depend on polling cadence or
    // React's commit timing.
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

    // Step 3: type more characters. The probe re-runs against the new
    // sanitized target; verdict stays block-nested (findEnclosingProject
    // still returns the same nestedRoot). The pre-fix shape would have
    // transitioned cascade through 'pending' here, unmounting the banner
    // div between keystrokes.
    await typeName('Plant Care Notes');

    // Step 4: wait — event-driven — for the debounced re-probe to fire.
    // Without this precondition, "banner not removed" could be trivially
    // satisfied by a future bail-out that skips the probe entirely.
    await waitFor(
      () => {
        const delta = stub.findGitCalls.length - probesBefore;
        expect(delta).toBeGreaterThanOrEqual(1);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // Step 5: wait for cascade to re-settle to block-nested (banner
    // still present).
    await waitFor(
      () => {
        expect(screen.queryByTestId('create-banner-nested')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    observer.disconnect();

    // The contract assertions, layered:
    //
    //   1. bannerWasRemoved — MutationObserver pin on the foundational
    //      contract ("while cascade-probe verdict is unchanged, the
    //      banner instance stays mounted"). The observer fires
    //      synchronously on any childList removal — captures the exact
    //      moment React's reconciler would have removed the banner if
    //      the unfixed pending-render code path were active.
    //   2. isConnected — belt-and-suspenders against a same-tick
    //      remove+re-attach the observer might coalesce. Would also
    //      catch a node re-parented to a different subtree.
    //   3. DOM-identity (===) — pins the user-visible contract directly:
    //      the banner the user is looking at is the same banner instance
    //      after the re-probe.
    expect(bannerWasRemoved).toBe(false);
    expect(initialBanner.isConnected).toBe(true);
    expect(screen.getByTestId('create-banner-nested') === initialBanner).toBe(true);
  });

  test('PRD-6649: canSubmit is gated by probeLifecycle: disabled while a probe is in-flight, re-enabled when settled', async () => {
    // Companion to the mount-identity test above. The SettledCascade +
    // ProbeLifecycle split has TWO halves of contract: (a) banner mount
    // identity stays stable during in-flight, (b) submit stays gated
    // (canSubmit === false) during in-flight so the user can't submit a
    // verdict that may be stale.
    //
    // Under the bug shape this guard prevents (a refactor that removed
    // `probeLifecycle === 'idle' &&` from canSubmit), the submit button
    // would re-enable while the probe is still resolving — letting the
    // user fire `createNew` against whatever cascade.kind happened to be
    // visible at click time (the previous verdict, not the in-flight
    // one).
    const stub = makeStubBridge(null, PARENT);
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    // Step 1: type a name → cascade settles to 'free' (initial nullable
    // findEnclosingGitRoot, default folderState='free'). canSubmit → true.
    await typeName('Plant Care');
    const submitButton = screen.getByTestId('create-submit') as HTMLButtonElement;
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    // Step 2: install a controllable deferred on findEnclosingGitRoot so
    // the next debounced probe stays in-flight indefinitely until the
    // test resolves it. The deferred is reset on every call; the test
    // controls when each probe settles. probeCallCount lets the test
    // wait event-driven for the debounced probe to actually fire (180 ms
    // later) before resolving the deferred.
    let probeCallCount = 0;
    let resolveDeferred: (value: OkFindEnclosingGitRootResult | null) => void = () => {};
    stub.setFindEnclosingGitRootImpl((_path) => {
      probeCallCount += 1;
      return new Promise<OkFindEnclosingGitRootResult | null>((r) => {
        resolveDeferred = r;
      });
    });

    // Step 3: edit the name — bumps deps → cascade useEffect re-runs →
    // setProbeLifecycle('in-flight') synchronously, 180 ms debounce,
    // probe stays in-flight. canSubmit drops to false.
    const probesBefore = probeCallCount;
    await typeName('Plant Care Notes');

    // Contract assertion: submit is disabled while the probe is
    // in-flight. Under the bug shape this guard prevents, this expect
    // would fail — submit would re-enable on the in-flight render.
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

    // Step 4: resolve the deferred → probe settles → cascade re-renders
    // to a terminal verdict → canSubmit re-enables.
    resolveDeferred(null);
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('PRD-6649: 5 s polling skips probeNonce bump while a probe is in-flight (race-prevention gate)', async () => {
    // The 5 s confirm-git polling effect's setInterval callback gates
    // probeNonce bumps on `probeLifecycleRef.current !== 'in-flight'`.
    // Without the gate, polling-triggered probeNonce bumps cancel
    // in-flight probes via the cascade-probe useEffect cleanup function
    // (clearTimeout + ctrl.abort()), leaving the banner stuck on whatever
    // settled verdict was visible when the new probe started.
    //
    // With a unified state shape this race would be harmless: cascade
    // transitioning through a `pending` discriminant unmounts the banner
    // itself, so a cancelled probe just delays the eventual
    // settle-to-terminal. Under the SettledCascade + ProbeLifecycle
    // split the banner stays mounted with its previous terminal verdict
    // during in-flight, so a cancelled probe leaves the banner stuck on
    // a stale verdict — the exact failure the gate prevents.
    //
    // The test pins BOTH halves of the gate's contract:
    //   (a) while a probe is in-flight, polling-triggered ticks do NOT
    //       fire a fresh probe (the gate's reason for existing)
    //   (b) once the probe settles, polling-triggered ticks DO fire a
    //       fresh probe (the gate doesn't permanently disable polling)
    //
    // A regression removing the gate (the bare `if (...) return` line)
    // would cause assertion (a) to fail: the manually-invoked polling
    // callback would bump probeNonce → cascade-probe re-runs → aborts
    // the in-flight probe → fresh debounce timer → 180 ms later a new
    // probe fires → probeCallCount increases.

    const stub = makeStubBridge(FIRST_GIT_RESULT, PARENT);

    // Spy on globalThis.setInterval to capture the polling callback.
    // Don't override the implementation — let the real setInterval
    // schedule. The test completes well under 5 s, so the real interval
    // never fires during the test; we drive it manually instead.
    const setIntervalSpy = spyOn(globalThis, 'setInterval');

    try {
      render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
      await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
      await waitForLocation();

      // Step 1: type a name → cascade probes → settles to confirm-git.
      // The polling effect (cascade.kind === 'confirm-git') mounts and
      // calls setInterval with the gated callback.
      await typeName(PROJECT_NAME);
      await waitFor(
        () => {
          expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      // Step 2: capture the polling callback. The polling setInterval
      // is the only one in the dialog with a 5 s interval. Bun's spyOn
      // calls through by default, so the real interval is scheduled
      // (we just don't wait for it).
      const pollingCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 5_000);
      expect(pollingCalls.length).toBeGreaterThanOrEqual(1);
      const pollingCallback = pollingCalls[pollingCalls.length - 1]?.[0] as
        | (() => void)
        | undefined;
      expect(typeof pollingCallback).toBe('function');
      if (typeof pollingCallback !== 'function') return;

      // Step 3: install a controllable deferred on findEnclosingGitRoot
      // so the next probe stays in-flight indefinitely. Track call count
      // so the test can observe whether new probes fire.
      let probeCallCount = 0;
      let resolveDeferred: (value: OkFindEnclosingGitRootResult | null) => void = () => {};
      stub.setFindEnclosingGitRootImpl((_path) => {
        probeCallCount += 1;
        return new Promise<OkFindEnclosingGitRootResult | null>((r) => {
          resolveDeferred = r;
        });
      });

      // Step 4: trigger a fresh probe via name edit → cascade-probe
      // useEffect re-runs → setProbeLifecycle('in-flight') synchronously
      // → 180 ms debounce → probe fires → stays in-flight (Promise never
      // resolves until we resolve it).
      await typeName(`${PROJECT_NAME} (v2)`);
      await waitFor(
        () => {
          expect(probeCallCount).toBeGreaterThanOrEqual(1);
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );
      const probeCountWhileInFlight = probeCallCount;

      // (a) THE GATE — invoke the polling callback while the probe is
      // in-flight. The gate should skip the probeNonce bump.
      pollingCallback();

      // Give React + the debounce a chance to fire if the gate failed.
      // 250 ms is well past PROBE_DEBOUNCE_MS (180 ms) — a missing gate
      // would have scheduled and fired a new probe by now.
      await new Promise((r) => setTimeout(r, 250));

      // Contract assertion (a): no new probe fired. probeCallCount is
      // unchanged from the in-flight count. Under a regression removing
      // the gate, probeCallCount would have grown.
      expect(probeCallCount).toBe(probeCountWhileInFlight);

      // (b) POLLING RESUMES — resolve the in-flight probe → cascade
      // settles → probeLifecycle returns to 'idle' (via the .then arm
      // in the cascade-probe useEffect).
      resolveDeferred(FIRST_GIT_RESULT);

      // Wait for the cascade to re-settle: the .then callback fires
      // setProbeLifecycle('idle') + setCascade(...), then React commits
      // the render, then the probeLifecycleRef-update useEffect fires
      // and writes 'idle' to the ref. Polling can resume after that.
      // Easiest event-driven signal: wait for the banner to be
      // confirm-git again (it was during the deferred state but the
      // .then might overwrite cascade to a different terminal verdict
      // briefly during in-flight). The findGitCallCount stays constant
      // because no NEW probe has fired yet.
      await waitFor(
        () => {
          expect(screen.queryByTestId('create-banner-git-confirm')).not.toBeNull();
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      // Now invoke the polling callback again. Probe should be 'idle';
      // the gate should NOT block. probeNonce bumps → cascade-probe
      // useEffect re-runs → 180 ms debounce → new probe fires.
      const probeCountBeforeIdleTick = probeCallCount;
      pollingCallback();

      // Wait for the new probe to actually fire.
      await waitFor(
        () => {
          expect(probeCallCount).toBeGreaterThan(probeCountBeforeIdleTick);
        },
        { timeout: ASYNC_TIMEOUT_MS },
      );

      // Resolve so the test cleanup doesn't leave a dangling Promise.
      resolveDeferred(FIRST_GIT_RESULT);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test('PRD-6649: probeLifecycle resets to idle on IPC-failure catch arm (canSubmit recovers after transient failure)', async () => {
    // Pins the catch-arm setProbeLifecycle('idle') reset. The
    // cascade-probe useEffect's .catch arm falls back to setCascade({
    // kind: 'free' }) on probe failure — same as before the split — but
    // ALSO now calls setProbeLifecycle('idle') before the fallback. If
    // that reset were ever removed by a future refactor, probeLifecycle
    // would stick at 'in-flight' after any IPC failure, permanently
    // disabling submit (the canSubmit gate's probeLifecycle === 'idle'
    // term would never be true again until the user picks a new target).
    //
    // The bridge IPC boundary is a real failure surface — `bridge.fs.*`
    // calls can reject (Electron utility-process crash, IPC marshalling
    // error, transient FS failure). Submit must recover after the catch
    // arm lands.
    const stub = makeStubBridge(null, PARENT);
    // Set findEnclosingGitRoot to reject. Promise.all in the cascade
    // probe will reject on the first reject, so the catch arm fires
    // regardless of which sibling probe fails.
    stub.setFindEnclosingGitRootImpl(async (_path) => {
      throw new Error('Simulated IPC failure');
    });
    render(<CreateProjectDialog open={true} onOpenChange={() => {}} bridge={stub.bridge} />);
    await screen.findByTestId('create-name', undefined, { timeout: ASYNC_TIMEOUT_MS });
    await waitForLocation();

    // Type a name → cascade-probe fires → Promise.all rejects → .catch
    // arm calls setProbeLifecycle('idle') then setCascade({ kind: 'free' }).
    await typeName(PROJECT_NAME);

    const submitButton = screen.getByTestId('create-submit') as HTMLButtonElement;

    // Contract assertion: after the catch arm lands, canSubmit is true.
    // Both halves of the catch are load-bearing:
    //   - setCascade({ kind: 'free' }) → cascade.kind matches the AND-arm
    //   - setProbeLifecycle('idle') → probeLifecycle gate matches
    // A regression that removed EITHER would leave submit disabled.
    await waitFor(
      () => {
        expect(submitButton.disabled).toBe(false);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });
});
