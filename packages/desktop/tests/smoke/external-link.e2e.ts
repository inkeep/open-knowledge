import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

test.describe('external-link safety-net delegation', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke uses open(1) for the deep-link drive — macOS-only.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

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

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${join(projectDir, 'electron-userdata')}`],
      timeout: 30_000,
      env: {
        ...process.env,
        OK_TEST_OPEN_PROJECT: projectDir,
      },
    });
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
});
