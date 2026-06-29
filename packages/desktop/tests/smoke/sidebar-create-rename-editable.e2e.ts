import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGED_EXECUTABLE = resolve(
  __dirname,
  '..',
  '..',
  'dist-desktop',
  'mac-arm64',
  'OpenKnowledge.app',
  'Contents',
  'MacOS',
  'OpenKnowledge',
);

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const PACKAGED_BUILD_EXISTS = existsSync(PACKAGED_EXECUTABLE);

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
  return electron.launch({
    executablePath: PACKAGED_EXECUTABLE,
    args,
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: seed.tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
      OK_RECLAIM_DISABLE: '1',
      NODE_ENV: 'production',
    },
  });
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
  await page.getByRole('button', { name: 'New file' }).click();
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

  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active instanceof HTMLElement && active.classList.contains('ProseMirror');
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
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(
    !PACKAGED_BUILD_EXISTS,
    `Packaged desktop build missing at ${PACKAGED_EXECUTABLE} — run an unpacked packaged build first.`,
  );

  test('successive sidebar-created files remain editable after inline rename commit', async ({
    captureStderrFor,
  }) => {
    const seed = seedProject('editable');
    const app = await launchApp(seed);
    captureStderrFor(app, { cleanupDirs: [seed.tmpHome, seed.projectDir] });

    const page = await findEditorWindow(app, 'start');
    await expect(page.locator('.ProseMirror[contenteditable="true"]').first()).toBeVisible({
      timeout: 30_000,
    });

    await createSidebarFileAndType(page, seed, 'dd', 'first sidebar-created file is editable');
    await createSidebarFileAndType(page, seed, 'ddd', 'second sidebar-created file is editable');
  });
});
