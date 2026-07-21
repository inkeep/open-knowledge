import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { confineToContentDir } from './thread-manager.ts';

const notExcluded = (): boolean => false;

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-confine-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('confineToContentDir', () => {
  test('maps in-scope markdown to an extension-less docName', async () => {
    const root = tmp();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'idea.md'), '# hi');
    const result = await confineToContentDir(root, join(root, 'notes', 'idea.md'), notExcluded);
    expect(result.docName).toBe('notes/idea');
    expect(result.rel).toBe('notes/idea.md');
  });

  test('resolves relative paths against the content root', async () => {
    const root = tmp();
    writeFileSync(join(root, 'a.mdx'), 'x');
    const result = await confineToContentDir(root, 'a.mdx', notExcluded);
    expect(result.docName).toBe('a');
  });

  test('maps not-yet-existing markdown (agent creating a doc)', async () => {
    const root = tmp();
    const result = await confineToContentDir(root, join(root, 'new', 'doc.md'), notExcluded);
    expect(result.docName).toBe('new/doc');
  });

  test('non-markdown stays docName-null (plain disk IO path)', async () => {
    const root = tmp();
    const result = await confineToContentDir(root, join(root, 'assets', 'x.png'), notExcluded);
    expect(result.docName).toBeNull();
  });

  test('filter-excluded markdown stays docName-null', async () => {
    const root = tmp();
    const result = await confineToContentDir(root, join(root, 'secret.md'), () => true);
    expect(result.docName).toBeNull();
  });

  test('reserved namespaces stay docName-null', async () => {
    const root = tmp();
    const result = await confineToContentDir(root, join(root, '__system__.md'), notExcluded);
    expect(result.docName).toBeNull();
  });

  test('refuses .. traversal out of the root', async () => {
    const root = tmp();
    await expect(
      confineToContentDir(root, join(root, '..', 'outside.md'), notExcluded),
    ).rejects.toThrow('escapes');
  });

  test('refuses a symlink that points outside the root', async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'target.md'), 'secret');
    symlinkSync(join(outside, 'target.md'), join(root, 'inside.md'));
    await expect(confineToContentDir(root, join(root, 'inside.md'), notExcluded)).rejects.toThrow(
      'escapes',
    );
  });

  test('refuses new paths under an escaping symlinked directory', async () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, 'linked'));
    await expect(
      confineToContentDir(root, join(root, 'linked', 'new.md'), notExcluded),
    ).rejects.toThrow('escapes');
  });
});
