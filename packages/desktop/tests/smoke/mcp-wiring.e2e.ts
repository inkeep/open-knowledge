import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const WINDOWS = process.platform === 'win32';

const EXPECTED_CHAIN = WINDOWS
  ? {
      command: 'powershell',
      prefixArgs: ['-NoProfile', '-NonInteractive', '-Command'] as const,
      sentinel: '# ok-mcp-win-v1',
    }
  : {
      command: '/bin/sh',
      prefixArgs: ['-l', '-c'] as const,
      sentinel: '# ok-mcp-v2',
    };

interface LaunchOpts {
  tmpHome: string;
  extraEnv?: Record<string, string>;
}

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

async function launchApp({ tmpHome, extraEnv }: LaunchOpts): Promise<ElectronApplication> {
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_M6B_FORCE: '1',
        OK_DESKTOP_E2E_SMOKE: '1',
        ...extraEnv,
      },
    }),
  );
}

function createTmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ok-m6b-${prefix}-`));
}

function seedEditorDetectionDirs(tmpHome: string, editorHints: readonly string[]): void {
  for (const rel of editorHints) {
    mkdirSync(join(tmpHome, rel), { recursive: true });
  }
}

function markerPath(tmpHome: string): string {
  return join(tmpHome, '.ok', 'mcp-status.json');
}

function readMarker(tmpHome: string): Record<string, unknown> | null {
  const p = markerPath(tmpHome);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

async function waitForConsentDialog(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  return await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const visible = await page
            .locator('[data-testid="mcp-consent-add"]')
            .isVisible()
            .catch(() => false);
          if (visible) return page;
        }
        return null;
      },
      {
        timeout: timeoutMs,
        message: 'McpConsentDialog did not appear — renderer mount-ack handshake may have failed',
      },
    )
    .not.toBeNull()
    .then(async () => {
      for (const page of app.windows()) {
        const visible = await page
          .locator('[data-testid="mcp-consent-add"]')
          .isVisible()
          .catch(() => false);
        if (visible) return page;
      }
      throw new Error('dialog was visible during poll but no window has it now');
    });
}

function forceRemove(pathsToRestore: readonly string[], dir: string): void {
  for (const p of pathsToRestore) {
    try {
      chmodSync(p, 0o755);
    } catch {}
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test.describe('M6b first-launch MCP-wiring smoke (US-010)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test.skip('F2 (cold-start deep-link) — deferred until signed DMG enables Launch Services binding', () => {});

  test.skip('AC2.6 (fresh-Mac P1 E2E with signed DMG) — creds-gated on Apple notarization', () => {});

  test('happy-path — Add writes marker + Claude config with resilient chain MCP entry', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('happy');
    seedEditorDetectionDirs(tmpHome, ['.claude']);
    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'marker not written within 15s of Add click',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true });
      expect(marker).toHaveProperty('configuredAt');
      expect(marker).toHaveProperty('editors');
      expect(Array.isArray((marker as { editors: unknown }).editors)).toBe(true);
      expect((marker as { editors: string[] }).editors).toContain('claude');

      const claudeConfigPath = join(tmpHome, '.claude.json');
      expect(existsSync(claudeConfigPath)).toBe(true);
      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf8')) as {
        mcpServers?: { 'open-knowledge'?: { command?: string; args?: string[] } };
      };
      const okEntry = claudeConfig.mcpServers?.['open-knowledge'];
      expect(okEntry).toBeDefined();
      expect(okEntry?.command).toBe(EXPECTED_CHAIN.command);
      expect(okEntry?.args?.slice(0, EXPECTED_CHAIN.prefixArgs.length)).toEqual([
        ...EXPECTED_CHAIN.prefixArgs,
      ]);
      const chainBody = okEntry?.args?.[EXPECTED_CHAIN.prefixArgs.length];
      expect(typeof chainBody).toBe('string');
      expect(chainBody).toContain(EXPECTED_CHAIN.sentinel);
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('startup PATH toast is anchored bottom-left and never covers consent Add/Skip', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('toast-position');
    seedEditorDetectionDirs(tmpHome, ['.claude']);
    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);

      await app.evaluate(
        ({ BrowserWindow }, payload) => {
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('ok:onboarding:toast', payload);
          }
        },
        {
          kind: 'startup-reclaim',
          mcp: { status: 'none' },
          path: { status: 'installed', summary: 'Added ok to your PATH' },
        },
      );

      await expect(
        window.locator(
          '[data-sonner-toaster][data-y-position="bottom"][data-x-position="left"] [data-sonner-toast]',
        ),
      ).toBeVisible();

      await window.getByTestId('mcp-consent-add').click();
      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'marker not written after Add click with startup toast present',
        })
        .not.toBeNull();
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('dismiss — writes configured:false marker and no editor configs', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('skip');
    seedEditorDetectionDirs(tmpHome, ['.claude']);
    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.keyboard.press('Escape');

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'skip marker not written within 15s of dismissing the dialog',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: false });
      expect(marker).toHaveProperty('skippedAt');

      expect(existsSync(join(tmpHome, '.claude.json'))).toBe(false);
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('idempotency — configured:true marker silences dialog on relaunch', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('idempotent');
    mkdirSync(join(tmpHome, '.ok'), { recursive: true });
    writeFileSync(
      markerPath(tmpHome),
      JSON.stringify({
        configured: true,
        configuredAt: new Date().toISOString(),
        editors: ['claude'],
        cliPath: '/usr/local/bin/ok',
      }),
    );
    seedEditorDetectionDirs(tmpHome, ['.claude']);

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const firstWindow = await app.firstWindow({ timeout: 15_000 });
      expect(firstWindow).toBeDefined();

      await firstWindow.waitForTimeout(10_000);
      for (const page of app.windows()) {
        const addButton = page.locator('[data-testid="mcp-consent-add"]');
        await expect(addButton).toHaveCount(0);
      }

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true, editors: ['claude'] });
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('partial-failure — read-only Cursor dir leaves marker absent, other writes succeed', async ({
    captureStderrFor,
  }) => {
    test.skip(WINDOWS, 'chmod-based read-only-directory injection is POSIX-only (see comment).');
    const tmpHome = createTmpHome('partial');
    seedEditorDetectionDirs(tmpHome, ['.claude', '.cursor']);
    const cursorDir = join(tmpHome, '.cursor');
    chmodSync(cursorDir, 0o444);

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      await expect
        .poll(() => existsSync(join(tmpHome, '.claude.json')), {
          timeout: 15_000,
          message: 'expected write to .claude.json after Add (partial-failure branch)',
        })
        .toBe(true);

      expect(readMarker(tmpHome)).toBeNull();

      expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      forceRemove([cursorDir], tmpHome);
    }
  });

  test('F1 — lastOpenedProject opens editor first, dialog still fires', async ({
    captureStderrFor,
  }) => {
    test.skip(
      WINDOWS || TARGET.mode === 'packaged',
      'Open finding: consent dialog never fires on the editor-first boot path — intermittently on Windows, always against a packaged bundle (see comment).',
    );
    const tmpHome = createTmpHome('f1');
    seedEditorDetectionDirs(tmpHome, ['.claude']);

    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m6b-f1-project-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );

    const userDataDir = userDataDirFor(tmpHome);
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          {
            path: projectDir,
            name: 'F1 Smoke Project',
            lastOpenedAt: new Date().toISOString(),
          },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app, { cleanupDirs: [projectDir] });

      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'marker not written after Add in F1 flow',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true });
    } finally {
      forceRemove([], tmpHome);
    }
  });
});
