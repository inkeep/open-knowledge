import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { handleBranchSwitched } from '../../src/editor/branch-invalidation';
import { ProviderPool } from '../../src/editor/provider-pool';
import { parseCC1BranchSwitched, SYSTEM_DOC_NAME } from '../../src/lib/cc1';
import {
  clientIdsInDoc,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
  seedPoolServerInstanceId,
} from './test-harness';

const CONTENT_A = `# Main Branch Doc

Content on main branch.

[[main-sibling]]
`;

const CONTENT_B = `# Feature Branch Doc

Content on feature branch.

[[feature-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function setupGitRepoWithBranches(
  contentDir: string,
  docName: string,
  contentA: string,
  contentB: string,
): Promise<void> {
  await ensureProjectGit(contentDir);
  git(contentDir, 'config user.name test');
  git(contentDir, 'config user.email test@test.local');
  writeFileSync(join(contentDir, `${docName}.md`), contentA, 'utf-8');
  git(contentDir, 'add .');
  git(contentDir, 'commit -m content-A');
  git(contentDir, 'checkout -b feature');
  writeFileSync(join(contentDir, `${docName}.md`), contentB, 'utf-8');
  git(contentDir, 'add .');
  git(contentDir, 'commit -m content-B');
  git(contentDir, 'checkout main');
}

describe('T5: Branch switch while tab open', () => {
  test('REPRO: tab synced to main, switch to feature — content settles to B without bleed', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-')));
    await setupGitRepoWithBranches(contentDir, 'test-doc', CONTENT_A, CONTENT_B);

    const server = await createRestartableServer({
      contentDir,
      keepContentDir: false,
      gitEnabled: true,
      commitDebounceMs: 500,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    const systemDoc = new Y.Doc();
    const systemProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: SYSTEM_DOC_NAME,
      document: systemDoc,
      onStateless: ({ payload }: { payload: string }) => {
        const switched = parseCC1BranchSwitched(payload);
        if (switched) {
          pool.setObservedBranch(switched.branch);
          void handleBranchSwitched(pool, switched.branch);
        }
      },
    });
    cleanups.push(async () => {
      systemProvider.destroy();
      systemDoc.destroy();
    });

    const originalDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    const deletedDbs: string[] = [];
    type DeleteDatabaseFn = typeof indexedDB.deleteDatabase;
    (indexedDB as { deleteDatabase: DeleteDatabaseFn }).deleteDatabase = ((
      name: string,
      options?: IDBDatabaseInfo,
    ) => {
      deletedDbs.push(name);
      return (originalDeleteDatabase as (n: string, o?: IDBDatabaseInfo) => IDBOpenDBRequest)(
        name,
        options,
      );
    }) as DeleteDatabaseFn;
    cleanups.push(() => {
      (indexedDB as { deleteDatabase: DeleteDatabaseFn }).deleteDatabase = originalDeleteDatabase;
    });

    pool.setObservedBranch('main');
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    await pollUntil(
      () =>
        pool.getActive()?.provider.document.getText('source').toString().includes('main-sibling') ??
        false,
      8000,
      50,
    );

    const preSwitchEntry = pool.getActive();
    if (!preSwitchEntry) throw new Error('pool has no active entry pre-switch');
    const preSwitchClientIds = clientIdsInDoc(preSwitchEntry.provider.document);

    const preSwitchDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(preSwitchDisk.includes('main-sibling')).toBe(true);

    git(contentDir, 'checkout feature');

    await pollUntil(
      () =>
        pool
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes('feature-sibling') ?? false,
      10_000,
      50,
    );

    await wait(500);

    const postSwitchEntry = pool.getActive();
    if (!postSwitchEntry) throw new Error('pool has no active entry post-switch');
    const postSwitchClientIds = clientIdsInDoc(postSwitchEntry.provider.document);
    const idsOnlyInPost = [...postSwitchClientIds].filter((id) => !preSwitchClientIds.has(id));
    const idsOnlyInPre = [...preSwitchClientIds].filter((id) => !postSwitchClientIds.has(id));

    console.log('[T5] clientID drift', {
      preSwitch: [...preSwitchClientIds],
      postSwitch: [...postSwitchClientIds],
      idsOnlyInPost,
      idsOnlyInPre,
    });

    const clientText = postSwitchEntry.provider.document.getText('source').toString();
    const featureSiblingCount = (clientText.match(/\[\[feature-sibling\]\]/g) ?? []).length;
    const mainSiblingCount = (clientText.match(/\[\[main-sibling\]\]/g) ?? []).length;
    const featureHeadingCount = (clientText.match(/# Feature Branch Doc/g) ?? []).length;
    const mainHeadingCount = (clientText.match(/# Main Branch Doc/g) ?? []).length;

    console.log('[T5] client content marker counts', {
      featureSibling: featureSiblingCount,
      mainSibling: mainSiblingCount,
      featureHeading: featureHeadingCount,
      mainHeading: mainHeadingCount,
      clientBytes: clientText.length,
    });

    expect(featureSiblingCount).toBe(1);
    expect(featureHeadingCount).toBe(1);
    expect(mainSiblingCount).toBe(0);
    expect(mainHeadingCount).toBe(0);

    const diskAfter = await pollDiskContentStable(
      join(contentDir, 'test-doc.md'),
      (c) => c.includes('feature-sibling'),
      { timeoutMs: 8000, settleMs: 400 },
    );
    expect((diskAfter.match(/\[\[feature-sibling\]\]/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/\[\[main-sibling\]\]/g) ?? []).length).toBe(0);

    const ystateDir = join(contentDir, '.ok', 'local', 'ystate');
    expect(existsSync(ystateDir)).toBe(false);

    const expectedDbName = `ok-ydoc:main:${serverInstanceId}:test-doc`;
    await pollUntil(() => deletedDbs.includes(expectedDbName), 10_000, 50);
    expect(deletedDbs).toContain(expectedDbName);
  }, 45_000);
});
