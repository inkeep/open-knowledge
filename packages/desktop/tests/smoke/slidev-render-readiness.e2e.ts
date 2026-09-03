import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from './_helpers/electron-cleanup';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

function fakeSlidevServer(rendered: boolean): string {
  const shell = rendered
    ? '<!doctype html><html><head><meta property="slidev:version" content="52.19.0"></head><body><div id="app"><div data-slidev-no="1"><div class="slidev-slide-loading"></div></div></div><script>setTimeout(() => { document.querySelector("[data-slidev-no]").innerHTML = "<div class=\\"slidev-layout\\">Rendered</div>"; }, 600)</script></body></html>'
    : '<!doctype html><html><head><meta property="slidev:version" content="52.19.0"></head><body><div id="app"><div data-slidev-no="1"></div></div><script>setTimeout(() => { document.querySelector("[data-slidev-no]").innerHTML = "<div class=\\"slidev-slide-loading\\"></div>"; }, 250)</script></body></html>';
  return `
const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const shell = ${JSON.stringify(shell)};
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(shell);
});
server.listen(port, 'localhost');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
setTimeout(() => process.exit(0), 120_000);
`;
}

function seedProject(rendered = false): { tmpHome: string; projectDir: string; deckPath: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ok-slidev-readiness-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-slidev-readiness-project-'));
  const deckPath = join(projectDir, 'slides.md');
  const binDir = join(projectDir, 'node_modules', '.bin');
  const fakeServerPath = join(projectDir, 'fake-slidev.cjs');
  const userDataDir = userDataDirFor(tmpHome);

  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  const serverSource = fakeSlidevServer(rendered);
  writeFileSync(deckPath, `---\nslides: true\n---\n\n# ${rendered ? 'Rendered' : 'Shell only'}\n`);
  writeFileSync(fakeServerPath, serverSource);
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'slidev.cmd'), `@"${process.execPath}" "${fakeServerPath}" %*\r\n`);
  } else {
    const binPath = join(binDir, 'slidev');
    writeFileSync(binPath, `#!/usr/bin/env node\n${serverSource}`);
    chmodSync(binPath, 0o755);
  }
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        {
          path: projectDir,
          name: 'Slidev readiness fixture',
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
  return { tmpHome, projectDir, deckPath };
}

async function findEditor(app: ElectronApplication): Promise<Page | undefined> {
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'editor') return page;
  }
  return undefined;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function closeElectronAppBounded(app: ElectronApplication): Promise<void> {
  const process = captureAppProcess(app);
  await Promise.race([
    app.close().catch(() => undefined),
    closeAppBounded(process, { gracefulMs: 5_000 }),
  ]);
}

test.describe('Slidev renderer readiness smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('a server shell without a mounted deck stays hidden and returns a failure', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir, deckPath } = seedProject();
    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
        env: {
          ...process.env,
          ...homeEnv(tmpHome),
          OK_DESKTOP_E2E_SMOKE: '1',
        },
      }),
    );
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });
    try {
      await expect
        .poll(() => findEditor(app), { timeout: 30_000, message: 'editor window did not open' })
        .not.toBeUndefined();
      const editor = await findEditor(app);
      if (editor === undefined) throw new Error('editor window vanished after opening');

      const openResult = editor.evaluate(async (path) => {
        const slides = window.okDesktop?.slides;
        if (slides === undefined) throw new Error('slides bridge unavailable');
        return slides.open(path);
      }, deckPath);

      await expect
        .poll(
          () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .filter((window) => window.webContents.getURL().startsWith('http://localhost:'))
                .map((window) => ({
                  loading: window.webContents.isLoading(),
                  visible: window.isVisible(),
                })),
            ),
          { timeout: 20_000, message: 'Slidev shell did not finish loading while hidden' },
        )
        .toEqual([{ loading: false, visible: false }]);
      const slidevUrl = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith('http://localhost:'))
          ?.webContents.getURL(),
      );
      if (slidevUrl === undefined) throw new Error('hidden Slidev shell vanished before failure');
      await expect(openResult).resolves.toEqual({
        kind: 'open',
        ok: false,
        reason: 'renderer-failed',
      });
      await expect
        .poll(
          () =>
            app.evaluate(
              ({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().filter((window) =>
                  window.webContents.getURL().startsWith('http://localhost:'),
                ).length,
            ),
          { timeout: 5_000, message: 'failed Slidev shell window stayed open' },
        )
        .toBe(0);
      await expect
        .poll(() => isReachable(slidevUrl), {
          timeout: 5_000,
          message: 'failed Slidev process kept its loopback port open',
        })
        .toBe(false);
    } finally {
      await closeElectronAppBounded(app);
    }
  });

  test('a mounted deck becomes visible and reports a successful open', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir, deckPath } = seedProject(true);
    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
        env: {
          ...process.env,
          ...homeEnv(tmpHome),
          OK_DESKTOP_E2E_SMOKE: '1',
        },
      }),
    );
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });
    try {
      await expect
        .poll(() => findEditor(app), { timeout: 30_000, message: 'editor window did not open' })
        .not.toBeUndefined();
      const editor = await findEditor(app);
      if (editor === undefined) throw new Error('editor window vanished after opening');

      const openResult = editor.evaluate(async (path) => {
        const slides = window.okDesktop?.slides;
        if (slides === undefined) throw new Error('slides bridge unavailable');
        return slides.open(path);
      }, deckPath);

      await expect
        .poll(
          () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .filter((window) => window.webContents.getURL().startsWith('http://localhost:'))
                .map((window) => ({
                  loading: window.webContents.isLoading(),
                  visible: window.isVisible(),
                })),
            ),
          { timeout: 20_000, message: 'mounted Slidev deck did not become visible' },
        )
        .toEqual([{ loading: false, visible: true }]);
      await expect(openResult).resolves.toEqual({ kind: 'open', ok: true });
    } finally {
      await closeElectronAppBounded(app);
    }
  });
});
