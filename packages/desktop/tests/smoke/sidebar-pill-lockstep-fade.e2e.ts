
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

function userDataDirFor(home: string): string {
  return join(home, 'electron-userdata');
}

test.describe('sidebar search pill — Electron lockstep-fade smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1) and chrome stack is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('expanded → neither row opacity-0; collapsed → BOTH rows opacity-0 (lockstep)', async ({
    captureStderrFor,
  }) => {
    const docName = `sidebar-pill-${randomUUID()}`;
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-sidebar-pill-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      '# Sidebar Pill Lockstep Fade Smoke\n\nFixture for chrome-row collapse verification.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(projectDir)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=${encodeURIComponent(docName)}`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    let editorPage: import('@playwright/test').Page | undefined;
    const expectedHashSuffix = `#/${docName}`;
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith(expectedHashSuffix)) {
          editorPage = page;
          return;
        }
      }
      throw new Error(`no window matches ${expectedHashSuffix} yet`);
    }).toPass({ timeout: 15_000 });
    if (!editorPage) throw new Error('unreachable');
    const page = editorPage;

    const isElectronHost = await page.evaluate(
      () => typeof window !== 'undefined' && window.okDesktop != null,
    );
    expect(isElectronHost).toBe(true);

    const pill = page.getByRole('button', { name: /^Search/ });
    await pill.waitFor({ state: 'visible', timeout: 10_000 });

    const collectFadeState = async () => {
      return page.evaluate(() => {
        const header = document.querySelector('[data-slot="sidebar-header"]') as HTMLElement | null;
        const pillButton = document.querySelector(
          'button[data-telemetry-event="ok.sidebar.search_pill.click"]',
        );
        let pillRow: HTMLElement | null = null;
        if (pillButton) {
          let node: HTMLElement | null = pillButton.parentElement as HTMLElement | null;
          while (node) {
            const next = node.nextElementSibling as HTMLElement | null;
            if (next?.dataset?.slot === 'sidebar-content') {
              pillRow = node;
              break;
            }
            node = node.parentElement as HTMLElement | null;
          }
        }
        return {
          sidebarState:
            document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null,
          headerHasOpacity0: header?.classList.contains('opacity-0') ?? null,
          headerHasTransition: header?.className.includes('motion-safe:transition-opacity') ?? null,
          pillRowHasOpacity0: pillRow?.classList.contains('opacity-0') ?? null,
          pillRowHasTransition:
            pillRow?.className.includes('motion-safe:transition-opacity') ?? null,
          pillRowFound: pillRow !== null,
          headerFound: header !== null,
        };
      });
    };

    const expanded = await collectFadeState();
    expect(expanded.headerFound).toBe(true);
    expect(expanded.pillRowFound).toBe(true);
    expect(expanded.sidebarState).toBe('expanded');
    expect(expanded.headerHasOpacity0).toBe(false);
    expect(expanded.pillRowHasOpacity0).toBe(false);
    expect(expanded.headerHasTransition).toBe(true);
    expect(expanded.pillRowHasTransition).toBe(true);

    await page.locator('[data-sidebar="trigger"]').first().click();

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state'),
          ),
        { intervals: [50, 50, 100, 200, 500], timeout: 5_000 },
      )
      .toBe('collapsed');

    await expect
      .poll(
        async () => {
          const s = await collectFadeState();
          return s.headerHasOpacity0 && s.pillRowHasOpacity0;
        },
        { intervals: [50, 50, 100, 200], timeout: 2_000 },
      )
      .toBe(true);

    const collapsed = await collectFadeState();
    expect(collapsed.sidebarState).toBe('collapsed');
    expect(collapsed.headerHasOpacity0).toBe(true);
    expect(collapsed.pillRowHasOpacity0).toBe(true);
    expect(collapsed.headerHasTransition).toBe(true);
    expect(collapsed.pillRowHasTransition).toBe(true);
  });
});
