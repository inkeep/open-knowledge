/**
 * Permanent regression test for the rename body-loss class.
 *
 * What this guards: the managed-rename spine must complete the disk move
 * before `captureAndCloseDocuments` emits the forced-reconnect close. If
 * a future spine change reorders those two steps, the production-built
 * renderer's reconnect lands at the server before the destination file
 * exists on disk, `persistence.onLoadDocument` early-returns, and the
 * destination Y.Doc loads empty — the regression this test was authored
 * against. The dev-renderer companion
 * `packages/app/tests/stress/rename-noext-probe.e2e.ts` pins the same
 * invariant against the dev (Vite) renderer's slower reconnect.
 *
 * Drives the sidebar inline-rename gesture in a Playwright-controlled
 * Electron instance with a live editor connected, then asserts BOTH disk
 * and the destination server Y.Doc retain the original body. Two variants:
 *   1. `with-ext` — types "renamed-target.md" (extension included)
 *   2. `no-ext`   — types "renamed-target" (no extension — the user's
 *      exact gesture)
 *
 * Runs against built `out/main/index.js`; the lightweight file:// load
 * of the production-built renderer is sufficient (no asar/fuses/code-
 * sign needed — any Electron wrapper of the production build exercises
 * the same reconnect path).
 *
 * Skip conditions mirror the existing smoke tests (smoke-gated,
 * darwin-only, build-must-exist).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const MARKER_PREFIX = 'rename-divergence-PROBE';
// Bounded budget to poll the destination server Y.Doc for body rehydration.
// A fixed sleep risks a false-RED on a slow runner but never a false-GREEN:
// the bug leaves the destination Y.Doc permanently empty (no async re-import
// — the file-watcher add is suppressed during the rename window), so the
// marker never appears and the assertion still fails after the budget.
const YDOC_REHYDRATE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

interface ProbeOutcome {
  variant: 'with-ext' | 'no-ext';
  typedName: string;
  expectedDocName: string;
  diskExists: boolean;
  diskBytes: number;
  diskHasMarker: boolean;
  yDocLen: number;
  yDocHasMarker: boolean;
  oldFileExists: boolean;
  raceFired: boolean;
}

async function runProbe(
  variant: 'with-ext' | 'no-ext',
  captureStderrFor: (app: ElectronApplication) => void,
): Promise<ProbeOutcome> {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1).');
  test.skip(!existsSync(MAIN_ENTRY), `out/main/index.js missing — run \`bun run build:desktop\`.`);

  // Fresh isolated everything
  const contentDir = mkdtempSync(join(tmpdir(), `ok-rename-probe-${variant}-`));
  const userDataDir = mkdtempSync(join(tmpdir(), `ok-pw-userdata-${variant}-`));
  const sourceDocName = `probe-${variant}-${randomUUID().slice(0, 8)}`;
  const marker = `${MARKER_PREFIX}-${variant}-${randomUUID().slice(0, 8)}`;
  const sourceContent = `# Probe doc\n\nMarker: ${marker}.\n\nParagraph two — non-trivial content for rename.\n\nParagraph three.\n`;

  // Make it a managed project so deep-link bypasses consent dialog
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(contentDir, `${sourceDocName}.md`), sourceContent);

  const deepLink = `openknowledge://open?project=${encodeURIComponent(
    contentDir,
  )}&doc=${encodeURIComponent(sourceDocName)}`;

  // Deliver deep-link via argv at cold launch (Playwright _electron.launch
  // doesn't fire open-url Apple Event, but main process parses argv URLs
  // for first-instance — confirmed by the packaged .app working earlier
  // with the same args shape).
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, deepLink],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30_000,
  });
  // Registers BOTH the stderr-capture and the bounded-cleanup contract.
  // The fixture's teardown reaps the Electron process group within a
  // ~5s budget — the test body must not call `app.close()` itself
  // (enforced by `_helpers/no-unbounded-app-close.test.ts`).
  captureStderrFor(app);

  try {
    // Cold launch may open Navigator briefly then close it when the editor
    // appears. Poll ALL windows looking for one whose URL hash matches the
    // expected docName.
    const expectedHashSuffix = `#/${sourceDocName}`;
    let page: import('@playwright/test').Page | undefined;
    await expect(async () => {
      for (const w of app.windows()) {
        const hash = await w.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith(expectedHashSuffix)) {
          page = w;
          return;
        }
      }
      throw new Error('editor window not yet open');
    }).toPass({ timeout: 30_000 });
    if (!page) throw new Error('editor page not found');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)'),
    ).toContainText(marker, { timeout: 30_000 });

    // Discover the API origin straight from the renderer's own config
    // (window.okDesktop.config.apiOrigin, the canonical value production code
    // reads) rather than scraping `ps`. The awaited toContainText gate above
    // guarantees the renderer (hence config) is live, so no poll is needed.
    const apiOrigin = await page.evaluate(() => window.okDesktop?.config?.apiOrigin);
    if (!apiOrigin) {
      throw new Error(`window.okDesktop.config.apiOrigin was empty (got: ${apiOrigin})`);
    }
    const port = Number(new URL(apiOrigin).port);
    console.log(`[PROBE ${variant}] API port: ${port}`);

    // Confirm Y.Doc has content BEFORE rename — `port` is guaranteed by
    // the throw above; the assertion is a mandatory precondition (a
    // post-rename empty Y.Doc must not be misattributed to a never-loaded
    // source doc).
    const r = await fetch(`http://localhost:${port}/api/document?docName=${sourceDocName}`);
    const j = (await r.json()) as { content?: string };
    const len = j.content?.length ?? 0;
    console.log(`[PROBE ${variant}] BEFORE rename — server Y.Doc len=${len}`);
    expect(len).toBeGreaterThan(0);

    // Drive the rename gesture
    const typedName = variant === 'with-ext' ? 'renamed-target.md' : 'renamed-target';
    const expectedDocName = 'renamed-target';
    const sourceItem = page.getByRole('treeitem', { name: new RegExp(`${sourceDocName}\\.md`) });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', {
      name: new RegExp(`rename ${sourceDocName}\\.md`, 'i'),
    });
    await renameInput.fill(typedName);
    await renameInput.press('Enter');

    // Y.DOC CHECK (the divergence we care about) — bounded poll instead of a
    // fixed sleep. Exits as soon as the destination Y.Doc rehydrates (fast on
    // the happy path); on the bug path it never rehydrates and the budget
    // elapses, leaving `yDocHasMarker` false so the assertion still fails RED.
    // `port` is guaranteed here — the auto-detect block above throws if it
    // could not be resolved, so the poll always runs.
    let yDocLen = -1;
    let yDocHasMarker = false;
    const deadline = Date.now() + YDOC_REHYDRATE_BUDGET_MS;
    while (Date.now() < deadline) {
      const r = await fetch(
        `http://localhost:${port}/api/document?docName=${expectedDocName}`,
      ).catch(() => null);
      if (r) {
        const j = (await r.json().catch(() => ({}))) as { content?: string };
        yDocLen = j.content?.length ?? 0;
        yDocHasMarker = (j.content ?? '').includes(marker);
        if (yDocHasMarker) break;
      }
      await wait(YDOC_POLL_INTERVAL_MS);
    }

    // DISK CHECK — taken after the poll resolves. On the happy path the move
    // has landed (the Y.Doc loaded from it); on the bug path the budget
    // elapsed and disk still holds the original body — exactly the
    // divergence `raceFired` encodes.
    const newDiskPath = join(contentDir, `${expectedDocName}.md`);
    const oldDiskPath = join(contentDir, `${sourceDocName}.md`);
    const diskExists = existsSync(newDiskPath);
    const diskContent = diskExists ? readFileSync(newDiskPath, 'utf-8') : '';
    const diskBytes = diskContent.length;
    const diskHasMarker = diskContent.includes(marker);
    const oldFileExists = existsSync(oldDiskPath);

    const raceFired = diskHasMarker && !yDocHasMarker;

    const outcome: ProbeOutcome = {
      variant,
      typedName,
      expectedDocName,
      diskExists,
      diskBytes,
      diskHasMarker,
      yDocLen,
      yDocHasMarker,
      oldFileExists,
      raceFired,
    };
    console.log(`[PROBE ${variant}] OUTCOME:`, outcome);

    return outcome;
  } finally {
    // No `app.close()` here — the smoke fixture owns the FIRST and ONLY
    // (bounded) Electron teardown pass, which runs AFTER this body returns.
    // Electron is therefore still alive holding `userDataDir` (Cache/IDB) at
    // this point, so the rmSyncs must be genuinely best-effort: `force: true`
    // ignores a missing path but NOT `ENOTEMPTY` from a live process. Swallow
    // cleanup errors so they cannot fail an otherwise-passing assertion — the
    // dirs are OS temp dirs (reclaimed) and the fixture reaps the process
    // group moments later.
    for (const dir of [contentDir, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort: Electron still holds the dir; fixture teardown + OS tmp reclamation handle it */
      }
    }
  }
}

test.describe('Production-built Electron — rename divergence probe', () => {
  test('with .md extension typed', async ({ captureStderrFor }) => {
    const outcome = await runProbe('with-ext', captureStderrFor);
    // Hard assertions — fail if race fired
    expect(outcome.diskHasMarker).toBe(true);
    expect(outcome.oldFileExists).toBe(false);
    expect(outcome.yDocHasMarker).toBe(true);
    expect(outcome.raceFired).toBe(false);
  });

  test('without .md extension typed (user gesture)', async ({ captureStderrFor }) => {
    const outcome = await runProbe('no-ext', captureStderrFor);
    expect(outcome.diskHasMarker).toBe(true);
    expect(outcome.oldFileExists).toBe(false);
    expect(outcome.yDocHasMarker).toBe(true);
    expect(outcome.raceFired).toBe(false);
  });
});
