import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { previewContent } from './preview.ts';

const LINKED_FILE_COUNT = 1500;

let tmpRoot: string;
let fixtureRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-preview-unbounded-'));
  fixtureRoot = realpathSync(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('previewContent — the CLI consumer descends directory symlinks', () => {
  test('counts every markdown file reachable through a directory symlink', () => {
    const bulk = resolve(fixtureRoot, 'bulk');
    const root = resolve(fixtureRoot, 'root');
    mkdirSync(bulk, { recursive: true });
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < LINKED_FILE_COUNT; i += 1) {
      writeFileSync(join(bulk, `f${i}.md`), '# x');
    }
    writeFileSync(join(root, 'a.md'), '# a');
    symlinkSync(bulk, join(root, 'linked'), process.platform === 'win32' ? 'junction' : undefined);

    const result = previewContent({ projectDir: root, contentDir: root });

    expect(result.totalCount).toBe(LINKED_FILE_COUNT + 1);
    expect(result.warnings).toEqual([]);
  });
});
