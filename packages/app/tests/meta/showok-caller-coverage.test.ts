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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
// Defines the `ContentFilterReadOpts.showOk` opt and consumes it in the
// always-skip floor of `isExcluded` / `isDirExcluded`.
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
// Hosts the walk-opts contract (`StreamShowAllOpts.showOk`) and the walk
// implementations the sanctioned data path threads the flag through.
const API_EXT_PATH = join(SERVER_SRC_ROOT, 'api-extension.ts');
// Hosts `handleDocumentList` (query parse + both walk invocations) after its
// Wave 2 lift; the deps interface restates the walk-opts contract's showOk
// field types.
const DOCUMENT_ROUTES_PATH = join(SERVER_SRC_ROOT, 'http/document-routes.ts');
// Hosts `toOpenTarget` (the sync popover's open-target resolver, the second
// authorized consumer) after its Wave 2 lift out of api-extension.ts with the
// git family — moved whole with its sole consumer, the worktree-status
// handler; the authorization rationale travels with the region check below.
const GIT_ROUTES_PATH = join(SERVER_SRC_ROOT, 'http/git-routes.ts');

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
  test('no server/cli production file outside the sanctioned files names showOk', () => {
    const allowedFiles = new Set([
      CONTENT_FILTER_PATH,
      API_EXT_PATH,
      DOCUMENT_ROUTES_PATH,
      GIT_ROUTES_PATH,
    ]);
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
    const outside: string[] = [];
    for (const match of source.matchAll(/\bshowOk\b/g)) {
      const offset = match.index ?? 0;
      const inWalk = offset >= walkStart && offset < walkEnd;
      if (!inWalk) {
        const line = source.slice(0, offset).split('\n').length;
        outside.push(
          `api-extension.ts:${line} — showOk outside the walk-opts region. ` +
            'Only the tree-listing path may pass the flag; a new consumer needs a deliberate ' +
            'spec decision, not a new call site.',
        );
      }
    }

    // git-routes.ts (post-lift home of `toOpenTarget`, the sync popover's
    // open-target resolver — Region A2 before the git family's Wave 2 lift).
    //
    // A second AUTHORIZED consumer, not a leak. It enumerates nothing — the
    // rows come from `git status`, which never consults ContentFilter — and
    // decides only whether an already-listed row carries a clickable link.
    // `bypassFilters` + `showOk` reduce the filter to its floors alone, which
    // is the set the sidebar itself refuses under Show All Files; without
    // `showOk` a changed `.ok/config.yml` would render unclickable while the
    // sidebar opens it. `.ok/worktrees` and `.ok/local` stay floored
    // unconditionally (OK_ALWAYS_SKIP_CHILDREN), so per-machine state cannot
    // reach the wire through this path either way.
    // Starts at the docblock, which states the contract and names the flag.
    const gitSource = readFileSync(GIT_ROUTES_PATH, 'utf8');
    const [openTargetStart, openTargetEnd] = sliceRegion(
      gitSource,
      '   * Where a project-relative working-tree path opens',
      /\n {2}\/\*\*/,
    );
    for (const match of gitSource.matchAll(/\bshowOk\b/g)) {
      const offset = match.index ?? 0;
      const inOpenTarget = offset >= openTargetStart && offset < openTargetEnd;
      if (!inOpenTarget) {
        const line = gitSource.slice(0, offset).split('\n').length;
        outside.push(
          `http/git-routes.ts:${line} — showOk outside the toOpenTarget region. ` +
            'Only the tree-listing path may pass the flag; a new consumer needs a deliberate ' +
            'spec decision, not a new call site.',
        );
      }
    }

    // document-routes.ts (post-lift home of the handler): Region B is the
    // deps interface (restates the walk-opts showOk contract), Region C the
    // documents-list handler (query parse, both walk invocations, the
    // single-flight key).
    const routesSource = readFileSync(DOCUMENT_ROUTES_PATH, 'utf8');
    const [depsStart, depsEnd] = sliceRegion(
      routesSource,
      'export interface DocumentRouteDeps',
      /export function createDocumentRoutes/,
    );
    const [handlerStart, handlerEnd] = sliceRegion(
      routesSource,
      'const handleDocumentList = withValidation(',
      /\bconst handle[A-Z][A-Za-z]*\s*=/,
    );
    for (const match of routesSource.matchAll(/\bshowOk\b/g)) {
      const offset = match.index ?? 0;
      const inDeps = offset >= depsStart && offset < depsEnd;
      const inHandler = offset >= handlerStart && offset < handlerEnd;
      if (!inDeps && !inHandler) {
        const line = routesSource.slice(0, offset).split('\n').length;
        outside.push(
          `http/document-routes.ts:${line} — showOk outside the deps-contract and document-list regions. ` +
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
    expect(readFileSync(DOCUMENT_ROUTES_PATH, 'utf8')).toContain("searchParams.get('showOk')");
    expect(readFileSync(GIT_ROUTES_PATH, 'utf8')).toContain('showOk: true');
  });
});
