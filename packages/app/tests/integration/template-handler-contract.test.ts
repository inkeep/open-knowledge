/**
 * Template-handler asymmetry contract — static analysis gate.
 *
 * Mirror of `conflict-gate-coverage.test.ts` / `attribution-sweep-coverage.test.ts`:
 * statically scans the four mutating template handlers and pins three deliberate
 * asymmetries the templates-as-content cutover preserves. The handlers live in
 * whichever source currently owns them — `api-extension.ts`'s legacy dispatch or
 * a native `http/*-routes.ts` group factory — so the scan builds its source set
 * from the union of both (via `listNativeRouteFiles`), exactly as the sibling
 * meta-tests do, and a future lift between those files cannot silently vacate
 * this gate.
 * These are properties of the HANDLER source, not of the end-to-end runtime — the
 * `files` derived-view channel also fires from raw disk events, and the CRDT
 * write path's writeTracker suppresses its own self-writes, so the honest thing
 * to pin is which handler emits the signal directly. A future edit that adds a
 * TO-side conflict gate to move, drops a `files` signal, or reorders the move's
 * fs-direct content-edit tail ahead of the source-doc teardown trips this test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  HANDLER_RUN_END_NEEDLES,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const SERVER_SRC = join(import.meta.dirname, '../../../server/src');
const SOURCES = ['api-extension.ts', ...listNativeRouteFiles(SERVER_SRC)].map((rel) =>
  readFileSync(join(SERVER_SRC, rel), 'utf8'),
);

/**
 * Slice one `const handle... = withValidation(` template handler body out of
 * whichever source owns it, bounded at the next top-level handler or the group's
 * route-record declaration — the same extractor shape the sibling meta-tests use.
 */
function extractHandlerBody(handlerName: string): string {
  const source = SOURCES.find((s) => s.includes(`const ${handlerName} = withValidation(`));
  if (!source) throw new Error(`${handlerName}: withValidation handler not found in source`);
  const start = source.indexOf(`const ${handlerName} = withValidation(`);
  const candidates = [
    '\n  async function handle',
    '\n  const handle',
    ...HANDLER_RUN_END_NEEDLES,
    '\n  return {',
  ]
    .map((needle) => source.indexOf(needle, start + 1))
    .filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return source.slice(start, next === -1 ? source.length : next);
}

const put = extractHandlerBody('handleTemplatePut');
const del = extractHandlerBody('handleTemplateDelete');
const move = extractHandlerBody('handleTemplateMove');
const imp = extractHandlerBody('handleTemplateImport');

describe('template handler asymmetries (FR5)', () => {
  test('move gates the FROM side only — exactly one conflict gate, keyed on fromName', () => {
    const gateCalls = move.match(/checkTemplateConflictGate\(/g) ?? [];
    expect(gateCalls.length).toBe(1);
    // The gate takes the pre-resolved doc name, so from-side keying reads as
    // the doc-name builder over the FROM folder + name.
    expect(
      /checkTemplateConflictGate\(\s*templateDocNameFor\(fromValidated\.folderRel, body\.fromName\)/.test(
        move,
      ),
    ).toBe(true);
    // The TO side is never gated: the destination doc does not exist yet, so
    // there is nothing to be mid-conflict.
    expect(/checkTemplateConflictGate\(\s*templateDocNameFor\(toValidated/.test(move)).toBe(false);
  });

  test("move's optional content-edit tail is fs-direct AFTER the source-doc teardown", () => {
    const teardown = move.indexOf('captureAndCloseDocuments(');
    const fsDirectEdit = move.indexOf('applyTemplateWrite(');
    expect(teardown).toBeGreaterThan(-1);
    expect(fsDirectEdit).toBeGreaterThan(-1);
    // Teardown must precede the fs-direct rewrite: the source doc is closed
    // before the relocated file is edited, so the edit surfaces as a watcher
    // event rather than resurrecting the moved template through a stale store.
    expect(teardown).toBeLessThan(fsDirectEdit);
  });

  test('the files signal fires on move and import but not on put and delete', () => {
    expect(move.includes("signalChannel?.('files')")).toBe(true);
    expect(imp.includes("signalChannel?.('files')")).toBe(true);
    // put/delete route their disk change through the content pipeline (CRDT
    // paired-write / doc teardown); the watcher re-derives the file index, so a
    // handler-level signal would be redundant.
    expect(put.includes("signalChannel?.('files')")).toBe(false);
    expect(del.includes("signalChannel?.('files')")).toBe(false);
  });
});
