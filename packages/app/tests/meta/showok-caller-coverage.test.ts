import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
const API_EXT_PATH = join(SERVER_SRC_ROOT, 'api-extension.ts');
const DOCUMENT_ROUTES_PATH = join(SERVER_SRC_ROOT, 'http/document-routes.ts');
const GIT_ROUTES_PATH = join(SERVER_SRC_ROOT, 'http/git-routes.ts');

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

    const gitSource = readFileSync(GIT_ROUTES_PATH, 'utf8');
    const [openTargetStart, openTargetEnd] = sliceRegion(
      gitSource,
      'function toOpenTarget(projectRelPath',
      /\n {2}async function handleGitWorktreeStatus/,
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
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain('showOk?: boolean');
    expect(readFileSync(DOCUMENT_ROUTES_PATH, 'utf8')).toContain("searchParams.get('showOk')");
    expect(readFileSync(GIT_ROUTES_PATH, 'utf8')).toContain('showOk: true');
  });
});
