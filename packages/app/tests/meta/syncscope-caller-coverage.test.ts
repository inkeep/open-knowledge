import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
const APP_SRC_ROOT = join(import.meta.dirname, '../../src');
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
const SYNC_ENGINE_PATH = join(SERVER_SRC_ROOT, 'sync-engine.ts');

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
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain(
      "syncScope: { pathBase: 'content' | 'project' }",
    );
    expect(readFileSync(CONTENT_FILTER_PATH, 'utf8')).toContain('bypassFilters?: never');
  });

  test('the conflict partition inside sync-engine.ts stays unscoped', () => {
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
