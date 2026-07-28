/**
 * Behavioral tests for freshness trigger 3: a doc-persisted relay (CC1
 * `disk-ack` docName) re-validates JUST that doc via the scoped audit and
 * patches its shared-store entry — reserved/mermaid docNames are skipped, and
 * bursts debounce to one trailing fetch per doc.
 */

import type { ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { emitDocPersisted } from '@/lib/documents-events';
import { getValidationSnapshot, resetValidationStoreForTest } from '@/lib/validation-store';

// Config context gates the whole subscriber (`validation.fileTreeIndicators`).
let mergedConfigValue: { validation?: { fileTreeIndicators?: boolean } } | null = null;
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ merged: mergedConfigValue }),
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

beforeEach(() => {
  resetValidationStoreForTest();
  mergedConfigValue = null;
  fetchUrls = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    fetchUrls.push(String(url));
    return new Response(JSON.stringify(fetchBody), {
      status: 200,
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
});
