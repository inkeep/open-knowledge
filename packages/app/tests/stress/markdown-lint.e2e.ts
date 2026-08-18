/**
 * Playwright E2E for the client-side markdown-lint composed flow.
 *
 * This is the real-browser rung that jsdom `dom.test.tsx` structurally cannot
 * cover: CodeMirror 6's `@codemirror/lint` paints decorations against a real
 * layout, and the Problems panel is driven live off `Y.Text('source')` through
 * `useDocDiagnostics`. Unit/dom tests assert the hook returns diagnostics and
 * the panel renders static props; only a browser proves the decoration paints
 * and the config→lint→decoration/panel wiring composes end-to-end.
 *
 * Covered seams (see reports test-substrate audit): S7 source-mode CM6
 * decorations, S9 Problems-panel badge+list+nav composition, plus the live
 * re-lint observer path and the no-false-positive negative case.
 *
 * The WYSIWYG hover callout's geometry and dismissal live here for the same
 * reason: the assertion is real-pixel rect arithmetic between the callout and
 * the caret's line box, and a layout-less DOM reports both as zero-size rects,
 * so the jsdom tier would report "no overlap" whatever the code does.
 *
 * markdownlint is opt-in (off by default), so `beforeEach` enables the plugin
 * for the worker's project (`.ok/config.yml`); a hard tab then trips MD010.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * playwright.config.ts webServer on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

// A body whose first line carries a hard tab → markdownlint MD010 (no-hard-tabs).
// Kept to a single block so the violation maps to one line/node.
const HARD_TAB_BODY = '# Heading\n\n\tindented with a hard tab\n';
const CLEAN_BODY = '# Heading\n\nA clean paragraph with no violations.\n';
// The Problems row names its producing plugin in the chip, so the subline
// carries the bare rule code rather than a `source/code` pair.
const MD010 = 'MD010';
// An H1 followed by an H3 skips a level → MD001 (heading-increment). The hard
// tab keeps a second, independent violation in the doc so "MD010 still fires"
// is the positive signal that a re-lint ran with the new config (an MD001
// zero-count alone would also pass against a dead linter).
const MD001_AND_TAB_BODY = '# Heading\n\n### Skipped level\n\n\tindented with a hard tab\n';
const MD001 = 'MD001';

/** Switch to source mode and wait for CodeMirror to paint. */
async function switchToSource(page: Page) {
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 0, null, {
    timeout: 5_000,
  });
}

/** Open the right-rail Problems tab. */
async function openProblemsTab(page: Page) {
  await page.locator('#tab-problems').click();
  // The panel wrapper has no stable id; wait for its body (list or empty state).
  await expect(
    page.locator('ul[aria-label="Problems"]').or(page.getByText('No problems found')),
  ).toBeVisible({ timeout: 5_000 });
}

/**
 * 1-based `.cm-line` index containing the DOM selection anchor. The source
 * editor renders no line-number gutter, so the focused cursor's real DOM
 * selection is the observable position signal.
 */
async function activeSourceLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    const line = element?.closest('.cm-line') ?? null;
    if (!line) return -1;
    return Array.from(document.querySelectorAll('.cm-content .cm-line')).indexOf(line) + 1;
  });
}

const errors: LogEntry[] = [];
let testDocName = '';

test.beforeEach(async ({ page, api, workerServer }) => {
  // markdownlint is opt-in (off by default); enable the plugin for the worker's
  // project so the linter runs. readLinterBaseConfig reads this fresh per request.
  mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'config.yml'),
    'contentRules:\n  markdownlint:\n    enabled: true\n',
    'utf-8',
  );
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });

  // Follow-the-file (ACP) defaults ON, so an agent write — including the
  // `seed()` used to set up these fixtures — scrolls the shared editor
  // container to follow the write. That viewport side-effect is orthogonal to
  // lint navigation and defeats the source-mode scroll assertion (the container
  // arrives at the violation before the click can move it). Pin it OFF so these
  // tests measure lint navigation from a stable top-of-doc baseline.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ok-acp-follow-file-v1', '0');
    } catch {}
  });

  testDocName = `mdlint-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${testDocName}.md`);
  await page.goto(`/#/${testDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  // Restore the default (markdownlint off) so any e2e file sharing this worker
  // isn't left with the plugin silently enabled.
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('markdown lint — source-mode decorations', () => {
  test('a hard tab paints a CM6 lint range + gutter marker', async ({ page, api }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await switchToSource(page);

    // @codemirror/lint renders the diagnostic as a .cm-lintRange underline and a
    // .cm-lint-marker in the gutter. Neither exists in jsdom — this is the rung.
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
    await expect(page.locator('.cm-gutter .cm-lint-marker').first()).toBeVisible();
  });

  test('a clean document paints no lint ranges (no false positives)', async ({ page, api }) => {
    // An empty `.cm-lintRange` set is not a settle barrier: it reads the same before the
    // debounced pass runs and after it runs clean, so a bare `toHaveCount(0)` would pass
    // even against a dead linter. Paint a known violation first (a positive wait that
    // proves the source linter is live), then clear to clean — the range disappearing is
    // the deterministic signal that a relint cycle actually ran on the clean text.
    await seed(api, testDocName, HARD_TAB_BODY);
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);

    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.locator('.cm-content .cm-lintRange')).toHaveCount(0);
  });

  test('editing to introduce a violation live-relints the open editor', async ({ page, api }) => {
    await seed(api, testDocName, CLEAN_BODY);
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).toHaveCount(0);

    // Mutate Y.Text out-of-band through the same provider the editor is bound to;
    // useDocDiagnostics observes Y.Text('source') and re-lints on the debounce.
    await seed(api, testDocName, HARD_TAB_BODY);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
  });
});

test.describe('markdown lint — Problems panel composition', () => {
  test('the violation surfaces in the panel with its rule code and a count badge', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);

    const violations = page.locator('ul[aria-label="Problems"] > li');
    await expect(violations).not.toHaveCount(0);
    await expect(page.getByText(MD010)).toBeVisible();

    // The Problems tab shows a destructive count badge when diagnostics exist —
    // mode-agnostic, driven off the same useDocDiagnostics source.
    await expect(page.locator('#tab-problems').getByText(/^\d+$/)).toBeVisible();
  });

  test('a clean document shows the empty state and no badge', async ({ page, api }) => {
    // The empty state renders from the panel's initial `diagnostics === []` before the
    // first lint pass resolves, so asserting it directly would pass against a dead
    // pipeline. Surface a real violation first (proves the panel is live), then clear it;
    // the flip back to the empty state and the dropped badge is the deterministic settle.
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);
    await expect(page.locator('ul[aria-label="Problems"] > li')).not.toHaveCount(0);

    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.getByText('No problems found')).toBeVisible();
    await expect(page.locator('#tab-problems').getByText(/^\d+$/)).toHaveCount(0);
  });

  test('clicking a violation row emits a lint-nav event with the target line', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);

    const navLine = page.evaluate<number>(
      () =>
        new Promise((resolve) => {
          window.addEventListener(
            'open-knowledge:lint-nav',
            (e) => resolve((e as CustomEvent).detail?.line ?? -1),
            { once: true },
          );
        }),
    );
    await page.locator('ul[aria-label="Problems"] > li button').first().click();
    // The hard tab is on line 3 of HARD_TAB_BODY.
    expect(await navLine).toBe(3);
  });
});

test.describe('markdown lint — Problems panel project scope', () => {
  test('project scope lists violating files with per-file counts on demand', async ({
    page,
    api,
    workerServer,
  }) => {
    // A second violating doc that is never opened in the editor — project
    // scope must surface it anyway.
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    await seed(api, doc2, HARD_TAB_BODY); // one violation: MD010
    await seed(api, testDocName, MD001_AND_TAB_BODY); // two violations: MD001 + MD010

    // The audit walks the content dir on disk; wait for the persistence
    // debounce to flush both seeded docs before running it.
    await expect
      .poll(
        () => {
          try {
            return (
              readFileSync(join(workerServer.contentDir, `${testDocName}.md`), 'utf-8').includes(
                '### Skipped level',
              ) && readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes('\t')
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();

    const scopeBody = page.getByTestId('problems-project-scope');
    const group1 = scopeBody.getByTestId('problems-audit-group').filter({ hasText: testDocName });
    const group2 = scopeBody.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group1).toBeVisible({ timeout: 10_000 });
    await expect(group2).toBeVisible();
    // Headers show the file path and per-file count while collapsed.
    await expect(group1.getByTestId('problems-audit-file-count')).toHaveText('2');
    await expect(group2.getByTestId('problems-audit-file-count')).toHaveText('1');
    // Groups mount collapsed, so their diagnostic rows are not in the DOM — the
    // structural guard for the panel-open cost (element count bounded by group
    // count, not by finding count).
    await expect(group1).toHaveAttribute('data-state', 'closed');
    await expect(group2).toHaveAttribute('data-state', 'closed');
    await expect(scopeBody.getByText(MD001)).toHaveCount(0);
    await expect(scopeBody.getByText(MD010)).toHaveCount(0);

    // Expand-all restores the fully-expanded view in one action…
    await scopeBody.getByTestId('problems-audit-expand-toggle').click();
    await expect(group1).toHaveAttribute('data-state', 'open');
    await expect(group1.getByText(MD001)).toBeVisible();
    await expect(group2.getByText(MD010)).toBeVisible();
    // …and collapse-all returns them to headers only.
    await scopeBody.getByTestId('problems-audit-expand-toggle').click();
    await expect(group1).toHaveAttribute('data-state', 'closed');
    await expect(scopeBody.getByText(MD001)).toHaveCount(0);

    // The audit-wide error/warning counts render above the groups (substring
    // tolerant of the singular/plural form — leftover docs from earlier tests
    // in this worker legitimately contribute to the totals).
    await expect(page.getByTestId('problems-audit-summary')).toContainText('warning');
  });

  test('clicking a project-scope diagnostic for a closed doc opens it at the diagnostic line', async ({
    page,
    api,
    workerServer,
  }) => {
    // The jump target lives in a doc that is never opened before the click.
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    await seed(api, doc2, HARD_TAB_BODY); // MD010 on line 3
    await seed(api, testDocName, CLEAN_BODY);

    // The audit walks the content dir on disk; wait for the persistence
    // debounce to flush the seeded doc before running it.
    await expect
      .poll(
        () => {
          try {
            return readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes(
              '\t',
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // Editor mode is a user-global preference: with source mode active before
    // the click, the target doc opens straight into a source editor and the
    // banked lint intent replays there.
    await switchToSource(page);
    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();

    const group = page.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group).toBeVisible({ timeout: 10_000 });
    // Groups mount collapsed, so open them before the diagnostic row exists.
    await page.getByTestId('problems-audit-expand-toggle').click();
    await group.getByRole('button', { name: /Hard tabs/ }).click();

    // Hash navigation to the closed doc…
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${doc2}`);
    await waitForProvider(page);
    // …whose source editor mounts with the doc content…
    await expect(page.locator('.cm-content')).toContainText('indented with a hard tab');
    // …and the pending-intent replay lands the cursor on the diagnostic line.
    await expect.poll(() => activeSourceLine(page)).toBe(3);
  });
});

test.describe('markdown lint — settings rule browser', () => {
  test('toggling MD001 off writes the native config file and clears its decorations', async ({
    page,
    api,
    workerServer,
  }) => {
    await seed(api, testDocName, MD001_AND_TAB_BODY);
    await openProblemsTab(page);
    await expect(page.getByText(MD001)).toBeVisible();
    await expect(page.getByText(MD010)).toBeVisible();
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);

    // The browser writes into the worker's own contentDir; remove the file
    // afterwards so later tests in this worker lint against OK defaults again.
    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    try {
      await page.goto('/#settings');
      await page.getByTestId('settings-sidebar-item-plugin:markdownlint').click();
      const search = page.getByTestId('markdownlint-rule-search');
      await expect(search).toBeVisible({ timeout: 10_000 });
      await search.fill('MD001');
      const toggle = page.getByTestId('markdownlint-rule-toggle-MD001');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();

      // The Modified badge flips on once the write round-trips through the
      // config endpoint and the panel re-fetches the governing config.
      await expect(page.getByTestId('markdownlint-rule-modified-MD001')).toBeVisible({
        timeout: 10_000,
      });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      expect(config.MD001).toBe(false);

      await page.goto(`/#/${testDocName}`);
      await waitForProvider(page);
      await switchToSource(page);
      // MD010 still painting proves the re-lint ran with the new config …
      await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
      await openProblemsTab(page);
      await expect(page.getByText(MD010)).toBeVisible();
      // … and the MD001 diagnostic is gone.
      await expect(page.getByText(MD001)).toHaveCount(0);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  test('editing MD013 line_length through the option field preserves the file’s other keys', async ({
    page,
    workerServer,
  }) => {
    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    // A sibling rule key (MD010) plus a sibling option key (code_blocks) —
    // both must survive the single-option edit.
    writeFileSync(
      configPath,
      `${JSON.stringify({ MD010: false, MD013: { line_length: 120, code_blocks: false } }, null, 2)}\n`,
    );
    try {
      await page.goto('/#settings');
      await page.getByTestId('settings-sidebar-item-plugin:markdownlint').click();
      const search = page.getByTestId('markdownlint-rule-search');
      await expect(search).toBeVisible({ timeout: 10_000 });
      await search.fill('MD013');
      await page.getByTestId('markdownlint-rule-expand-MD013').click();

      const field = page.locator('#rule-option-MD013-line_length');
      // The field is backed by the file's value, not the schema default.
      await expect(field).toHaveValue('120');
      await field.fill('100');
      await field.press('Enter');

      await expect
        .poll(
          () => {
            const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
              MD013?: { line_length?: unknown };
            };
            return config.MD013?.line_length;
          },
          { timeout: 10_000 },
        )
        .toBe(100);
      const raw = readFileSync(configPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({
        MD010: false,
        MD013: { line_length: 100, code_blocks: false },
      });
      // Row-replace only rewrites the edited rule's value: the untouched
      // sibling line keeps its formatting byte-for-byte.
      expect(raw).toContain('"MD010": false');
    } finally {
      rmSync(configPath, { force: true });
    }
  });
});

// Three trailing spaces trip MD009 (no-trailing-spaces; br_spaces=2 allows
// exactly two). Chosen deliberately: serialization NORMALIZES trailing spaces
// away, so this violation class only paints in WYSIWYG when the decoration
// pass lints the raw Y.Text source — the rung that proves the source-bytes
// path, not a re-serialization.
const MD009_BODY = '# Heading\n\nFirst paragraph.\n\nLast paragraph with trailing spaces   \n';

test.describe('markdown lint — WYSIWYG block decorations + navigation', () => {
  test('a serialization-erased violation (trailing spaces) marks its block in WYSIWYG', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, MD009_BODY);
    // Stay in WYSIWYG (the default mode) — the block the violation falls in
    // gets the .ok-lint-block node decoration.
    await expect(page.locator('.ProseMirror .ok-lint-block').first()).toBeVisible({
      timeout: 10_000,
    });
    // The decoration must land on the OFFENDING block (the last paragraph),
    // not merely on some block — guards buildDecorationSet's block-index → PM
    // -node mapping against an off-by-one that would underline the wrong
    // paragraph while still passing a bare "some block is marked" check.
    await expect(
      page.locator('.ProseMirror .ok-lint-block', {
        hasText: 'Last paragraph with trailing spaces',
      }),
    ).toHaveCount(1);
    await expect(
      page.locator('.ProseMirror .ok-lint-block', { hasText: 'First paragraph' }),
    ).toHaveCount(0);

    // Clearing the violation clears the decoration — proves a live re-lint
    // cycle on the current bytes, not a stale set.
    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });

  test('decorations render in a doc that ends with a heading (trailing empty paragraph)', async ({
    page,
    api,
  }) => {
    // Mirrors the user-test repro: a heading-final doc makes the PM doc carry
    // a trailing empty paragraph with no source counterpart, so a strict
    // block-count comparison never matches and decorations silently never
    // paint (and row clicks never navigate).
    const headingFinalBody =
      '# Lint demo\n\nTrailing spaces here.   \n\n- dash item\n* star item\n\n### End heading\n';
    await seed(api, testDocName, headingFinalBody);
    await expect(page.locator('.ProseMirror .ok-lint-block').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a textless block (thematic break / image) gets a visible outline, not an invisible underline', async ({
    page,
    api,
  }) => {
    // MD035 fires on the second (differently-styled) thematic break — a
    // textless block, so the base wavy underline paints nothing and it must
    // fall back to the .ok-lint-block-atom outline. (Images are textless too
    // but a fake src 404s the console-error gate, so a thematic break is the
    // clean textless probe.)
    await seed(api, testDocName, '# Title\n\n---\n\ntext\n\n***\n\nEnd.\n');
    const atoms = page.locator('.ProseMirror .ok-lint-block-atom');
    await expect(atoms.first()).toBeVisible({ timeout: 10_000 });
    // Every atom-decorated block renders a real outline (the visible fallback).
    const outlined = await atoms.evaluateAll((els) =>
      els.every((el) => getComputedStyle(el).outlineStyle !== 'none'),
    );
    expect(outlined).toBe(true);
  });

  test('clicking a Problems row in WYSIWYG actually scrolls the block into view', async ({
    page,
    api,
  }) => {
    // A doc tall enough that the violation sits well below the fold, so a
    // real scroll is observable (the earlier selection-only assertion could
    // pass without the viewport ever moving). Heading-final to also exercise
    // the trailing-empty-paragraph path.
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1}.`).join(
      '\n\n',
    );
    const tallBody = `# Top heading\n\n${filler}\n\nParagraph with trailing spaces here.   \n\n### Bottom heading\n`;
    await seed(api, testDocName, tallBody);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    const scroller = page.getByTestId('editor-scroll-container');
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    // The container must actually scroll down toward the violation.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(before + 100);
    // And the offending block must settle within the visible viewport, clear
    // of the 3.5rem toolbar overlay (scroll-pt-14 alignment). Poll so the
    // smooth-scroll animation has time to settle; small tolerance on the
    // toolbar band for sub-pixel rounding.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
          const scrollEl = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!pm || !scrollEl) return false;
          const target = Array.from(pm.children).find((c) =>
            c.textContent?.includes('Paragraph with trailing spaces here.'),
          );
          if (!target) return false;
          const t = target.getBoundingClientRect();
          const s = scrollEl.getBoundingClientRect();
          return t.top >= s.top + 48 && t.top <= s.bottom;
        }),
      )
      .toBe(true);
  });

  test('clicking a Problems row in source mode scrolls the ancestor container to the line', async ({
    page,
    api,
  }) => {
    // Regression for the source-mode scroll no-op: in full-page source mode the
    // CM editor renders at content height with no internal scrollport, so
    // scrollIntoView(y:'center'|'nearest') measures the target as already visible
    // against CM's own scrollDOM and never scrolls the real ancestor
    // (ScrollPreservingContainer). Only y:'start' propagates the scroll. A tall
    // doc puts the violation well below the fold so a real scroll is observable —
    // the bug is invisible whenever the whole doc fits the viewport.
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1}.`).join(
      '\n\n',
    );
    const tallBody = `# Top heading\n\n${filler}\n\nParagraph with trailing spaces here.   \n`;
    await seed(api, testDocName, tallBody);
    await switchToSource(page);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    const scroller = page.getByTestId('editor-scroll-container');
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    // The ancestor container must actually scroll down toward the violation line.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(before + 100);
  });

  test('clicking a Problems row in WYSIWYG selects and scrolls to the offending block', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, MD009_BODY);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    // The violation is on the LAST paragraph (top-level block index 2:
    // heading, paragraph, paragraph). The nav handler puts the selection
    // inside that block in the visible WYSIWYG editor.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const anchor = window.getSelection()?.anchorNode ?? null;
          const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
          const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
          if (!pm || !element) return -1;
          const top = Array.from(pm.children).find((child) => child.contains(element));
          return top ? Array.from(pm.children).indexOf(top) : -1;
        }),
      )
      .toBe(2);
  });

  test('project-scope click on a closed doc opens it AND scrolls on the first click', async ({
    page,
    api,
    workerServer,
  }) => {
    // Regression: the cross-doc project path banks the intent and opens the
    // doc WITHOUT dispatching the live event, so the WYSIWYG editor must
    // REPLAY it on mount — otherwise the first click only navigates and a
    // second click is needed to scroll.
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    const filler = Array.from({ length: 40 }, (_, i) => `Filler line ${i + 1}.`).join('\n\n');
    const doc2Body = `# ${doc2}\n\n${filler}\n\nParagraph with trailing spaces here.   \n\n### Bottom heading\n`;
    await seed(api, doc2, doc2Body);
    await seed(api, testDocName, CLEAN_BODY);

    // The audit walks disk; wait for the persistence debounce to flush doc2.
    await expect
      .poll(
        () => {
          try {
            return readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes(
              'trailing spaces here.',
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();
    const group = page.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group).toBeVisible({ timeout: 10_000 });
    // Groups mount collapsed, and Radix unmounts closed content, so the row is
    // not in the DOM yet. Expand as a SEPARATE prior action — folding it into
    // the click below would destroy what this test pins, which is that ONE
    // click both navigates and scrolls.
    await page.getByTestId('problems-audit-expand-toggle').click();
    await expect(group.getByRole('button', { name: /Trailing spaces/ }).first()).toBeVisible({
      timeout: 10_000,
    });

    // A single click: navigate to the closed doc …
    await group
      .getByRole('button', { name: /Trailing spaces/ })
      .first()
      .click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${doc2}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // … and the offending block scrolls into view without a second click.
    // Two scroll containers exist (the previous doc stays pool-mounted but
    // hidden) — target the visible one.
    const scroller = page.locator('[data-testid="editor-scroll-container"]:visible');
    await expect(scroller).toBeVisible();
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  });
});

test.describe('markdown lint — auto-fix', () => {
  // MD009 (trailing spaces) is auto-fixable; the fix deletes the trailing run.
  const FIXABLE_BODY = '# Title\n\nParagraph with trailing spaces.   \n';

  test('the Problems panel Fix button applies the fix and the violation clears', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, FIXABLE_BODY);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();
    const fix = page.getByTestId('problems-fix').first();
    await expect(fix).toBeAttached();
    await fix.click();
    // The write lands on Y.Text('source'); useDocDiagnostics re-lints and the
    // row disappears, and the WYSIWYG squiggle clears without navigating.
    await expect(page.getByText('MD009')).toHaveCount(0);
    await expect(page.getByText('No problems found')).toBeVisible();
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });

  test('the WYSIWYG tooltip Fix button applies the fix', async ({ page, api }) => {
    await seed(api, testDocName, FIXABLE_BODY);
    // Stay in WYSIWYG. Hover the decorated paragraph to raise the tooltip.
    const block = page.locator('.ProseMirror .ok-lint-block').first();
    await expect(block).toBeVisible({ timeout: 10_000 });
    await block.hover();
    const tooltipFix = page.locator('.ok-lint-tooltip-fix');
    await expect(tooltipFix).toBeVisible();
    await tooltipFix.click();
    // The stale squiggle must clear WITHOUT navigating away: a source-only fix
    // leaves the PM doc unchanged, so the decoration relies on the
    // LINT_SOURCE_FIXED_EVENT nudge to re-lint and drop the mark.
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });
});

test.describe('markdown lint — WYSIWYG hover callout vs the editing region', () => {
  // Long enough to wrap, so a click can land mid-line with the pointer left
  // resting inside the block. The trailing run trips MD009 (auto-fixable), so
  // the callout renders with its Fix button — the tallest, worst-case form.
  const OCCLUDING_BODY =
    '# Title\n\nA long paragraph that wraps across more than one visual line in the editor, so a click can land at the measured vertical centre of a known line box while the pointer keeps resting on the block.   \n';

  /**
   * Max caret-line overlap treated as "clear". The callout's bottom edge is
   * pinned relative to the anchor, so a correct anchor (the caret's line box)
   * leaves a gap and the measure floors at 0; only an anchor that ignores the
   * line's height reads positive. Observed regression magnitudes are 4.0-4.6 px
   * on ordinary paragraphs and 18.2 px of a 20 px line on a tall JSX block, so
   * 1 px absorbs sub-pixel and font-rendering jitter while staying 4x below the
   * smallest real occlusion.
   */
  const CARET_OCCLUSION_TOLERANCE_PX = 1;

  interface EdgeRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }

  interface CalloutGeometry {
    tooltip: EdgeRect | null;
    /** The caret's line box: its vertical extent, spanned to the block's width. */
    caretLine: EdgeRect | null;
    /** Height of the callout ∩ caret-line intersection; 0 when disjoint or hidden. */
    caretOcclusionPx: number;
    elementAtCaret: string | null;
  }

  /**
   * Measure the visible callout against the caret's line box — the region the
   * user is editing. A collapsed caret rect carries the line's height but no
   * width, and text keeps flowing into the rest of the line as it is typed, so
   * the horizontal extent comes from the enclosing block rather than from the
   * caret's own zero-width x.
   */
  function readCalloutGeometry(page: Page): Promise<CalloutGeometry> {
    return page.evaluate(() => {
      const toEdges = (r: DOMRect) => ({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      });
      const visible =
        Array.from(document.querySelectorAll<HTMLElement>('.ok-lint-tooltip')).find(
          (el) => !el.hidden,
        ) ?? null;
      const selection = window.getSelection();
      let caretLine: EdgeRect | null = null;
      let elementAtCaret: string | null = null;
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        const rects = range.getClientRects();
        const caret = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        const focus = selection.focusNode;
        const focusElement = focus instanceof Element ? focus : (focus?.parentElement ?? null);
        const blockRect =
          focusElement?.closest('.ProseMirror > *')?.getBoundingClientRect() ?? null;
        caretLine = {
          top: caret.top,
          bottom: caret.bottom,
          left: blockRect ? blockRect.left : caret.left,
          right: blockRect ? blockRect.right : caret.right,
        };
        elementAtCaret =
          document.elementFromPoint(caret.left + 1, (caret.top + caret.bottom) / 2)?.className ??
          null;
      }
      const tooltip = visible ? toEdges(visible.getBoundingClientRect()) : null;
      let caretOcclusionPx = 0;
      if (tooltip && caretLine) {
        const horizontalOverlap =
          Math.min(tooltip.right, caretLine.right) - Math.max(tooltip.left, caretLine.left);
        const verticalOverlap =
          Math.min(tooltip.bottom, caretLine.bottom) - Math.max(tooltip.top, caretLine.top);
        caretOcclusionPx = horizontalOverlap > 0 ? Math.max(0, verticalOverlap) : 0;
      }
      return { tooltip, caretLine, caretOcclusionPx, elementAtCaret };
    });
  }

  const visibleCallouts = (page: Page) => page.locator('.ok-lint-tooltip:visible');

  async function lintBlockBox(page: Page) {
    const block = page.locator('.ProseMirror:not(.composer-prosemirror) .ok-lint-block').first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    const box = await block.boundingBox();
    if (!box) throw new Error('lint block has no layout box');
    return box;
  }

  test('the hover callout clears the line box the caret sits in', async ({ page, api }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    // Click near the top of the block: places the caret AND drags the pointer
    // into the block, raising the callout. A visible callout here is the
    // positive precondition — without it the occlusion measurement below would
    // read 0 vacuously.
    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    const probe = await readCalloutGeometry(page);
    expect(probe.caretLine, 'no caret after clicking into the lint block').not.toBeNull();
    const lineBox = probe.caretLine as EdgeRect;
    // A zero-size line box would make any overlap arithmetic pass trivially —
    // exactly the vacuous shape a layout-less DOM produces.
    expect(lineBox.bottom - lineBox.top).toBeGreaterThan(8);
    expect(lineBox.right - lineBox.left).toBeGreaterThan(50);

    // Leave the block so the next entry re-runs the show path with a fresh
    // anchor, then click at the measured vertical centre of that same line —
    // where a user aiming at text in the middle of a line actually clicks.
    await page.mouse.move(box.x + 20, 60);
    await expect(visibleCallouts(page)).toHaveCount(0);
    await page.mouse.click(box.x + 150, (lineBox.top + lineBox.bottom) / 2);
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    // floating-ui resolves the placement asynchronously; before it lands the
    // callout still sits at its initial 0,0, which would also read as no overlap.
    // Testing both axes rather than a positive `top` keeps the guard honest: a
    // legitimately-resolved placement can carry a non-positive top near the
    // viewport edge, which a `top > 0` poll would misread as never-positioned.
    await expect
      .poll(
        async () => {
          const { tooltip } = await readCalloutGeometry(page);
          return tooltip ? tooltip.top !== 0 || tooltip.left !== 0 : false;
        },
        {
          message: 'the hover callout never received a computed position',
        },
      )
      .toBe(true);

    const geometry = await readCalloutGeometry(page);
    // Stated locally rather than leaned on: a hidden callout makes the
    // occlusion measure below read 0 and pass for the wrong reason.
    expect(geometry.tooltip, 'the hover callout vanished before it was measured').not.toBeNull();
    expect(
      geometry.caretLine && Math.abs(geometry.caretLine.top - lineBox.top),
      'the second click landed on a different line than the one that was measured',
    ).toBeLessThan(2);
    expect(
      geometry.caretOcclusionPx,
      `hover callout overlaps the caret line box by ${geometry.caretOcclusionPx.toFixed(2)}px — ` +
        `callout=${JSON.stringify(geometry.tooltip)} caretLine=${JSON.stringify(geometry.caretLine)} ` +
        `topmostElementAtCaret=${geometry.elementAtCaret}`,
    ).toBeLessThanOrEqual(CARET_OCCLUSION_TOLERANCE_PX);
  });

  test('typing with the pointer resting on the block retires the hover callout', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + box.height / 2);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    // The pointer never moves again — the only thing that can retire the
    // callout is the typing itself.
    await page.keyboard.type('typing under the callout', { delay: 25 });
    await expect(visibleCallouts(page)).toHaveCount(0);
  });

  test('arrow-key caret movement retires the hover callout', async ({ page, api }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    // Keyboard navigation moves the caret out from under the point the callout
    // was anchored against, so a callout still parked there sits over text the
    // user is now editing. Separate from the typing case: a dismissal wired to
    // document changes alone would leave this one covered.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(visibleCallouts(page)).toHaveCount(0);
  });

  test('the hover callout comes back when the pointer moves after a keyboard dismissal', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    // Caret-only navigation rather than typing: it retires the callout without
    // editing the document, so the block stays decorated and there is still a
    // callout to raise again. (Typing here would rewrite the trailing run that
    // produces the diagnostic in the first place.)
    await page.keyboard.press('ArrowRight');
    await expect(visibleCallouts(page)).toHaveCount(0);

    // Off the block and back on. `pointerover` fires on boundary crossings, not
    // on motion: two 4 px moves inside one block were measured to produce zero
    // events, so a nudge in place would leave this assertion passing on an
    // accident of hit-testing rather than on the re-arm actually working.
    await page.mouse.move(box.x + 20, 60);
    await page.mouse.move(box.x + 140, box.y + 6);
    // Hover-to-read must survive the dismissal: a callout that never returns
    // has traded the reported bug for the loss of the whole affordance. The
    // diagnostic text proves this is the real callout re-shown, not a stray
    // empty box left standing.
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    await expect(visibleCallouts(page).first()).toContainText('MD009');
  });

  // A 100x100 PNG, inline so the image resolves without a network fetch: a fake
  // src renders the not-found placeholder AND trips the console-error gate.
  const INLINE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAJ0lEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAOBrAB+wAAF7bJcRAAAAAElFTkSuQmCC';
  // Both textless shapes that get decorated, in one doc: the alt-less image
  // (MD045) and the second, differently-styled thematic break (MD035).
  const TEXTLESS_BODY = `# Title\n\nA paragraph of ordinary text.\n\n![](${INLINE_PNG})\n\nMore ordinary text.\n\n---\n\nEven more text.\n\n***\n\nEnd.\n`;

  /**
   * Max distance from the callout's bottom edge to the top of the block it
   * describes. `offset(6)` sets the intended gap; the allowance absorbs
   * `shift()` nudges and sub-pixel jitter while staying far below a callout
   * that has lost its anchor altogether — an anchor rect of all zeros parks it
   * at the viewport origin, measured 170.4 px from its block on this fixture
   * and further still on a scrolled document.
   */
  const MAX_ANCHOR_GAP_PX = 24;

  test('the hover callout on a textless block anchors to that block', async ({ page, api }) => {
    // A textless block has no text line for `coordsAtPos` to measure, so it
    // answers with a zero-height rect — the exact shape the line-box anchor
    // exists to replace. `flattenH` collapses a thematic break to its own top
    // edge, which still clears; an atom React node view (the image) has no laid
    // out position DOM at all and measures as (0,0,0,0), which anchors the
    // callout to the top-left of the window instead of to the block.
    await seed(api, testDocName, TEXTLESS_BODY);
    const atoms = page.locator('.ProseMirror:not(.composer-prosemirror) .ok-lint-block-atom');
    await expect(atoms.first()).toBeVisible({ timeout: 15_000 });
    const count = await atoms.count();
    // Without both shapes present the loop below would pass on the easy one.
    expect(count, 'expected both textless shapes to be decorated').toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const atom = atoms.nth(index);
      const box = await atom.boundingBox();
      expect(box, `textless lint block ${index} has no layout box`).not.toBeNull();
      const blockBox = box as NonNullable<typeof box>;

      // Off the block and back on: `pointerover` fires on boundary crossings,
      // so re-entry is what re-runs the anchor computation.
      await page.mouse.move(blockBox.x + 20, 60);
      await expect(visibleCallouts(page)).toHaveCount(0);
      await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
      await expect(visibleCallouts(page)).not.toHaveCount(0);
      await expect
        .poll(
          async () => {
            const { tooltip } = await readCalloutGeometry(page);
            return tooltip ? tooltip.top !== 0 || tooltip.left !== 0 : false;
          },
          { message: 'the hover callout never received a computed position' },
        )
        .toBe(true);

      const { tooltip } = await readCalloutGeometry(page);
      expect(tooltip, 'the hover callout vanished before it was measured').not.toBeNull();
      const callout = tooltip as EdgeRect;
      const gapPx = blockBox.y - callout.bottom;
      expect(
        gapPx,
        `hover callout sits ${gapPx.toFixed(2)}px above the block it describes — ` +
          `callout=${JSON.stringify(callout)} block=${JSON.stringify(blockBox)}`,
      ).toBeLessThanOrEqual(MAX_ANCHOR_GAP_PX);
      // The other side of the same invariant: a callout that has slid down over
      // the block is anchored no better than one that flew off the top.
      expect(
        gapPx,
        `hover callout overlaps the block it describes by ${(-gapPx).toFixed(2)}px — ` +
          `callout=${JSON.stringify(callout)} block=${JSON.stringify(blockBox)}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

/** Seed content via agent-write-md (replace mode). */
async function seed(api: ApiHelpers, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
}
