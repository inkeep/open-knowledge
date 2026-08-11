/**
 * Behavioral tests for freshness triggers 3, 4 and 5.
 *
 * Trigger 3: a doc-persisted relay (CC1 `disk-ack` docName) re-validates JUST
 * that doc via the scoped audit and patches its shared-store entry — reserved/
 * mermaid docNames are skipped, and bursts debounce to one trailing fetch per doc.
 *
 * Trigger 4: a lint-config change re-audits the whole plane via the counts-only
 * response, replacing the store — bursts coalesce to one walk, and a change
 * landing mid-walk supersedes it rather than racing it.
 *
 * Trigger 5: opening a project audits the whole plane once, budgeted by doc
 * count — it latches only once a run populates the store, so a page-count shift
 * or a failed fetch during the settle delay does not strand it un-run, and a
 * failed attempt is retried a bounded number of times.
 */

import type {
  ValidationAuditCountsResponse,
  ValidationAuditResponse,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { emitLintConfigChanged } from '@/editor/lint-config-client';
import { emitBranchChanged, emitDocPersisted, emitDocumentsChanged } from '@/lib/documents-events';
import {
  getValidationSnapshot,
  resetValidationStoreForTest,
  subscribeToValidationStore,
} from '@/lib/validation-store';

// Config context gates the whole subscriber (`validation.fileTreeIndicators`).
let mergedConfigValue: {
  validation?: { fileTreeIndicators?: boolean; links?: 'off' | 'warning' | 'error' };
} | null = null;
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ merged: mergedConfigValue }),
}));

// Doc count is the on-open readiness signal. Empty by default so the trigger-3
// and trigger-4 tests below see no on-open walk competing with their assertions.
let mockPages = new Set<string>();
vi.doMock('@/components/PageListContext', () => ({
  useOptionalPageList: () => ({ pages: mockPages }),
}));

const { ValidationFreshness } = await import('./ValidationFreshness');

const origFetch = globalThis.fetch;
let fetchUrls: string[] = [];
let fetchBody: ValidationAuditResponse = {
  files: [],
  fileCount: 0,
  errorCount: 0,
  warningCount: 0,
  warnings: [],
};

let countsBody: ValidationAuditCountsResponse = {
  files: [],
  fileCount: 0,
  errorCount: 0,
  warningCount: 0,
  warnings: [],
};
/** Set to delay the counts response so a supersede can be observed mid-walk. */
let countsDelayMs = 0;
/** Set non-200 to make the counts endpoint fail (server-unavailable path). */
let countsStatus = 200;

beforeEach(() => {
  resetValidationStoreForTest();
  mergedConfigValue = null;
  fetchUrls = [];
  countsDelayMs = 0;
  countsStatus = 200;
  countsBody = { files: [], fileCount: 0, errorCount: 0, warningCount: 0, warnings: [] };
  mockPages = new Set();
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    fetchUrls.push(href);
    const isCounts = href.includes('counts=1');
    // Snapshot the body/status at CALL time, not after the delay: a delayed
    // walk must return the payload configured when it started, so a supersede
    // test that reassigns `countsBody` mid-flight sees the first walk still
    // carrying the stale body it would (wrongly) land if not aborted.
    const bodyAtCall = isCounts ? countsBody : fetchBody;
    const statusAtCall = isCounts ? countsStatus : 200;
    if (isCounts && countsDelayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, countsDelayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
    return new Response(JSON.stringify(bodyAtCall), {
      status: statusAtCall,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  cleanup();
});

describe('ValidationFreshness', () => {
  test('a persisted doc is re-validated alone and its store entry patched', async () => {
    fetchBody = {
      files: [
        {
          file: 'guides/setup.md',
          diagnostics: [
            {
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
              severity: 'error',
              source: 'links',
              code: 'dead-link',
              message: 'Link target "ghost" does not resolve to an existing document.',
            },
          ],
        },
      ],
      fileCount: 1,
      errorCount: 1,
      warningCount: 0,
      warnings: [],
    };
    render(<ValidationFreshness />);
    emitDocPersisted('guides/setup');

    await waitFor(
      () =>
        expect(getValidationSnapshot().get('guides/setup')).toEqual({
          errorCount: 1,
          warningCount: 0,
        }),
      { timeout: 3000 },
    );
    expect(fetchUrls).toEqual(['/api/audit?doc=guides%2Fsetup']);
  });

  test('a burst of acks for one doc coalesces to one trailing fetch', async () => {
    render(<ValidationFreshness />);
    emitDocPersisted('notes');
    emitDocPersisted('notes');
    emitDocPersisted('notes');

    await waitFor(() => expect(fetchUrls).toHaveLength(1), { timeout: 3000 });
    // Trailing-edge only — give the window a beat to prove no extra fetches land.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchUrls).toEqual(['/api/audit?doc=notes']);
  });

  test('reserved and mermaid docNames are skipped', async () => {
    render(<ValidationFreshness />);
    emitDocPersisted('__config__/project');
    emitDocPersisted('__system__');
    emitDocPersisted('assets/flow.mmd');
    emitDocPersisted('diagrams/arch.mermaid');

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchUrls).toEqual([]);
  });

  test('the subscriber is inert when the project turns file-tree indicators off', async () => {
    mergedConfigValue = { validation: { fileTreeIndicators: false } };
    render(<ValidationFreshness />);
    emitDocPersisted('notes');

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchUrls).toEqual([]);
  });

  test('a healed doc is dropped from the snapshot on its next re-validate', async () => {
    render(<ValidationFreshness />);
    fetchBody = {
      files: [
        {
          file: 'a.md',
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              severity: 'warning',
              source: 'markdownlint',
              code: 'MD010',
              message: 'Hard tabs',
            },
          ],
        },
      ],
      fileCount: 1,
      errorCount: 0,
      warningCount: 1,
      warnings: [],
    };
    emitDocPersisted('a');
    await waitFor(() => expect(getValidationSnapshot().has('a')).toBe(true), { timeout: 3000 });

    fetchBody = { files: [], fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] };
    emitDocPersisted('a');
    await waitFor(() => expect(getValidationSnapshot().has('a')).toBe(false), { timeout: 3000 });
  });

  describe('trigger 4: lint-config change', () => {
    test('re-audits the whole plane and replaces the store', async () => {
      countsBody = {
        files: [
          {
            file: 'guides/setup.md',
            lint: { errorCount: 2, warningCount: 1 },
            links: { errorCount: 0, warningCount: 1 },
          },
        ],
        fileCount: 12,
        errorCount: 2,
        warningCount: 2,
        warnings: [],
      };
      render(<ValidationFreshness />);
      // No walk until something actually changes — mounting must not audit.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(fetchUrls).toEqual([]);

      emitLintConfigChanged();

      await waitFor(
        () =>
          expect(getValidationSnapshot().get('guides/setup')).toEqual({
            errorCount: 2,
            warningCount: 2,
          }),
        { timeout: 3000 },
      );
      // Counts-only, project scope: no `doc=`/`path=`, and no enumerated fetch.
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test.each([
      'local-targets',
      'files',
    ] as const)('re-audits when the local-target assessment plane changes via %s', async (channel) => {
      countsBody = {
        files: [
          {
            file: 'notes.md',
            lint: { errorCount: 0, warningCount: 0 },
            links: { errorCount: 0, warningCount: 1 },
          },
        ],
        fileCount: 1,
        errorCount: 0,
        warningCount: 1,
        warnings: [],
      };
      render(<ValidationFreshness />);
      emitDocumentsChanged([channel]);

      await waitFor(
        () =>
          expect(getValidationSnapshot().get('notes')).toEqual({
            errorCount: 0,
            warningCount: 1,
          }),
        { timeout: 3000 },
      );
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test('docs the new config no longer flags drop out of the snapshot', async () => {
      render(<ValidationFreshness />);
      countsBody = {
        files: [
          {
            file: 'a.md',
            lint: { errorCount: 0, warningCount: 3 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 1,
        errorCount: 0,
        warningCount: 3,
        warnings: [],
      };
      emitLintConfigChanged();
      await waitFor(() => expect(getValidationSnapshot().has('a')).toBe(true), { timeout: 3000 });

      // The rule that produced those three warnings is switched off.
      countsBody = { files: [], fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] };
      emitLintConfigChanged();
      await waitFor(() => expect(getValidationSnapshot().has('a')).toBe(false), { timeout: 3000 });
    });

    test('a burst of toggles coalesces to one walk', async () => {
      render(<ValidationFreshness />);
      emitLintConfigChanged();
      emitLintConfigChanged();
      emitLintConfigChanged();
      emitLintConfigChanged();

      await waitFor(() => expect(fetchUrls).toHaveLength(1), { timeout: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test('a change landing mid-walk supersedes it instead of racing it', async () => {
      // Above the 750ms config debounce, so the first walk is genuinely still in
      // flight when the second change fires. At 600ms (below the debounce) the
      // first walk settled and wrote before the second even started, so the
      // abort was a no-op against a completed request and this test passed
      // purely because the later write clobbered the earlier one.
      countsDelayMs = 1200;
      countsBody = {
        files: [
          {
            file: 'stale.md',
            lint: { errorCount: 9, warningCount: 0 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 1,
        errorCount: 9,
        warningCount: 0,
        warnings: [],
      };
      // Assert on every store notification, not just the final state: an
      // unconditional store-clear would satisfy a final `has('stale') === false`
      // without any abort. The superseded walk's result must never land, even
      // for one render.
      let staleEverPresent = false;
      const unsubscribe = subscribeToValidationStore(() => {
        if (getValidationSnapshot().has('stale')) staleEverPresent = true;
      });
      render(<ValidationFreshness />);
      emitLintConfigChanged();
      await waitFor(() => expect(fetchUrls).toHaveLength(1), { timeout: 3000 });

      // Second change while the first walk is still in flight: its result must
      // never reach the store, even though it was requested first — the abort
      // of the in-flight walk is what this exercises.
      countsBody = {
        files: [
          {
            file: 'fresh.md',
            lint: { errorCount: 0, warningCount: 1 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 1,
        errorCount: 0,
        warningCount: 1,
        warnings: [],
      };
      emitLintConfigChanged();

      await waitFor(() => expect(getValidationSnapshot().has('fresh')).toBe(true), {
        timeout: 5000,
      });
      unsubscribe();
      expect(staleEverPresent).toBe(false);
      expect(getValidationSnapshot().has('stale')).toBe(false);
    });

    test('a failed audit keeps the prior snapshot (stale beats wrongly-clean)', async () => {
      render(<ValidationFreshness />);
      // A first config change succeeds and seeds the store.
      countsBody = {
        files: [
          {
            file: 'a.md',
            lint: { errorCount: 0, warningCount: 2 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 1,
        errorCount: 0,
        warningCount: 2,
        warnings: [],
      };
      emitLintConfigChanged();
      await waitFor(() => expect(getValidationSnapshot().has('a')).toBe(true), { timeout: 3000 });

      // A later config change lands while the server is unavailable (500). The
      // null result must leave the prior entry standing rather than clear the
      // store — an empty snapshot reads as "all files clean".
      countsStatus = 500;
      emitLintConfigChanged();
      await waitFor(() => expect(fetchUrls).toHaveLength(2), { timeout: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(getValidationSnapshot().get('a')).toEqual({ errorCount: 0, warningCount: 2 });
    });

    test('is inert when the project turns file-tree indicators off', async () => {
      mergedConfigValue = { validation: { fileTreeIndicators: false } };
      render(<ValidationFreshness />);
      emitLintConfigChanged();

      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(fetchUrls).toEqual([]);
    });
  });

  describe('trigger 4: branch switch', () => {
    const docs = (n: number) => new Set(Array.from({ length: n }, (_, i) => `doc-${i}`));

    test('re-audits the whole plane after the on-open walk has already run', async () => {
      mockPages = docs(3);
      countsBody = {
        files: [
          {
            file: 'only-on-main.md',
            lint: { errorCount: 1, warningCount: 0 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 3,
        errorCount: 1,
        warningCount: 0,
        warnings: [],
      };
      render(<ValidationFreshness />);
      // Let the on-open walk land first: a branch switch handled in-window has
      // to re-audit even though that walk already populated the store.
      await waitFor(() => expect(getValidationSnapshot().has('only-on-main')).toBe(true), {
        timeout: 5000,
      });
      expect(fetchUrls).toHaveLength(1);

      // Switching branches replaces the content set wholesale, so every entry
      // in the store was produced by content that no longer exists.
      countsBody = {
        files: [
          {
            file: 'only-on-feature.md',
            lint: { errorCount: 0, warningCount: 4 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 5,
        errorCount: 0,
        warningCount: 4,
        warnings: [],
      };
      emitBranchChanged('feature/x');

      await waitFor(
        () =>
          expect(getValidationSnapshot().get('only-on-feature')).toEqual({
            errorCount: 0,
            warningCount: 4,
          }),
        { timeout: 5000 },
      );
      expect(getValidationSnapshot().has('only-on-main')).toBe(false);
      expect(fetchUrls).toEqual(['/api/audit?counts=1', '/api/audit?counts=1']);
    });

    test('is inert when the project turns file-tree indicators off', async () => {
      mergedConfigValue = { validation: { fileTreeIndicators: false } };
      render(<ValidationFreshness />);
      emitBranchChanged('feature/x');

      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(fetchUrls).toEqual([]);
    });
  });

  describe('trigger 5: audit on project open', () => {
    const docs = (n: number) => new Set(Array.from({ length: n }, (_, i) => `doc-${i}`));

    test('audits once on open', async () => {
      mockPages = docs(3);
      countsBody = {
        files: [
          {
            file: 'stale/from-last-session.md',
            lint: { errorCount: 1, warningCount: 0 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 3,
        errorCount: 1,
        warningCount: 0,
        warnings: [],
      };
      render(<ValidationFreshness />);

      // Nothing in this session opened, wrote, or reconfigured anything — the
      // whole point is that a project configured earlier is correct on arrival.
      await waitFor(
        () =>
          expect(getValidationSnapshot().get('stale/from-last-session')).toEqual({
            errorCount: 1,
            warningCount: 0,
          }),
        { timeout: 5000 },
      );
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test('audits on open regardless of project size — no doc-size cap', async () => {
      // The Problems panel's on-demand audit and the config-change trigger both
      // walk any project uncapped, so capping this one bought no protection and
      // made the same project show a populated sidebar after a rule toggle and a
      // bare one after a reopen. A size bound, if ever warranted, belongs in the
      // audit engine where all three callers inherit it.
      mockPages = docs(4000);
      countsBody = {
        files: [
          {
            file: 'big/doc.md',
            lint: { errorCount: 0, warningCount: 2 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 4000,
        errorCount: 0,
        warningCount: 2,
        warnings: [],
      };
      render(<ValidationFreshness />);

      await waitFor(() => expect(fetchUrls).toEqual(['/api/audit?counts=1']), { timeout: 5000 });
      expect(getValidationSnapshot().get('big/doc')).toEqual({ errorCount: 0, warningCount: 2 });
    });

    test('audits once, not again as the page list grows', async () => {
      mockPages = docs(3);
      const view = render(<ValidationFreshness />);
      await waitFor(() => expect(fetchUrls).toHaveLength(1), { timeout: 5000 });

      // Creating docs must not re-trigger a whole-project walk; per-doc freshness
      // is trigger 3's job.
      mockPages = docs(9);
      view.rerender(<ValidationFreshness />);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test('a page-count change during the settle delay does not strand the audit un-run', async () => {
      mockPages = docs(3);
      countsBody = {
        files: [
          {
            file: 'stale/from-last-session.md',
            lint: { errorCount: 1, warningCount: 0 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 3,
        errorCount: 1,
        warningCount: 0,
        warnings: [],
      };
      const view = render(<ValidationFreshness />);
      // A doc is added (optimistic create / background refetch) during the
      // settle window, before the scheduled audit fires. The effect tears down
      // and reschedules; latching at schedule time would have refused the
      // reschedule and left the sidebar empty for the whole session.
      mockPages = docs(4);
      view.rerender(<ValidationFreshness />);

      await waitFor(
        () =>
          expect(getValidationSnapshot().get('stale/from-last-session')).toEqual({
            errorCount: 1,
            warningCount: 0,
          }),
        { timeout: 5000 },
      );
      // The cancelled first schedule never fetched; only the rescheduled run did.
      expect(fetchUrls).toEqual(['/api/audit?counts=1']);
    });

    test('holds until the doc count is known rather than auditing an empty project', async () => {
      // An unresolved page list reads as 0; auditing then would race the list and
      // spend a walk before the project is even known.
      mockPages = new Set();
      const view = render(<ValidationFreshness />);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(fetchUrls).toEqual([]);

      mockPages = docs(2);
      view.rerender(<ValidationFreshness />);
      await waitFor(() => expect(fetchUrls).toEqual(['/api/audit?counts=1']), { timeout: 5000 });
    });

    test('is inert when the project turns file-tree indicators off', async () => {
      mergedConfigValue = { validation: { fileTreeIndicators: false } };
      mockPages = docs(3);
      render(<ValidationFreshness />);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(fetchUrls).toEqual([]);
    });

    test('a failed first attempt retries instead of costing the whole session', async () => {
      // The server is still finishing its own boot when the settle delay fires.
      // Nothing else re-triggers this pass in a session where no doc is created
      // or removed, so without a retry one 500 reinstates the bare sidebar for
      // the rest of the session.
      mockPages = docs(3);
      countsStatus = 500;
      render(<ValidationFreshness />);
      await waitFor(() => expect(fetchUrls).toHaveLength(1), { timeout: 5000 });
      expect(getValidationSnapshot().size).toBe(0);

      countsStatus = 200;
      countsBody = {
        files: [
          {
            file: 'stale/from-last-session.md',
            lint: { errorCount: 1, warningCount: 0 },
            links: { errorCount: 0, warningCount: 0 },
          },
        ],
        fileCount: 3,
        errorCount: 1,
        warningCount: 0,
        warnings: [],
      };

      await waitFor(
        () =>
          expect(getValidationSnapshot().get('stale/from-last-session')).toEqual({
            errorCount: 1,
            warningCount: 0,
          }),
        { timeout: 10_000 },
      );
    });

    test('the retry is bounded rather than an open-ended poll', async () => {
      mockPages = docs(3);
      countsStatus = 500;
      render(<ValidationFreshness />);

      // Three attempts total (1.2s, +1.5s, +3s), then the trigger gives up for
      // the session — the manual audit and triggers 3-4 still cover it.
      await waitFor(() => expect(fetchUrls).toHaveLength(3), { timeout: 15_000 });
      // A fourth attempt would be due 6s after the third; wait past that.
      await new Promise((resolve) => setTimeout(resolve, 7000));
      expect(fetchUrls).toHaveLength(3);
    });
  });
});
