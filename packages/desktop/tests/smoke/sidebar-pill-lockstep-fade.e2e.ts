import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

function userDataDirFor(home: string): string {
  return join(home, 'electron-userdata');
}

async function expectDocument(
  page: import('@playwright/test').Page,
  docName: string,
  marker: string,
): Promise<void> {
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)))
    .toBe(`#/${docName}`);
  await expect(
    page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: marker }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe('sidebar search pill — Electron lockstep-fade smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1) and chrome stack is darwin-only in v0.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('navigation controls relocate on collapse while sidebar chrome fades in lockstep', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    const docName = `sidebar-pill-${randomUUID()}`;
    const secondDocName = `sidebar-pill-second-${randomUUID()}`;
    const firstMarker = 'Sidebar Pill Lockstep Fade Smoke';
    const secondMarker = 'Sidebar Pill Navigation Second';
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-sidebar-pill-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      `# ${firstMarker}\n\nFixture for chrome-row collapse verification.\n`,
    );
    writeFileSync(
      join(projectDir, `${secondDocName}.md`),
      `# ${secondMarker}\n\nFixture for browser-history traversal.\n`,
    );

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(projectDir)}`],
        timeout: 30_000,
      }),
    );
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
    await expectDocument(page, docName, firstMarker);

    const pill = page.getByRole('button', { name: /^Search/ });
    await pill.waitFor({ state: 'visible', timeout: 10_000 });

    const sidebarHeader = page.locator('[data-slot="sidebar-header"]');
    const editorHeaderLeadingActions = page.locator('[data-editor-header-leading-actions]');
    const backButtons = page.getByRole('button', { name: 'Back', exact: true });
    const forwardButtons = page.getByRole('button', { name: 'Forward', exact: true });
    const sidebarBack = sidebarHeader.getByRole('button', { name: 'Back', exact: true });
    const sidebarForward = sidebarHeader.getByRole('button', { name: 'Forward', exact: true });
    const headerBack = editorHeaderLeadingActions.getByRole('button', {
      name: 'Back',
      exact: true,
    });
    const headerForward = editorHeaderLeadingActions.getByRole('button', {
      name: 'Forward',
      exact: true,
    });

    await expect(sidebarBack).toHaveCount(1);
    await expect(sidebarForward).toHaveCount(1);
    await expect(headerBack).toHaveCount(0);
    await expect(headerForward).toHaveCount(0);
    await expect(backButtons).toHaveCount(1);
    await expect(forwardButtons).toHaveCount(1);

    await page
      .locator('[data-slot="sidebar-container"]')
      .getByRole('treeitem', { name: `${secondDocName}.md`, exact: true })
      .click();
    await expectDocument(page, secondDocName, secondMarker);
    await sidebarBack.click();
    await expectDocument(page, docName, firstMarker);
    await sidebarForward.click();
    await expectDocument(page, secondDocName, secondMarker);

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

    await expect(sidebarBack).toHaveCount(0);
    await expect(sidebarForward).toHaveCount(0);
    await expect(headerBack).toHaveCount(1);
    await expect(headerForward).toHaveCount(1);
    await expect(backButtons).toHaveCount(1);
    await expect(forwardButtons).toHaveCount(1);

    await headerBack.click();
    await expectDocument(page, docName, firstMarker);
    await headerForward.click();
    await expectDocument(page, secondDocName, secondMarker);
  });
});
