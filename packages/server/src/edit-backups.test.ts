import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fnv1aDigest } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { backUpDisplacedVersion } from './edit-backups.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-edit-backups-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

function discarded(...segments: string[]): string {
  return join(home, '.ok', 'edit-backups', 'discarded', ...segments);
}

function contentsOf(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf-8'));
}

describe('backUpDisplacedVersion', () => {
  test('a project document keeps its five newest copies in a folder of its own project, apart from another project with the same file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let n = 1; n <= 6; n++) {
      vi.setSystemTime(Date.UTC(2026, 9, 21, 10, 0, n));
      await backUpDisplacedVersion(home, '/work/alpha', 'flow.mmd', `alpha ${n}\n`, 'flow.mmd');
    }
    const beta = await backUpDisplacedVersion(home, '/work/beta', 'flow.mmd', 'beta\n', 'flow.mmd');

    expect(contentsOf(discarded('projects', fnv1aDigest('/work/alpha'), 'flow.mmd'))).toEqual([
      'alpha 2\n',
      'alpha 3\n',
      'alpha 4\n',
      'alpha 5\n',
      'alpha 6\n',
    ]);
    expect(contentsOf(discarded('projects', fnv1aDigest('/work/beta'), 'flow.mmd'))).toEqual([
      'beta\n',
    ]);
    expect(beta?.display).toBe(
      `~/.ok/edit-backups/discarded/projects/${fnv1aDigest('/work/beta')}/flow.mmd/2026-10-21T10-00-06-000Z.mmd`,
    );
  });

  test('a document with no project keeps the folder it had before', async () => {
    await backUpDisplacedVersion(home, null, '__skill__/global/demo', 'outside\n', 'SKILL.md');

    expect(readdirSync(discarded())).toEqual(['__skill____global__demo']);
    expect(contentsOf(discarded('__skill____global__demo'))).toEqual(['outside\n']);
  });
});
