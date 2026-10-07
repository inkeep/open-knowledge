import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recordContributor, swapContributors } from './contributor-tracker.ts';
import { createPersistenceExtension } from './persistence.ts';
import {
  appendRenameLogEntry,
  getOrLoadRenameLogIndex,
  loadRenameLogIndex,
  type RenameLogEntry,
  resetRenameLogIndexCache,
} from './rename-log.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

const commitHooks = vi.hoisted(() => ({
  beforeWriterCommit: undefined as undefined | (() => void),
}));

vi.mock('./shadow-repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shadow-repo.ts')>();
  return {
    ...actual,
    commitWipFromTree: (...args: Parameters<typeof actual.commitWipFromTree>) => {
      const hook = commitHooks.beforeWriterCommit;
      commitHooks.beforeWriterCommit = undefined;
      hook?.();
      return actual.commitWipFromTree(...args);
    },
  };
});

const WRITER = { id: 'agent-mover', name: 'Mover' };

let tmpDir: string;
let contentDir: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-backfill-'));
  contentDir = join(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  shadow = await initShadowRepo(tmpDir);
  swapContributors();
  resetRenameLogIndexCache();
});

afterEach(() => {
  commitHooks.beforeWriterCommit = undefined;
  swapContributors();
  resetRenameLogIndexCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

function renameOnDisk(from: string, to: string): void {
  renameSync(join(contentDir, `${from}.md`), join(contentDir, `${to}.md`));
  const entry: RenameLogEntry = {
    v: 1,
    from,
    to,
    at: new Date().toISOString(),
    commitSha: '',
    branch: 'main',
    groupId: `${from}-${to}`,
    kind: 'file',
    actor: { writerId: WRITER.id, displayName: WRITER.name },
  };
  appendRenameLogEntry(shadow.gitDir, entry, getOrLoadRenameLogIndex(shadow.gitDir), shadow);
  recordContributor(to, WRITER.id, WRITER.name, WRITER.id, undefined, undefined, undefined, [
    { from, to },
  ]);
}

async function treePaths(sha: string): Promise<string[]> {
  const listing = await shadowGit(shadow).raw('ls-tree', '-r', '--name-only', sha);
  return listing.split('\n').filter((line) => line.length > 0);
}

describe('rename-log commitSha backfill', () => {
  test('a history commit only claims renames that were on disk when its tree was built', async () => {
    writeFileSync(join(contentDir, 'alpha.md'), '# alpha\n');
    writeFileSync(join(contentDir, 'gamma.md'), '# gamma\n');
    const persistence = createPersistenceExtension({
      contentDir,
      projectDir: tmpDir,
      contentRoot: 'content',
      shadowRef: { current: shadow },
      commitDebounceMs: 600_000,
    });

    renameOnDisk('alpha', 'beta');
    commitHooks.beforeWriterCommit = () => renameOnDisk('gamma', 'delta');
    await persistence.flushContributors();
    await persistence.flushContributors();

    const entries = [...loadRenameLogIndex(shadow.gitDir).byTo.values()];
    expect(entries.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'alpha->beta',
      'gamma->delta',
    ]);
    for (const entry of entries) {
      expect(entry.commitSha, `${entry.from}->${entry.to}`).toMatch(/^[0-9a-f]{40}$/);
      expect(await treePaths(entry.commitSha), `${entry.from}->${entry.to}`).toContain(
        `content/${entry.to}.md`,
      );
    }
  });
});
