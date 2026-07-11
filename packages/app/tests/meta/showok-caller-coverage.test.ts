/**
 * `showOk` caller meta-test — static analysis gate.
 *
 * The `showOk` read-opt lifts ContentFilter's `.ok` always-skip floor for the
 * tree-listing reveal (`GET /api/documents?showAll=true&showOk=true`). Every
 * other filter consumer — watcher seed + event admission, search corpus,
 * embeddings, MCP, asset serving, persistence — must keep the absolute floor:
 * a caller that passes `showOk` rescopes what its surface can enumerate, so
 * the set of production sources that may even NAME the flag is pinned here.
 *
 * Modeled on `getfileindex-allfiles-coverage.test.ts` — same shape: scan
 * production sources for the capability, require explicit authorization.
 * Authorization here is by source REGION (the walk-opts contract plus the
 * documents-list handler) rather than enclosing-function name, because the
 * flag legitimately appears in nested helpers and local consts whose names
 * are incidental.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
// Defines the `ContentFilterReadOpts.showOk` opt and consumes it in the
// always-skip floor of `isExcluded` / `isDirExcluded`.
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
// The one sanctioned data path: `handleDocumentList` parses `?showOk=true`
// and threads it through `streamShowAllEntries` / `walkContentDirForShowAll`.
const API_EXT_PATH = join(SERVER_SRC_ROOT, 'api-extension.ts');

/** Recursively enumerate `.ts` files under `dir`, skipping test files. */
function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Character range `[start, end)` of the authorized region beginning at
 * `startAnchor` and ending at the first `endAnchor` match after it. Both
 * anchors are asserted present so a rename/refactor fails loudly instead of
 * silently authorizing the rest of the file.
 */
function sliceRegion(source: string, startAnchor: string, endAnchor: RegExp): [number, number] {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + startAnchor.length);
  const endMatch = endAnchor.exec(rest);
  expect(endMatch).not.toBeNull();
  const end = start + startAnchor.length + (endMatch?.index ?? 0);
  return [start, end];
}

describe('showOk caller coverage', () => {
  test('no server/cli production file outside the two sanctioned ones names showOk', () => {
    const allowedFiles = new Set([CONTENT_FILTER_PATH, API_EXT_PATH]);
    const offenders: string[] = [];
    for (const root of [SERVER_SRC_ROOT, CLI_SRC_ROOT]) {
      for (const file of listProductionTsFiles(root)) {
        if (allowedFiles.has(file)) continue;
        if (/\bshowOk\b/.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every showOk occurrence in api-extension.ts sits in an authorized region', () => {
    const source = readFileSync(API_EXT_PATH, 'utf8');
    // Region A: the walk-opts contract + the walk itself (interface field,
    // destructure, the shared filter-opts object, gate comments).
    const [walkStart, walkEnd] = sliceRegion(
      source,
      'export interface StreamShowAllOpts',
      /export async function walkContentDirForShowAll/,
    );
    // Region B: the documents-list handler (query parse, both walk
    // invocations, the single-flight key).
    const [handlerStart, handlerEnd] = sliceRegion(
      source,
      'const handleDocumentList = withValidation(',
      /\bconst handle[A-Z][A-Za-z]*\s*=/,
    );

    const outside: string[] = [];
    for (const match of source.matchAll(/\bshowOk\b/g)) {
      const offset = match.index ?? 0;
      const inWalk = offset >= walkStart && offset < walkEnd;
      const inHandler = offset >= handlerStart && offset < handlerEnd;
      if (!inWalk && !inHandler) {
        const line = source.slice(0, offset).split('\n').length;
        outside.push(
          `api-extension.ts:${line} — showOk outside the walk-opts and document-list regions. ` +
            'Only the tree-listing path may pass the flag; a new consumer needs a deliberate ' +
            'spec decision, not a new call site.',
        );
      }
    }
    expect(outside).toEqual([]);
  });

  test('the sanctioned surfaces still exist (allowlist-rot guard)', () => {
    // If the flag is renamed or removed, this test forces the allowlist and
    // regions above to be revisited rather than rotting into dead authority.
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain('showOk?: boolean');
    expect(readFileSync(API_EXT_PATH, 'utf8')).toContain("searchParams.get('showOk')");
  });
});
