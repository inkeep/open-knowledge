/**
 * RED test: WYSIWYG editor must be interactive after the
 * create → inline-rename → click → type sequence.
 *
 * Bug: clicking the FileTree `+` button opens an inline rename input against
 * the default placeholder name (`Untitled.md`). Typing a new name into that
 * input and pressing Enter commits a rename of the newly-created file before
 * `/api/pages` has refetched, before the editor pool has registered the new
 * docName, and across the warm-skeleton Suspense fallback path. The combined
 * effect is that the user lands on a visually-blank, non-interactive editor
 * surface — keystrokes are silently dropped — until they perform a workaround
 * (click another doc and back). The footer's `useDocumentStats` counter
 * confirms zero bytes reached `Y.Text('source')`.
 *
 * Multi-assertion structure localizes which proximate cause fires:
 *   (a) `.ProseMirror` contains the typed sentinel — keystrokes reached
 *       the editor view (rules out warm-fallback `pointer-events-none`
 *       intercepting clicks/keys).
 *   (b) `window.__activeProvider.document.getText('source')` contains the
 *       sentinel — the WYSIWYG → Y.Text bridge fired. Mirrors the footer's
 *       useDocumentStats counter — zero bytes here means the bridge never
 *       fired.
 *   (c) `window.__activeEditor.isEditable === true` — distinguishes
 *       "view destroyed" from "view exists but not editable".
 *   (d) No `.tiptap-editor[aria-hidden="true"]` element survives —
 *       distinguishes a warm fallback masking the real editor from a
 *       Suspense fallback that never unsuspends.
 *
 * Test tier: Playwright E2E (NOT integration). The bug lives in the React +
 * Suspense + ProseMirror + Hocuspocus lifecycle interaction; the integration
 * harness at `packages/app/tests/integration/test-harness.ts` exercises only
 * the server + provider-pool + observers, and would silently pass.
 */
import { expect, test } from './_helpers';

const SENTINEL = 'HelloWorldUniqueSentinel987';

test.describe('create → inline-rename → click → type', () => {
  test('newly-created file is editable on first click after inline rename', async ({
    page,
    workerServer,
  }) => {
    // Unique per-test docName guards two distinct hazards:
    //   1. Cross-worker CRDT corruption (CLAUDE.md STOP rule — workers run
    //      tests in parallel and shared docNames stomp each other's Y.Doc).
    //   2. Auto-increment of the default `Untitled.md` placeholder across
    //      retries inside the same worker (Playwright retries 2× on CI; a
    //      prior failed run can leave `Untitled.md` on disk, shifting the
    //      next default to `Untitled 2.md`).
    const uniqueName = `dhx-${Math.random().toString(36).slice(2, 10)}`;

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem').first()).toBeVisible({ timeout: 15_000 });

    // Click "+" to begin a new-file create. The inline rename input opens
    // against the auto-incrementing default (`Untitled.md` if not taken,
    // else `Untitled 2.md`, etc.). The regex tolerates both forms.
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: /rename Untitled/i });
    await expect(renameInput).toBeVisible({ timeout: 10_000 });

    // Rename IMMEDIATELY — the bug's premise is that the commit lands before
    // `/api/pages` refetch resolves. `fill` + `press('Enter')` is fast enough
    // to win the race in practice.
    await renameInput.fill(uniqueName);
    await renameInput.press('Enter');

    await expect(
      sidebar.getByRole('treeitem', { name: `${uniqueName}.md`, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .locator('[data-active-tab="true"]')
        .getByRole('button', { name: `${uniqueName}.md`, exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The user's first interaction with the editor body. `.first()` because
    // multiple ActivityEntry mounts can coexist in the hybrid render tree;
    // the visible one is the active pool entry's editor.
    const proseMirror = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(proseMirror).toBeVisible({ timeout: 10_000 });
    await proseMirror.click();

    // `keyboard.insertText` dispatches one `beforeinput` event with the full
    // payload, bypassing the per-character race that `keyboard.type` can hit
    // under CPU contention (precedent §20(i)).
    await page.keyboard.insertText(SENTINEL);

    // (a) DOM observable. Failure here means keystrokes were intercepted by
    //     a `pointer-events-none` / `aria-hidden` ancestor (the warm
    //     fallback) before the ProseMirror view ever saw them.
    await expect(proseMirror).toContainText(SENTINEL, { timeout: 5_000 });

    // (b) CRDT bridge fired. Failure here means the editor took the
    //     keystroke into its DOM but the WYSIWYG → Y.Text observer chain
    //     did not propagate. This is what `useDocumentStats` reads — the
    //     "0 words 0 chars 0 tokens" footer counter the user reported.
    await page.waitForFunction(
      (s) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(s) ?? false,
      SENTINEL,
      { timeout: 5_000 },
    );

    // (c) Editor reports itself as editable. Failure here while (a) and (b)
    //     pass would indicate a TipTap `setEditable(false)` slipping in
    //     during the rename lifecycle. Failure here as the FIRST failing
    //     assertion indicates the entire view is gated (commands ignored,
    //     not just visually masked).
    const isEditable = await page.evaluate(() => window.__activeEditor?.isEditable);
    expect(isEditable).toBe(true);

    // (d) The warm-skeleton fallback element is `.tiptap-editor[aria-hidden=
    //     "true"]` (see WarmContentFallback in EditorActivityPool.tsx). The
    //     real editor's wrapper carries the same class but NO aria-hidden.
    //     A nonzero count means the warm fallback DOM survived next to the
    //     real editor. (Sentinel value is a structural observation, not a
    //     behavioral coupling — the fix may legitimately rework the fallback
    //     to remain visible but non-blocking; in that case (a)/(b)/(c) pass
    //     and (d) reports the remaining structural state for diagnostics.)
    const stuckWarmFallbackCount = await page.locator('.tiptap-editor[aria-hidden="true"]').count();
    expect(stuckWarmFallbackCount).toBe(0);

    // Acknowledge `workerServer` so the worker-scoped fixture is force-
    // resolved even on an early-exit failure path — without a reference
    // the fixture would only spin up lazily on first `page` use.
    expect(workerServer.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
