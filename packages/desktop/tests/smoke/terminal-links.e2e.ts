/**
 * Clickable-terminal-links live-Electron smoke harness (the `_electron.launch()`
 * rung). The mocked `TerminalPanel.dom.test.tsx` tests pin the orchestration
 * against a fake xterm; they CANNOT prove that real xterm actually detects a URL
 * / file path, calls the registered link provider, and activates on click. This
 * suite drives the real renderer + real xterm + real PTY + real preload bridge +
 * real main handlers, and asserts the user-observable outcome:
 *
 *   - a plain `http(s)` URL printed in the shell → click → `shell.openExternal`
 *     (stubbed in main so no real browser opens) receives the URL;
 *   - an in-project `.md` path printed in the shell → click → the editor
 *     navigates to that doc (hash route).
 *
 * Skip gates mirror the sibling terminal smokes: opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * darwin-only, and the electron-vite build must exist (out/main/index.js).
 *
 * QUARANTINED ON CI (test.skip(IS_CI)): same live-Electron terminal surface +
 * constrained-runner degradation as terminal-dock (shells exit before "running"
 * after a few launches on the 6-vCPU runner). Allowlisted in the CI no-skip guard
 * (QUARANTINE_ALLOWLIST); tracked in inkeep/agents-private#2187.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

interface Seed {
  tmpHome: string;
  projectDir: string;
  pathPrefix: string;
}

/** Seed a consented project with a `notes.md` doc for the file-path case. */
function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-termlink-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-termlink-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  writeFileSync(join(projectDir, 'notes.md'), '# Notes\n\nClickable link target.\n');

  // A fake `claude` on PATH so the readiness probe resolves deterministically
  // (mirrors the sibling terminal smokes; the banner isn't under test here).
  const binDir = join(tmpHome, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "claude 0.0.0-fake"\n');
  chmodSync(join(binDir, 'claude'), 0o755);

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Term Links', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );

  return { tmpHome, projectDir, pathPrefix: binDir };
}

async function launchApp(s: Seed): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  return electron.launch({
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${join(s.tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME)}`,
      deepLink,
    ],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: s.tmpHome,
      PATH: `${s.pathPrefix}:${process.env.PATH ?? ''}`,
      OK_DESKTOP_E2E_SMOKE: '1',
      OK_RECLAIM_DISABLE: '1',
    },
  });
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 25_000): Promise<Page> {
  let page: Page | undefined;
  await expect(async () => {
    for (const p of app.windows()) {
      const mode = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (mode === 'editor') {
        page = p;
        return;
      }
    }
    throw new Error('no editor window yet');
  }).toPass({ timeout: timeoutMs });
  if (!page) throw new Error('editor window vanished after readiness poll');
  return page;
}

/** Open the terminal via the View menu, bottom-dock it, and wait for a live shell. */
async function openRunningTerminal(app: ElectronApplication, page: Page): Promise<void> {
  const label = await app.evaluate(async ({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) return false;
    if (item.label === 'Show Terminal') item.click();
    return item.label;
  });
  expect(label).toBeTruthy();
  await expect(page.locator('section[aria-label="Terminal"]')).toBeVisible({ timeout: 15_000 });
  // Bottom-dock (default is the right column) so the terminal is wide enough for
  // a printed URL to render on one row — the link-click assertions need it.
  const toBottom = page.getByRole('button', { name: 'Dock terminal to the bottom' });
  if (await toBottom.count()) await toBottom.click();
  // The status container isn't "visible" to Playwright while right-docked; assert
  // the attribute value instead (matches the terminal-dock smoke).
  await expect(page.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
}

/** Run a command in the focused xterm and wait for `marker` to render. */
async function runInTerminal(page: Page, command: string, marker: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  // The command echoes + its output prints; wait for the marker to appear in the
  // rendered rows (DOM renderer under OK_DESKTOP_E2E_SMOKE=1).
  await expect(page.locator('section[aria-label="Terminal"] .xterm-rows')).toContainText(marker, {
    timeout: 10_000,
  });
}

/**
 * Click the last rendered occurrence of `linkText` in the terminal. xterm's DOM
 * renderer paints each glyph run as a span; the printed token (URL / path) is a
 * contiguous run, so clicking that span's box lands on the link's cells and
 * triggers xterm's link activation.
 */
async function clickTerminalLink(page: Page, linkText: string): Promise<void> {
  const span = page
    .locator('section[aria-label="Terminal"] .xterm-rows span', { hasText: linkText })
    .last();
  await span.scrollIntoViewIfNeeded();
  await span.hover();
  await span.click();
}

/** Replace `shell.openExternal` in main with a recorder (no real browser opens). */
async function stubOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedExternal?: string[] };
    g.__openedExternal = [];
    shell.openExternal = async (url: string) => {
      g.__openedExternal?.push(url);
    };
  });
}

async function readOpenedExternal(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __openedExternal?: string[] }).__openedExternal ?? [],
  );
}

const cleanup: string[] = [];
function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Terminal clickable links — live Electron', () => {
  test.skip(
    !SMOKE_ENABLED || !DARWIN || !BUILD_EXISTS,
    'Live-Electron smoke: set OK_DESKTOP_E2E_SMOKE=1 on darwin after `bun run build:desktop`.',
  );
  test.skip(
    IS_CI,
    'Quarantined on CI: live-Electron terminal smoke degrades on the constrained runner (see inkeep/agents-private#2187).',
  );

  test.afterAll(() => {
    for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  test('clicking a printed URL opens it via shell.openExternal', async ({ captureStderrFor }) => {
    const s = seed('url');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    // Bounded auto-close + dir cleanup on teardown (no unbounded `app.close()`).
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await stubOpenExternal(app);
    await openRunningTerminal(app, page);

    const url = 'https://ok-smoke.example/link';
    await runInTerminal(page, `echo ${url}`, 'ok-smoke.example');
    await clickTerminalLink(page, 'ok-smoke.example');

    await expect(async () => {
      expect(await readOpenedExternal(app)).toContain(url);
    }).toPass({ timeout: 8_000 });
  });

  test('clicking an in-project markdown path opens the doc in the editor', async ({
    captureStderrFor,
  }) => {
    const s = seed('doc');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openRunningTerminal(app, page);

    await runInTerminal(page, 'echo notes.md', 'notes.md');
    await clickTerminalLink(page, 'notes.md');

    // The doc link routes an in-editor hash navigation to `notes`.
    await expect(async () => {
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toBe('#/notes');
    }).toPass({ timeout: 8_000 });
  });
});
