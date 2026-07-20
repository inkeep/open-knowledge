/**
 * End-to-end coverage for the markdownlint-config Source/Rules toggle
 * (LintConfigEditor). These are the running-app fidelities the DOM tests can't
 * reach: the DOM test (`LintConfigEditor.dom.test.tsx`) mocks the three system
 * boundaries — `useProjectLintConfig` (GET /api/lint/config), `TextViewer`
 * (GET /api/asset-text), and `MarkdownlintRuleBrowser` (POST
 * /api/lint/markdownlint-config) — so the real chain
 * open -> real config discovery -> real rule write -> real disk -> Source
 * re-render is UNKNOWN until exercised against a live server. This file drives
 * the real Vite dev server + API (per-worker fixture) with real
 * `.markdownlint.json` / `.markdownlint.jsonc` files on disk.
 *
 * The config is a hidden dotfile served through the ungated `/api/asset-text`
 * route and opened by hash (`#/__asset__/<path>`), so no "Show hidden files"
 * sidebar toggle is needed to reach it here — direct hash nav mirrors selecting
 * the file once it is revealed (the FileTree dotfile-hiding path is the
 * sidebar's concern, out of scope for the editor pane under test).
 *
 * Discovery is live and filesystem-bound (`existsSync`/`readFileSync` per
 * request in `markdownlint-discovery.ts` + the GET/POST lint handlers), so a
 * config written straight into the worker's content dir is seen immediately by
 * both `/api/lint/config` and `/api/asset-text` with no watcher/index round.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/** Hash for opening a content-dir asset directly (mirrors `hashFromAssetPath`). */
function assetHash(assetPath: string): string {
  return `/#/__asset__/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

const configEditor = (page: Page) => page.locator('[data-lint-config-editor]');
// The toggle segments name themselves via aria-label ("Rules" / "Source"),
// scoped to the config editor so the doc-editor toggle ("Visual editor" /
// "Markdown source") can never be matched by accident.
const rulesSegment = (page: Page) =>
  configEditor(page).getByRole('radio', { name: 'Rules', exact: true });
const sourceSegment = (page: Page) =>
  configEditor(page).getByRole('radio', { name: 'Source', exact: true });
// The read-only source viewer, loaded branch only (data-text-viewer is stamped
// on every fetch state; `-state="loaded"` disambiguates the mounted-with-bytes
// variant).
const loadedSource = (page: Page) =>
  configEditor(page).locator('[data-text-viewer][data-text-viewer-state="loaded"]');
const ruleBrowser = (page: Page) =>
  page.locator('[data-testid="settings-linting-markdownlint-rules"]');

// Config basenames this suite writes into the shared per-worker content dir.
// The afterEach hook clears them so a leftover governing `.markdownlint.json`
// never changes lint resolution for sibling stress files on the same worker.
const CLEANUP_PATHS = [
  '.markdownlint.json',
  '.markdownlint.jsonc',
  'base.json',
  'docs/.markdownlint.json',
  'lint-cfg-package.json',
] as const;

function cleanupConfigs(contentDir: string): void {
  for (const rel of CLEANUP_PATHS) {
    rmSync(join(contentDir, rel), { force: true });
  }
}

test.describe('lint-config Source/Rules toggle — running-app E2E (PRD-7378)', () => {
  test.afterEach(({ workerServer }) => {
    cleanupConfigs(workerServer.contentDir);
  });

  // Opening the governing root config shows the toggle with Source as the
  // default view, and the Source view is byte-faithful to the on-disk file.
  test('root .markdownlint.json opens with a Source/Rules toggle, Source default, byte-faithful', async ({
    page,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.json';
    // Distinctive bytes: a rule map with unusual (3-space) indentation so the
    // byte-fidelity assertion is meaningful, not a formatter no-op.
    const fileBytes = '{\n   "MD013": false,\n   "MD033": false\n}\n';
    writeFileSync(join(workerServer.contentDir, assetPath), fileBytes, 'utf-8');

    await page.goto(assetHash(assetPath));

    // The dedicated config editor mounts (not the plain AssetPreview).
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    // Both segments render; Source is the default view (the read-only viewer is
    // mounted, the rule browser is not — the behavioral signal for the active
    // segment, mirroring the DOM test's mount assertions).
    await expect(sourceSegment(page)).toBeVisible();
    await expect(rulesSegment(page)).toBeVisible();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(ruleBrowser(page)).toHaveCount(0);

    // Byte faithfulness: the ungated /api/asset-text route serves the file
    // exactly as it is on disk — no reformat, no BOM/newline mutation. Compare
    // the served bytes to a direct disk read (the true oracle; the rendered
    // CodeMirror DOM is virtualized/normalized and not byte-exact).
    const served = await page.request.get(`/api/asset-text?path=${encodeURIComponent(assetPath)}`);
    expect(served.status()).toBe(200);
    const servedText = await served.text();
    const diskText = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
    expect(servedText).toBe(diskText);
    expect(servedText).toBe(fileBytes);
  });

  // Toggling a rule in Rules writes to the real config on disk, the real
  // MarkdownlintRuleBrowser mounts and is interactive outside Settings, Source
  // reflects the WYSIWYG edit after switching back, and the Rules preference
  // persists across close/reopen.
  test('toggling a rule in Rules writes to disk, Source reflects it, and the preference persists', async ({
    page,
    api,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, assetPath), '{\n  "MD013": false\n}\n', 'utf-8');

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    // Rules is enabled once the governing config resolves (GET /api/lint/config
    // reports configFile === the opened path). The segment is disabled until
    // that fetch lands, so wait for enablement rather than asserting eagerly.
    await expect(rulesSegment(page)).toBeEnabled({ timeout: 15_000 });
    await rulesSegment(page).click();

    // The REAL rule browser (the same component Settings mounts) renders
    // in the editor pane — providers satisfied, catalog interactive.
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);

    // Narrow to MD013 (search forces every section open so the row renders) and
    // flip it on. The Switch write path is real: onWrite -> writeMarkdownlintRule
    // -> POST /api/lint/markdownlint-config -> format-preserving writer -> disk.
    await page.locator('[data-testid="markdownlint-rule-search"]').fill('MD013');
    const md013Toggle = page.locator('[data-testid="markdownlint-rule-toggle-MD013"]');
    await expect(md013Toggle).toBeEnabled({ timeout: 15_000 });
    await md013Toggle.click();

    // The change is on the actual file on disk (false -> true).
    await expect
      .poll(
        () => {
          const raw = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
          return JSON.parse(raw).MD013;
        },
        { timeout: 15_000, message: 'MD013 must be written to .markdownlint.json on disk' },
      )
      .toBe(true);

    // Switching back to Source remounts TextViewer (Rules had unmounted it),
    // which refetches /api/asset-text and shows the just-written bytes.
    await sourceSegment(page).click();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page).locator('.cm-content')).toContainText(/"MD013"\s*:\s*true/, {
      timeout: 15_000,
    });

    // The Rules preference is now persisted. Reopen the config after navigating
    // away — LintConfigEditor remounts and honors the persisted 'rules' on the
    // governing config.
    await sourceSegment(page).click(); // ensure Source is active first...
    await rulesSegment(page).click(); // ...then choose Rules so the pref is 'rules'.
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });

    await api.createPage('lint-cfg-away.md');
    await page.goto(`/#/lint-cfg-away`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)', { timeout: 15_000 });

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });
    // Reopened straight into Rules (persisted), not the default Source.
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
  });

  // Format-preserving round-trip through the running UI, and .jsonc renders
  // with jsonc-highlighted source directly on open.
  test('editing a .jsonc rule preserves comment, extends, trailing comma, and default:false', async ({
    page,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.jsonc';
    // A base the extends points at, so `extends` resolves cleanly (no problem
    // noise) while remaining a construct the writer must preserve verbatim.
    writeFileSync(join(workerServer.contentDir, 'base.json'), '{}\n', 'utf-8');
    const jsoncBytes = [
      '// project markdownlint config',
      '{',
      '  "extends": "./base.json",',
      '  "default": false,',
      '  "MD013": false,',
      '  "MD033": false,',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(workerServer.contentDir, assetPath), jsoncBytes, 'utf-8');

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    // The .jsonc opens directly in a jsonc-highlighted source view — no "View
    // as text" indirection. TextViewer stamps the resolved extension.
    await expect(loadedSource(page)).toHaveAttribute('data-text-viewer-extension', 'jsonc', {
      timeout: 15_000,
    });

    // Edit one rule through the real Rules browser.
    await expect(rulesSegment(page)).toBeEnabled({ timeout: 15_000 });
    await rulesSegment(page).click();
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="markdownlint-rule-search"]').fill('MD009');
    const md009Toggle = page.locator('[data-testid="markdownlint-rule-toggle-MD009"]');
    await expect(md009Toggle).toBeEnabled({ timeout: 15_000 });
    await md009Toggle.click();

    // Read the file back from disk and prove every hand-authored JSONC construct
    // survived the write, alongside the applied change. Poll until the write
    // lands (POST is async after the click).
    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, assetPath), 'utf-8'), {
        timeout: 15_000,
        message: 'the MD009 write must land in .markdownlint.jsonc',
      })
      .toContain('MD009');
    const roundTripped = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
    expect(roundTripped).toContain('// project markdownlint config'); // leading comment
    expect(roundTripped).toContain('"extends": "./base.json"'); // extends reference
    expect(roundTripped).toContain('"default": false'); // default:false entry
    expect(roundTripped).toMatch(/"MD033":\s*false,/); // trailing comma preserved
  });

  // A non-governing nested config disables Rules with an explanatory tooltip
  // while Source still works; the disabled Rules segment keeps its accessible
  // name and the reason tooltip is reachable on the wrapping trigger.
  test('a nested docs/.markdownlint.json disables Rules with a tooltip while Source still works', async ({
    page,
    workerServer,
  }) => {
    // Root config governs; the nested one is NOT the governing file the writer
    // targets, so Rules must be disabled for it.
    writeFileSync(
      join(workerServer.contentDir, '.markdownlint.json'),
      '{\n  "MD013": false\n}\n',
      'utf-8',
    );
    mkdirSync(join(workerServer.contentDir, 'docs'), { recursive: true });
    const nestedPath = 'docs/.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, nestedPath), '{\n  "MD041": false\n}\n', 'utf-8');

    await page.goto(assetHash(nestedPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    // Source still renders the nested file's bytes.
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });

    // The disabled Rules segment keeps its accessible name...
    const rules = rulesSegment(page);
    await expect(rules).toHaveCount(1);
    // ...and is disabled (correct-target gating — configFile is the root, not
    // this nested path).
    await expect(rules).toBeDisabled({ timeout: 15_000 });
    // Deterministically confirm the gating input resolved to a different file,
    // then that Rules stays disabled — a leading-slash / separator equality bug
    // would have flipped it enabled once the config landed.
    const nestedCfg = await page.request.get('/api/lint/config');
    expect(nestedCfg.status()).toBe(200);
    expect((await nestedCfg.json()).configFile).not.toBe(nestedPath);
    await expect(rules).toBeDisabled();

    // The reason tooltip is reachable. The disabled <button> can't fire pointer
    // events, so the wrapping <div> (the TooltipTrigger) is hovered.
    await rules.locator('xpath=..').hover();
    await expect(page.getByRole('tooltip')).toContainText(
      "Rule editing is available for the project's root markdownlint config",
      { timeout: 15_000 },
    );
  });

  // A normal .json file is unaffected — no toggle, the existing AssetPreview.
  test('a normal package.json opens in the plain read-only preview with no Source/Rules toggle', async ({
    page,
    workerServer,
  }) => {
    // A real package.json basename would be governing-adjacent noise for other
    // files on the shared worker; use a package.json copy under a distinct name
    // that still classifies as a plain .json asset (mediaKind 'text') and is
    // NOT a markdownlint config basename.
    const assetPath = 'lint-cfg-package.json';
    writeFileSync(
      join(workerServer.contentDir, assetPath),
      '{\n  "name": "not-a-lint-config",\n  "version": "1.0.0"\n}\n',
      'utf-8',
    );

    await page.goto(assetHash(assetPath));

    // The plain AssetPreview text viewer renders the file...
    const preview = page.locator('[data-text-viewer][data-text-viewer-state="loaded"]');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator('.cm-content')).toContainText('not-a-lint-config', {
      timeout: 15_000,
    });

    // ...WITHOUT the LintConfigEditor wrapper or its Source/Rules toggle. The
    // feature is scoped strictly to markdownlint config basenames, so ordinary
    // JSON is untouched.
    await expect(configEditor(page)).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Rules', exact: true })).toHaveCount(0);
  });
  // When no native config governs, configFile is null and Rules is disabled
  // while Source still works. Distinct cause from the nested-config case: here
  // NOTHING governs, so the server GET /api/lint/config reports configFile: null
  // (root-level discovery finds no native file), disabling Rules because no
  // governing file equals the opened path — not by a path mismatch.
  test('when no native config governs (configFile null), Rules is disabled and Source works', async ({
    page,
    workerServer,
  }) => {
    // Only a nested config exists; there is NO root `.markdownlint.*`, so
    // root-level discovery (the no-`?doc` GET the editor issues) returns null.
    mkdirSync(join(workerServer.contentDir, 'docs'), { recursive: true });
    const nestedPath = 'docs/.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, nestedPath), '{\n  "MD041": false\n}\n', 'utf-8');

    await page.goto(assetHash(nestedPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    // Source renders the file bytes...
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });

    // ...and Rules stays disabled (configFile null branch).
    const rules = rulesSegment(page);
    await expect(rules).toBeDisabled({ timeout: 15_000 });

    // Deterministically confirm the branch cause (server reports configFile
    // null), then that Rules stays disabled once that resolved.
    const cfg = await page.request.get('/api/lint/config');
    expect(cfg.status()).toBe(200);
    expect((await cfg.json()).configFile).toBeNull();
    await expect(rules).toBeDisabled();
  });
});
