/**
 * Playwright fixture helpers for the `handoff.e2e.ts` matrix.
 *
 * Goal: drive the Open-in-Agent dispatch flow across 8 cells
 * without dependencies on what Claude / Codex / Cursor is actually installed
 * on the CI runner, and without triggering real cross-app URL dispatch.
 *
 * Two host modes:
 *   - `host: 'electron'` — installs a mock `window.okDesktop` bridge via
 *     `page.addInitScript`. Every shell method is a capturing stub. The
 *     initial probe + on-open refresh both consult `shell.detectProtocol`
 *     which reads from the injected mock state.
 *   - `host: 'web'` — leaves `window.okDesktop` undefined so the app falls
 *     through to the web path. `GET /api/installed-agents` is intercepted
 *     via `page.route` and served from the injected mock state.
 *
 * Anchor-click capture (both hosts):
 *   Handoff URL dispatch on web host uses a short-lived `<a href=... click>`
 *   pattern. Without interception, Chromium
 *   would either navigate away (for `https://claude.ai/...`) or hit a
 *   protocol-handler dialog (for `claude://`, `codex://`, `cursor://`). This
 *   file patches `HTMLAnchorElement.prototype.click` to capture clicks on
 *   anchors whose href matches a known handoff scheme / host, record the
 *   URL into `window.__handoffMocks__.anchorClicks`, and swallow the click.
 *   All other anchor clicks (sidebar nav, install-affordance `<button>`s in
 *   tooltips when dispatched via Electron) fall through unchanged.
 *
 * Time control:
 *   The install-detect coordinator throttles `refresh()` to once per 10s per
 *   scheme. For the install-state-flip cell the test must advance past the
 *   throttle window without stalling the run for 10s wall-time. The init
 *   script patches `Date.now` only (not `setTimeout` / `setInterval`) so
 *   WebSocket heartbeats + sonner toast lifecycles keep running on real
 *   time while the handoff hook's lastProbedAt check sees future-time on
 *   `advanceHandoffFakeTime(ms)`.
 */

import type { Page } from '@playwright/test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export interface InstallMap {
  /** Single `claude:` scheme covers both Claude Cowork + Claude rows. */
  readonly claude: boolean;
  readonly codex: boolean;
  readonly cursor: boolean;
}

export interface HandoffMockConfig {
  readonly host: 'electron' | 'web';
  readonly install: InstallMap;
  /** Worker's baseURL — passed so the mock bridge's `collabUrl` / `apiOrigin`
   *  point at the real Vite+Hocuspocus instance for this worker. */
  readonly workerBaseURL: string;
  /** Worker's content dir — passed so the mock bridge's `projectPath`
   *  matches the on-disk content dir and `useWorkspace()` resolves cleanly. */
  readonly workerContentDir: string;
}

export interface CapturedHandoff {
  readonly anchorClicks: ReadonlyArray<string>;
  readonly openExternalCalls: ReadonlyArray<string>;
  readonly detectProtocolCalls: ReadonlyArray<string>;
  readonly handoffApiCalls: ReadonlyArray<{
    readonly target: string;
    readonly url: string;
    readonly workspacePath?: string;
  }>;
  readonly recordHandoffCalls: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Install the handoff mock harness onto the page.
 *
 * Call BEFORE `page.goto(...)` — `page.addInitScript` takes effect on the
 * next document load, and `page.route` must be installed before the
 * `/api/installed-agents` fetch fires (which happens on app mount when
 * `useInstalledAgents` boots).
 */
export async function installHandoffMocks(page: Page, cfg: HandoffMockConfig): Promise<void> {
  // Intercept `/api/handoff` for both Electron and Web hosts — the unified
  // dispatch endpoint POSTed by `dispatch.ts`. Tests must intercept before
  // it reaches the worker server, which runs on a CI host where Claude /
  // Codex / Cursor likely aren't installed (and we'd be racing OS-level
  // app launches). Returns 200 unconditionally so the renderer's
  // `dispatchHandoff` resolves successfully; tests assert on the captured
  // body via `mocks.handoffApiCalls` (populated by the window.fetch
  // wrapper in the init script).
  await page.route('**/api/handoff', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
  // Web-host install-detect path: intercept the HTTP probe before it hits
  // the real server. Route handlers persist for the page's lifetime; the
  // later `updateWebInstallMap` helper re-registers on top.
  if (cfg.host === 'web') {
    await page.route('**/api/installed-agents', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.install),
      });
    });
    // Web-host install gate: defense-in-depth no-op for `POST /api/install-skill`.
    // The install-state mock below should already short-circuit at Step 1 of
    // the gate ladder in `cowork-skill-install.ts`, so this route is unreachable
    // in steady state. It exists to keep `~/.ok/skill-state.yml` clean if a
    // future refactor changes the gate's short-circuit semantics — preventing the real
    // `buildAndOpenSkill` build that pollutes the runner's home directory and
    // re-introduces the install-flake class. Body shape mirrors the canonical
    // `skip-current` response `httpSkillInstaller` parses (for the
    // `skip-current` branch, `status` drives control flow; `outputPath` and
    // `handoffError` are absent on real responses, so any extras here are
    // inert — but a `built` or `installed` status would also need
    // `outputPath`).
    await page.route('**/api/install-skill', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'skip-current',
          skillVersion: '0.0.0-test-fixture',
          recordedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
    });
  }

  // Cowork install-gate short-circuit. `GET /api/skill/install-state` is
  // host-agnostic — both web and Electron renderers call it from `runEnsure`
  // in `cowork-skill-install.ts`; only Step 3's installer differs by host
  // (HTTP POST on web, IPC bridge on Electron). Returning a snapshot whose
  // `targets['claude-cowork'].version` equals `currentVersion` makes the
  // gate's verdict deterministic (`{ kind: 'already-installed',
  // source: 'server' }`), so the `claude-cowork` install-gate branch in
  // `runHandoffDispatch` falls through past the install-gate branch to the
  // URL-dispatch path. Snapshot body mirrors the wire format
  // `readSkillInstallStateSnapshot` emits in `api-extension.ts` (the source
  // schema is `SkillStateSchema` in `skill-state/schema.ts`, declared as a
  // `z.looseObject`, so additive server changes won't break this mock).
  // Sentinel version `'0.0.0-test-fixture'` satisfies the
  // `SKILL_STATE_VERSION_RE` semver shape so the snapshot is structurally
  // valid for any future stricter parser.
  await page.route('**/api/skill/install-state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        currentVersion: '0.0.0-test-fixture',
        targets: {
          'claude-cowork': {
            version: '0.0.0-test-fixture',
            recordedAt: '2026-01-01T00:00:00.000Z',
          },
          'cli-hosts': null,
        },
      }),
    });
  });

  // Init script: runs before ANY page script on every document load.
  // Plants the capture object + anchor-click interceptor + (Electron only)
  // the window.okDesktop bridge.
  await page.addInitScript((args) => {
    const { host, install, workerBaseURL, workerContentDir } = args as HandoffMockConfig;

    // ---- Capture scaffold ----
    interface HandoffApiCall {
      target: string;
      url: string;
      workspacePath?: string;
    }
    interface HandoffMocksState {
      anchorClicks: string[];
      openExternalCalls: string[];
      detectProtocolCalls: string[];
      handoffApiCalls: HandoffApiCall[];
      recordHandoffCalls: Record<string, unknown>[];
      install: { claude: boolean; codex: boolean; cursor: boolean };
      fakeTimeOffset: number;
      /** Web-host only: set once `/api/installed-agents` fetch resolves so
       *  tests can poll for the probe having landed. */
      installedAgentsFetchResolved: boolean;
    }
    const mocks: HandoffMocksState = {
      anchorClicks: [],
      openExternalCalls: [],
      detectProtocolCalls: [],
      handoffApiCalls: [],
      recordHandoffCalls: [],
      install: { ...install },
      fakeTimeOffset: 0,
      installedAgentsFetchResolved: false,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    (window as any).__handoffMocks__ = mocks;

    // ---- Fetch instrumentation for probe-settled detection (web host) ----
    // The install-detect coordinator's `probeViaFetch` strategy calls
    // `fetch('/api/installed-agents')`. Wrap window.fetch so we set a flag
    // when the response resolves — tests poll this instead of racing the
    // React state update. No-op for Electron cells (detectProtocol is the
    // probe strategy there, captured via detectProtocolCalls directly).
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      // Capture `/api/handoff` POST body before forwarding so tests can
      // assert on the dispatched target / URL / workspacePath. Fail-soft:
      // if reading init.body throws, fall through unchanged.
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        if (url.includes('/api/handoff') && !url.includes('/api/handoff-')) {
          if (init?.body && typeof init.body === 'string') {
            try {
              const parsed = JSON.parse(init.body) as {
                target?: string;
                url?: string;
                workspacePath?: string;
              };
              mocks.handoffApiCalls.push({
                target: parsed.target ?? '',
                url: parsed.url ?? '',
                ...(parsed.workspacePath !== undefined
                  ? { workspacePath: parsed.workspacePath }
                  : {}),
              });
            } catch {
              // Body wasn't JSON — record empty placeholder.
              mocks.handoffApiCalls.push({ target: '', url: '' });
            }
          }
        }
      } catch {
        // Defensive — never let instrumentation corrupt the real fetch.
      }
      const res = await originalFetch(input, init);
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        if (url.includes('/api/installed-agents')) {
          mocks.installedAgentsFetchResolved = true;
        }
      } catch {
        // Defensive — never let instrumentation corrupt the real fetch.
      }
      return res;
    };
    // Cast through unknown because Bun's globals.d.ts augments `typeof fetch`
    // with a `fetch.preconnect` namespace member that the wrapper doesn't
    // implement. Standard lib.dom.d.ts does not declare `preconnect`.
    window.fetch = wrappedFetch as unknown as typeof window.fetch;

    // ---- Anchor-click interceptor (both hosts) ----
    const HANDOFF_SCHEMES = new Set(['claude:', 'codex:', 'cursor:']);
    const HANDOFF_HOSTS = new Set(['claude.ai']);
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      try {
        const u = new URL(this.href);
        if (HANDOFF_SCHEMES.has(u.protocol) || HANDOFF_HOSTS.has(u.hostname)) {
          mocks.anchorClicks.push(this.href);
          return;
        }
      } catch {
        // Invalid URL — fall through to real click.
      }
      return originalAnchorClick.call(this);
    };

    // ---- Date.now patching for throttle bypass (install-state-flip cell) ----
    // ONLY patch Date.now — NOT setTimeout / setInterval — so real wall-clock
    // timers (WebSocket heartbeats, sonner lifecycles, React scheduler) keep
    // running. The install-detect coordinator reads `deps.now` (bound to
    // Date.now); patching here lets us advance its view of time without
    // stalling the test for 10 real seconds.
    const realDateNow = Date.now.bind(Date);
    Date.now = () => realDateNow() + mocks.fakeTimeOffset;

    // ---- Electron-host bridge injection ----
    if (host === 'electron') {
      const shellStub = {
        openExternal: async (url: string): Promise<void> => {
          mocks.openExternalCalls.push(url);
        },
        detectProtocol: async (
          scheme: string,
        ): Promise<{ installed: boolean; displayName?: string }> => {
          mocks.detectProtocolCalls.push(scheme);
          const key = scheme.replace(':', '') as keyof InstallMap;
          const installed = mocks.install[key] ?? false;
          return installed
            ? { installed: true, displayName: `${scheme.replace(':', '')}-mock` }
            : { installed: false };
        },
        // No-op stub — the unified `/api/handoff` design routes Cursor
        // through the HTTP endpoint, not this IPC channel. Required by the
        // `OkDesktopBridge` contract until the IPC surface is retired.
        spawnCursor: async (): Promise<{ ok: true }> => ({ ok: true }),
        recordHandoff: async (line: Record<string, unknown>): Promise<void> => {
          mocks.recordHandoffCalls.push(line);
        },
        openAsset: async (): Promise<{ ok: true }> => ({ ok: true }),
        revealAsset: async (): Promise<{ ok: true }> => ({ ok: true }),
        showAssetMenu: async (): Promise<void> => {},
        showItemInFolder: async (): Promise<void> => {},
        // No-op stub — sidebar Delete flow isn't exercised by the handoff
        // stress fixtures, but the `OkDesktopBridge` contract requires every
        // shell.* method to be present for `satisfies OkDesktopBridge` to
        // typecheck.
        trashItem: async (): Promise<{ ok: true }> => ({ ok: true }),
      };

      // Typed with `satisfies OkDesktopBridge` so any drift between the
      // canonical contract (`packages/core/src/desktop-bridge.ts`) and this
      // fixture fails `bun run typecheck` instead of going silent.
      // `tests/stress/fixtures` is in `packages/app/tsconfig.json` `include`
      // for this reason. Imported types erase at runtime, so the
      // `addInitScript` callback's stringification is unaffected.
      //
      // Coverage limit: TypeScript function subtyping accepts shape-
      // compatible parameters silently, so signature-shape drift on
      // existing methods (e.g. a new required field on a request param)
      // passes here. That drift class is caught instead by the three
      // OkDesktopBridge contract copies (core / desktop / app) being
      // consumed across enough call sites that divergence surfaces at
      // `bun run typecheck`. `packages/desktop/tests/integration/
      // m1-smoke.test.ts` is the member-name drift catcher (set-equality
      // on extracted member names across the three copies); its own
      // signature-coverage disclaimer documents the gap explicitly.
      const bridge = {
        config: {
          // Hocuspocus is mounted at /collab by the Vite plugin (the upgrade
          // handler in `hocuspocus-plugin.ts` filters on
          // `req.url.startsWith('/collab')`). Passing just `ws://host:port`
          // without the path makes the WebSocket upgrade request hit Vite's
          // HMR handler instead of Hocuspocus, and the provider never reports
          // synced.
          collabUrl: `${workerBaseURL.replace(/^http/, 'ws')}/collab`,
          apiOrigin: workerBaseURL,
          projectPath: workerContentDir,
          projectName: 'handoff-e2e-fixture',
          mode: 'editor' as const,
          e2eSmoke: false,
          singleFile: false,
          initialDoc: null,
        },
        onProjectSwitched: () => () => {},
        onMenuAction: () => () => {},
        onUpdateDownloaded: () => () => {},
        onUpdateRelaunching: () => () => {},
        onUpdateRelaunchFailed: () => () => {},
        onWhatsNew: () => () => {},
        onWhatsNewDismissed: () => () => {},
        onUpdateStuckHint: () => () => {},
        onDeepLink: () => () => {},
        onShareReceived: () => () => {},
        onServerVersionDrift: () => () => {},
        onServerRestarted: () => () => {},
        onServerReclaimed: () => () => {},
        restartServer: async () => ({ ok: true as const }),
        // Theme bridge is invoked on first ConfigProvider render via
        // useThemeBridge — must not throw or the ConfigProvider subtree
        // unmounts before NavigationHandler can call pool.setActive(docName).
        setThemeSource: async (): Promise<{ ok: true }> => ({ ok: true }),
        signalThemeApplied: (): void => {},
        dialog: {
          openFolder: async () => null,
        },
        fs: {
          defaultProjectsRoot: async () => workerContentDir,
          folderState: async () => 'free' as const,
          findEnclosingProjectRoot: async () => null,
          findEnclosingGitRoot: async () => null,
          removeGitFolder: async () => undefined,
        },
        shell: shellStub,
        clipboard: {
          writeText: async () => {},
        },
        project: {
          listRecent: async () => [],
          removeRecent: async () => {},
          // Tab-session-restore effect in DocumentContext reads
          // getSessionState on first render; setSessionState fires on tab
          // mutations. Both must resolve cleanly or the editor tree never
          // installs the __activeProvider getter the e2e helper polls.
          getSessionState: async () => ({
            openTabs: [],
            pinnedTabIds: [],
            activeDocName: null,
            activeTabId: null,
            updatedAt: null,
          }),
          setSessionState: async () => {},
          open: async () => {},
          createNew: async () => {},
          recordCreateNewBannerShown: async () => {},
          checkTargetExists: async () => 'unreadable' as const,
          readHeadBranch: async () => ({ currentBranch: null, headSha: null, detached: false }),
          fetchBranchInfo: async () => null,
          runCheckout: async () => null,
          fetchTargetStatus: async () => null,
          awaitBranchSwitched: async () => ({ ok: false, reason: 'timeout' as const }),
          okInit: async () => ({
            ok: false as const,
            reason: 'init-failed' as const,
            message: 'test mock',
          }),
          close: async () => {},
        },
        worktree: {
          list: async () => ({ ok: false as const, reason: 'no-git' as const }),
          create: async () => ({ ok: false as const, reason: 'no-git' as const }),
        },
        sharing: {
          status: async () =>
            ({
              kind: 'status' as const,
              mode: 'shared' as const,
              excluded: [],
              trackedUpstream: [],
            }) satisfies import('@/lib/desktop-bridge-types').OkSharingStatusResult,
          setMode: async () => ({
            kind: 'applied' as const,
            mode: 'shared' as const,
          }),
        },
        navigator: {
          open: async () => {},
        },
        seed: {
          plan: async () => ({ ok: false, error: { kind: 'no-project', message: 'test mock' } }),
          apply: async () => ({ ok: false, error: { kind: 'no-project', message: 'test mock' } }),
          listPacks: async () => ({ ok: true, packs: [] }),
        },
        skill: {
          detectClaudeDesktop: async () => false,
          buildAndOpen: async () => ({ ok: false, reason: 'build-failed', message: 'test mock' }),
        },
        update: {
          relaunchNow: async () => {},
          checkNow: async () => {},
          dismissWhatsNew: async () => {},
        },
        // installUpdateNoticesBridge() at main.tsx module-init invokes
        // bridge.state.query() (the result is consumed via .then(...) in
        // the installUpdateNoticesBridge body in update-notices-store.ts).
        // The throw happens at property-access time, not in the awaited
        // body — accessing `query` on an undefined `bridge.state` raises
        // TypeError synchronously, halting module-init before createRoot
        // runs.
        state: {
          query: async () => ({
            channel: 'latest' as const,
            schemaIncompatibility: null,
          }),
          resetIncompatible: async () => {},
        },
        mcpWiring: {
          onShow: () => () => {},
          signalReady: () => {},
          confirm: async () => ({ ok: true }),
          skip: async () => ({ ok: true }),
        },
        integrations: {
          status: async () => ({
            available: false,
            editors: [],
            path: { shellDetected: false, rcFilesToTouch: [], installed: false },
            skills: [],
          }),
          setComponent: async () => ({
            ok: false as const,
            error: 'unavailable in tests',
            status: {
              available: false,
              editors: [],
              path: { shellDetected: false, rcFilesToTouch: [], installed: false },
              skills: [],
            },
          }),
        },
        projectIntegrations: {
          status: async () => ({
            available: false,
            hasProject: false,
            projectDir: null,
            editors: [],
            skill: null,
          }),
          setComponent: async () => ({
            ok: false as const,
            error: 'unavailable in tests',
            status: {
              available: false,
              hasProject: false,
              projectDir: null,
              editors: [],
              skill: null,
            },
          }),
        },
        // installConsentListener + installOnboardingToastListener are
        // wired unconditionally by main.tsx (both guarded internally by
        // `if (!b.onboarding) return`), so these stubs run at the
        // subscription-install layer even in editor-mode boot. All
        // onboarding + localOp members below are stubbed to keep the
        // satisfies clause structurally complete — the selective-field
        // minimum would pass typecheck but defeat its purpose as a
        // contract backstop.
        onboarding: {
          onShow: () => () => {},
          signalReady: () => {},
          confirm: async () => ({ ok: true }),
          cancel: async () => ({ ok: true }),
          probeContent: async () => ({
            ok: true as const,
            count: 0,
            sample: [],
            truncated: false,
          }),
          onToast: () => () => {},
        },
        localOp: {
          auth: {
            start: () => ({
              events: (async function* () {})(),
              cancel: () => {},
            }),
          },
          clone: {
            start: () => ({
              events: (async function* () {})(),
              cancel: () => {},
            }),
          },
          authStatus: async () => ({ authenticated: false as const, host: 'github.com' }),
          authRepos: async () => ({ ok: true as const, host: 'github.com', repos: [] }),
        },
        share: {
          validateLocalFolder: async () => ({ kind: 'not-git' as const }),
        },
        // Sidebar context-menu surfaces — no-op stubs. Stress fixtures
        // don't exercise File-menu state-aware rebuilds or View-menu
        // tree-state push, but the `OkDesktopBridge` contract requires
        // these surfaces for `satisfies OkDesktopBridge` to typecheck.
        editor: {
          notifyActiveTargetChanged: (): void => {},
          notifyViewMenuStateChanged: (): void => {},
        },
        startup: {
          reportMarks: (): void => {},
        },
        sidebar: {
          expandAll: (_cb: () => void) => () => {},
          collapseAll: (_cb: () => void) => () => {},
        },
        terminal: {
          create: async () => ({ ok: true as const, ptyId: 'mock-pty' }),
          input: () => {},
          resize: () => {},
          kill: async () => {},
          drain: () => {},
          list: async () => [],
          adopt: async () => ({ ok: true as const, replay: '' }),
          setMeta: () => {},
          setOrder: () => {},
          getDockState: async () => ({ visible: false }),
          onData: () => () => {},
          onExit: () => () => {},
          claudePreflight: async () => ({ claude: 'present' as const, mcp: 'wired' as const }),
          cliPreflight: async () => ({ onPath: 'present' as const }),
          cliInstalledMap: async () => ({
            claude: true,
            codex: true,
            opencode: true,
            cursor: true,
            pi: true,
          }),
          rewireClaudeMcp: async () => ({ claude: 'present' as const, mcp: 'wired' as const }),
        },
        platform: 'darwin' as const,
        appVersion: 'test-0.0.0',
        getPathForFile: () => null,
      } satisfies OkDesktopBridge;

      // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
      (window as any).okDesktop = bridge;
    }

    // ---- Cowork skill install-guard seed (offline fallback) ----
    // The Open-in-Agent dropdown's `claude-cowork` row routes through a lazy
    // install gate (`ensureCoworkSkillInstalled` in `cowork-skill-install.ts`)
    // on first click per skill version. The 3-step gate ladder is:
    //   1. `GET /api/skill/install-state` — server check.
    //   2. `localStorage` lookup of `ok:skill:cowork:installed:v<version>`.
    //   3. Real install: `POST /api/install-skill` (web) or
    //      `okDesktop.skill.buildAndOpen()` IPC (Electron). On the Electron
    //      bridge stub above, `buildAndOpen` returns `build-failed` — gate
    //      then returns `install-failed` and `runHandoffDispatch` early-
    //      returns with an error toast (no URL dispatch).
    //
    // Once the server-check Step 1 was introduced, the gate's lookup key for
    // Step 2 uses `snapshot.currentVersion` from the server response — which
    // on the real server is `@inkeep/open-knowledge-server`'s package.json
    // version (e.g. `0.4.0-beta.6`), NOT the `'unknown'` literal this seed
    // writes. The load-bearing short-circuit is now the
    // `/api/skill/install-state` route mock above (returns a snapshot whose
    // recorded `claude-cowork` version equals `currentVersion`, so the gate
    // resolves at Step 1 with `'already-installed', source: 'server'`).
    //
    // This localStorage seed is retained as the offline fallback (Step 2)
    // for environments where the server is unreachable — it preserves the
    // legacy offline-only contract and keeps the unit-test parity with
    // `useHandoffDispatch.test.ts`. The install gate itself is covered by
    // unit tests, not this matrix.
    try {
      // biome-ignore lint/suspicious/noExplicitAny: matches production resolution in cowork-skill-install.ts.
      const ver = (window as any).okDesktop?.appVersion ?? 'unknown';
      window.localStorage.setItem(`ok:skill:cowork:installed:v${ver}`, '1');
    } catch {
      // localStorage unavailable (sandboxed) — gate falls through harmlessly.
    }
  }, cfg);
}

/** Read all captured calls. */
export async function readCapturedHandoff(page: Page): Promise<CapturedHandoff> {
  return await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    const mocks = (window as any).__handoffMocks__ as {
      anchorClicks: string[];
      openExternalCalls: string[];
      detectProtocolCalls: string[];
      handoffApiCalls: { target: string; url: string; workspacePath?: string }[];
      recordHandoffCalls: Record<string, unknown>[];
    };
    return {
      anchorClicks: [...mocks.anchorClicks],
      openExternalCalls: [...mocks.openExternalCalls],
      detectProtocolCalls: [...mocks.detectProtocolCalls],
      handoffApiCalls: mocks.handoffApiCalls.map((c) => ({ ...c })),
      recordHandoffCalls: mocks.recordHandoffCalls.map((l) => ({ ...l })),
    };
  });
}

/**
 * Swap the Electron-host install map mid-test. After calling, the next
 * `shell.detectProtocol(scheme)` returns the new value. Pair with
 * `advanceHandoffFakeTime(11_000)` to bypass the 10s throttle so the
 * next `refresh()` actually probes.
 */
export async function updateElectronInstallMap(page: Page, install: InstallMap): Promise<void> {
  await page.evaluate((next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    const mocks = (window as any).__handoffMocks__;
    mocks.install = { ...next };
  }, install);
}

/**
 * Swap the web-host install response. Re-registers the page.route handler
 * so subsequent GET /api/installed-agents fetches see the new value.
 * Pair with `advanceHandoffFakeTime(11_000)` as above.
 */
export async function updateWebInstallMap(page: Page, install: InstallMap): Promise<void> {
  await page.unroute('**/api/installed-agents');
  await page.route('**/api/installed-agents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(install),
    });
  });
}

/**
 * Advance the page's `Date.now()` view by `ms` milliseconds. Only affects
 * `Date.now` (the install-detect coordinator's throttle check reads this).
 * Real `setTimeout` / `setInterval` fire on wall-clock time.
 */
export async function advanceHandoffFakeTime(page: Page, ms: number): Promise<void> {
  await page.evaluate((delta) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    const mocks = (window as any).__handoffMocks__;
    mocks.fakeTimeOffset += delta;
  }, ms);
}
