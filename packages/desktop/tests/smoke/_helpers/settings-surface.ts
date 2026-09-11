import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron, type Page } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from './electron-cleanup';
import { type DesktopTarget, desktopLaunchOptions, resolveDesktopTarget } from './launch-desktop';
import { seedMcpConsentComplete } from './mcp-consent';
import { homeEnv, userDataDirFor } from './platform-gate';
import { expect } from './smoke-test';

export interface SeededProjectProfile {
  readonly tmpHome: string;
  readonly userDataDir: string;
  readonly projectDir: string;
  readonly cleanupDirs: readonly string[];
}

export interface SeedProjectProfileOptions {
  readonly spellCheckEnabled?: boolean;
}

function writeSeededAppState(
  userDataDir: string,
  lastOpenedProject: string | null,
  options: SeedProjectProfileOptions = {},
): void {
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [],
      recentFiles: [],
      lastOpenedProject,
      pendingWindowRestore: null,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
      ...(options.spellCheckEnabled === undefined
        ? {}
        : { spellCheckEnabled: options.spellCheckEnabled }),
    }),
  );
}

export function seedProjectProfile(
  prefix: string,
  options: SeedProjectProfileOptions = {},
): SeededProjectProfile {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-${prefix}-project-`)));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'note.md'), '# Note\n\nProse for the checker to look at.\n');
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeSeededAppState(userDataDir, projectDir, options);
  seedMcpConsentComplete(tmpHome);
  return { tmpHome, userDataDir, projectDir, cleanupDirs: [tmpHome, projectDir] };
}

export interface LaunchOnProfileOptions {
  readonly target?: DesktopTarget;
  readonly onLaunch?: (app: ElectronApplication) => void;
}

export async function launchOnSeededProfile(
  profile: SeededProjectProfile,
  options: LaunchOnProfileOptions = {},
): Promise<ElectronApplication> {
  const app = await electron.launch(
    desktopLaunchOptions({
      target: options.target ?? resolveDesktopTarget(),
      args: [`--user-data-dir=${profile.userDataDir}`],
      env: {
        ...process.env,
        ...homeEnv(profile.tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
  options.onLaunch?.(app);
  return app;
}

export async function findEditorWindow(
  app: ElectronApplication,
  timeoutMs = 45_000,
): Promise<Page> {
  const readMode = (page: Page): Promise<string | undefined> =>
    page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if ((await readMode(page)) === 'editor') return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: 'project window did not appear within timeout' },
    )
    .toBe(true);
  for (const page of app.windows()) {
    if ((await readMode(page)) === 'editor') return page;
  }
  throw new Error('project window vanished between poll resolution and read');
}

export async function openSettingsDialog(editor: Page): Promise<void> {
  await editor.getByTestId('header-settings-button').click({ timeout: 30_000 });
  await expect(editor.getByTestId('settings-dialog')).toBeVisible({ timeout: 20_000 });
  await expect(editor.getByTestId('settings-content-skeleton')).toHaveCount(0, { timeout: 30_000 });
}

export async function showUserPreferences(editor: Page): Promise<void> {
  const languageField = editor.locator('[data-field="appearance.language"]');
  const item = editor.getByTestId('settings-sidebar-item-preferences');
  await expect(async () => {
    if (!(await languageField.isVisible())) await item.click({ timeout: 5_000 });
    await expect(languageField).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

export interface OpenSpellingSettingsOptions extends LaunchOnProfileOptions {
  readonly beforeSettings?: (app: ElectronApplication, editor: Page) => Promise<void>;
}

export interface SpellingSettingsSession {
  readonly app: ElectronApplication;
  readonly editor: Page;
}

export async function openSpellingSettings(
  profile: SeededProjectProfile,
  options: OpenSpellingSettingsOptions = {},
): Promise<SpellingSettingsSession> {
  const app = await launchOnSeededProfile(profile, options);
  const editor = await findEditorWindow(app);
  await options.beforeSettings?.(app, editor);
  await openSettingsDialog(editor);
  await showUserPreferences(editor);
  return { app, editor };
}

export interface SessionSpellingTruth {
  readonly enabled: boolean;
  readonly selected: string[];
  readonly available: string[];
}

export async function readSessionSpellingTruth(
  app: ElectronApplication,
): Promise<SessionSpellingTruth> {
  return app.evaluate(({ session }) => ({
    enabled: session.defaultSession.isSpellCheckerEnabled(),
    selected: [...session.defaultSession.getSpellCheckerLanguages()],
    available: [...session.defaultSession.availableSpellCheckerLanguages],
  }));
}

export async function seedSessionSpellingLanguages(
  app: ElectronApplication,
  languages: readonly string[],
): Promise<void> {
  await app.evaluate(
    ({ session }, codes) => {
      session.defaultSession.setSpellCheckerLanguages(codes);
    },
    [...languages],
  );
}

function userConfigPath(profile: SeededProjectProfile): string {
  return join(profile.tmpHome, '.ok', 'global.yml');
}

function readUserConfig(profile: SeededProjectProfile): string {
  const path = userConfigPath(profile);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export async function awaitUserInterfaceLanguage(
  profile: SeededProjectProfile,
  locale: string,
): Promise<void> {
  await expect
    .poll(() => readUserConfig(profile), {
      timeout: 20_000,
      message: `the interface-language choice never reached ${userConfigPath(profile)}`,
    })
    .toMatch(new RegExp(`language:\\s*['"]?${locale}`));
}

export function seedExtraProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ok-${prefix}-project2-`)));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(dir, 'note.md'), '# Second\n\nMore prose for the checker.\n');
  return dir;
}

export function projectConfigBytes(profile: SeededProjectProfile): string {
  return readFileSync(join(profile.projectDir, '.ok', 'config.yml'), 'utf8');
}

export function readAppStateFile(profile: SeededProjectProfile): Record<string, unknown> {
  const raw = readFileSync(join(profile.userDataDir, 'state.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

export function findAppStateFiles(root: string, depth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'state.json') found.push(join(dir, entry.name));
      else if (entry.isDirectory() && left > 0) walk(join(dir, entry.name), left - 1);
    }
  };
  walk(root, depth);
  return found.sort();
}

export async function findEditorWindowForProject(
  app: ElectronApplication,
  projectPath: string,
  timeoutMs = 45_000,
): Promise<Page> {
  const readProject = (page: Page): Promise<string | undefined> =>
    page
      .evaluate(() =>
        window.okDesktop?.config?.mode === 'editor'
          ? window.okDesktop.config.projectPath
          : undefined,
      )
      .catch(() => undefined);
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if ((await readProject(page)) === projectPath) return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: `no editor window opened on ${projectPath}` },
    )
    .toBe(true);
  for (const page of app.windows()) {
    if ((await readProject(page)) === projectPath) return page;
  }
  throw new Error(`the window on ${projectPath} vanished between poll resolution and read`);
}

export async function openProjectFromRecents(editor: Page, projectPath: string): Promise<void> {
  await editor.evaluate(
    (path) => window.okDesktop?.menu.dispatch({ kind: 'open-recent-project', path }),
    projectPath,
  );
}

export async function closeSettingsDialog(editor: Page): Promise<void> {
  await editor.keyboard.press('Escape');
  await expect(editor.getByTestId('settings-dialog')).toBeHidden({ timeout: 15_000 });
}

export async function reopenUserPreferences(editor: Page): Promise<void> {
  await closeSettingsDialog(editor);
  await openSettingsDialog(editor);
  await showUserPreferences(editor);
}

export async function setSpellcheckToggle(editor: Page, next: boolean): Promise<void> {
  const toggle = editor.getByTestId('settings-spellcheck-toggle');
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    if ((await toggle.getAttribute('aria-checked')) !== String(next)) {
      await toggle.click({ timeout: 5_000 });
    }
    await expect(toggle).toHaveAttribute('aria-checked', String(next), { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

export async function readSpellcheckToggleChecked(editor: Page): Promise<string | null> {
  const toggle = editor.getByTestId('settings-spellcheck-toggle');
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  return toggle.getAttribute('aria-checked');
}

export type RendererSpellingResult =
  | { readonly outcome: 'no-bridge' }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'ok'; readonly selected: string[]; readonly available: string[] };

export async function setLanguagesFromRenderer(
  editor: Page,
  languages: readonly string[],
): Promise<RendererSpellingResult> {
  return editor.evaluate(
    async (codes): Promise<RendererSpellingResult> => {
      const spellcheck = window.okDesktop?.spellcheck;
      if (!spellcheck) return { outcome: 'no-bridge' };
      const result = await spellcheck.setLanguages(codes);
      if (!result.ok) return { outcome: 'failed', reason: result.reason };
      return {
        outcome: 'ok',
        selected: [...result.state.selected],
        available: [...result.state.available],
      };
    },
    [...languages],
  );
}

export async function readLanguagesFromRenderer(editor: Page): Promise<RendererSpellingResult> {
  return editor.evaluate(async (): Promise<RendererSpellingResult> => {
    const spellcheck = window.okDesktop?.spellcheck;
    if (!spellcheck) return { outcome: 'no-bridge' };
    const result = await spellcheck.languages();
    if (!result.ok) return { outcome: 'failed', reason: result.reason };
    return {
      outcome: 'ok',
      selected: [...result.state.selected],
      available: [...result.state.available],
    };
  });
}

export function sameLanguageSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export function pickNonDefaultSelection(truth: SessionSpellingTruth): string[] | null {
  const preferred = ['en-US', 'vi'].filter((code) => truth.available.includes(code));
  if (preferred.length === 2 && !sameLanguageSet(preferred, truth.selected)) return preferred;
  const extra = truth.available.find((code) => !truth.selected.includes(code));
  if (extra === undefined) return null;
  return [...truth.selected, extra];
}

export async function readMenuSnapshotSpellcheck(editor: Page): Promise<boolean | undefined> {
  return editor.evaluate(async () => {
    const snapshot = await window.okDesktop?.menu.dispatch({ kind: 'query' });
    return snapshot?.spellCheckEnabled;
  });
}

export async function applicationMenuSpellcheck(
  app: ElectronApplication,
  action: 'read' | 'click',
): Promise<boolean> {
  return app.evaluate(({ Menu }, requested) => {
    const root = Menu.getApplicationMenu();
    if (root === null) throw new Error('no application menu is installed');
    const found: Electron.MenuItem[] = [];
    const walk = (items: readonly Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.type === 'checkbox' && /spell/i.test(item.label)) found.push(item);
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(root.items);
    const item = found[0];
    if (found.length !== 1 || item === undefined) {
      throw new Error(`expected one spellcheck checkbox menu item, found ${found.length}`);
    }
    if (requested === 'click') (item.click as unknown as () => void)();
    return item.checked;
  }, action);
}

export async function awaitEngineSpellcheckEnabled(
  app: ElectronApplication,
  expected: boolean,
): Promise<void> {
  await expect
    .poll(async () => (await readSessionSpellingTruth(app)).enabled, {
      timeout: 20_000,
      message: `session.defaultSession never reported spellcheck enabled=${expected}`,
    })
    .toBe(expected);
}

export async function closeAppForRelaunch(app: ElectronApplication): Promise<void> {
  const proc = captureAppProcess(app);
  await Promise.race([
    app.close().catch(() => undefined),
    closeAppBounded(proc, { gracefulMs: 5_000 }),
  ]);
}

export function editorBody(editor: Page) {
  return editor.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)').first();
}

export async function openProjectDocument(editor: Page, docName: string): Promise<void> {
  await editor.evaluate((name) => {
    window.location.hash = `#/${name}`;
  }, docName);
  await expect(editorBody(editor)).toBeVisible({ timeout: 30_000 });
}

async function openLanguageSelector(editor: Page): Promise<void> {
  const trigger = editor.getByTestId('settings-spellcheck-languages-trigger');
  const list = editor.getByTestId('settings-spellcheck-languages-list');
  await expect(async () => {
    if (!(await list.isVisible())) await trigger.click({ timeout: 5_000 });
    await expect(list).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

export async function addLanguageInSelector(editor: Page, code: string): Promise<void> {
  await openLanguageSelector(editor);
  const item = editor.getByTestId(`settings-spellcheck-language-item-${code}`);
  await expect(async () => {
    if ((await item.getAttribute('aria-selected')) !== 'true') await item.click({ timeout: 5_000 });
    await expect(item).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await editor.keyboard.press('Escape');
  await expect(editor.getByTestId('settings-spellcheck-languages-list')).toHaveCount(0, {
    timeout: 15_000,
  });
}
