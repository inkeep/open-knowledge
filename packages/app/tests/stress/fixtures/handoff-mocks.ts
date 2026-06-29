import type { Page } from '@playwright/test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export interface InstallMap {
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

export async function installHandoffMocks(page: Page, cfg: HandoffMockConfig): Promise<void> {
  await page.route('**/api/handoff', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
  if (cfg.host === 'web') {
    await page.route('**/api/installed-agents', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.install),
      });
    });
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

  await page.addInitScript((args) => {
    const { host, install, workerBaseURL, workerContentDir } = args as HandoffMockConfig;

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

    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
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
              mocks.handoffApiCalls.push({ target: '', url: '' });
            }
          }
        }
      } catch {}
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
      } catch {}
      return res;
    };
    window.fetch = wrappedFetch as unknown as typeof window.fetch;

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
      } catch {}
      return originalAnchorClick.call(this);
    };

    const realDateNow = Date.now.bind(Date);
    Date.now = () => realDateNow() + mocks.fakeTimeOffset;

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
        spawnCursor: async (): Promise<{ ok: true }> => ({ ok: true }),
        recordHandoff: async (line: Record<string, unknown>): Promise<void> => {
          mocks.recordHandoffCalls.push(line);
        },
        openAsset: async (): Promise<{ ok: true }> => ({ ok: true }),
        revealAsset: async (): Promise<{ ok: true }> => ({ ok: true }),
        showAssetMenu: async (): Promise<void> => {},
        showItemInFolder: async (): Promise<void> => {},
        trashItem: async (): Promise<{ ok: true }> => ({ ok: true }),
      };

      const bridge = {
        config: {
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
          awaitBranchSwitched: async () => ({ ok: false, reason: 'timeout' as const }),
          okInit: async () => ({
            ok: false as const,
            reason: 'init-failed' as const,
            message: 'test mock',
          }),
          close: async () => {},
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
        editor: {
          notifyActiveTargetChanged: (): void => {},
          notifyViewMenuStateChanged: (): void => {},
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
          getDockState: async () => ({ visible: false }),
          onData: () => () => {},
          onExit: () => () => {},
          claudePreflight: async () => ({ claude: 'present' as const, mcp: 'wired' as const }),
          cliPreflight: async () => ({ onPath: 'present' as const }),
          rewireClaudeMcp: async () => ({ claude: 'present' as const, mcp: 'wired' as const }),
        },
        platform: 'darwin' as const,
        appVersion: 'test-0.0.0',
      } satisfies OkDesktopBridge;

      // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
      (window as any).okDesktop = bridge;
    }

    try {
      // biome-ignore lint/suspicious/noExplicitAny: matches production resolution in cowork-skill-install.ts.
      const ver = (window as any).okDesktop?.appVersion ?? 'unknown';
      window.localStorage.setItem(`ok:skill:cowork:installed:v${ver}`, '1');
    } catch {}
  }, cfg);
}

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

export async function updateElectronInstallMap(page: Page, install: InstallMap): Promise<void> {
  await page.evaluate((next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    const mocks = (window as any).__handoffMocks__;
    mocks.install = { ...next };
  }, install);
}

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

export async function advanceHandoffFakeTime(page: Page, ms: number): Promise<void> {
  await page.evaluate((delta) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
    const mocks = (window as any).__handoffMocks__;
    mocks.fakeTimeOffset += delta;
  }, ms);
}
