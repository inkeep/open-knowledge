/**
 * DEV-ONLY (underscore-prefixed, opt-in via OK_DESKTOP_E2E_SMOKE=1). Not a
 * CI assertion — it captures real screenshots of the rendered Navigator at
 * three candidate window sizes for visual comparison, then exits.
 *
 * Uses the proven smoke harness (same as navigator-return.e2e.ts /
 * window-min-size.e2e.ts): seed a project so the editor opens first, trigger
 * the Navigator via bridge.navigator.open(), then resize that ONE window
 * between captures. One Electron instance — no single-instance-lock fight.
 *
 * Output: packages/desktop/tmp/nav-shot-<w>x<h>.png (gitignored).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
const SHOT_DIR = resolve(__dirname, '..', '..', 'tmp');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

const SIZES = [
  { w: 800, h: 750, label: 'current-800x750' },
  { w: 840, h: 600, label: 'proposed-default-840x600' },
  { w: 640, h: 560, label: 'proposed-min-640x560' },
];

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function seedHome(prefix: string): { tmpHome: string; projectDir: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navshot-${prefix}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ok-navshot-${prefix}-project-`));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  // Seed a generous recents list so the list section is realistically full
  // and scroll behavior is visible in the captures.
  const now = Date.now();
  const recentProjects = [
    'agents-private',
    'open-knowledge',
    'dragon-wiki',
    'claude-config',
    'ship-loop-rewrite',
    'agents-ui',
    'chat-to-edit',
    'zendesk-package',
    'copilot-app',
    'nest-claude-spec',
    'fix-bug-loop',
    'pr-smart-eval',
  ].map((name, i) => ({
    path: i === 0 ? projectDir : `${projectDir}-${name}`,
    name,
    lastOpenedAt: new Date(now - i * 3600_000).toISOString(),
  }));
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects,
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectDir };
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
    timeout: 30_000,
    env: { ...process.env, HOME: tmpHome, OK_DESKTOP_E2E_SMOKE: '1' },
  });
}

async function findWindow(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
  timeoutMs = 20_000,
): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const m = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (m === mode) return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: `${mode} window did not appear` },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) return page;
  }
  throw new Error(`${mode} window vanished`);
}

function rmSafe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // ENOTEMPTY race during Electron shutdown — harmless.
  }
}

test.describe('Navigator size screenshots (dev-only)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop".`);

  test('capture Navigator at 3 candidate sizes', async ({ captureStderrFor }) => {
    test.setTimeout(120_000);
    mkdirSync(SHOT_DIR, { recursive: true });
    const { tmpHome, projectDir } = seedHome('shots');
    try {
      const app = await launchApp(tmpHome);
      captureStderrFor(app);

      const editor = await findWindow(app, 'editor');
      await editor.evaluate(async () => {
        await window.okDesktop?.navigator.open();
      });
      const nav = await findWindow(app, 'navigator');
      const winHandle: JSHandle = await app.browserWindow(nav);

      for (const { w, h, label } of SIZES) {
        await winHandle.evaluate(
          (win: unknown, size: { w: number; h: number }) => {
            const b = win as {
              setBounds: (r: { width: number; height: number }) => void;
              center: () => void;
            };
            b.setBounds({ width: size.w, height: size.h });
            b.center();
          },
          { w, h },
        );
        // Let the renderer reflow + the show-gate settle.
        await nav.waitForTimeout(900);
        const outPath = join(SHOT_DIR, `nav-shot-${label}.png`);
        await nav.screenshot({ path: outPath });
        // eslint-disable-next-line no-console
        console.log(`captured ${w}x${h} -> ${outPath}`);
      }
    } finally {
      rmSafe(tmpHome);
      rmSafe(projectDir);
    }
  });
});
