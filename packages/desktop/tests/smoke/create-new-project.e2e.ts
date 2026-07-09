/**
 * Create-new-project smoke harness — drives an Electron launch through the
 * Navigator → blank-create affordance → in-app CreateProjectDialog flow and
 * asserts the three end-to-end cascade UX states.
 *
 * Every test seeds zero recents (`seedTmpHome`), so the Navigator opens on the
 * first-run packs-forward view — the blank-create affordance there is
 * `nav-first-run-blank`, NOT the returning-user `nav-create-new` card (which
 * renders only once recents exist). Both fire the same `onCreate` → the same
 * dialog. The cascade states asserted:
 *
 *   1. Free path (happy submit): no banner, Create enabled. After submit,
 *      .ok/config.yml lands at parent/<name> and the editor window opens
 *      against that path.
 *   2. Nested-project block: parent sits inside an existing OK project. Red
 *      banner names the rootPath, Create is disabled, and the inline "Open
 *      <basename>" action is present.
 *   3. Git-root promote confirm: parent is inside a git repo with no
 *      enclosing .ok/. Blue banner names the gitRoot, Create stays enabled.
 *      After submit, .ok/config.yml lands at the git root (NOT at the target);
 *      content.dir defaults to '.' (the git root) — opened folder and content
 *      scope align by default, narrowing to the picked sub-folder is opt-in.
 *
 * The native folder picker is bypassed via the OK_DESKTOP_TEST_PICKED_PATH
 * env-var seam in dialog-helpers.ts — gated by OK_DESKTOP_E2E_SMOKE=1 so the
 * seam can never fire in production.
 *
 * Name-first model. Browse picks the **parent** folder. The
 * Name <Input> (data-testid="create-name") supplies the project basename.
 * The renderer composes the target as `joinPathPreview(parent, sanitized)`
 * before calling `bridge.project.createNew({ parent, name, ... })`. Tests
 * set `OK_DESKTOP_TEST_PICKED_PATH = parent` and type the project name
 * into the input; the test seam passes the parent verbatim through every
 * picker call.
 *
 * Skip gates mirror consent-dialog.e2e.ts — opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * darwin-only, and build-must-exist.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { typeProjectName } from './_helpers/create-new-dialog';
import { clickNavCreateNew } from './_helpers/navigator-actions';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

function seedTmpHome(prefix: string): string {
  // Realpath: macOS's tmpdir() resolves /var/folders → /private/var/folders.
  // folder-admission's `isDescendantOfHome` compares realpathSync(picked) to
  // homedir() (the literal HOME env). If HOME is the un-realpathed tmpdir
  // path, the descendant check fails and git-root promotion never fires.
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-create-new-${prefix}-`)));
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  // Empty state.json so the app boots straight to the Navigator (no
  // lastOpenedProject; the editor branch never fires).
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
  return tmpHome;
}

interface LaunchOpts {
  /**
   * Path the OK_DESKTOP_TEST_PICKED_PATH seam returns for Browse clicks.
   * Under the name-first model this is the **parent** directory; the project
   * basename is supplied via the Name input.
   */
  pickedParent?: string;
}

async function launchApp(tmpHome: string, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  // `--user-data-dir` is the only reliable way to redirect Electron's
  // app.getPath('userData') on macOS — setting HOME doesn't work because
  // NSHomeDirectory() resolves via getpwuid(), not the env.
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
      ...(opts.pickedParent !== undefined
        ? { OK_DESKTOP_TEST_PICKED_PATH: opts.pickedParent }
        : {}),
    },
  });
}

async function findWindowByMode(
  app: ElectronApplication,
  mode: 'navigator' | 'editor',
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
      { timeout: timeoutMs, message: `${mode} window did not appear within timeout` },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) return page;
  }
  throw new Error(`${mode} window vanished between poll resolution and read`);
}

async function countWindowsByMode(
  app: ElectronApplication,
  mode: 'navigator' | 'editor',
): Promise<number> {
  let n = 0;
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) n += 1;
  }
  return n;
}

const cleanupTargets: string[] = [];
function trackForCleanup(...paths: string[]): void {
  cleanupTargets.push(...paths);
}

test.describe('Create-new-project smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test.afterEach(async () => {
    for (const target of cleanupTargets.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  test('creates a new project at the named location when target is free', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('free');
    // Browse picks the PARENT; the user types the project name via the Name
    // input. Target = `${parent}/${projectName}`. The create-new IPC handler
    // mkdirs the target.
    const parent = join(tmpHome, 'projects-free');
    mkdirSync(parent, { recursive: true });
    const projectName = 'MySmokeProject';
    const expectedTarget = join(parent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavCreateNew(navigator);

    const dialog = navigator.locator('[data-testid="create-project-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // The Name input is the first focused control under the name-first model.
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();

    // Browse populates Location (read-only display) via the env-var seam
    // with the chosen parent.
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      parent,
      { timeout: 15_000 },
    );

    // Type the project name → caption updates with the resolved target.
    await typeProjectName(navigator, projectName);
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(
      expectedTarget,
      { timeout: 15_000 },
    );
    await expect(navigator.locator('[data-testid="create-banner-nested"]')).toHaveCount(0);
    await expect(navigator.locator('[data-testid="create-banner-git-confirm"]')).toHaveCount(0);

    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Editor window opens; .ok/config.yml lands at the expected target.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(expectedTarget, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);

    // The create-new open must surface `freshlyCreated: true` on the editor
    // window's bridge config (main → `--ok-fresh-create=1` → preload → config).
    // This is what lets the renderer's onboarding card stay visible for a
    // first-run project — including a starter-pack seed, which opens through
    // this same `create-new` entry point. Blank and seeded creates are
    // indistinguishable at this seam, so asserting it here covers both.
    //
    // The editor window already exists (the countWindowsByMode poll above waited
    // for it), so read it inline rather than re-polling via the 20s-default
    // `findWindowByMode` helper — that second helper budget would push this
    // test's cumulative inner-timeout over the calibration ceiling.
    let editor: Page | undefined;
    for (const page of app.windows()) {
      const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (m === 'editor') {
        editor = page;
        break;
      }
    }
    if (!editor) throw new Error('editor window not found after create-new submit');
    const freshlyCreated = await editor.evaluate(() => window.okDesktop?.config?.freshlyCreated);
    expect(freshlyCreated).toBe(true);
  });

  test('blocks creation when chosen Location is inside an existing OK project', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('nested');
    // Seed an existing OK project at <tmpHome>/existing-project. The user
    // Browses to <rootPath>/sub (the chosen parent), inside that project.
    const rootPath = join(tmpHome, 'existing-project');
    mkdirSync(join(rootPath, '.ok'), { recursive: true });
    writeFileSync(join(rootPath, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const subFolder = join(rootPath, 'sub');
    mkdirSync(subFolder, { recursive: true });
    const projectName = 'Nested';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: subFolder });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavCreateNew(navigator);
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      subFolder,
      { timeout: 15_000 },
    );
    await typeProjectName(navigator, projectName);

    // Red nested-project banner appears with the rootPath; submit disabled;
    // the inline "Open <basename>" action is rendered.
    const nestedBanner = navigator.locator('[data-testid="create-banner-nested"]');
    await expect(nestedBanner).toBeVisible({ timeout: 15_000 });
    await expect(nestedBanner).toContainText(rootPath);
    await expect(navigator.locator('[data-testid="create-banner-nested-open"]')).toBeVisible();
    await expect(navigator.locator('[data-testid="create-submit"]')).toBeDisabled();
  });

  test('promotes project root to git root; content.dir defaults to the git root, not the picked sub-folder', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('git-confirm');
    // Seed a git repo inside HOME so isDescendantOfHome admits promotion.
    // The picked parent is <repoRoot>/notes; the project name is MyProj; the
    // target ends up at <repoRoot>/notes/MyProj. After promotion,
    // .ok/config.yml lands at <repoRoot> AND content scope aligns with the
    // opened folder (the git root) — narrowing to the picked sub-folder is
    // opt-in, not the silent default.
    const repoRoot = join(tmpHome, 'website');
    mkdirSync(repoRoot, { recursive: true });
    execSync('git init -q', { cwd: repoRoot });
    const pickedParent = join(repoRoot, 'notes');
    mkdirSync(pickedParent, { recursive: true });
    const projectName = 'MyProj';
    const target = join(pickedParent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavCreateNew(navigator);
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      pickedParent,
      { timeout: 5_000 },
    );
    await typeProjectName(navigator, projectName);
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(target, {
      timeout: 5_000,
    });

    // Blue git-root-confirm banner appears naming the repoRoot; submit
    // stays enabled.
    const gitBanner = navigator.locator('[data-testid="create-banner-git-confirm"]');
    await expect(gitBanner).toBeVisible({ timeout: 15_000 });
    await expect(gitBanner).toContainText(repoRoot);
    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Editor window opens; .ok/config.yml lands at the GIT ROOT (not the
    // target). The user-facing target folder still exists but contains no
    // project marker. content.dir defaults to '.' (the git root) — the
    // sub-folder name does NOT appear as an uncommented entry, and the
    // commented `# content:` template block stays in place. Both halves
    // catch different regression shapes: the negative catches a bug that
    // re-encodes the sub-folder; the positive catches a bug that writes
    // some other path or drops the template.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(repoRoot, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
    expect(existsSync(join(target, '.ok', 'config.yml'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    const cfg = readFileSync(join(repoRoot, '.ok', 'config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*notes\/MyProj/m);
    expect(cfg).toMatch(/^# content:/m);
  });

  test('PRD-6649: cascade banner DOM node survives a verdict-content change of the same kind (no flicker, real Electron renderer)', async ({
    captureStderrFor,
  }) => {
    // The other three smoke tests assert the dialog FUNCTIONALLY works
    // (creates, blocks, promotes). None pin the no-flicker contract:
    // while the cascade-probe *kind* is unchanged, the banner's DOM
    // subtree must NOT unmount/remount when the probe re-runs — even if
    // the banner's *content* updates. That contract is pinned at the
    // jsdom RTL tier (cascade-staleness.dom.test.tsx); this test confirms
    // it holds in the REAL Chromium/Electron renderer, not just the
    // jsdom proxy of it.
    //
    // Scenario: Browse two distinct parents that each sit inside a
    // DIFFERENT existing OK project. The Name input value stays constant
    // ('NestedX'). Both Browses resolve to `block-nested`, but with
    // different rootPaths. The banner *kind* is unchanged
    // (block-nested → block-nested); only its rendered rootPath text
    // changes. The contract: cascade goes block-nested(root1) →
    // block-nested(root2) directly, React reconciles the rootPath text
    // in place on the SAME div, and the banner node is never removed. A
    // banner that keyed its mount on probe lifecycle would instead drop
    // to null mid-reprobe and re-create the div ~180 ms later — the
    // visible reflow this test guards against.
    //
    // Two distinct picks are driven via the dialog-helpers.ts E2E seam's
    // `\x1f`-separated sequence: Browse #1 returns sub1, Browse #2 returns sub2.
    const tmpHome = seedTmpHome('prd6649-noflicker');

    const proj1Root = join(tmpHome, 'existing-project-1');
    mkdirSync(join(proj1Root, '.ok'), { recursive: true });
    writeFileSync(join(proj1Root, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const sub1 = join(proj1Root, 'sub');
    mkdirSync(sub1, { recursive: true });

    const proj2Root = join(tmpHome, 'existing-project-2');
    mkdirSync(join(proj2Root, '.ok'), { recursive: true });
    writeFileSync(join(proj2Root, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const sub2 = join(proj2Root, 'sub');
    mkdirSync(sub2, { recursive: true });

    trackForCleanup(tmpHome);

    // \x1f-separated sequence: Browse #1 → sub1, Browse #2 → sub2.
    const app = await launchApp(tmpHome, { pickedParent: `${sub1}\x1f${sub2}` });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavCreateNew(navigator);
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    // Type the project name first; the cascade-probe needs both location
    // and name to leave 'idle' and produce a banner.
    await typeProjectName(navigator, 'NestedX');

    // Browse #1 → block-nested banner appears, naming proj1Root. This is
    // the steady state the user is "looking at" when they re-Browse.
    await navigator.locator('[data-testid="create-browse"]').click();
    const nestedBanner = navigator.locator('[data-testid="create-banner-nested"]');
    await expect(nestedBanner).toBeVisible({ timeout: 15_000 });
    await expect(nestedBanner).toContainText(proj1Root);

    // Tag the live banner node with a unique marker + install a
    // MutationObserver on its parent recording any removal of THAT node.
    // The marker lets the post-transition read re-find the exact node by
    // identity even though the test-id selector is unchanged.
    await navigator.evaluate(() => {
      const banner = document.querySelector('[data-testid="create-banner-nested"]');
      if (banner === null || banner.parentElement === null) {
        throw new Error('banner or its parent not found at observer install');
      }
      banner.setAttribute('data-prd6649-marker', 'initial');
      const state: {
        bannerWasRemoved: boolean;
        initialBanner: Element;
        observer: MutationObserver;
      } = {
        bannerWasRemoved: false,
        initialBanner: banner,
        observer: new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const removed of Array.from(m.removedNodes)) {
              if (
                removed === state.initialBanner ||
                (removed instanceof Element && removed.contains(state.initialBanner))
              ) {
                state.bannerWasRemoved = true;
              }
            }
          }
        }),
      };
      state.observer.observe(banner.parentElement, { childList: true, subtree: true });
      (window as unknown as { __prd6649: typeof state }).__prd6649 = state;
    });

    // Browse #2 → seam returns sub2 (inside proj2). cascade goes
    // block-nested(proj1Root) → block-nested(proj2Root). Kind unchanged;
    // only the rendered rootPath text changes.
    await navigator.locator('[data-testid="create-browse"]').click();

    // Event-driven settle signal: the banner now names proj2Root. This
    // proves the second probe fired AND re-settled (Playwright retries
    // until the text updates), making the no-removal assertion
    // non-vacuous.
    await expect(nestedBanner).toContainText(proj2Root, { timeout: 15_000 });
    await expect(nestedBanner).not.toContainText(proj1Root);

    // Read back the observer. Disconnect first so the result is stable.
    const result = await navigator.evaluate(() => {
      const s = (
        window as unknown as {
          __prd6649: {
            bannerWasRemoved: boolean;
            initialBanner: Element;
            observer: MutationObserver;
          };
        }
      ).__prd6649;
      s.observer.disconnect();
      const current = document.querySelector('[data-testid="create-banner-nested"]');
      return {
        bannerWasRemoved: s.bannerWasRemoved,
        stillConnected: s.initialBanner.isConnected,
        sameNode: current === s.initialBanner,
        markerSurvived: s.initialBanner.getAttribute('data-prd6649-marker') === 'initial',
      };
    });

    // The contract, in the real Electron renderer:
    //   1. The banner DOM node was never removed during the probe-driven
    //      content change (block-nested → block-nested, root1 → root2).
    //   2. The original node is still connected to the document.
    //   3. Querying the banner returns the SAME node — React reconciled
    //      the rootPath text in place; the user is looking at the same
    //      banner instance, no flash.
    //   4. The marker attribute set pre-transition is still on that same
    //      node (a fresh remount would not carry the test-set attribute).
    expect(result.bannerWasRemoved).toBe(false);
    expect(result.stillConnected).toBe(true);
    expect(result.sameNode).toBe(true);
    expect(result.markerSurvived).toBe(true);
  });

  test('PRD-6649: idle confirm-git dialog does not flash on 5 s poll ticks (zero interaction, real Electron renderer)', async ({
    captureStderrFor,
  }) => {
    // The most user-hostile manifestation, and the one reachable with NO
    // additional input and ZERO interaction after the name + Browse. A
    // target inside a git working tree that is not already an OK project
    // shows the destructive-action confirm-git banner ("remove .git?").
    // While that banner is shown a 5 s setInterval re-probes (to self-heal
    // if the user removes the .git out-of-band). If the banner's mount
    // were keyed on probe lifecycle, every tick would unmount it and the
    // debounced probe would remount it ~180 ms later — the banner strobes
    // every 5 s while the user reads a destructive confirmation, doing
    // nothing. Reachable by every developer: any folder inside any git
    // checkout that is not already an OK project.
    //
    // Non-vacuity: the poll interval is a fixed 5 s constant and the
    // confirm-git verdict is provably stable for the whole window (static
    // .git, no .ok), so a 12 s idle deterministically spans >=2 ticks. A
    // dead poll would make the pre-fix regression run pass vacuously too;
    // the pre-fix run failing (banner removed) is itself proof the ticks
    // fire.
    const tmpHome = seedTmpHome('prd6649-idle-poll');
    const repoRoot = join(tmpHome, 'some-checkout');
    mkdirSync(repoRoot, { recursive: true });
    execSync('git init -q', { cwd: repoRoot });
    const pickedParent = join(repoRoot, 'docs');
    mkdirSync(pickedParent, { recursive: true });
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavCreateNew(navigator);
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await typeProjectName(navigator, 'Notes');
    await navigator.locator('[data-testid="create-browse"]').click();
    const gitBanner = navigator.locator('[data-testid="create-banner-git-confirm"]');
    await expect(gitBanner).toBeVisible({ timeout: 15_000 });
    await expect(gitBanner).toContainText(repoRoot);

    // Tag the live banner node + observe its parent for removal of THAT
    // exact node across the idle window.
    await navigator.evaluate(() => {
      const banner = document.querySelector('[data-testid="create-banner-git-confirm"]');
      if (banner === null || banner.parentElement === null) {
        throw new Error('confirm-git banner or its parent not found at observer install');
      }
      banner.setAttribute('data-prd6649-marker', 'idle');
      const state: {
        bannerWasRemoved: boolean;
        initialBanner: Element;
        observer: MutationObserver;
      } = {
        bannerWasRemoved: false,
        initialBanner: banner,
        observer: new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const removed of Array.from(m.removedNodes)) {
              if (
                removed === state.initialBanner ||
                (removed instanceof Element && removed.contains(state.initialBanner))
              ) {
                state.bannerWasRemoved = true;
              }
            }
          }
        }),
      };
      state.observer.observe(banner.parentElement, { childList: true, subtree: true });
      (window as unknown as { __prd6649idle: typeof state }).__prd6649idle = state;
    });

    // Zero interaction. Idle long enough to span >=2 poll ticks (5 s each).
    await navigator.waitForTimeout(12_000);

    // Still naming the same repoRoot — confirms we stayed in confirm-git
    // the whole window, so the poll was armed and ticking throughout.
    await expect(gitBanner).toContainText(repoRoot);

    const result = await navigator.evaluate(() => {
      const s = (
        window as unknown as {
          __prd6649idle: {
            bannerWasRemoved: boolean;
            initialBanner: Element;
            observer: MutationObserver;
          };
        }
      ).__prd6649idle;
      s.observer.disconnect();
      const current = document.querySelector('[data-testid="create-banner-git-confirm"]');
      return {
        bannerWasRemoved: s.bannerWasRemoved,
        stillConnected: s.initialBanner.isConnected,
        sameNode: current === s.initialBanner,
        markerSurvived: s.initialBanner.getAttribute('data-prd6649-marker') === 'idle',
      };
    });

    // An idle confirm-git dialog never unmounts its banner on a poll
    // tick: same node, still connected, test-set marker survives.
    expect(result.bannerWasRemoved).toBe(false);
    expect(result.stillConnected).toBe(true);
    expect(result.sameNode).toBe(true);
    expect(result.markerSurvived).toBe(true);
  });
});
