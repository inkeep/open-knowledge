import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in this
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { formatOkActor, type OkActorEntry } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import {
  commitUpstreamImport,
  commitWip,
  initShadowRepo,
  saveVersion,
  type WriterIdentity,
} from '../shadow-repo.ts';
import { readShadowLog } from './shadow-log.ts';

/** Build a realistic WIP commit body with an ok-actor line (as the persistence
 *  write path does in production — the saveVersion fallback attributes from it). */
function wipBody(subject: string, writerId: string, displayName: string): string {
  const actor: OkActorEntry = {
    v: 1,
    writer_id: writerId,
    principal: null,
    agent_session: writerId,
    agent_type: null,
    client_name: null,
    client_version: null,
    label: null,
    display_name: displayName,
    color_seed: writerId,
    docs: ['content/auth'],
  };
  return `${subject}\n\n${formatOkActor(actor)}`;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-shadow-log-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function bootstrapProject(): Promise<string> {
  const project = resolve(tmpDir, 'project');
  mkdirSync(project, { recursive: true });
  const git = simpleGit(project);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 't@t.test');
  writeFileSync(resolve(project, 'README.md'), '# root\n');
  await git.add('README.md');
  await git.commit('init');
  return project;
}

describe('readShadowLog — absent shadow repo', () => {
  test('returns source="shadow-repo-absent" and empty commits', async () => {
    const project = await bootstrapProject();
    const result = await readShadowLog(project, 'articles/auth.md');
    expect(result.source).toBe('shadow-repo-absent');
    expect(result.commits).toEqual([]);
  });

  test('returns shadow-repo-absent when project is not a git repo at all', async () => {
    const project = resolve(tmpDir, 'not-git');
    mkdirSync(project, { recursive: true });
    const result = await readShadowLog(project, 'articles/auth.md');
    expect(result.source).toBe('shadow-repo-absent');
  });
});

describe('readShadowLog — single writer ref', () => {
  test('single commit on an agent ref surfaces with classification=agent', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '# auth v1\n');
    const writer: WriterIdentity = { id: 'agent-x', name: 'Agent X', email: 'a@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    await commitWip(shadow, writer, contentDir, 'add auth doc', branch);

    const { commits, source } = await readShadowLog(project, 'content/auth.md', 5);
    expect(source).toBe('shadow-repo');
    expect(commits.length).toBe(1);
    expect(commits[0].writerId).toBe('agent-x');
    expect(commits[0].writerName).toBe('Agent X');
    expect(commits[0].writerClassification).toBe('agent');
    expect(commits[0].isAgent).toBe(true);
    expect(commits[0].message).toBe('add auth doc');
    expect(commits[0].branch).toBe(branch);
    expect(commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('principal-prefixed writer id → classification=principal, isAgent=false (D34)', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '# v1\n');
    const writer: WriterIdentity = { id: 'principal-tim', name: 'Tim', email: 't@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    await commitWip(shadow, writer, contentDir, 'human edit', branch);

    const { commits } = await readShadowLog(project, 'content/auth.md', 5);
    expect(commits[0].writerClassification).toBe('principal');
    expect(commits[0].isAgent).toBe(false);
  });
});

describe('readShadowLog — multi-writer merge', () => {
  test('commits from multiple writer refs merge by committer date descending', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    const authPath = resolve(contentDir, 'auth.md');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    const agent: WriterIdentity = { id: 'agent-a', name: 'A', email: 'a@t.test' };
    const principal: WriterIdentity = { id: 'principal-b', name: 'B', email: 'b@t.test' };

    // Explicit increasing commit dates make the committer-date ordering
    // deterministic without >1s real-time waits (git dates are 1s-granular).
    writeFileSync(authPath, '# v1\n');
    await commitWip(shadow, agent, contentDir, 'agent first', branch, {
      date: '2026-05-05T12:00:01+00:00',
    });
    writeFileSync(authPath, '# v2\n');
    await commitWip(shadow, principal, contentDir, 'principal second', branch, {
      date: '2026-05-05T12:00:02+00:00',
    });
    writeFileSync(authPath, '# v3\n');
    await commitWip(shadow, agent, contentDir, 'agent third', branch, {
      date: '2026-05-05T12:00:03+00:00',
    });

    const { commits } = await readShadowLog(project, 'content/auth.md', 10);
    expect(commits.length).toBe(3);
    expect(commits[0].message).toBe('agent third');
    expect(commits[0].writerClassification).toBe('agent');
    expect(commits[1].message).toBe('principal second');
    expect(commits[1].writerClassification).toBe('principal');
    expect(commits[2].message).toBe('agent first');
    expect(commits[0].date > commits[1].date).toBe(true);
    expect(commits[1].date > commits[2].date).toBe(true);
  }, 10000);

  test('limit caps the merged result globally', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    const authPath = resolve(contentDir, 'auth.md');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    const writer: WriterIdentity = { id: 'agent-a', name: 'A', email: 'a@t.test' };

    for (let i = 0; i < 4; i++) {
      writeFileSync(authPath, `# v${i}\n`);
      // Increasing per-iteration date → deterministic ordering, no real-time wait.
      await commitWip(shadow, writer, contentDir, `edit ${i}`, branch, {
        date: `2026-05-05T12:00:0${i + 1}+00:00`,
      });
    }

    const { commits } = await readShadowLog(project, 'content/auth.md', 2);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe('edit 3');
    expect(commits[1].message).toBe('edit 2');
  }, 10000);
});

describe('readShadowLog — upstream and empty cases', () => {
  test('upstream-imported commit → classification=classified-git-upstream, isAgent=null (D34)', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '# upstream version\n');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    const oldHead = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const newHead = 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9';
    await commitUpstreamImport(shadow, contentDir, oldHead, newHead, branch);

    const { commits } = await readShadowLog(project, 'content/auth.md', 5);
    expect(commits.length).toBe(1);
    expect(commits[0].writerId).toBe('git-upstream');
    expect(commits[0].writerClassification).toBe('classified-git-upstream');
    expect(commits[0].isAgent).toBe(null);
    expect(commits[0].message).toBe('import: from a1b2c3d4..f0e1d2c3');
  });

  test('shadow repo present but no edits on path → source="shadow-repo", commits=[]', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'other.md'), 'other\n');
    const writer: WriterIdentity = { id: 'agent-x', name: 'X', email: 'x@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    await commitWip(shadow, writer, contentDir, 'edit other', branch);

    const { commits, source } = await readShadowLog(project, 'content/auth.md', 5);
    expect(source).toBe('shadow-repo');
    expect(commits).toEqual([]);
  });
});

describe('readShadowLog — FR14 summaries carry through (US-007)', () => {
  // This test fabricates a shadow commit with a hand-written `ok-contributors:`
  // body line in the new shape (with `summaries`), then asserts that
  // `readShadowLog` surfaces the summaries on `commits[i].contributors[*]`
  // WITHOUT any CLI-side code change. The enrichment path flows through the
  // existing `parseContributors` call — once the parser accepts
  // the field, exec/read_document see it for free.
  test('summaries on the body line surface in commit.contributors[*].summaries', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    const authPath = resolve(contentDir, 'auth.md');
    writeFileSync(authPath, '# auth v1\n');
    const writer: WriterIdentity = { id: 'agent-c', name: 'Claude', email: 'c@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    // Commit message body that mimics what `formatContributorsFrom` emits.
    const body = [
      'WIP auto-save 2026-04-21T00:00:00.000Z',
      '',
      'ok-contributors: {"v":1,"id":"agent-c","name":"Claude","colorSeed":"seed","docs":["content/auth"],"summaries":["Fixed token-refresh race","Added unit test"]}',
    ].join('\n');

    await commitWip(shadow, writer, contentDir, body, branch);

    const { commits } = await readShadowLog(project, 'content/auth.md', 5);
    expect(commits).toHaveLength(1);
    expect(commits[0].contributors).toHaveLength(1);
    expect(commits[0].contributors[0].summaries).toEqual([
      'Fixed token-refresh race',
      'Added unit test',
    ]);
  });

  test('legacy body without summaries field → contributors[*].summaries is undefined', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    const authPath = resolve(contentDir, 'auth.md');
    writeFileSync(authPath, '# v1\n');
    const writer: WriterIdentity = { id: 'agent-legacy', name: 'Legacy', email: 'l@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    // Legacy body (no `summaries` key) — identical to what shipped commits contain today.
    const body = [
      'WIP auto-save 2026-04-10T00:00:00.000Z',
      '',
      'ok-contributors: {"v":1,"id":"agent-legacy","name":"Legacy","colorSeed":"x","docs":["content/auth"]}',
    ].join('\n');

    await commitWip(shadow, writer, contentDir, body, branch);

    const { commits } = await readShadowLog(project, 'content/auth.md', 5);
    expect(commits).toHaveLength(1);
    expect(commits[0].contributors[0].summaries).toBeUndefined();
  });
});

describe('readShadowLog — checkpoint-ancestry fallback (PRD-6972 FR7 / D15)', () => {
  test('enriched read parity across a consolidation (WIP refs gone, checkpoint anchors)', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    const writer: WriterIdentity = { id: 'agent-z', name: 'Agent Z', email: 'z@t.test' };

    for (let i = 1; i <= 3; i++) {
      writeFileSync(resolve(contentDir, 'auth.md'), `# v${i}\n`);
      await commitWip(
        shadow,
        writer,
        contentDir,
        wipBody(`edit ${i}`, 'agent-z', 'Agent Z'),
        branch,
      );
      await wait(5);
    }

    const before = await readShadowLog(project, 'content/auth.md', 5);
    expect(before.commits.length).toBe(3);

    // Consolidate: folds the writer's chain into an auto-consolidation checkpoint
    // and deletes its WIP ref — exactly the post-consolidation state.
    await saveVersion(shadow, contentDir, [writer], branch, undefined, {
      checkpointKind: { foldedRefs: 1, trigger: 'dead-chain' },
    });

    const after = await readShadowLog(project, 'content/auth.md', 5);
    // Same top recent activity as before — surfaced via the checkpoint ancestry.
    expect(after.commits.map((c) => c.hash).sort()).toEqual(
      before.commits.map((c) => c.hash).sort(),
    );
    // The consolidation checkpoint itself is NOT surfaced as activity.
    expect(after.commits.every((c) => !c.message.startsWith('checkpoint:'))).toBe(true);
    // Attribution preserved via the ok-actor body line (the ref name is gone).
    expect(after.commits.every((c) => c.writerId === 'agent-z')).toBe(true);
    expect(after.commits.every((c) => c.writerClassification === 'agent')).toBe(true);
  });

  test('no checkpoint + no WIP refs → still empty (no false fallback)', async () => {
    const project = await bootstrapProject();
    await initShadowRepo(project);
    const result = await readShadowLog(project, 'content/auth.md', 5);
    expect(result.source).toBe('shadow-repo');
    expect(result.commits).toEqual([]);
  });
});
