/**
 * Regression smoke for the production-only sidebar create -> inline rename
 * path leaving the selected document without an editable TipTap surface.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { SMOKE_ENABLED } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget({ requirePackaged: true });

const DARWIN = process.platform === 'darwin';

interface SeededProject {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function userDataDirFor(home: string): string {
  return join(home, 'electron-userdata');
}

function seedProject(prefix: string): SeededProject {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-sidebar-create-${prefix}-home-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ok-sidebar-create-${prefix}-project-`));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        {
          path: projectDir,
          name: 'Sidebar Create Smoke',
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

  return { tmpHome, userDataDir, projectDir };
}

async function launchApp(seed: SeededProject): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(seed.projectDir)}&doc=start`;
  const args = [`--user-data-dir=${seed.userDataDir}`, deepLink];
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args,
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: seed.tmpHome,
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
        NODE_ENV: 'production',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, docName: string): Promise<Page> {
  const expectedHashSuffix = `#/${docName}`;
  let editorPage: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const hash = await page.evaluate(() => window.location.hash).catch(() => '');
      if (hash.endsWith(expectedHashSuffix)) {
        editorPage = page;
        return;
      }
    }
    throw new Error(`no window matches ${expectedHashSuffix} yet`);
  }).toPass({ timeout: 30_000 });
  if (!editorPage) throw new Error('editor window vanished after readiness poll');
  return editorPage;
}

async function createSidebarFileAndType(
  page: Page,
  seed: SeededProject,
  docName: string,
  bodyText: string,
): Promise<void> {
  // `exact` because `name` matches a substring by default, and the empty-state
  // "or create a new file" button also carries "new file" in its name.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const renameInput = page.getByRole('textbox', { name: /rename Untitled\.md/i });
  await renameInput.fill(docName);
  await renameInput.press('Enter');

  await expect(page.getByRole('treeitem', { name: new RegExp(`${docName}\\.md`) })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 30_000,
      message: `${docName} did not become active`,
    })
    .toBe(`#/${docName}`);

  const editor = page
    .locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)')
    .first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          // The Ask-AI composer is its own ProseMirror instance and can hold
          // focus, so the class alone does not mean the document editor.
          return (
            active instanceof HTMLElement &&
            active.classList.contains('ProseMirror') &&
            !active.classList.contains('composer-prosemirror')
          );
        }),
      { timeout: 5_000, message: `${docName} editor did not receive focus after rename` },
    )
    .toBe(true);

  await page.keyboard.type(bodyText);
  await expect(editor).toContainText(bodyText, { timeout: 5_000 });
  await expect
    .poll(
      () => {
        const diskPath = join(seed.projectDir, `${docName}.md`);
        return existsSync(diskPath) ? readFileSync(diskPath, 'utf8') : '';
      },
      { timeout: 10_000, message: `${docName} typed text was not persisted` },
    )
    .toContain(bodyText);
}

test.describe('Sidebar create and rename editability smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  // Deliberately NOT cross-platform, unlike its un-gated siblings: this spec
  // drives the PACKAGED app, and `resolveDesktopTarget({requirePackaged:true})`
  // falls back to the mac-arm64 `.app`. Off-mac the target never exists, so a
  // `PLATFORM_SUPPORTED` gate here would read as cross-platform coverage while
  // the spec silently skipped on Windows and Linux — worse than an honest
  // darwin-only gate. Making it genuinely cross-platform means resolving the
  // per-OS unpacked path AND packaging before the smoke run rather than after;
  // the crossbuild job does the reverse, on purpose (a packaging breach must
  // not skip the smoke signal).
  test.skip(!DARWIN, 'Drives the packaged mac .app; see comment.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('successive sidebar-created files remain editable after inline rename commit', async ({
    captureStderrFor,
  }) => {
    const seed = seedProject('editable');
    const app = await launchApp(seed);
    captureStderrFor(app, { cleanupDirs: [seed.tmpHome, seed.projectDir] });

    const page = await findEditorWindow(app, 'start');
    await expect(
      page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)').first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    await createSidebarFileAndType(page, seed, 'dd', 'first sidebar-created file is editable');
    await createSidebarFileAndType(page, seed, 'ddd', 'second sidebar-created file is editable');
  });
});
