import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { previewContent } from '@inkeep/open-knowledge';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runProbe } from './consent-dialog.ts';

let tmpRoot: string;
let fixtureRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-probe-descent-'));
  fixtureRoot = realpathSync(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedBulkBehindDirectorySymlink(fileCount: number, extension: string): string {
  const bulk = resolve(fixtureRoot, 'bulk');
  const root = resolve(fixtureRoot, 'root');
  mkdirSync(bulk, { recursive: true });
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(bulk, `f${i}${extension}`), '');
  }
  writeFileSync(join(root, 'a.md'), '# a');
  symlinkSync(bulk, join(root, 'linked'), process.platform === 'win32' ? 'junction' : undefined);
  return root;
}

describe('runProbe — the guard verdict bounds the walk it authorises', () => {
  test('truncates rather than handing a symlinked over-cap tree to previewContent', async () => {
    const walkCap = 60;
    const root = seedBulkBehindDirectorySymlink(walkCap, '.txt');

    const result = await runProbe(
      previewContent,
      root,
      { contentDir: '.' },
      { walkCapForTests: walkCap },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(walkCap);
  });
});
