/**
 * E2E coverage for the Timeline inline-diff side-pane.
 *
 * Each test creates its own uniquely-named doc via the `api` fixture —
 * STOP rule: never hardcode 'test-doc'; workers share a dev-server instance
 * and parallel tests would corrupt shared CRDT state.
 *
 * **Test infrastructure dependency.** These tests require the worker's
 * Hocuspocus instance to have a working shadow-repo so `/api/history`
 * returns Timeline entries. The per-worker fixture in `_helpers/fixtures.ts`
 * satisfies this by spawning the dev server with `OK_TEST_GIT_ENABLED=1`,
 * which opts the isolated `contentDir` into shadow-repo mode (git-init +
 * `gitEnabled: true` in `createServer`). `/api/save-version` and
 * `/api/history` work correctly in the worker environment.
 *
 * Reference patterns:
 *   - agent-activity-panel.e2e.ts  (per-test seeding + writeAsAgent)
 *   - outline-navigation.e2e.ts    (DocPanel tab panel selectors)
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

function uid() {
  return `tl-${randomUUID().slice(0, 8)}`;
}

const AGENT = {
  agentId: `agent-${randomUUID().slice(0, 8)}`,
  agentName: 'Claude',
  clientName: 'claude' as const,
};

// ── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Best-effort `/api/save-version` call. The checkpoint it writes is NOT shown
 * in the Timeline (the panel filters checkpoint rows — they're cleanup-job
 * artifacts now). We still call it between writes because save-version resets
 * the per-writer WIP refs, so each subsequent write lands as its own distinct
 * WIP commit — and those WIP rows ARE what the Timeline surfaces. Network
 * errors and 400 (no shadow repo in the test fixture) are silently dropped;
 * any other unexpected HTTP status throws so failures don't disappear.
 */
async function saveVersion(baseURL: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseURL}/api/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: AGENT.agentId,
        agentName: AGENT.agentName,
        clientName: AGENT.clientName,
      }),
    });
  } catch {
    return; // network error — best-effort
  }
  if (!res.ok && res.status !== 400) {
    throw new Error(`save-version unexpected HTTP ${res.status}`);
  }
}

/**
 * Seed a doc with N versions. Each version lands as a distinct WIP commit
 * (the save-version call between writes resets the WIP refs so they don't
 * coalesce). The Timeline surfaces those WIP rows as a flat list; the
 * checkpoints save-version produces are filtered out of the panel.
 */
async function seedTimelineDoc(
  api: ApiHelpers,
  baseURL: string,
  docName: string,
  versions: string[],
): Promise<void> {
  if (versions.length === 0) throw new Error('seedTimelineDoc: versions must be non-empty');
  const [first, ...rest] = versions;
  await api.seedDocs([{ name: docName, markdown: first }]);
  await saveVersion(baseURL);
  for (const v of rest) {
    await api.writeAsAgent(docName, v, AGENT);
    await saveVersion(baseURL);
  }
}

async function navigateToDoc(page: Page, docName: string) {
  await page.goto(`/#/${docName}`);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeVisible({
    timeout: 15_000,
  });
}

/** Click the Timeline tab in DocPanel and wait for the loading skeleton to settle. */
async function openTimelineTab(page: Page) {
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.locator('#panel-timeline')).toBeVisible();
  await expect(page.locator('[aria-label="Loading timeline history"]')).toBeHidden({
    timeout: 15_000,
  });
}

/** All EntryRow expand-zone buttons (div[role="button"]) in the Timeline panel. */
function expandButtons(page: Page) {
  return page.locator('[data-testid="timeline-entry-expand"]');
}

/** All open diff content panels (present in DOM only while a row is expanded). */
function diffPanels(page: Page) {
  return page.locator('[data-testid="timeline-entry-diff"]');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Timeline inline diff — side pane', () => {
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D1: click entry expands inline diff; click again collapses; main editor untouched', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, [
      '# v1\n\nInitial content.',
      '# v2\n\nSecond version.',
    ]);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });
    const row = expandButtons(page).first();

    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(diffPanels(page)).toHaveCount(0);

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(diffPanels(page)).toHaveCount(1);

    // Main editor is still visible — no hijack
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeVisible();

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(diffPanels(page)).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D2: multiple entries can be open simultaneously (multi-expand)', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, [
      '# v1\n\nInitial.',
      '# v2\n\nVersion 2.',
      '# v3\n\nVersion 3.',
    ]);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).nth(2)).toBeVisible({ timeout: 15_000 });

    await expandButtons(page).nth(0).click();
    await expandButtons(page).nth(1).click();
    await expandButtons(page).nth(2).click();

    await expect(expandButtons(page).nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(expandButtons(page).nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(expandButtons(page).nth(2)).toHaveAttribute('aria-expanded', 'true');
    await expect(diffPanels(page)).toHaveCount(3);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D3: second expand of same entry uses cache — no second GET /api/history/{sha}', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1\n\nInitial.', '# v2\n\nSecond version.']);

    let historyShaCalls = 0;
    page.on('request', (req) => {
      if (/\/api\/history\/\w+/.test(req.url())) historyShaCalls++;
    });

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });
    const row = expandButtons(page).first();

    // First expand — triggers the SHA fetch
    await row.click();
    await page.waitForResponse(/\/api\/history\/\w+/, { timeout: 10_000 });
    await expect(page.getByText('Loading diff…')).toBeHidden({ timeout: 10_000 });
    expect(historyShaCalls).toBe(1);

    await row.click();
    await expect(diffPanels(page)).toHaveCount(0);

    // Re-expand — cache hit, no new request
    await row.click();
    await expect(diffPanels(page)).toHaveCount(1);
    await expect(page.getByText('Loading diff…')).toBeHidden({ timeout: 5_000 });
    expect(historyShaCalls).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D5: Restore icon (aria-label + tooltip) is visible on every row — collapsed and expanded', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2', '# v3']);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).nth(2)).toBeVisible({ timeout: 15_000 });

    const rowCount = await expandButtons(page).count();
    const restoreButtons = page.locator('[data-testid="timeline-entry-restore"]');

    await expect(restoreButtons).toHaveCount(rowCount);
    for (let i = 0; i < rowCount; i++) {
      // Every row is an actor/system commit now, so the affordance reads
      // "Restore to this point". Assert it starts with "Restore" so the test
      // survives copy refinement without false negatives.
      const label = await restoreButtons.nth(i).getAttribute('aria-label');
      expect(label).toMatch(/^Restore/);
    }

    // After expanding row 0, all Restore buttons remain (no count change)
    await expandButtons(page).first().click();
    await expect(restoreButtons).toHaveCount(rowCount);
    await expect(restoreButtons.first()).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D6: Restore icon click does NOT expand the row (stopPropagation)', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2']);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });
    const row = expandButtons(page).first();

    await expect(row).toHaveAttribute('aria-expanded', 'false');

    await page.locator('[data-testid="timeline-entry-restore"]').first().click();

    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(diffPanels(page)).toHaveCount(0);

    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D7: Dialog confirm fires POST /api/rollback with correct body; dialog closes on success', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1\n\nInitial.', '# v2\n\nUpdated.']);

    let capturedBody: Record<string, unknown> | null = null;
    await page.route('/api/rollback', async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="timeline-entry-restore"]').first().click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);

    await expect(dialog.getByTestId('timeline-entry-restore-confirm')).toBeVisible();
    await expect(dialog.getByTestId('timeline-entry-restore-cancel')).toBeVisible();

    await dialog.getByTestId('timeline-entry-restore-confirm').click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
      expect(capturedBody?.docName).toBe(doc);
      expect(typeof capturedBody?.commitSha).toBe('string');
      expect((capturedBody?.commitSha as string).length).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    await expect(dialog).toBeHidden();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D8: split/unified toggle in EditorHeader re-renders expanded diff layout', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, [
      '# v1\n\nInitial content here.',
      '# v2\n\nUpdated content here.',
    ]);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    await expandButtons(page).first().click();
    await expect(diffPanels(page)).toHaveCount(1);
    await expect(page.getByText('Loading diff…')).toBeHidden({ timeout: 10_000 });

    const layoutGroup = page.getByRole('group', { name: 'Diff layout' });
    await expect(layoutGroup).toBeVisible();

    // The diff renderer (react-diff-view) emits a single root <table> with
    // class `diff diff-{viewType}` — we assert against the rendered structure
    // so a future regression that drops the prop chain (e.g. hardcoding
    // `viewType="unified"` on ActivityPanelDiffView) fails this test.
    const diffRoot = diffPanels(page).first().locator('table.diff').first();

    await layoutGroup.getByRole('button', { name: 'Split diff' }).click();
    await expect(layoutGroup.getByRole('button', { name: 'Split diff' })).toHaveAttribute(
      'data-state',
      'on',
    );
    await expect(diffRoot).toHaveClass(/diff-split/);

    await expect(diffPanels(page)).toHaveCount(1);

    await layoutGroup.getByRole('button', { name: 'Unified diff' }).click();
    await expect(layoutGroup.getByRole('button', { name: 'Unified diff' })).toHaveAttribute(
      'data-state',
      'on',
    );
    await expect(diffRoot).toHaveClass(/diff-unified/);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D9: navigating to a different doc resets per-entry expanded state', async ({
    page,
    api,
    baseURL,
  }) => {
    const docA = uid();
    const docB = uid();

    await seedTimelineDoc(api, baseURL ?? '', docA, ['# Doc A v1', '# Doc A v2']);

    // Seed docB without resetting the workspace (use createPage + replaceDoc + saveVersion).
    await api.createPage(`${docB}.md`);
    await api.replaceDoc(docB, '# Doc B v1');
    await saveVersion(baseURL ?? '');
    await api.writeAsAgent(docB, '# Doc B v2', AGENT);
    await saveVersion(baseURL ?? '');

    await navigateToDoc(page, docA);
    await openTimelineTab(page);
    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });
    await expandButtons(page).first().click();
    await expect(diffPanels(page)).toHaveCount(1);

    // Navigate to docB — Timeline tab stays active (activeTab state lives in EditorPane)
    await page.goto(`/#/${docB}`);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[aria-label="Loading timeline history"]')).toBeHidden({
      timeout: 15_000,
    });
    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    // No diff panels — docB's entries are all collapsed (per-row expanded state reset)
    await expect(diffPanels(page)).toHaveCount(0);
    const count = await expandButtons(page).count();
    for (let i = 0; i < count; i++) {
      await expect(expandButtons(page).nth(i)).toHaveAttribute('aria-expanded', 'false');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D10: main editor is never replaced; no sticky "Viewing:" bar appears', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2']);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeVisible();

    await expandButtons(page).first().click();
    await page.locator('[data-testid="timeline-entry-restore"]').first().click();

    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toBeVisible();
    await expect(page.getByText(/^Viewing:/)).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('AC-D11: expanded entry has no Close button; only the Restore icon action button', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2']);

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });
    await expandButtons(page).first().click();
    await expect(diffPanels(page)).toHaveCount(1);

    await expect(
      page.locator('#panel-timeline').getByRole('button', { name: /close/i }),
    ).toHaveCount(0);

    await expect(page.locator('[data-testid="timeline-entry-restore"]').first()).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('FR-D17: all expanded entries collapse after a successful restore', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, [
      '# v1\n\nInitial.',
      '# v2\n\nVersion 2.',
      '# v3\n\nVersion 3.',
    ]);

    await page.route('/api/rollback', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) }),
    );

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).nth(2)).toBeVisible({ timeout: 15_000 });

    await expandButtons(page).nth(0).click();
    await expandButtons(page).nth(1).click();
    await expect(diffPanels(page)).toHaveCount(2);

    await page.locator('[data-testid="timeline-entry-restore"]').first().click();
    await page.getByTestId('timeline-entry-restore-confirm').click();

    await expect(diffPanels(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(expandButtons(page).nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButtons(page).nth(1)).toHaveAttribute('aria-expanded', 'false');
  });

  // ── Restore failure ─────────────────────────────────────────────────────────
  test('restore failure: toast appears, dialog stays open, both confirm + outer Restore re-enable', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2']);

    await page.route('/api/rollback', (route) =>
      route.fulfill({ status: 500, body: 'Internal Server Error' }),
    );

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="timeline-entry-restore"]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('timeline-entry-restore-confirm').click();

    await expect(page.getByText('Restore failed — document unchanged')).toBeVisible({
      timeout: 5_000,
    });

    await expect(dialog).toBeVisible();

    await expect(dialog.getByTestId('timeline-entry-restore-confirm')).not.toBeDisabled({
      timeout: 5_000,
    });

    await expect(page.locator('[data-testid="timeline-entry-restore"]').first()).not.toBeDisabled({
      timeout: 5_000,
    });
  });

  // ── Cancel aborts in-flight restore ────────────────────────────────────────
  test('Cancel during a slow rollback aborts the request — no side effects fire on late response', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    await seedTimelineDoc(api, baseURL ?? '', doc, ['# v1', '# v2', '# v3']);

    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rollbackHits = 0;
    await page.route('/api/rollback', async (route) => {
      rollbackHits++;
      await released;
      await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    await navigateToDoc(page, doc);
    await openTimelineTab(page);

    await expect(expandButtons(page).nth(1)).toBeVisible({ timeout: 15_000 });

    await expandButtons(page).nth(1).click();
    await expect(diffPanels(page)).toHaveCount(1);

    await page.locator('[data-testid="timeline-entry-restore"]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByTestId('timeline-entry-restore-confirm').click();

    await expect.poll(() => rollbackHits, { timeout: 5_000 }).toBe(1);

    await dialog.getByTestId('timeline-entry-restore-cancel').click();
    await expect(dialog).toBeHidden();

    // Verify the late response fires no side-effects. Auto-retrying assertions
    // can't catch absence-of-change, so wait for the response to actually arrive
    // and yield two frames to let React run (or correctly skip) handlers first.
    const lateResponse = page.waitForResponse('/api/rollback');
    release();
    await lateResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await expect(diffPanels(page)).toHaveCount(1);
    await expect(expandButtons(page).nth(1)).toHaveAttribute('aria-expanded', 'true');

    await expect(page.locator('[data-testid="timeline-entry-restore"]').first()).not.toBeDisabled({
      timeout: 5_000,
    });
  });

  // ── Real (un-mocked) rollback round-trip ───────────────────────────────────
  test('un-mocked rollback round-trip: confirming Restore actually replaces editor content with the historical version', async ({
    page,
    api,
    baseURL,
  }) => {
    const doc = uid();
    const v1 = '# Doc\n\nVersion-one body that we will restore to.';
    const v2 = '# Doc\n\nVersion-two body that we are throwing away.';
    await seedTimelineDoc(api, baseURL ?? '', doc, [v1, v2]);

    await navigateToDoc(page, doc);

    // Editor shows v2 currently
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'Version-two body',
    );

    await openTimelineTab(page);
    await expect(expandButtons(page).first()).toBeVisible({ timeout: 15_000 });

    // The OLDEST entry (last in the rendered list) is the v1 WIP commit
    // (createPage + replaceDoc coalesce into one non-agent WIP row).
    const lastRestoreIcon = page.locator('[data-testid="timeline-entry-restore"]').last();
    await lastRestoreIcon.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('timeline-entry-restore-confirm').click();

    // Editor content updates via the CRDT bridge to the v1 body
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'Version-one body',
      {
        timeout: 15_000,
      },
    );
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).not.toContainText(
      'Version-two body',
    );
  });
});
