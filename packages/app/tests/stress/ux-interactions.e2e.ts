/**
 * Layer C (Tier 2): Playwright UX integration tests.
 *
 * Critical UX flows that require a real browser: WYSIWYG↔Source sync,
 * round-trip toggle, and concurrent agent writes during editing.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * playwright.config.ts webServer on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

/** Get the current Y.Text content from the provider */
async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

function uniqueDocName(label: string): string {
  return `test-ux-${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a per-test doc, reset it on the server, open it, and wait for sync.
 * Returns the docName so tests can pass it to agent-write-md.
 */
async function openFreshDoc(api: ApiHelpers, page: Page, label: string): Promise<string> {
  const docName = uniqueDocName(label);
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  return docName;
}

// Editor mode toggle is a Radix ToggleGroup with type="single" — items render
// as role="radio" (not "button") and carry aria-label="Visual editor" / "Markdown source".
// These helpers centralize the selector so a future
// redesign only needs one update site.
const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

// --------------------------------------------------------------------------
// Dual-editor hit-testing.
//
// EditorActivityPool mounts BOTH SourceEditor and TiptapEditor concurrently
// so mode toggle stays CSS-only. The non-active editor wears `.ok-mode-hidden`
// (content-visibility:hidden + contain-intrinsic-size:8000px). The hidden
// editor must NOT intercept pointer events intended for the visible one.
//
// Bug class: prior to the fix, `.ok-mode-hidden` had no pointer-events
// override, and a grid-stacking wrapper placed both children in the same
// cell — so the hidden editor's wrapper sat above the visible one in
// source order (no z-index). Real pointer clicks anywhere in the editor
// region hit the hidden wrapper first; CM6 never received focus/keydown.
// `locator.click()` + `keyboard.insertText` bypassed this (the existing
// Source→WYSIWYG test above) because insertText dispatches `beforeinput`
// directly on the target element without going through pointer hit-testing.
// These tests exercise the real user path: `page.mouse.click(x, y)` at a
// coordinate inside the visible editor's bounding box + `keyboard.type`.
//
// Fix: `.ok-mode-hidden` sets `position:absolute; inset:0; pointer-events:none`
// in `globals.css`, and `EditorActivityPool` wraps the dual-editor pair in
// `position:relative` so the hidden editor goes out-of-flow instead of
// sizing a shared grid row to its 8000px intrinsic.
// --------------------------------------------------------------------------

test('source mode: real pointer click + keystrokes land in CodeMirror', async ({ page, api }) => {
  await openFreshDoc(api, page, 'source-hit-test');
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  // Real pointer hit-test: click at a pixel coordinate INSIDE the
  // `.cm-content` box specifically (not `.cm-editor`, which includes
  // gutters + scroller margins where a 20px inset may miss the
  // contenteditable region on an empty doc). Goes through the browser's
  // real z-order hit-testing, unlike `locator.click()`+`keyboard.insertText`
  // which target a specific element directly. If a hidden sibling wrapper
  // (e.g. `.ok-mode-hidden` without pointer-events:none) is stacked above
  // the visible editor, the click lands on the wrapper and `.cm-content`
  // never focuses.
  const cmContent = page.locator('.cm-content');
  const box = await cmContent.boundingBox();
  if (!box) throw new Error('.cm-content has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + 5);
  await expect(cmContent).toBeFocused();

  // `keyboard.type` — per-character keydown/keypress/keyup through the
  // real focus path. A short string avoids the parallel-CPU reorder race
  // documented in `Source→WYSIWYG` below (which uses `insertText` to
  // sidestep that race). For this test, per-character is load-bearing:
  // we want to exercise the full keydown → CM state.update path, not a
  // single synthetic beforeinput event.
  await page.keyboard.type('HITOK');
  await expect(page.locator('.cm-content')).toContainText('HITOK', { timeout: 5_000 });
});

test('visual mode: real pointer click + keystrokes land in ProseMirror', async ({ page, api }) => {
  await openFreshDoc(api, page, 'visual-hit-test');
  // `openFreshDoc` leaves the page in visual mode; re-assert for clarity.
  await expect(visualToggle(page)).toBeChecked();

  const pm = page.locator('.ProseMirror:not(.composer-prosemirror)');
  const box = await pm.boundingBox();
  if (!box) throw new Error('ProseMirror has no bounding box');
  // Click well inside the PM content region (center-x, a bit inside top).
  // Small fresh docs have minimal content; clicking the horizontal center
  // with a modest y-inset lands inside the first writable paragraph.
  await page.mouse.click(box.x + box.width / 2, box.y + 30);
  await expect(pm).toBeFocused();

  await page.keyboard.type('HITPM');
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText('HITPM', {
    timeout: 5_000,
  });
});

test('hidden-editor wrapper does not intercept pointer events (both modes)', async ({
  page,
  api,
}) => {
  await openFreshDoc(api, page, 'hidden-wrapper-invariant');

  // Visual mode: the source editor's wrapper carries `.ok-mode-hidden`.
  // Invariant: computed `pointer-events: none` — otherwise a real click
  // anywhere the hidden wrapper overlaps the visible editor would be
  // intercepted. `position: absolute` is the out-of-flow complement; it
  // keeps the hidden wrapper from sizing a shared parent row (the prior
  // bug stretched the visible editor to 8000px via grid-row intrinsic).
  const hiddenInVisual = page.locator('.ok-mode-hidden').first();
  await expect(hiddenInVisual).toHaveCSS('pointer-events', 'none');
  await expect(hiddenInVisual).toHaveCSS('position', 'absolute');

  // Source mode: role flips — the visual editor's wrapper now carries
  // `.ok-mode-hidden`. Invariant holds symmetrically.
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-editor');
  const hiddenInSource = page.locator('.ok-mode-hidden').first();
  await expect(hiddenInSource).toHaveCSS('pointer-events', 'none');
  await expect(hiddenInSource).toHaveCSS('position', 'absolute');
});

test('table cell-handle layer does not shift document content', async ({ page, api }) => {
  // Regression: `.ok-table-cell-handle-layer` mounts as a direct grid child of
  // `.tiptap-editor` when the cursor enters a table cell. Without explicit
  // `grid-row: 1` pinning (globals.css), the layer generated its own in-flow
  // auto row, and grid's default `align-content: stretch` handed that empty
  // row an equal share of the container's leftover height — a blank band above
  // the document the moment a cell was focused.
  const docName = await openFreshDoc(api, page, 'table-handle-layer');
  await api.replaceDoc(docName, '# Table layer\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nshort body\n');
  const heading = page.locator('.ProseMirror h1');
  await expect(heading).toHaveText('Table layer');
  const before = await heading.boundingBox();
  if (!before) throw new Error('heading has no bounding box');

  await page.locator('.ProseMirror table td').first().click();
  const layer = page.locator('.ok-table-cell-handle-layer');
  await expect(layer).toBeAttached();
  // Handles paint (focus-within) and are usable…
  await expect(page.locator('[data-testid="table-cell-handle"]:visible')).toHaveCount(2);
  // …but the layer occupies no flow space: nothing moved.
  const after = await heading.boundingBox();
  if (!after) throw new Error('heading has no bounding box after focus');
  expect(after.y).toBe(before.y);
});

test('WYSIWYG→Source: typing in ProseMirror appears in CodeMirror', async ({ page, api }) => {
  await openFreshDoc(api, page, 'wysiwyg-to-source');
  // Insert text in WYSIWYG mode. Two invariants:
  //   1. `.click()` + `toBeFocused()` before any keyboard call — `.focus()`
  //      does not await focus-transfer in Chromium, and events dispatched
  //      before focus lands go to the prior active element.
  //   2. `keyboard.insertText` (atomic single `beforeinput`/`input` event)
  //      instead of `keyboard.type` (per-character keydown/keypress/keyup).
  //      Under full-suite parallel CPU contention, per-character dispatch
  //      can reorder at CM6/PM's async input pipeline — characters can land
  //      out of order in the editor's internal buffer. `insertText` bypasses
  //      the per-character race entirely. See precedent §20(i).
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeFocused();
  await page.keyboard.insertText('Hello from WYSIWYG');

  // Wait for Observer A to sync to Y.Text
  await page.waitForFunction(
    () =>
      window.__activeProvider?.document
        ?.getText('source')
        ?.toString()
        ?.includes('Hello from WYSIWYG'),
    null,
    { timeout: 10_000 },
  );

  // Switch to Source mode
  await sourceToggle(page).click();

  // Verify CodeMirror shows the typed content
  const cmContent = await page.locator('.cm-content').textContent();
  expect(cmContent).toContain('Hello from WYSIWYG');
});

test('Source→WYSIWYG: typing in CodeMirror renders in ProseMirror', async ({ page, api }) => {
  await openFreshDoc(api, page, 'source-to-wysiwyg');
  // Switch to Source mode
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  // Insert markdown in CodeMirror. See the comment at the first test's
  // keyboard block — same two invariants apply: `.click()+toBeFocused()`
  // for focus, `keyboard.insertText` for atomic input. The keystroke-reorder
  // race this avoids captured CodeMirror rendering `#\n\nource Heading\n\nParagraph
  // from source.\nS\n` when `keyboard.type` was used — the `S` character
  // reordered past the rest of the string. `insertText` dispatches one
  // `beforeinput` event with the full payload, making the race
  // structurally impossible.
  await page.locator('.cm-content').click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.insertText('# Source Heading\n\nParagraph from source.');

  // Wait for Y.Text to have the content
  await page.waitForFunction(
    () =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes('Source Heading'),
    null,
    { timeout: 10_000 },
  );

  // Switch back to WYSIWYG
  await visualToggle(page).click();

  // Wait for ProseMirror to render the FULL synced content. Checking only
  // for 'Source Heading' is too permissive: y-prosemirror applies XmlFragment
  // → PM mutations incrementally over ~50-100ms under CPU contention, so PM
  // transiently shows a partial render like "Source HeadingParagraph fro"
  // where the heading substring is already present but the paragraph is
  // truncated mid-word. The wait condition must match every substring the
  // subsequent assertion will read — otherwise waitForFunction resolves on
  // the partial state and the `textContent()` read below catches PM
  // mid-render. Mirrors the round-trip test's pattern.
  await page.waitForFunction(
    () => {
      const content =
        document.querySelector('.ProseMirror:not(.composer-prosemirror)')?.textContent ?? '';
      return content.includes('Source Heading') && content.includes('Paragraph from source');
    },
    null,
    { timeout: 10_000 },
  );

  // Verify ProseMirror renders the content
  const pmContent = await page.locator('.ProseMirror:not(.composer-prosemirror)').textContent();
  expect(pmContent).toContain('Source Heading');
  expect(pmContent).toContain('Paragraph from source');
});

test('round-trip: edits in both modes survive toggle cycle', async ({ page, api }) => {
  await openFreshDoc(api, page, 'round-trip');
  // Insert in WYSIWYG — `.click()+toBeFocused()` + `insertText` per the
  // comment block at the first test in this file.
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeFocused();
  await page.keyboard.insertText('WYSIWYG edit');

  // Wait for sync
  await page.waitForFunction(
    () =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes('WYSIWYG edit'),
    null,
    { timeout: 10_000 },
  );

  // Switch to Source, insert there
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');
  await page.locator('.cm-content').click();
  await expect(page.locator('.cm-content')).toBeFocused();
  // Move to end before inserting. Bare `End` is end-of-line cross-platform
  // (no modifier required); single-line content makes it equivalent to
  // end-of-document here.
  await page.keyboard.press('End');
  await page.keyboard.insertText('\n\nSource edit');

  // Wait for Y.Text to have both edits
  await page.waitForFunction(
    () => {
      const txt = window.__activeProvider?.document?.getText('source')?.toString();
      return txt?.includes('WYSIWYG edit') && txt?.includes('Source edit');
    },
    null,
    { timeout: 10_000 },
  );

  // Switch back to WYSIWYG
  await visualToggle(page).click();

  // Wait for ProseMirror to render both edits
  await page.waitForFunction(
    () => {
      const content =
        document.querySelector('.ProseMirror:not(.composer-prosemirror)')?.textContent ?? '';
      return content.includes('WYSIWYG edit') && content.includes('Source edit');
    },
    null,
    { timeout: 10_000 },
  );

  // Both edits should be present
  const pmContent = await page.locator('.ProseMirror:not(.composer-prosemirror)').textContent();
  expect(pmContent).toContain('WYSIWYG edit');
  expect(pmContent).toContain('Source edit');
});

test('concurrent agent write: user + agent content coexist', async ({ page, api, baseURL }) => {
  const docName = await openFreshDoc(api, page, 'concurrent-agent');
  // Insert in WYSIWYG — `.click()+toBeFocused()` + `insertText` per the
  // comment block at the first test in this file.
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeFocused();
  await page.keyboard.insertText('User typing');

  // Wait for user content to sync
  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('User typing'),
    null,
    { timeout: 10_000 },
  );

  // Agent writes via API while user is editing. Uses default `position: append`
  // (omitted) to stack on top of the user's typing — the whole point of this
  // test is coexistence, not replace.
  const res = await fetch(`${baseURL}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown: '## Agent Section\n\nAgent content here.' }),
  });
  expect(res.ok).toBe(true);

  // Wait for agent content to propagate
  await page.waitForFunction(
    () =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes('Agent Section'),
    null,
    { timeout: 10_000 },
  );

  // Switch to Source to see both
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  const sourceContent = await getYText(page);
  expect(sourceContent).toContain('User typing');
  expect(sourceContent).toContain('Agent Section');
  expect(sourceContent).toContain('Agent content here');
});

test('sidebar folder: row click navigates to folder overview; treeitem toggles expand/collapse', async ({
  api,
  page,
  workerServer,
}) => {
  // Contract: the folder treeitem navigates to the folder's resolved target
  // (#/<folderPath>) on click, and exposes the `aria-expanded` disclosure
  // affordance for keyboard expand/collapse.
  //
  // Ancestor-priority UX: while a doc inside sidebar-folder is active, the
  // folder is unconditionally expanded — collapsing the treeitem is a no-op
  // for the derived state because `ancestors` takes
  // priority over `userCollapsed`. The test exercises the toggle BEFORE
  // navigating into the folder (where toggle IS honored) and asserts the
  // ancestor-priority behavior after navigation. See reveal-on-activate.e2e.ts
  // for Model A semantics coverage.
  //
  // Recreate the shared sidebar-folder fixture in case an earlier test in
  // this worker deleted it while exercising bulk delete.
  const folderResponse = await fetch(`${workerServer.baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'sidebar-folder' }),
  });
  if (!folderResponse.ok && folderResponse.status !== 409) {
    throw new Error(`create-folder failed for sidebar-folder: ${folderResponse.status}`);
  }
  await api.createPage('sidebar-folder/nested-doc.md');

  await page.goto('/');
  const folderRow = page.getByRole('treeitem', { name: 'sidebar-folder', exact: true });
  const nestedFile = page.getByRole('treeitem', { name: 'nested-doc.md', exact: true });

  // Starts collapsed — treeitem reflects state, nested child not visible.
  await expect(folderRow).toBeVisible();
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedFile).toHaveCount(0);

  // Keyboard disclosure toggles expand/collapse when folder is NOT an
  // active-doc ancestor (pre-nav state).
  await folderRow.focus();
  await folderRow.press('ArrowRight');
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedFile).toBeVisible();

  // Pre-nav toggle: clicking collapse BEFORE navigating into the folder IS
  // honored (not an active-doc ancestor yet).
  await folderRow.press('ArrowLeft');
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedFile).toHaveCount(0);

  // Re-expand so we can navigate to the nested doc.
  await folderRow.press('ArrowRight');
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedFile).toBeVisible();

  // Nested file click navigates to the doc — the folder becomes an ancestor.
  await nestedFile.click();
  await expect(page).toHaveURL(/#\/sidebar-folder\/nested-doc$/);

  // Ancestor priority: collapsing the treeitem does NOT hide the folder
  // because it's an active-doc ancestor. aria-expanded stays true;
  // nested-doc.md stays visible.
  await folderRow.focus();
  await folderRow.press('ArrowLeft');
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedFile).toBeVisible();

  // Row click navigates to the folder's resolved target. Folder routes keep a
  // trailing slash so a folder and same-basename document remain distinct.
  await folderRow.click();
  await expect(page).toHaveURL(/#\/sidebar-folder\/$/);
});

test('markdown link edit dialog preserves page mode while clearing and updates the href target', async ({
  page,
  api,
}) => {
  const docName = uniqueDocName('link-edit');
  const suggestionTarget = uniqueDocName('link-edit-target');
  const doc = '[Beta page](beta.md)';

  await api.seedDocs([
    { name: docName, markdown: doc },
    { name: suggestionTarget, markdown: '# Target\n' },
  ]);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  await page.waitForFunction(
    () =>
      window.__activeProvider?.document
        ?.getText('source')
        ?.toString()
        ?.includes('[Beta page](beta.md)'),
    null,
    { timeout: 10_000 },
  );

  // V2: chips render as plain DOM via renderHTML. The link mark gets
  // a `data-link` attr; the link-resolution decoration plugin adds
  // `data-resolution-state`; the mark-identity decoration plugin adds
  // `data-mark-id`. There is no longer a `data-internal-link` /
  // `data-doc-name` attribute on the chip itself — those lived on the
  // pre-V2 React MarkView. Resolution state is checked via the decoration
  // attribute instead.
  const chip = page.locator('span[data-link]').first();
  await expect(chip).toBeVisible({ timeout: 10_000 });

  // Hover semantics (post-redesign): clicking a chip navigates; hover (or
  // keyboard focus) opens the singleton PropPanel. The PropPanel exposes
  // Open / Edit / Remove (and Create-page when unresolved) as plain buttons.
  // 300 ms HOVER_OPEN_DELAY before the panel appears (see interaction-layer.tsx).
  await chip.hover();
  const propPanel = page.locator('[data-ok-prop-panel="internal-link"]');
  await expect(propPanel).toBeVisible({ timeout: 5_000 });

  // The "Edit" button in the PropPanel opens the EditMarkdownLinkDialog.
  await propPanel.getByRole('button', { name: 'Edit' }).click();

  const pageLabel = page.locator('label').filter({ hasText: 'Page' }).first();
  const sectionLabel = page.locator('label').filter({ hasText: 'Section' }).first();
  const targetInput = page
    .locator('input[placeholder="guides/install or https://example.com"]')
    .first();
  await expect(pageLabel).toBeVisible();
  await expect(sectionLabel).toBeVisible();

  await targetInput.fill('');
  await expect(pageLabel).toBeVisible();
  await expect(sectionLabel).toBeVisible();

  await targetInput.fill(`/${suggestionTarget}`);
  const suggestion = page.getByRole('option', { name: `/${suggestionTarget} Page` });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(page.getByRole('dialog', { name: 'Edit markdown link' })).toBeVisible();
  await expect(targetInput).toHaveValue(suggestionTarget);

  await page.getByRole('button', { name: 'Save' }).click();

  // Verify the underlying markdown was updated. V2 does NOT mirror the doc
  // name into a chip attribute (data-doc-name is gone) — the source-of-truth
  // is the Y.Text + the link mark's href attr.
  await page.waitForFunction(
    (target) =>
      window.__activeProvider?.document
        ?.getText('source')
        ?.toString()
        ?.includes(`[Beta page](./${target}.md)`),
    suggestionTarget,
    { timeout: 10_000 },
  );
});

// --------------------------------------------------------------------------
// Regression guard for navigate-to-anchor-on-click, open-edit-panel-on-hover.
// Pins that bare-click on a chip navigates
// rather than opening the popover. Three flavors:
//   - in-page anchor → window.location.hash carries the anchor fragment
//   - same-tab doc link → window.location.hash routes to the target doc
//   - external link → window.open fires (caught via context 'page' event)
// Hover-opens-panel is already covered above; this suite
// guards the complementary "click navigates" path.
// --------------------------------------------------------------------------

test('LINK-CLICK-ANCHOR: bare click on in-page anchor chip updates location hash to anchor', async ({
  page,
  api,
}) => {
  const docName = await openFreshDoc(api, page, 'link-click-anchor');
  await api.replaceDoc(
    docName,
    `# Top\n\n[Jump to section](#deep-section) below.\n\n## Deep Section\n\nTarget body.\n`,
  );
  await page.waitForFunction(
    (name) =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes(name) ?? false,
    'deep-section',
    { timeout: 10_000 },
  );

  const chip = page.locator('span[data-link]').first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();

  // Anchor jumps route through `window.location.assign(toInternalHashHref(...))`,
  // which serializes the anchor as a fragment on the doc hash.
  await page.waitForFunction(() => window.location.hash.includes('deep-section'), null, {
    timeout: 5_000,
  });

  // Panel did NOT open as a side-effect of the click (it opens only on hover).
  await expect(page.locator('[data-ok-prop-panel="internal-link"]')).not.toBeVisible();
});

test('LINK-CLICK-DOC-SAME-TAB: bare click on resolved doc link routes hash to the target doc', async ({
  page,
  api,
}) => {
  // Seed BOTH docs up front (target + source-with-link) then navigate, so the
  // page-list cache fetched at PageListProvider mount already contains the
  // target. A doc link is only resolved when its target is in the cache;
  // unresolved targets fall through to opening the panel instead of
  // navigating — a different branch entirely. (Anchor/external links resolve
  // without the cache, which is why those sibling tests can use openFreshDoc.)
  const targetDoc = `beta-${randomUUID().slice(0, 8)}`;
  const sourceDoc = `src-doc-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([
    { name: targetDoc, markdown: '# Beta\n\nBeta body.\n' },
    { name: sourceDoc, markdown: `# Source\n\n[Beta page](${targetDoc}.md) link.\n` },
  ]);
  await page.goto(`/#/${sourceDoc}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  // Wait for the resolution decoration to mark the chip resolved — proves the
  // page-list cache knows about the target, so `handlePrimary`'s `case 'doc'`
  // branch navigates (resolveLinkTargetIntent → toInternalHashHref) instead of
  // returning false. The decoration writes `data-resolution-state` onto an
  // INNER span nested inside the `span[data-link]` chip (ProseMirror
  // Decoration.inline wraps the marked range separately), so the two attrs
  // live on different elements — gate on the inner span, click the chip.
  await expect(page.locator('[data-resolution-state="resolved"]').first()).toBeVisible({
    timeout: 10_000,
  });
  const chip = page.locator('span[data-link]').first();
  await chip.click();

  await page.waitForFunction((name) => window.location.hash.includes(name), targetDoc, {
    timeout: 5_000,
  });

  // Panel did NOT open as a side-effect of the click (it opens only on hover).
  await expect(page.locator('[data-ok-prop-panel="internal-link"]')).not.toBeVisible();
});

test('LINK-CLICK-EXTERNAL: bare click on external link opens new tab via window.open', async ({
  page,
  api,
  context,
}) => {
  const docName = await openFreshDoc(api, page, 'link-click-external');
  await api.replaceDoc(docName, `# Doc\n\n[Example](https://example.com) link.\n`);
  await page.waitForFunction(
    () =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes('example.com') ??
      false,
    null,
    { timeout: 10_000 },
  );

  const chip = page.locator('span[data-link]').first();
  await expect(chip).toBeVisible({ timeout: 10_000 });

  // example.com is a live external site the CI sandbox may not reach, which made
  // this test flaky: the new tab's `page` event timing out, or the tab loading a
  // `chrome-error://` page instead of example.com. Stub the navigation so the test
  // verifies the product behavior (external link opens a new tab at the right URL)
  // deterministically and offline.
  await context.route(
    (url) => url.hostname === 'example.com',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>example.com stub</title>',
      }),
  );

  const pagePromise = context.waitForEvent('page', { timeout: 15_000 });
  await chip.click();
  const opened = await pagePromise;
  expect(opened.url()).toContain('example.com');
  await opened.close();
});

test('LINK-CLICK-WIKI: bare click on resolved wiki-link routes hash to the target doc', async ({
  page,
  api,
}) => {
  // Parallel to LINK-CLICK-DOC-SAME-TAB but for the wiki-link NodeView path
  // (wiki-link.ts handlePrimary `case 'doc'`). Seed both docs up front then
  // navigate so the page-list cache resolves the target at mount — unresolved
  // targets fall through to the popover instead of navigating.
  const targetDoc = `wikitarget-${randomUUID().slice(0, 8)}`;
  const sourceDoc = `src-wiki-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([
    { name: targetDoc, markdown: '# Wiki Target\n\nBody.\n' },
    { name: sourceDoc, markdown: `# Source\n\nSee [[${targetDoc}]] for details.\n` },
  ]);
  await page.goto(`/#/${sourceDoc}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  // Wiki-link chips carry no `data-resolution-state` attribute (that's
  // internal-link-only), so we gate on the panel's resolved aria-label
  // instead: hover until the WikiLinkPropPanel's aria-label reads
  // "Wiki link: …" (resolved) rather than "Page not found: …". The state
  // label is only exposed via aria-label for resolved links (the visible
  // chrome is just the icon + target text), so a text query won't see it.
  // A resolved label proves the page-list cache knows the target and
  // `handlePrimary` will navigate rather than fall through.
  const chip = page.locator('[data-wiki-link]').first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.hover();
  await expect(
    page.locator('[data-ok-prop-panel="wiki-link"][aria-label^="Wiki link:"]'),
  ).toBeVisible({ timeout: 10_000 });

  await chip.click();
  await page.waitForFunction((name) => window.location.hash.includes(name), targetDoc, {
    timeout: 5_000,
  });

  // The panel was open from the hover gate above; navigation must close it
  // (onMouseActivate → setActiveNode(null) after a handled bare click).
  await expect(page.locator('[data-ok-prop-panel="wiki-link"]')).not.toBeVisible({
    timeout: 2_000,
  });
});
