/**
 * `syncScope` caller meta-test — static analysis gate.
 *
 * The `syncScope` read-opt admits the shareable `.ok` artifact allow-list
 * (project `config.yml`, `.ok/.gitignore`, `.ok/schemas/*.json`, templates,
 * folder `frontmatter.yml`) through ContentFilter's `isExcluded` /
 * `isDirExcluded` so the sync engine can stage and deletion-track them. Every
 * other filter consumer — file index, sidebar, watcher admission, search,
 * asset serving, the merge-conflict partition — must keep these paths hidden:
 * a caller that passes `syncScope` rescopes what its surface can enumerate,
 * so the set of production sources that may even NAME the flag is pinned
 * here.
 *
 * Modeled on `showok-caller-coverage.test.ts` — same shape: scan production
 * sources for the capability, require explicit authorization.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
const APP_SRC_ROOT = join(import.meta.dirname, '../../src');
// Defines the `ContentFilterReadOpts.syncScope` opt and consumes it in the
// shareable-artifact carve-outs of `isExcluded` / `isDirExcluded`.
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
// Passes the opt on the staging paths only: the gather walk and the head
// listing (deletion tracking), shared by the push cycle and the pre-merge
// dirty-content commit. The engine's conflict partition stays unscoped.
const SYNC_ENGINE_PATH = join(SERVER_SRC_ROOT, 'sync-engine.ts');

/** Recursively enumerate TypeScript production files under `dir`, skipping tests. */
function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (
      st.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('syncScope caller coverage', () => {
  test('no server/cli/app production file outside the sanctioned files names syncScope', () => {
    const allowedFiles = new Set([CONTENT_FILTER_PATH, SYNC_ENGINE_PATH]);
    const offenders: string[] = [];
    for (const root of [SERVER_SRC_ROOT, CLI_SRC_ROOT, APP_SRC_ROOT]) {
      for (const file of listProductionTsFiles(root)) {
        if (allowedFiles.has(file)) continue;
        if (/\bsyncScope\b/.test(readFileSync(file, 'utf8'))) {
          offenders.push(
            `${file} — syncScope outside the sanctioned set. Only the sync engine's ` +
              'gather / head-listing staging paths may pass the flag; a new consumer ' +
              'needs a deliberate spec decision AND an allowlist entry here.',
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the sanctioned surface still exists (allowlist-rot guard)', () => {
    // If the flag is renamed or removed, this forces the allowlist above to
    // be revisited rather than rotting into dead authority.
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain(
      "syncScope: { pathBase: 'content' | 'project' }",
    );
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain('bypassFilters?: never');
  });

  test('the conflict partition inside sync-engine.ts stays unscoped', () => {
    // The file-level allowlist admits sync-engine.ts wholesale, so it cannot
    // stop the opt from creeping into the merge-conflict partition WITHIN the
    // file. Conflict classification must use the ordinary unscoped content
    // view: editor-visible templates remain content conflicts, while
    // non-document shareable artifacts fail the markdown gate.
    const source = readFileSync(SYNC_ENGINE_PATH, 'utf8');
    const methodBody = (signature: string): string => {
      const start = source.indexOf(signature);
      expect(start, `method not found: ${signature}`).toBeGreaterThan(-1);
      const next = source.indexOf('\n  private ', start + signature.length);
      return source.slice(start, next === -1 ? undefined : next);
    };
    const predicateBody = methodBody('private isContentConflictPath(');
    expect(predicateBody).toContain('isExcluded(');
    expect(predicateBody).not.toContain('isShareableOkArtifact');
    expect(predicateBody).not.toContain('SYNC_STAGING_SCOPE');
    expect(predicateBody).not.toContain('syncScope');

    const handlerBody = methodBody('private async handleMergeConflict(');
    expect(handlerBody).toContain('this.isContentConflictPath(file)');
    expect(handlerBody).not.toContain('SYNC_STAGING_SCOPE');
    expect(handlerBody).not.toContain('syncScope');
  });
});
