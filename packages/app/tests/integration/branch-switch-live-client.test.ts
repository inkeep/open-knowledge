/**
 * Branch switch while tab open with dirty content.
 *
 * When a user runs `git checkout <branch>` on a project directory that the
 * OpenKnowledge server is watching, the head-watcher detects the HEAD move,
 * fires BatchBegin (park WIP to shadow refs) → BatchEnd (reset Y.Docs from
 * disk via applyExternalChange → updateYFragment).
 *
 * Unlike the onLoadDocument path, branch switch does NOT destroy the server's
 * Y.Doc — its clientID is preserved. But updateYFragment mass-rewrites Items
 * under the current server clientID to reflect the new branch's disk state.
 * A live client who has synced the pre-switch state holds Items under its own
 * clientID AND the server's pre-switch-contributed items under the SAME server
 * clientID. Post-switch, the server's clientID is the same but its items are
 * replaced structurally.
 *
 * Whether the pre-switch server items reintroduce alongside the new ones on
 * sync-back is a subtly different mechanism from the restart bug — same
 * clientID, different items at same clocks would conflict but not duplicate;
 * different clocks would duplicate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
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

/** Run a git command in `cwd`. Forces empty global config so test identity
 *  doesn't leak into test-created commits. */
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

/** Build a git repo in `contentDir` with:
 *   - `main` branch containing `${docName}.md` = contentA
 *   - `feature` branch containing `${docName}.md` = contentB
 *   - HEAD currently on `main`
 */
async function setupGitRepoWithBranches(
  contentDir: string,
  docName: string,
  contentA: string,
  contentB: string,
): Promise<void> {
  await ensureProjectGit(contentDir);
  // ensureProjectGit initialized .git/. Now set up commits + branches.
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
    // Pre-create contentDir + git setup BEFORE server starts so the initial
    // `persistence.onLoadDocument` sees content A on main.
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-')));
    await setupGitRepoWithBranches(contentDir, 'test-doc', CONTENT_A, CONTENT_B);

    const server = await createRestartableServer({
      contentDir,
      keepContentDir: false,
      gitEnabled: true,
      commitDebounceMs: 500, // keep test brisk; default 30s blows the test budget
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    // Mirror `SystemDocSubscriber` in production: a minimal __system__ provider
    // that routes CC1 `branch-switched` payloads into `handleBranchSwitched`.
    // We don't mount the real React component here because the test runs in
    // bun (not jsdom), and the mechanism — CC1 parse + pool invalidation —
    // is the same code path.
    const systemDoc = new Y.Doc();
    const systemProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: SYSTEM_DOC_NAME,
      document: systemDoc,
      onStateless: ({ payload }: { payload: string }) => {
        const switched = parseCC1BranchSwitched(payload);
        if (switched) {
          // Mirror production wiring in DocumentContext.tsx: update the pool's
          // observed branch BEFORE invalidating, so the recycle's fresh
          // `pool.open()` constructs IDB names under the new-branch prefix.
          pool.setObservedBranch(switched.branch);
          void handleBranchSwitched(pool, switched.branch);
        }
      },
    });
    cleanups.push(async () => {
      systemProvider.destroy();
      systemDoc.destroy();
    });

    // Record every `indexedDB.deleteDatabase` call so the post-switch
    // assertion can confirm the client-side invalidation path fired. Without
    // this spy the test could pass by accident whenever the content just
    // happens to re-converge, without proving the invalidation mechanism ran.
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

    // Mirror production: DocumentContext seeds the pool's observed branch
    // and serverInstanceId from the boot fetch before any doc opens.
    // Without the branch seed, the pool's first IDB attach uses the
    // `_unknown_` sentinel branch. Without the serverInstanceId seed,
    // persistence wouldn't attach at all (epoch-scoped DB names require
    // the live id) and the post-switch deletion would never fire.
    pool.setObservedBranch('main');
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');

    // Wait for sync to main-branch content.
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    // Confirm client sees content A.
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

    // Capture pre-switch disk content for sanity.
    const preSwitchDisk = readFileSync(join(contentDir, 'test-doc.md'), 'utf-8');
    expect(preSwitchDisk.includes('main-sibling')).toBe(true);

    // Execute the branch switch externally (simulates user running `git checkout`).
    git(contentDir, 'checkout feature');

    // Head-watcher's default QUIET_WINDOW_MS = 100ms; BatchEnd fires after that,
    // then the cross-branch reset path rewrites Y.Doc from new disk state.
    // Wait for client's Y.Doc to reflect content B.
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

    // Let persistence settle after the cross-branch reset.
    await wait(500);

    const postSwitchEntry = pool.getActive();
    if (!postSwitchEntry) throw new Error('pool has no active entry post-switch');
    const postSwitchClientIds = clientIdsInDoc(postSwitchEntry.provider.document);
    // Delta across time is computed set-wise — compareClientIds compares two
    // docs at the same instant, but here we're comparing one doc at two times.
    const idsOnlyInPost = [...postSwitchClientIds].filter((id) => !preSwitchClientIds.has(id));
    const idsOnlyInPre = [...preSwitchClientIds].filter((id) => !postSwitchClientIds.has(id));

    console.log('[T5] clientID drift', {
      preSwitch: [...preSwitchClientIds],
      postSwitch: [...postSwitchClientIds],
      idsOnlyInPost,
      idsOnlyInPre,
    });

    // Behavior: client content settles to feature-branch content exactly once.
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

    // Feature branch content present exactly once.
    expect(featureSiblingCount).toBe(1);
    expect(featureHeadingCount).toBe(1);
    // Main branch content must NOT be bleeding through.
    expect(mainSiblingCount).toBe(0);
    expect(mainHeadingCount).toBe(0);

    // Disk content reflects feature-branch state (no bleed through from main).
    const diskAfter = await pollDiskContentStable(
      join(contentDir, 'test-doc.md'),
      (c) => c.includes('feature-sibling'),
      { timeoutMs: 8000, settleMs: 400 },
    );
    expect((diskAfter.match(/\[\[feature-sibling\]\]/g) ?? []).length).toBe(1);
    expect((diskAfter.match(/\[\[main-sibling\]\]/g) ?? []).length).toBe(0);

    // Server-side `.ok/local/ystate/` must not exist — restart recovery
    // moved to client-side y-indexeddb. A leftover directory here would
    // indicate stale scaffolding or a reintroduced sidecar write path.
    const ystateDir = join(contentDir, '.ok', 'local', 'ystate');
    expect(existsSync(ystateDir)).toBe(false);

    // Client-side invalidation fired: `handleBranchSwitched` called
    // `clearData()` on the pool's active persistence, which deletes the
    // OLD-branch-prefixed IDB. The pool's default observed branch on
    // first observation was `main` (the server's startup branch); the
    // epoch-scoped DB name embeds the live `serverInstanceId` between
    // branch and docName, so the deleted DB is
    // `ok-ydoc:main:${serverInstanceId}:test-doc`. The branch-switched
    // CC1 signal rides the __system__ doc's stateless channel and
    // travels independently of the main doc's sync round-trip, so poll
    // to absorb the handshake latency.
    const expectedDbName = `ok-ydoc:main:${serverInstanceId}:test-doc`;
    await pollUntil(() => deletedDbs.includes(expectedDbName), 10_000, 50);
    expect(deletedDbs).toContain(expectedDbName);
  }, 45_000);
});
