/**
 * Playwright E2E for the unified validation surface: the Problems
 * panel's project scope renders lint AND broken-link findings from
 * `GET /api/audit` with per-row source tags, and the file tree tints + badges
 * problem rows inside the real `@pierre/trees` shadow root — the rung jsdom
 * structurally cannot cover (unsafeCSS paints only in a browser).
 *
 * Three freshness triggers are exercised against the live persistence pipeline,
 * the real rule-write endpoint, and the real Settings switches — each asserting
 * on an UNOPENED doc's row, because "correct without opening each file" is the
 * behavior at issue:
 *   - trigger 3: an agent write tints via the CC1 disk-ack relay, no audit;
 *   - trigger 4: enabling a plugin (markdownlint AND frontmatter) or toggling a
 *     rule off re-audits, so rows update without being reopened;
 *   - trigger 5: a doc whose problems predate the page load tints on open, with
 *     nothing in the session touched at all.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

// A hard tab trips markdownlint MD010 (warning under OK's tuned defaults).
const HARD_TAB_BODY = '# Heading\n\n\tindented with a hard tab\n';

/** Open the right-rail Problems tab. */
async function openProblemsTab(page: Page) {
  await page.locator('#tab-problems').click();
  await expect(
    page.locator('ul[aria-label="Problems"]').or(page.getByText('No problems found')),
  ).toBeVisible({ timeout: 5_000 });
}

/** Activate project scope and wait for the audit snapshot to land. */
async function openProjectScope(page: Page) {
  await page.getByTestId('panel-scope-project').click();
  await expect(page.getByTestId('problems-project-scope')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('problems-audit-summary')).not.toBeEmpty({ timeout: 15_000 });
}

/** The file tree's shadow row for a tree path, evaluated in the live shadow root. */
function treeRowHandle(page: Page, treePath: string) {
  return page.locator('file-tree-container').evaluateHandle((host, path) => {
    return (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot?.querySelector(
      `[data-type="item"][data-item-path="${path}"]`,
    );
  }, treePath);
}

const errors: LogEntry[] = [];
let openDocName = '';
let lintDocName = '';
let linkDocName = '';

test.beforeEach(async ({ page, api, workerServer }) => {
  // markdownlint is opt-in; enable it so the lint plane carries findings.
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

  const suffix = randomUUID().slice(0, 8);
  openDocName = `uv-open-${suffix}`;
  lintDocName = `uv-lint-${suffix}`;
  linkDocName = `uv-link-${suffix}`;
  await api.createPage(`${openDocName}.md`);
  await api.createPage(`${lintDocName}.md`);
  await api.createPage(`${linkDocName}.md`);
  await api.replaceDoc(lintDocName, HARD_TAB_BODY);
  await api.replaceDoc(linkDocName, `# Linker\n\nSee [[uv-ghost-${suffix}]].\n`);

  await page.goto(`/#/${openDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('unified Problems — project scope', () => {
  test('lint and dead-link findings render together, source-tagged', async ({ page }) => {
    await openProblemsTab(page);
    await openProjectScope(page);

    // Both seeded files group in the plane.
    await expect(page.getByText(`${lintDocName}.md`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${linkDocName}.md`)).toBeVisible();

    // Groups mount collapsed; open them to assert the row-level chips.
    await page.getByTestId('problems-audit-expand-toggle').click();

    // Rows name their producing validator, not a generic category.
    const tags = page.getByTestId('problems-source-tag');
    await expect(tags.filter({ hasText: 'markdownlint' }).first()).toBeVisible();
    await expect(tags.filter({ hasText: 'links' }).first()).toBeVisible();

    // The chip carries the producer, so the subline shows the bare rule code.
    await expect(page.getByText('dead-link').first()).toBeVisible();
    // `getByText` substring-matches by default, so asserting `dead-link` alone
    // also passes against the old `links/dead-link`. Pin the absence too.
    await expect(page.getByText('links/dead-link')).toHaveCount(0);
  });
});

test.describe('unified Problems — file-tree indicators', () => {
  test('a project audit tints problem rows in the live shadow root, clean rows stay bare', async ({
    page,
  }) => {
    await openProblemsTab(page);
    await openProjectScope(page);

    // The tint attribute lands on the real shadow-DOM rows. Broken links are
    // warnings by default (validation.links), like the lint findings.
    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${linkDocName}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 15_000 },
      )
      .toBe('warning');
    await expect
      .poll(async () => {
        const row = await treeRowHandle(page, `${lintDocName}.md`);
        return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
      })
      .toBe('warning');

    // Count badge is injected next to the label, and carries its own hover
    // explanation. Both halves of that need the real browser: the DOM test can
    // only read the stylesheet source, and jsdom never resolves hit-testing.
    const badge = await (await treeRowHandle(page, `${linkDocName}.md`)).evaluate((el) => {
      const node = el?.querySelector('[data-ok-problem-badge]');
      if (!node) return null;
      return {
        text: node.textContent,
        title: (node as HTMLElement).title,
        pointerEvents: getComputedStyle(node).pointerEvents,
      };
    });
    expect(badge?.text).toBe('1');
    // Not `none`: the cursor has to resolve on the badge, or it falls through
    // to the row and surfaces the row's full-path title instead.
    expect(badge?.pointerEvents).not.toBe('none');
    expect(badge?.title).toBe('1 warning in this file. Open the Problems panel for details.');

    // The unsafeCSS actually paints: a tinted row's label color differs from a
    // clean row's — the pixels jsdom cannot verify.
    const colors = await page.locator('file-tree-container').evaluate(
      (host, paths) => {
        const shadow = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        const colorOf = (path: string) => {
          const section = shadow?.querySelector(
            `[data-type="item"][data-item-path="${path}"] [data-item-section="content"]`,
          );
          return section ? getComputedStyle(section as Element).color : null;
        };
        return { problem: colorOf(paths[0] as string), clean: colorOf(paths[1] as string) };
      },
      [`${linkDocName}.md`, `${openDocName}.md`],
    );
    expect(colors.problem).not.toBeNull();
    expect(colors.clean).not.toBeNull();
    expect(colors.problem).not.toBe(colors.clean);
  });

  test('enabling the plugin from Settings lights up an UNOPENED doc row', async ({ page, api }) => {
    // The report's headline symptom: "you enable the plugin, nothing lights up."
    // Driven through the real Settings switch rather than an API call, because
    // the plugin toggle takes a DIFFERENT route to the freshness trigger than a
    // rule write does — it patches the project config doc and relies on the
    // server's CC1 lint-config broadcast after that doc persists, with no local
    // emitLintConfigChanged() of its own.
    const suffix = randomUUID().slice(0, 8);
    const enableDoc = `uv-enable-${suffix}`;
    await api.createPage(`${enableDoc}.md`);
    await api.replaceDoc(enableDoc, HARD_TAB_BODY);

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${enableDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    // The same deep link the Problems panel's "Enable plugins" pointer uses.
    await page.goto('/#settings/plugins-manage');
    await expect(page.getByTestId('settings-plugins-manage')).toBeVisible({ timeout: 10_000 });
    const toggle = page.getByTestId('settings-plugin-toggle-markdownlint');
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Off: the doc's only finding was MD010, so its row must go bare.
    await toggle.click();
    await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();

    // Back on — the reported scenario. The row must light up again with the doc
    // still never opened. Left ON so the file's config state matches beforeEach.
    await toggle.click();
    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');
  });

  test('enabling the frontmatter plugin lights up an UNOPENED doc with a schema violation', async ({
    page,
    api,
    workerServer,
  }) => {
    // The report's FIRST symptom names frontmatter specifically ("files with
    // frontmatter issues don't turn yellow until you click into them one at a
    // time"). markdownlint and frontmatter are separate plugins reaching the
    // audit plane by different validators, so covering one does not cover the
    // other.
    const suffix = randomUUID().slice(0, 8);
    const fmDoc = `uv-fm-${suffix}`;
    const schemaRel = join('.ok', 'schemas', `uv-fm-${suffix}.schema.json`);
    mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(
      join(workerServer.contentDir, schemaRel),
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['title'],
      }),
      'utf-8',
    );
    // The schema is mapped but the PLUGIN starts off, so nothing validates yet —
    // the state a user is in right before they flip the switch.
    writeFileSync(
      join(workerServer.contentDir, '.ok', 'config.yml'),
      [
        'contentRules:',
        '  markdownlint:',
        '    enabled: true',
        '  frontmatter:',
        '    enabled: false',
        '    schemas:',
        `      - file: ${schemaRel}`,
        `        appliesTo: '${fmDoc}'`,
        '        enabled: true',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Frontmatter present but missing the required `title`, and no hard tab, so
    // the ONLY possible finding is the frontmatter one.
    await api.createPage(`${fmDoc}.md`);
    await api.replaceDoc(fmDoc, '---\nsummary: no title here\n---\n\n# Body\n\nClean prose.\n');

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${fmDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    // Plugin off: the row is bare even though the doc violates the schema.
    await expect.poll(problemAttr, { timeout: 20_000 }).toBeNull();

    await page.goto('/#settings/plugins-manage');
    await expect(page.getByTestId('settings-plugins-manage')).toBeVisible({ timeout: 10_000 });
    const toggle = page.getByTestId('settings-plugin-toggle-frontmatter');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await toggle.click();

    // Enabling the plugin must light the row up with the doc never opened.
    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    // Leave the plugin off again: this test's config write lives in the project
    // config DOC, which outlives the per-test config.yml that beforeEach lays
    // down, so a sibling test could otherwise inherit frontmatter validation.
    // The schema mapping itself goes inert once the plugin is off (the audit
    // skips schema resolution and appliesTo checks entirely when disabled).
    await toggle.click();
    await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();
  });

  test('toggling a rule off clears an UNOPENED doc row, no Problems panel interaction', async ({
    page,
    api,
    baseURL,
    workerServer,
  }) => {
    // Freshness trigger 4, the whole reported symptom: validation state used to
    // stand until each file was reopened, so switching a rule off left its
    // sidebar tint and count in place. The doc here is never opened and the
    // Problems panel is never touched — a config change is the only freshness
    // path available.
    const suffix = randomUUID().slice(0, 8);
    const toggleDoc = `uv-toggle-${suffix}`;
    await api.createPage(`${toggleDoc}.md`);
    await api.replaceDoc(toggleDoc, HARD_TAB_BODY);

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${toggleDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    // Baseline via trigger 3 (disk-ack): MD010 is on, so the row tints.
    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    try {
      // The real rule-write endpoint the Settings rule browser posts to — it
      // lands on disk AND signals the CC1 lint-config channel, which is how a
      // window learns about a config change it did not make itself.
      const res = await fetch(`${baseURL}/api/lint/markdownlint-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruleId: 'MD010', value: false }),
      });
      expect(res.ok, 'rule write should succeed').toBe(true);

      // The hard tab is no longer a finding, so the row must go bare on its own.
      await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();
    } finally {
      // A governing native file applies wholesale, so leaving one behind (even
      // rule-less) would silence MD010 for every sibling test in this worker.
      // Discovery re-reads from disk per request, so removing the file restores
      // OK's tuned defaults for whatever runs next.
      rmSync(configPath, { force: true });
    }
  });

  test('a doc whose problems predate the page load tints on open, nothing touched', async ({
    page,
    api,
  }) => {
    // Freshness trigger 5. Triggers 2-4 all need something to HAPPEN in the
    // session, so a project configured in an earlier session used to show a bare
    // sidebar at every launch until the user opened files or ran the audit by
    // hand. Reloading is what makes the doc's problems predate the load: the
    // store is module state, so it starts empty again, and no disk-ack for this
    // doc will ever reach the new page.
    const suffix = randomUUID().slice(0, 8);
    // One doc per validator source: the on-open audit is the whole plane, not a
    // lint-only pass, so a dead link has to surface the same way a lint finding
    // does. `links` is the one source the counts plane tracks separately.
    const priorLintDoc = `uv-prior-lint-${suffix}`;
    const priorLinkDoc = `uv-prior-link-${suffix}`;
    await api.createPage(`${priorLintDoc}.md`);
    await api.createPage(`${priorLinkDoc}.md`);
    await api.replaceDoc(priorLintDoc, HARD_TAB_BODY);
    await api.replaceDoc(priorLinkDoc, `# Linker\n\nSee [[uv-prior-ghost-${suffix}]].\n`);

    await page.reload();
    await waitForProvider(page);

    // No file opened, no Problems panel, no config change, no write after load.
    const attrOf = async (treePath: string) => {
      const row = await treeRowHandle(page, treePath);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };
    await expect.poll(() => attrOf(`${priorLintDoc}.md`), { timeout: 30_000 }).toBe('warning');
    await expect.poll(() => attrOf(`${priorLinkDoc}.md`), { timeout: 30_000 }).toBe('warning');
  });

  test('an agent write to an unopened doc tints its row via disk-ack', async ({ page, api }) => {
    // Condition-based wait for the on-open audit (trigger 5) to land, so the tint
    // asserted below is attributable to the disk-ack path this test is about.
    // beforeEach seeds lintDocName BEFORE the page loads, so no disk-ack for it
    // ever reaches this page — its row going warning can only be the on-open
    // audit, which makes it a signal rather than a sleep.
    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${lintDocName}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 30_000 },
      )
      .toBe('warning');

    const suffix = randomUUID().slice(0, 8);
    const sleeperDoc = `uv-sleeper-${suffix}`;
    await api.createPage(`${sleeperDoc}.md`);

    // No Problems panel interaction at all — the only freshness path available
    // is the per-doc disk-ack re-validate.
    await api.replaceDoc(sleeperDoc, `# Sleeper\n\nSee [[uv-sleeper-ghost-${suffix}]].\n`);

    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${sleeperDoc}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        // Bounded by the persistence debounce + disk-ack + 500ms revalidate
        // debounce — generous ceiling, converges much earlier in practice.
        { timeout: 30_000 },
      )
      .toBe('warning');
  });
});
