import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  deriveScanRoots,
  diffMtimes,
  SCAN_WHOLE_TREE,
  snapshotMtimes,
  snapshotMtimesForRoots,
} from './mtime-scan.ts';
import type { Stage } from './parse-command.ts';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(resolve(tmpdir(), 'ok-mtime-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('snapshotMtimes', () => {
  test('captures files at the root and subdirs', async () => {
    writeFileSync(resolve(tmp, 'a.md'), 'a');
    mkdirSync(resolve(tmp, 'sub'), { recursive: true });
    writeFileSync(resolve(tmp, 'sub/b.md'), 'b');

    const { snapshot, truncated } = await snapshotMtimes(tmp);
    expect(truncated).toBe(false);
    expect(snapshot.size).toBe(2);
    expect(snapshot.has('a.md')).toBe(true);
    expect(snapshot.has('sub/b.md')).toBe(true);
  });

  test('skips known OK/system dirs', async () => {
    writeFileSync(resolve(tmp, 'keep.md'), 'k');
    mkdirSync(resolve(tmp, '.git'), { recursive: true });
    writeFileSync(resolve(tmp, '.git/HEAD'), 'ref');
    mkdirSync(resolve(tmp, 'node_modules'), { recursive: true });
    writeFileSync(resolve(tmp, 'node_modules/x.js'), 'x');

    const { snapshot } = await snapshotMtimes(tmp);
    expect(snapshot.size).toBe(1);
    expect(snapshot.has('keep.md')).toBe(true);
  });

  test('returns empty snapshot for an empty dir', async () => {
    const { snapshot, truncated } = await snapshotMtimes(tmp);
    expect(truncated).toBe(false);
    expect(snapshot.size).toBe(0);
  });
});

function stage(...args: string[]): Stage {
  return { command: args[0], args };
}

describe('deriveScanRoots', () => {
  test.each([
    'find -newer ref.md',
    'find -anewer ref.md',
    'find -cnewer ref.md',
    'find -mtime 7',
    'find -mmin 5',
    'find -atime 3',
    'find -amin 3',
    'find -ctime 3',
    'find -cmin 3',
    'find -perm 644',
    'find -links 2',
    'find -inum 12345',
    'find -user root',
    'find -group staff',
    'find -size 1k',
    'find -type f',
    'find -maxdepth 2',
    'find -mindepth 1',
  ])('%s walks the tree, so the sweep watches all of it', (command) => {
    const args = command.split(/\s+/);
    expect(deriveScanRoots([stage(...args)])).toEqual([SCAN_WHOLE_TREE]);
  });

  test.each([
    ['grep -f pats*.txt', [SCAN_WHOLE_TREE]],
    ['sort -T logs* data.txt', [SCAN_WHOLE_TREE]],
    ['find docs -newer other/*.md', ['docs', 'other']],
  ])('%s — a glob a flag supplies is still swept', (command, expected) => {
    const args = command.split(/\s+/);
    expect(deriveScanRoots([stage(...args)]).sort()).toEqual([...expected].sort());
  });

  test('a flag value never narrows the sweep away from the whole tree', () => {
    expect(deriveScanRoots([stage('grep', '-r', '-f', 'pats.txt')])).toEqual([SCAN_WHOLE_TREE]);
    expect(deriveScanRoots([stage('find', '.', '-newer', 'ref.md')]).sort()).toEqual([
      '.',
      'ref.md',
    ]);
  });

  test('cat file operands become roots', () => {
    expect(deriveScanRoots([stage('cat', 'a.md', 'sub/b.md')]).sort()).toEqual([
      'a.md',
      'sub/b.md',
    ]);
  });

  test('bare ls scans the whole tree', () => {
    expect(deriveScanRoots([stage('ls', '-la')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('ls with a dir operand scopes to it', () => {
    expect(deriveScanRoots([stage('ls', 'articles/')])).toEqual(['articles/']);
  });

  test('grep drops the pattern positional but keeps operands', () => {
    const roots = deriveScanRoots([stage('grep', '-rn', 'oauth', 'articles/')]);
    expect(roots).toContain('articles/');
    expect(roots).not.toContain('oauth');
  });

  test('recursive grep with no operand scans the whole tree', () => {
    expect(deriveScanRoots([stage('grep', '-rn', 'oauth')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('non-recursive grep with no operand (stdin) contributes nothing', () => {
    expect(deriveScanRoots([stage('cat', 'a.md'), stage('grep', 'oauth')])).toEqual(['a.md']);
  });

  test('grep -e pattern value is dropped, leaving only path operands', () => {
    expect(deriveScanRoots([stage('grep', '-e', 'oauth', 'articles/')])).toEqual(['articles/']);
  });

  test('recursive grep with -e pattern and no path operand scans the whole tree', () => {
    expect(deriveScanRoots([stage('grep', '-rn', '-e', 'oauth')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('find roots are the leading non-flag args; glob predicates are skipped', () => {
    const roots = deriveScanRoots([stage('find', 'specs', '-name', '*.md')]);
    expect(roots).toContain('specs');
    expect(roots).not.toContain('*.md');
  });

  test('find literal predicate values stay watched', () => {
    expect(deriveScanRoots([stage('find', 'specs', '-newer', 'ref.md')])).toEqual(
      expect.arrayContaining(['ref.md', 'specs']),
    );
  });

  test('find with no path root scans the whole tree', () => {
    expect(deriveScanRoots([stage('find', '-name', 'SPEC.md')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('glob operand reduces to its literal dir prefix', () => {
    expect(deriveScanRoots([stage('cat', 'articles/*.md')])).toEqual(['articles']);
  });

  test('bare glob operand scans the whole tree', () => {
    expect(deriveScanRoots([stage('cat', '*.md')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('glob-bearing attached flag values are match patterns, not paths', () => {
    const roots = deriveScanRoots([stage('grep', '-rn', '--include=*.md', 'oauth', 'articles/')]);
    expect(roots).toContain('articles/');
    expect(roots).not.toContain('*.md');
  });

  test('literal attached flag values are watched as candidate write targets', () => {
    expect(deriveScanRoots([stage('sort', '--weird=out.md', 'in.md')]).sort()).toEqual([
      'in.md',
      'out.md',
    ]);
  });

  test('stdin consumers with no operand contribute nothing', () => {
    expect(deriveScanRoots([stage('cat', 'a.md'), stage('head', '-5'), stage('wc', '-l')])).toEqual(
      ['a.md'],
    );
  });

  test('whole-tree subsumes every other root', () => {
    expect(deriveScanRoots([stage('cat', 'a.md'), stage('ls')])).toEqual([SCAN_WHOLE_TREE]);
  });

  test('grep-derived whole tree subsumes other pipeline operands', () => {
    expect(deriveScanRoots([stage('grep', '-rn', 'oauth'), stage('cat', 'a.md')])).toEqual([
      SCAN_WHOLE_TREE,
    ]);
  });

  test('find-derived whole tree subsumes other pipeline operands', () => {
    expect(deriveScanRoots([stage('find', '-name', 'SPEC.md'), stage('cat', 'a.md')])).toEqual([
      SCAN_WHOLE_TREE,
    ]);
  });
});

describe('snapshotMtimesForRoots', () => {
  test('file root records only that file', async () => {
    writeFileSync(resolve(tmp, 'a.md'), 'a');
    writeFileSync(resolve(tmp, 'b.md'), 'b');

    const { snapshot, truncated } = await snapshotMtimesForRoots(tmp, ['a.md']);
    expect(truncated).toBe(false);
    expect([...snapshot.keys()]).toEqual(['a.md']);
  });

  test('dir root walks its subtree, not siblings', async () => {
    mkdirSync(resolve(tmp, 'sub/nested'), { recursive: true });
    writeFileSync(resolve(tmp, 'sub/a.md'), 'a');
    writeFileSync(resolve(tmp, 'sub/nested/b.md'), 'b');
    writeFileSync(resolve(tmp, 'outside.md'), 'o');

    const { snapshot } = await snapshotMtimesForRoots(tmp, ['sub']);
    expect([...snapshot.keys()].sort()).toEqual(['sub/a.md', 'sub/nested/b.md']);
  });

  test('missing root: creation during exec is caught by pre/post diff', async () => {
    const before = (await snapshotMtimesForRoots(tmp, ['new.md'])).snapshot;
    writeFileSync(resolve(tmp, 'new.md'), 'created');
    const after = (await snapshotMtimesForRoots(tmp, ['new.md'])).snapshot;
    expect(diffMtimes(before, after).changed).toEqual(['new.md']);
  });

  test('overlapping roots dedupe (dir + file inside it)', async () => {
    mkdirSync(resolve(tmp, 'sub'), { recursive: true });
    writeFileSync(resolve(tmp, 'sub/a.md'), 'a');

    const { snapshot } = await snapshotMtimesForRoots(tmp, ['sub', 'sub/a.md']);
    expect([...snapshot.keys()]).toEqual(['sub/a.md']);
  });

  test('cap truncates and reports it', async () => {
    writeFileSync(resolve(tmp, 'a.md'), 'a');
    writeFileSync(resolve(tmp, 'b.md'), 'b');
    writeFileSync(resolve(tmp, 'c.md'), 'c');

    const { snapshot, truncated } = await snapshotMtimesForRoots(tmp, [SCAN_WHOLE_TREE], 2);
    expect(truncated).toBe(true);
    expect(snapshot.size).toBe(2);
  });

  test('exactly-at-cap is not truncated', async () => {
    writeFileSync(resolve(tmp, 'a.md'), 'a');
    writeFileSync(resolve(tmp, 'b.md'), 'b');

    const { truncated } = await snapshotMtimesForRoots(tmp, [SCAN_WHOLE_TREE], 2);
    expect(truncated).toBe(false);
  });

  test('roots inside skipped dirs stay outside the coverage domain', async () => {
    mkdirSync(resolve(tmp, 'node_modules/pkg'), { recursive: true });
    writeFileSync(resolve(tmp, 'node_modules/pkg/x.md'), 'x');

    const { snapshot } = await snapshotMtimesForRoots(tmp, ['node_modules/pkg']);
    expect(snapshot.size).toBe(0);
  });

  test('root with a skipped dir in a middle segment stays outside the coverage domain', async () => {
    mkdirSync(resolve(tmp, 'content/node_modules/pkg'), { recursive: true });
    writeFileSync(resolve(tmp, 'content/node_modules/pkg/x.md'), 'x');

    const { snapshot } = await snapshotMtimesForRoots(tmp, ['content/node_modules/pkg']);
    expect(snapshot.size).toBe(0);
  });

  test('whole-tree sentinel matches snapshotMtimes', async () => {
    writeFileSync(resolve(tmp, 'a.md'), 'a');
    mkdirSync(resolve(tmp, 'sub'), { recursive: true });
    writeFileSync(resolve(tmp, 'sub/b.md'), 'b');

    const scoped = await snapshotMtimesForRoots(tmp, [SCAN_WHOLE_TREE]);
    const full = await snapshotMtimes(tmp);
    expect([...scoped.snapshot.keys()].sort()).toEqual([...full.snapshot.keys()].sort());
  });
});

describe('diffMtimes', () => {
  test('empty before + empty after → no changes', () => {
    const result = diffMtimes(new Map(), new Map());
    expect(result.changed).toEqual([]);
  });

  test('identical snapshots → no changes', () => {
    const snap = new Map([
      ['a.md', 1234],
      ['b.md', 5678],
    ]);
    const result = diffMtimes(snap, new Map(snap));
    expect(result.changed).toEqual([]);
  });

  test('mtime change → reported', () => {
    const before = new Map([['a.md', 1000]]);
    const after = new Map([['a.md', 2000]]);
    expect(diffMtimes(before, after).changed).toEqual(['a.md']);
  });

  test('new file → reported', () => {
    const before = new Map([['a.md', 1000]]);
    const after = new Map([
      ['a.md', 1000],
      ['b.md', 2000],
    ]);
    expect(diffMtimes(before, after).changed).toEqual(['b.md']);
  });

  test('deleted file → reported', () => {
    const before = new Map([
      ['a.md', 1000],
      ['b.md', 2000],
    ]);
    const after = new Map([['a.md', 1000]]);
    expect(diffMtimes(before, after).changed).toEqual(['b.md']);
  });

  test('full round-trip: write → snapshot → touch → snapshot → diff', async () => {
    const tmp2 = await mkdtemp(resolve(tmpdir(), 'ok-mtime-rt-'));
    try {
      writeFileSync(resolve(tmp2, 'a.md'), 'v1');
      const before = (await snapshotMtimes(tmp2)).snapshot;
      await wait(15);
      writeFileSync(resolve(tmp2, 'a.md'), 'v2');
      const after = (await snapshotMtimes(tmp2)).snapshot;
      expect(diffMtimes(before, after).changed).toEqual(['a.md']);
    } finally {
      await rm(tmp2, { recursive: true, force: true });
    }
  });
});

describe('deriveScanRoots — over-inclusion is the correct bias for a detective layer', () => {
  test('an extension-less attached write target is still watched', () => {
    expect(deriveScanRoots([stage('sort', '--out=notes', 'other.md')])).toContain('notes');
    expect(deriveScanRoots([stage('sort', '-onotes', 'other.md')])).toContain('notes');
  });

  test('a delimiter argument never becomes a scan root', () => {
    expect(deriveScanRoots([stage('cut', '-d.', '-f1', 'other.md')])).not.toContain('.');
    expect(deriveScanRoots([stage('sort', '-t.', 'other.md')])).not.toContain('.');
    expect(deriveScanRoots([stage('cut', '-d/', '-f1', 'other.md')])).not.toContain('/');
  });

  test('the scan base is what resolveWithinRoot turns into the whole-tree sentinel', () => {
    expect(SCAN_WHOLE_TREE).toBe('');
    expect(deriveScanRoots([stage('cut', '-d.', '-f1', 'other.md')])).toContain('other.md');
  });
});

describe('deriveScanRoots — a match-pattern flag value is not a path', () => {
  test('an exclude-dir value does not become a root the sweep then walks', () => {
    const roots = deriveScanRoots([stage('grep', '-rn', '--exclude-dir=node_modules', 'x', 'a/')]);
    expect(roots).toContain('a/');
    expect(roots).not.toContain('node_modules');
  });
});
