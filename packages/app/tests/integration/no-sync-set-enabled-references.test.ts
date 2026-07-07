/**
 * Regression guard: no client-side code may import or reference the
 * deleted `/api/sync/set-enabled` endpoint or `postSyncEnabled` helper.
 *
 * The endpoint and helper were removed.
 * All client write surfaces now route through
 * `bindConfigDoc.patch` on the project-local binding. A future refactor
 * that re-introduces the HTTP path would split the writer surface back
 * into two (HTTP + CRDT) and bypass the standard config pipeline.
 *
 * This test fails noisily if any new file under `packages/app/src/`
 * mentions the deleted symbols. Source-grep test — fast, no I/O beyond
 * the filesystem walk.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_SRC = join(import.meta.dir, '..', '..', 'src');

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (
      (entry.endsWith('.ts') ||
        entry.endsWith('.tsx') ||
        entry.endsWith('.js') ||
        entry.endsWith('.mjs')) &&
      // Tests reference the deleted strings via .not.toContain assertions.
      // Those are intentional regression guards, not real consumers.
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      yield full;
    }
  }
}

describe('No /api/sync/set-enabled references in client source (regression guard)', () => {
  test('no production source under packages/app/src/ contains "/api/sync/set-enabled"', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(APP_SRC)) {
      const contents = readFileSync(file, 'utf-8');
      if (contents.includes('/api/sync/set-enabled')) {
        offenders.push(file.replace(APP_SRC, 'packages/app/src'));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no production source under packages/app/src/ imports postSyncEnabled', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(APP_SRC)) {
      const contents = readFileSync(file, 'utf-8');
      if (contents.includes('postSyncEnabled')) {
        offenders.push(file.replace(APP_SRC, 'packages/app/src'));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no production source under packages/app/src/ imports from sync-api', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(APP_SRC)) {
      const contents = readFileSync(file, 'utf-8');
      if (contents.includes("'@/lib/sync-api'") || contents.includes('"@/lib/sync-api"')) {
        offenders.push(file.replace(APP_SRC, 'packages/app/src'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
