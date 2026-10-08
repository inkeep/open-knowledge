import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { findProjectEditorWindow } from './_helpers/project-editor-window';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const WINDOWS = process.platform === 'win32';

interface SeededHome {
  tmpHome: string;
  projectDir: string;
}

interface SeededHomeWithEditor {
  tmpHome: string;
  projectAPath: string;
  projectBPath: string;
}

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function createProjectDir(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-project-`));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  return projectDir;
}

function seedHomeWithoutLastOpenedProject(prefix: string): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-`));
  const projectDir = createProjectDir(prefix);
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [],
      lastOpenedProject: null,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectDir };
}

function seedHomeWithLastOpenedProjectAndExtra(prefix: string): SeededHomeWithEditor {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-`));
  const projectAPath = createProjectDir(`${prefix}-A`);
  const projectBPath = createProjectDir(`${prefix}-B`);
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        {
          path: projectAPath,
          name: 'Project A',
          lastOpenedAt: new Date().toISOString(),
        },
      ],
      lastOpenedProject: projectAPath,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectAPath, projectBPath };
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
}

async function countWindowsByMode(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
): Promise<number> {
  let count = 0;
  for (const page of app.windows()) {
    const observed = await page
      .evaluate(() => window.okDesktop?.config?.mode)
      .catch(() => undefined);
    if (observed === mode) count++;
  }
  return count;
}

async function findFirstWindowByMode(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
): Promise<Page> {
  for (const page of app.windows()) {
    const observed = await page
      .evaluate(() => window.okDesktop?.config?.mode)
      .catch(() => undefined);
    if (observed === mode) return page;
  }
  throw new Error(`${mode} window vanished between poll resolution and read`);
}

interface RecordedErrorDialog {
  title: string | undefined;
  parentWindowId: number | null;
  parentVisible: boolean | null;
}

async function recordErrorDialogs(
  app: ElectronApplication,
  { acknowledge }: { acknowledge: boolean } = { acknowledge: true },
): Promise<void> {
  await app.evaluate(({ BrowserWindow, dialog }, acknowledgeDialogs) => {
    const recorded: RecordedErrorDialog[] = [];
    Reflect.set(globalThis, '__okRecordedErrorDialogs', recorded);
    const original = dialog.showMessageBox.bind(dialog);
    const recording = (
      ...args: [Electron.MessageBoxOptions] | [Electron.BrowserWindow, Electron.MessageBoxOptions]
    ) => {
      const [first, second] = args;
      const parent = first instanceof BrowserWindow ? first : null;
      const options = (parent === null ? first : second) as Electron.MessageBoxOptions;
      if (options.type !== 'error') {
        return parent === null ? original(options) : original(parent, options);
      }
      recorded.push({
        title: options.title,
        parentWindowId: parent?.id ?? null,
        parentVisible: parent?.isVisible() ?? null,
      });
      return acknowledgeDialogs
        ? Promise.resolve({ response: 0, checkboxChecked: false })
        : new Promise<Electron.MessageBoxReturnValue>(() => {});
    };
    dialog.showMessageBox = recording as typeof dialog.showMessageBox;
  }, acknowledge);
}

async function readRecordedErrorDialogs(app: ElectronApplication): Promise<RecordedErrorDialog[]> {
  return app.evaluate(
    () => (Reflect.get(globalThis, '__okRecordedErrorDialogs') ?? []) as RecordedErrorDialog[],
  );
}

async function windowIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id));
}

async function onlyWindowId(app: ElectronApplication): Promise<number> {
  const ids = await windowIds(app);
  expect(ids).toHaveLength(1);
  return ids[0] as number;
}

async function openFromNavigator(navigator: Page, path: string): Promise<void> {
  await navigator.evaluate(async (target) => {
    await window.okDesktop?.project.open({
      path: target,
      target: 'new-window',
      entryPoint: 'pick-existing',
    });
  }, path);
}

test.describe('Project Navigator close-on-project-open smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('Navigator boots first, closes once a project window resolves', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('happy');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    expect(await countWindowsByMode(app, 'editor')).toBe(0);

    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({ path, target: 'new-window', entryPoint: 'recents' });
    }, projectDir);

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'editor window did not appear after project.open()',
      })
      .toBe(1);

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 10_000,
        message: 'navigator window did not close after project window resolved',
      })
      .toBe(0);

    expect(await countWindowsByMode(app, 'editor')).toBe(1);
    expect(await countWindowsByMode(app, 'navigator')).toBe(0);
    const editor = await findFirstWindowByMode(app, 'editor');
    await configureDesktopGitRepositories(editor, projectDir);
  });

  test('Switch-Project flow: Editor A summons Navigator, picks Project B, both editors persist', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectAPath, projectBPath } = seedHomeWithLastOpenedProjectAndExtra('switch');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectAPath, projectBPath] });

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'Editor A did not appear from lastOpenedProject',
      })
      .toBe(1);
    const editorA = await findFirstWindowByMode(app, 'editor');
    expect(await countWindowsByMode(app, 'navigator')).toBe(0);
    await configureDesktopGitRepositories(editorA, projectAPath);

    await editorA.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 15_000,
        message: 'navigator window did not appear after bridge.navigator.open()',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({ path, target: 'new-window', entryPoint: 'recents' });
    }, projectBPath);

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'Editor B did not appear after Navigator picked Project B',
      })
      .toBe(2);

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 10_000,
        message: 'navigator window did not close after Project B opened',
      })
      .toBe(0);

    expect(editorA.isClosed()).toBe(false);
    expect(await countWindowsByMode(app, 'editor')).toBe(2);
    const editorB = await findProjectEditorWindow(app, projectBPath);
    if (!editorB) throw new Error('Project B editor did not open');
    await configureDesktopGitRepositories(editorB, projectBPath);
  });

  test('Navigator stays visible when project open fails', async ({ captureStderrFor }) => {
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('failure');
    const bogusProjectPath = join(tmpHome, 'does-not-exist');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    await recordErrorDialogs(app);

    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({
        path,
        target: 'new-window',
        entryPoint: 'recents',
      });
    }, bogusProjectPath);

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 10_000,
        message: 'editor window appeared even though project.open() failed',
      })
      .toBe(0);
    expect(await countWindowsByMode(app, 'navigator')).toBe(1);

    const navigatorWindowId = await onlyWindowId(app);
    expect(await readRecordedErrorDialogs(app)).toContainEqual({
      title: 'Cannot open this folder',
      parentWindowId: navigatorWindowId,
      parentVisible: true,
    });
  });

  test('A refusal sent from an editor attaches its dialog to the Navigator once it is visible', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectAPath, projectBPath } =
      seedHomeWithLastOpenedProjectAndExtra('refused-editor');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectAPath, projectBPath] });

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'Editor A did not appear from lastOpenedProject',
      })
      .toBe(1);
    const editor = await findFirstWindowByMode(app, 'editor');
    expect(await countWindowsByMode(app, 'navigator')).toBe(0);
    await configureDesktopGitRepositories(editor, projectAPath);
    const editorWindowIds = await windowIds(app);
    await recordErrorDialogs(app);

    await editor.evaluate(async (target) => {
      await window.okDesktop?.project.open({
        path: target,
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    }, tmpHome);

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 15_000,
        message: 'the refusal did not open the Navigator',
      })
      .toBe(1);
    const navigatorWindowIds = (await windowIds(app)).filter((id) => !editorWindowIds.includes(id));
    expect(navigatorWindowIds).toHaveLength(1);
    await expect
      .poll(() => readRecordedErrorDialogs(app), {
        timeout: 15_000,
        message: 'the refusal dialog was not shown over the Navigator',
      })
      .toEqual([
        {
          title: 'Cannot open this folder',
          parentWindowId: navigatorWindowIds[0],
          parentVisible: true,
        },
      ]);
    expect(editor.isClosed()).toBe(false);
  });

  test('Refusing the home directory or a drive root leaves the Navigator usable', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('refused');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');
    const navigatorWindowId = await onlyWindowId(app);
    await recordErrorDialogs(app);

    await openFromNavigator(navigator, tmpHome);
    await openFromNavigator(navigator, parse(tmpHome).root);

    expect(await countWindowsByMode(app, 'editor')).toBe(0);
    const refusal = {
      title: 'Cannot open this folder',
      parentWindowId: navigatorWindowId,
      parentVisible: true,
    };
    expect(await readRecordedErrorDialogs(app)).toEqual([refusal, refusal]);

    await openFromNavigator(navigator, projectDir);
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'a valid project did not open after the refusals',
      })
      .toBe(1);
    const editor = await findProjectEditorWindow(app, projectDir);
    if (!editor) throw new Error('project editor did not open');
    await configureDesktopGitRepositories(editor, projectDir);
  });

  test('The app quits on SIGTERM while the home-directory refusal is still open', async ({
    captureStderrFor,
  }) => {
    test.skip(
      WINDOWS,
      'Windows has no SIGTERM: ChildProcess.kill terminates the process whatever the app does.',
    );
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('refused-sigterm');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');
    await recordErrorDialogs(app, { acknowledge: false });
    await openFromNavigator(navigator, tmpHome);
    expect(await readRecordedErrorDialogs(app)).toHaveLength(1);

    const main = app.process();
    const exited = once(main, 'exit');
    main.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('still running'), 20_000);
      }),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe('exited');
  });
});
