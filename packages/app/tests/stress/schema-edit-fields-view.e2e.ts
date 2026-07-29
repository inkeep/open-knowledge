/**
 * End-to-end coverage for the Settings "Edit" gesture on a frontmatter schema.
 *
 * The DOM tests (`SchemaConfigEditor.dom.test.tsx`,
 * `FrontmatterPluginSection.dom.test.tsx`) pin the two ENDS of the chain in
 * isolation — the Edit button records a Fields intent, and the editor claims an
 * intent that arrives while it is mounted. Neither reaches the assembly the bug
 * lived in, and the gap is not academic: an earlier attempt at this fix claimed
 * the intent from the `useState` initializer and passed every DOM test while
 * BOTH paths stayed broken in the running app. A render-phase claim survives
 * jsdom, where the component is rendered directly, and is lost here, where
 * `EditorArea` mounts it lazily under `Suspense` and the discarded render takes
 * the one-shot intent with it. Only an effect-phase claim works, and only this
 * file can tell the difference.
 *
 * The second, narrower trap these cover: Settings is a hash-routed OVERLAY, so
 * the editor area underneath keeps its active target, and `SchemaConfigEditor`
 * (keyed by asset path) does NOT remount when Edit targets the schema that is
 * already open — the mount-time claim never re-runs at all.
 *
 * Both tests drive the real Vite dev server with a real schema file and a real
 * `.ok/config.yml` mapping, and reach the schema editor ONLY by clicking the
 * real Edit button — never by navigating to the asset hash directly. That is
 * deliberate: the schema lives under `.ok/`, which is outside the default
 * content scope, so a cold load at `#/__asset__/.ok/...` does not resolve the
 * target. Going through Edit is both the gesture under test and the only
 * routing that reaches these files the way a user does. Together the two tests
 * cover the gesture's branches: the schema is already the open file (no
 * remount — the reported bug), and a different file is open (fresh mount).
 *
 * Settings itself is opened by assigning the hash rather than clicking a chrome
 * button. That is the app's own contract, not a shortcut: `use-settings-route`
 * treats the hash AS the route state and every entry point (Cmd-, the Electron
 * menu, the header button, the command palette) exists only to mutate it. A
 * same-document hash assignment is also precisely the overlay condition under
 * test — it leaves the editor beneath mounted, which a full page load would not.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const SCHEMA_PATH = '.ok/schemas/blog.schema.json';

/** The frontmatter plugin's own settings panel — where the schema rows live. */
const SETTINGS_FRONTMATTER_HASH = '#settings/plugin:frontmatter';

const SCHEMA_BYTES = `${JSON.stringify(
  {
    type: 'object',
    properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['title'],
  },
  null,
  2,
)}\n`;

const CONFIG_YML = [
  'contentRules:',
  '  frontmatter:',
  '    enabled: true',
  '    schemas:',
  `      - file: "${SCHEMA_PATH}"`,
  '        appliesTo: "**/*.md"',
  '',
].join('\n');

const schemaEditor = (page: Page) => page.locator('[data-schema-config-editor]');
// Toggle segments name themselves via aria-label ("Fields" / "Source") on a
// single-select ToggleGroup (role=radio), scoped to the schema editor so the
// doc-editor toggle can never be matched by accident.
const sourceSegment = (page: Page) =>
  schemaEditor(page).getByRole('radio', { name: 'Source', exact: true });
// The read-only source viewer, loaded branch only — `data-text-viewer` is
// stamped on every fetch state, so the state attribute disambiguates the
// mounted-with-bytes variant from the pending one.
const loadedSource = (page: Page) =>
  schemaEditor(page).locator('[data-text-viewer][data-text-viewer-state="loaded"]');
const fieldEditor = (page: Page) => page.getByTestId(`frontmatter-field-editor-${SCHEMA_PATH}`);
const settingsEditButton = (page: Page) =>
  page.getByTestId(`frontmatter-schema-edit-${SCHEMA_PATH}`);

/** Open Settings on the frontmatter panel without leaving the current document. */
async function openFrontmatterSettings(page: Page): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, SETTINGS_FRONTMATTER_HASH);
}

test.describe('schema Edit lands on the Fields view — running-app E2E (PRD-7650)', () => {
  test.beforeEach(({ workerServer }) => {
    mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(join(workerServer.contentDir, SCHEMA_PATH), SCHEMA_BYTES, 'utf-8');
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), CONFIG_YML, 'utf-8');
  });

  // A governing config left behind would change lint resolution for every
  // sibling stress file sharing this worker's content dir.
  test.afterEach(({ workerServer }) => {
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
    rmSync(join(workerServer.contentDir, SCHEMA_PATH), { force: true });
  });

  // The reported bug, in the reporters' own sequence: edit a schema, drop to
  // Source to read the raw JSON, then go back to Settings and hit Edit again.
  // That second Edit targets the schema that is ALREADY the open file, so the
  // editor beneath the overlay never remounts. Before the fix the pane stayed
  // on the read-only Source view and the ignored intent went on to hijack a
  // later open of the same file.
  test('Edit reaches the Fields view when the schema is already the open file', async ({
    page,
    api,
  }) => {
    const docName = `schema-reopen-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // First Edit mounts the schema editor fresh, on Fields.
    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();
    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });

    // The user drops to Source to inspect the raw JSON. This also persists
    // `source` as the view preference, so nothing but a claimed intent can put
    // the pane back on Fields.
    await sourceSegment(page).click();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(fieldEditor(page)).toHaveCount(0);

    // Second Edit — same file, still the active target, editor still mounted.
    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();

    // The gesture's whole point: the field editor is what the user lands on.
    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
    // Settings closed on the way — Edit is a navigation, not just a mode flip.
    await expect(settingsEditButton(page)).toHaveCount(0);
  });

  // The other branch: a different file is open, so the hash navigation mounts
  // the schema editor fresh and the intent is claimed at mount instead.
  test('Edit reaches the Fields view when a different file is open', async ({ page, api }) => {
    const docName = `schema-edit-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    // The schema editor is not mounted at all yet — this is the fresh-mount path.
    await expect(schemaEditor(page)).toHaveCount(0);

    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();

    await expect(schemaEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
  });
});
