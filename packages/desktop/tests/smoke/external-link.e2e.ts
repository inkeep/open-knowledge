import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

test.describe('external-link safety-net delegation', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke uses open(1) for the deep-link drive — macOS-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('window.open(https://...) routes to shell.openExternal via safety net', async ({
    captureStderrFor,
  }) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-external-link-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, 'doc.md'),
      '# External Link Test\n\n[GitHub](https://github.com)\n',
    );

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(projectDir, 'electron-userdata')}`],
        timeout: 30_000,
        env: {
          ...process.env,
          OK_TEST_OPEN_PROJECT: projectDir,
        },
      }),
    );
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    await app.evaluate(({ shell }) => {
      const calls: string[] = [];
      const g = globalThis as unknown as Record<string, unknown>;
      g.__okExternalCalls = calls;
      g.__okOriginalOpenExternal = shell.openExternal.bind(shell);
      (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = (
        url: string,
      ) => {
        calls.push(url);
        return Promise.resolve();
      };
    });

    const _firstWindow = await app.firstWindow({ timeout: 15_000 });
    const { execSync } = await import('node:child_process');
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=doc`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    let editorPage: import('@playwright/test').Page | undefined;
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith('#/doc')) {
          editorPage = page;
          return;
        }
      }
      throw new Error('editor page with doc hash not yet ready');
    }).toPass({ timeout: 15_000 });

    if (!editorPage) throw new Error('unreachable');
    await configureDesktopGitRepositories(editorPage, projectDir);

    await editorPage.evaluate(() => {
      window.open('https://github.com/inkeep/open-knowledge', '_blank', 'noopener,noreferrer');
    });

    await expect(async () => {
      const calls = await app.evaluate(() => {
        const g = globalThis as unknown as { __okExternalCalls?: string[] };
        return g.__okExternalCalls ?? [];
      });
      expect(calls).toContain('https://github.com/inkeep/open-knowledge');
    }).toPass({ timeout: 15_000 });

    await editorPage.evaluate(async () => {
      type Bridge = { shell: { openExternal: (url: string) => Promise<void> } };
      const bridge = (window as unknown as { okDesktop?: Bridge }).okDesktop;
      if (!bridge?.shell?.openExternal) {
        throw new Error('window.okDesktop.shell.openExternal missing — bridge not loaded');
      }
      await bridge.shell.openExternal('https://docs.example.com/help');
    });

    await expect(async () => {
      const callsAfterBridge = await app.evaluate(() => {
        const g = globalThis as unknown as { __okExternalCalls?: string[] };
        return g.__okExternalCalls ?? [];
      });
      expect(callsAfterBridge).toContain('https://docs.example.com/help');
    }).toPass({ timeout: 15_000 });
  });
  test('an embedded page is refused a non-web new window and a non-web navigation of its own frame', async ({
    captureStderrFor,
  }) => {
    const popupAddress = 'openknowledge://ok-smoke-embedded-page/new-window';
    const frameAddress = 'openknowledge://ok-smoke-embedded-page/own-frame';
    const frameRequests: string[] = [];
    const embeddedPage = createServer((req, res) => {
      frameRequests.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>embedded</title><script>setTimeout(() => {` +
          `window.open(${JSON.stringify(popupAddress)});` +
          `location.href = ${JSON.stringify(frameAddress)};` +
          `}, 500);</script>`,
      );
    });
    await new Promise<void>((resolveListen) => embeddedPage.listen(0, '127.0.0.1', resolveListen));
    const embeddedOrigin = `http://127.0.0.1:${(embeddedPage.address() as AddressInfo).port}`;

    const projectDir = mkdtempSync(join(tmpdir(), 'ok-embedded-page-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, 'doc.md'),
      `# Embedded Page Test\n\n<Embed src="${embeddedOrigin}/frame.html" title="Embedded page" />\n`,
    );

    try {
      const app = await electron.launch(
        desktopLaunchOptions({
          target: TARGET,
          args: [`--user-data-dir=${join(projectDir, 'electron-userdata')}`],
          timeout: 30_000,
          env: {
            ...process.env,
            OK_TEST_OPEN_PROJECT: projectDir,
          },
        }),
      );
      captureStderrFor(app, { cleanupDirs: [projectDir] });
      const mainOutput: string[] = [];
      app.process().stderr?.on('data', (chunk: Buffer | string) => mainOutput.push(String(chunk)));
      app.process().stdout?.on('data', (chunk: Buffer | string) => mainOutput.push(String(chunk)));

      await app.evaluate(({ session, shell }) => {
        const g = globalThis as unknown as Record<string, unknown>;
        const calls: string[] = [];
        g.__okExternalCalls = calls;
        (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = (
          url: string,
        ) => {
          calls.push(url);
          return Promise.resolve();
        };
        type Details = { isMainFrame: boolean; requestingUrl: string; externalURL?: string };
        type Handler = (
          contents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details: Details,
        ) => void;
        const decisions: {
          granted: boolean;
          isMainFrame: boolean;
          requestingUrl: string;
          externalURL: string;
        }[] = [];
        g.__okHandoffDecisions = decisions;
        const sessionPrototype = Object.getPrototypeOf(session.defaultSession) as {
          setPermissionRequestHandler: (handler: Handler | null) => void;
        };
        const install = sessionPrototype.setPermissionRequestHandler;
        sessionPrototype.setPermissionRequestHandler = function (this: unknown, handler) {
          if (handler === null) return install.call(this, handler);
          return install.call(this, (contents, permission, callback, details) =>
            handler(
              contents,
              permission,
              (granted) => {
                if (permission === 'openExternal') {
                  decisions.push({
                    granted,
                    isMainFrame: details.isMainFrame,
                    requestingUrl: details.requestingUrl,
                    externalURL: details.externalURL ?? '',
                  });
                }
                callback(granted);
              },
              details,
            ),
          );
        };
      });

      await app.firstWindow({ timeout: 15_000 });
      const { execSync } = await import('node:child_process');
      const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=doc`;
      execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

      let editorPage: import('@playwright/test').Page | undefined;
      await expect(async () => {
        for (const page of app.windows()) {
          const hash = await page.evaluate(() => window.location.hash).catch(() => '');
          if (hash.endsWith('#/doc')) {
            editorPage = page;
            return;
          }
        }
        throw new Error('editor page with doc hash not yet ready');
      }).toPass({ timeout: 15_000 });
      if (!editorPage) throw new Error('unreachable');
      await configureDesktopGitRepositories(editorPage, projectDir);

      await expect(async () => {
        expect(frameRequests).toContain('/frame.html');
      }).toPass({ timeout: 15_000 });

      await expect(async () => {
        const decisions = await app.evaluate(() => {
          const g = globalThis as unknown as { __okHandoffDecisions?: unknown[] };
          return g.__okHandoffDecisions ?? [];
        });
        expect(decisions).toContainEqual({
          granted: false,
          isMainFrame: false,
          requestingUrl: `${embeddedOrigin}/frame.html`,
          externalURL: frameAddress,
        });
      }).toPass({ timeout: 15_000 });

      await expect(async () => {
        const output = mainOutput.join('');
        expect(output).toContain('refused a new-window request for a non-web address');
        expect(output).toContain(popupAddress);
      }).toPass({ timeout: 15_000 });

      const externalCalls = await app.evaluate(() => {
        const g = globalThis as unknown as { __okExternalCalls?: string[] };
        return g.__okExternalCalls ?? [];
      });
      expect(externalCalls).not.toContain(popupAddress);
    } finally {
      await new Promise<void>((resolveClose) => embeddedPage.close(() => resolveClose()));
    }
  });
});
