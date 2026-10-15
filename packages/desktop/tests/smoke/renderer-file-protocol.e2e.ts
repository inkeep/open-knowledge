import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchDesktopInHome } from './_helpers/launch-in-home';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

async function projectWindow(app: ElectronApplication, docName: string): Promise<Page> {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const page of app.windows()) {
      const hash = await page.evaluate(() => window.location.hash).catch(() => '');
      if (hash.includes(docName)) return page;
    }
    await wait(500);
  }
  throw new Error('project window never mounted from the argv deep-link');
}

test.describe('renderer file protocol', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link project open is macOS-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('the renderer refuses injected handlers and files outside its bundle, and previews still run', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-file-protocol-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-file-protocol-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, 'note.md'),
      [
        '# Note',
        '',
        '```html preview',
        '<div id="probe">before</div>',
        "<script>document.getElementById('probe').textContent = 'ran';</script>",
        '```',
        '',
      ].join('\n'),
    );
    const outsideFile = join(projectDir, 'outside.html');
    writeFileSync(outsideFile, '<!doctype html><p id="outside">outside</p>');

    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await launchDesktopInHome(tmpHome, {
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });
    await app.firstWindow({ timeout: 15_000 });
    const page = await projectWindow(app, 'note');

    await expect(page.locator('iframe[title="HTML preview"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.frameLocator('iframe[title="HTML preview"]').locator('#probe')).toHaveText(
      'ran',
    );

    const handler = await page.evaluate(
      () =>
        new Promise<{ ran: boolean; directive: string }>((settle) => {
          const probe = window as Window & { injectedHandlerRan?: boolean };
          const timer = setTimeout(
            () => settle({ ran: Boolean(probe.injectedHandlerRan), directive: '' }),
            5_000,
          );
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              clearTimeout(timer);
              settle({
                ran: Boolean(probe.injectedHandlerRan),
                directive: event.effectiveDirective,
              });
            },
            { once: true },
          );
          const host = document.createElement('div');
          host.innerHTML = '<img src="data:," alt="" onerror="window.injectedHandlerRan = true">';
          document.body.append(host);
        }),
    );
    expect(handler.ran).toBe(false);
    expect(handler.directive).toMatch(/^script-src/);

    const outside = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        return `status ${response.status}`;
      } catch {
        return 'refused';
      }
    }, pathToFileURL(outsideFile).href);
    expect(outside).not.toBe('status 200');

    const upperCaseShell = await page.evaluate(async () => {
      const url = new URL(window.location.href);
      url.hash = '';
      url.pathname = url.pathname.replace(/index\.html$/, 'INDEX.HTML');
      const response = await fetch(url);
      return {
        status: response.status,
        policy: response.headers.get('content-security-policy') ?? '',
      };
    });
    expect(upperCaseShell.status).toBe(200);
    expect(upperCaseShell.policy).toMatch(/^script-src 'self'/);
  });
});
