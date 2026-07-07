import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { formatOkActor, type OkActorEntry } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import {
  appendRenameLogEntry,
  createEmptyIndex,
  type RenameLogEntry,
  resetRenameLogIndexCache,
  setRenameLogIndex,
} from './rename-log.ts';
import {
  buildWipTree,
  commitUpstreamImport,
  commitWip,
  commitWipFromTree,
  initShadowRepo,
  type ParkableDoc,
  parkBranch,
  SERVICE_WRITER,
  type ShadowHandle,
  saveVersion,
  type WriterIdentity,
} from './shadow-repo';
import { getDocumentHistory, historyWalkCap } from './timeline-query';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-timeline-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Set up a project + shadow for tests. */
async function setup() {
  const projectRoot = resolve(tmpDir, 'project');
  const contentDir = resolve(projectRoot, 'content/docs');
  mkdirSync(contentDir, { recursive: true });

  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');

  // Initial project commit so HEAD exists
  writeFileSync(resolve(contentDir, 'intro.md'), '# Hello\n');
  await git.add('.');
  await git.commit('Initial commit');

  const shadow = await initShadowRepo(projectRoot);
  return { projectRoot, contentDir, shadow };
}

const human: WriterIdentity = {
  id: 'human-ada',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
};

const agent: WriterIdentity = {
  id: 'agent-cursor',
  name: 'cursor-agent',
  email: 'cursor@openknowledge.local',
};

/**
 * Per-test dated `commitWip`/`saveVersion` helpers. Every commit and checkpoint
 * gets a strictly increasing timestamp (1s apart) so the history walk orders
 * deterministically. Git committer dates are 1-second-granular, so commits in
 * the same second sort ambiguously — this replaces the >1s real-time sleeps the
 * multi-cycle rename tests previously inserted between cycles to force a tick.
 */
function datedCommits(shadow: ShadowHandle) {
  let t = Date.parse('2026-05-05T12:00:00.000Z');
  const next = () => {
    t += 1000;
    return new Date(t).toISOString();
  };
  return {
    cw: (message: string) =>
      commitWip(shadow, human, 'content/docs', message, 'main', { date: next() }),
    sv: () => saveVersion(shadow, 'content/docs', [human], 'main', undefined, { date: next() }),
  };
}

describe('getDocumentHistory', () => {
  test('returns empty result when shadow has no commits', async () => {
    const { shadow } = await setup();
    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test('returns WIP entries as flat list when no checkpoints exist', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Edit 1\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: first human edit');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Edit 2\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: second human edit');

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');

    expect(result.entries.length).toBe(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.entries.every((e) => e.type === 'wip')).toBe(true);
  });

  test('classifies entry types from commit message prefix', async () => {
    const { contentDir, shadow } = await setup();

    // WIP commit
    writeFileSync(resolve(contentDir, 'intro.md'), '# WIP\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human edit');

    // Upstream commit
    writeFileSync(resolve(contentDir, 'intro.md'), '# Upstream\n');
    await commitUpstreamImport(shadow, 'content/docs', 'abc', 'def');

    // Checkpoint (Save Version)
    writeFileSync(resolve(contentDir, 'intro.md'), '# Checkpoint\n');
    await saveVersion(shadow, 'content/docs', [human]);

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');

    const types = result.entries.map((e) => e.type);
    expect(types).toContain('wip');
    expect(types).toContain('upstream');
    expect(types).toContain('checkpoint');
  });

  test('interleaves entries from multiple writers by author date', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Human 1\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human edit 1');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Agent 1\n');
    await commitWip(shadow, agent, 'content/docs', 'WIP: agent edit 1');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Human 2\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human edit 2');

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');

    // All 3 entries should appear, from both authors
    expect(result.entries.length).toBe(3);
    const authorEmails = result.entries.map((e) => e.authorEmail);
    expect(authorEmails).toContain(human.email);
    expect(authorEmails).toContain(agent.email);
  });

  test('type=checkpoint fast path returns only checkpoints', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# v1\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: v1');
    await saveVersion(shadow, 'content/docs', [human]);

    writeFileSync(resolve(contentDir, 'intro.md'), '# v2\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: v2');

    const result = await getDocumentHistory(
      shadow,
      { docName: 'intro', type: 'checkpoint' },
      'content/docs',
    );

    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.type).toBe('checkpoint');
  });

  test('supports filtering by author name/email', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Human\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Agent\n');
    await commitWip(shadow, agent, 'content/docs', 'WIP: agent');

    const result = await getDocumentHistory(
      shadow,
      {
        docName: 'intro',
        author: human.email,
      },
      'content/docs',
    );

    expect(result.entries.every((e) => e.authorEmail === human.email)).toBe(true);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  });

  test('supports excludeAuthor filter', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Human\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Agent\n');
    await commitWip(shadow, agent, 'content/docs', 'WIP: agent');

    const result = await getDocumentHistory(
      shadow,
      {
        docName: 'intro',
        excludeAuthor: agent.email,
      },
      'content/docs',
    );

    expect(result.entries.every((e) => e.authorEmail !== agent.email)).toBe(true);
  });

  test('supports limit/offset pagination', async () => {
    const { contentDir, shadow } = await setup();

    for (let i = 1; i <= 5; i++) {
      writeFileSync(resolve(contentDir, 'intro.md'), `# Edit ${i}\n`);
      await commitWip(shadow, human, 'content/docs', `WIP: edit ${i}`);
    }

    const page1 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 2, offset: 0 },
      'content/docs',
    );
    expect(page1.entries.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.hasMore).toBe(true);

    const page2 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 2, offset: 2 },
      'content/docs',
    );
    expect(page2.entries.length).toBe(2);
    expect(page2.hasMore).toBe(true);

    const page3 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 2, offset: 4 },
      'content/docs',
    );
    expect(page3.entries.length).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  test('entries have all required fields', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Test\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: field check');

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    const entry = result.entries[0];

    expect(entry).toBeDefined();
    expect(entry?.sha).toHaveLength(40);
    expect(entry?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.author).toBe(human.name);
    expect(entry?.authorEmail).toBe(human.email);
    expect(entry?.type).toBe('wip');
    expect(entry?.message).toContain('WIP');
  });

  test('returns empty result gracefully when shadow repo is corrupt/missing', async () => {
    // Create a shadow handle pointing to a non-existent git dir
    const fakeShadow = {
      gitDir: resolve(tmpDir, 'nonexistent/.git/ok'),
      workTree: resolve(tmpDir, 'nonexistent'),
    };

    const result = await getDocumentHistory(fakeShadow, { docName: 'intro' });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test('hides park commits even when their tree-deletion shadows the doc path', async () => {
    const { contentDir, shadow } = await setup();

    // Seed a service-writer WIP commit on refs/wip/main/openknowledge-service —
    // its tree contains content/docs/intro.md, so the next park (whose tree
    // omits that path) registers a "deletion" diff and would surface via
    // git log pathspec without explicit filtering.
    writeFileSync(resolve(contentDir, 'intro.md'), '# Service edit\n');
    await commitWip(shadow, SERVICE_WRITER, 'content/docs', 'wip: service edit');

    const docs: ParkableDoc[] = [
      { docName: 'intro', markdown: '# Parked\n', diskSnapshot: '# Service edit\n' },
    ];
    const parkSha = await parkBranch(shadow, 'main', SERVICE_WRITER.id, docs, 'feature');
    expect(parkSha).toHaveLength(40);

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    expect(result.entries.some((e) => e.sha === parkSha)).toBe(false);
    expect(result.entries.every((e) => e.type !== 'park')).toBe(true);
  });

  test('returns empty result for docNames containing path traversal segments', async () => {
    const { contentDir, shadow } = await setup();

    // Seed a real commit so the function has data to walk over.
    writeFileSync(resolve(contentDir, 'intro.md'), '# Real\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: real edit');

    // Each of these is a structurally invalid docName that would otherwise
    // get interpolated into a git pathspec like `content/docs/<docName>.md`,
    // letting `..` segments escape the configured content root.
    for (const docName of ['../intro', '../../etc/passwd', 'foo/../../bar', 'foo\0bar']) {
      const result = await getDocumentHistory(shadow, { docName }, 'content/docs');
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    }
  });

  test("multi-writer fan-out: writer A's commit touching only doc-a does NOT surface in doc-b's timeline", async () => {
    // Two writers committing concurrently to the same shadow repo. Each
    // writer's WIP commit is built by `buildWipTree` from the full
    // contentRoot, so writer A's commit captures files writer B has written
    // to disk — appearing as ADDED relative to writer A's parent commit. The
    // git-log pathspec pre-filter would surface writer A's commit on doc-B's
    // timeline; the ok-actor.docs[]-aware post-filter must drop it.
    const { contentDir, shadow } = await setup();

    const writerA: WriterIdentity = {
      id: 'agent-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'codex-mcp-client',
      email: 'agent-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa@openknowledge.local',
    };
    const writerB: WriterIdentity = {
      id: 'agent-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      name: 'claude-code',
      email: 'agent-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb@openknowledge.local',
    };

    const commitWriter = async (writer: WriterIdentity, docs: string[], subject: string) => {
      const treeSha = await buildWipTree(shadow, 'content/docs');
      const actor: OkActorEntry = {
        v: 1,
        writer_id: writer.id,
        principal: null,
        agent_session: writer.id.startsWith('agent-') ? writer.id.slice(6) : null,
        agent_type: null,
        client_name: writer.name,
        client_version: null,
        label: null,
        display_name: writer.name,
        color_seed: writer.id,
        docs,
      };
      const message = `wip: ${subject}\n\n${formatOkActor(actor)}`;
      return commitWipFromTree(shadow, writer, treeSha, message);
    };

    // Writer A commits its first edit to doc-a. Only doc-a exists on disk.
    writeFileSync(resolve(contentDir, 'doc-a.md'), '# A v1\n');
    const a1 = await commitWriter(writerA, ['doc-a'], 'doc-a v1');

    // Writer B writes doc-b to disk, then commits its first edit declaring
    // only doc-b in its actor entry. Writer B's tree captures doc-a from
    // writer A's earlier write, which is correct — doc-a was already on disk.
    writeFileSync(resolve(contentDir, 'doc-b.md'), '# B v1\n');
    const b1 = await commitWriter(writerB, ['doc-b'], 'doc-b v1');

    // Writer A edits doc-a again. Critically, this commit's tree ALSO
    // captures doc-b (because buildWipTree reads the full contentRoot).
    // Relative to writer A's previous commit (a1), doc-b appears as ADDED —
    // even though writer A never touched it. The fan-out noise this test
    // guards against is this commit appearing in doc-b's timeline.
    writeFileSync(resolve(contentDir, 'doc-a.md'), '# A v2\n');
    const a2 = await commitWriter(writerA, ['doc-a'], 'doc-a v2');

    const aHistory = await getDocumentHistory(shadow, { docName: 'doc-a' }, 'content/docs');
    const aShas = aHistory.entries.map((e) => e.sha);
    expect(aShas).toContain(a1);
    expect(aShas).toContain(a2);
    expect(aShas).not.toContain(b1);

    const bHistory = await getDocumentHistory(shadow, { docName: 'doc-b' }, 'content/docs');
    const bShas = bHistory.entries.map((e) => e.sha);
    expect(bShas).toContain(b1);
    // The regression: writer A's a2 commit touched only doc-a per its
    // ok-actor.docs[] declaration. git-log pathspec surfaced it on
    // doc-b's timeline as multi-writer fan-out noise.
    expect(bShas).not.toContain(a2);
    expect(bShas).not.toContain(a1);
  });

  test('resolves a skill timeline queried by its synthetic doc name', async () => {
    const { contentDir, shadow } = await setup();

    const writer: WriterIdentity = {
      id: 'agent-cccccccc-cccc-4ccc-cccc-cccccccccccc',
      name: 'claude-code',
      email: 'agent-cccccccc-cccc-4ccc-cccc-cccccccccccc@openknowledge.local',
    };

    // A project skill is versioned under its `.ok/skills/<name>` artifact key:
    // SKILL.md on disk, the docKey declared in OkActor.docs — exactly what the
    // managed-artifact write path records. The editor tab, however, addresses it
    // by the synthetic `__skill__/project/<name>` doc name.
    const skillDir = resolve(contentDir, '.ok', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), '# My Skill v1\n');

    const treeSha = await buildWipTree(shadow, 'content/docs');
    const actor: OkActorEntry = {
      v: 1,
      writer_id: writer.id,
      principal: null,
      agent_session: writer.id.slice(6),
      agent_type: null,
      client_name: writer.name,
      client_version: null,
      label: null,
      display_name: writer.name,
      color_seed: writer.id,
      docs: ['.ok/skills/my-skill'],
    };
    const sha = await commitWipFromTree(
      shadow,
      writer,
      treeSha,
      `wip: skill-edit: my-skill/SKILL.md\n\n${formatOkActor(actor)}`,
    );

    // The synthetic name must translate to the `.ok/skills/<name>` key for both
    // the git pathspec and the OkActor post-filter, or the saved version is
    // invisible to the timeline.
    const result = await getDocumentHistory(
      shadow,
      { docName: '__skill__/project/my-skill' },
      'content/docs',
    );
    expect(result.entries.map((e) => e.sha)).toContain(sha);

    // Global skills are unversioned — no shadow history.
    const personal = await getDocumentHistory(
      shadow,
      { docName: '__skill__/global/my-skill' },
      'content/docs',
    );
    expect(personal.entries).toHaveLength(0);
  });

  test('deduplicates entries that appear in multiple ref walks', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# Shared\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: shared ancestor');

    // Save version — checkpoint will parent on the WIP commit
    await saveVersion(shadow, 'content/docs', [human]);

    // The WIP commit is reachable from both the checkpoint ref and the (now-deleted) WIP ref
    // After save version, WIP ref is deleted but checkpoint ancestry still includes it
    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');

    // checkpoint + wip = 2 unique entries (no duplicates)
    const shas = result.entries.map((e) => e.sha);
    const uniqueShas = new Set(shas);
    expect(uniqueShas.size).toBe(shas.length);
  });
});

describe('getDocumentHistory — rename-history mitigation (US-004)', () => {
  afterEach(() => {
    resetRenameLogIndexCache();
  });

  function entry(overrides: Partial<RenameLogEntry> = {}): RenameLogEntry {
    return {
      v: 1,
      from: 'a',
      to: 'b',
      at: '2026-05-05T12:00:00.000Z',
      commitSha: '',
      branch: 'main',
      groupId: '01234567-89ab-cdef-0123-456789abcdef',
      kind: 'file',
      actor: { writerId: 'agent-test', displayName: 'Test' },
      ...overrides,
    };
  }

  test('rename a → b: timeline of `b` includes pre-rename WIP commits at path `a`', async () => {
    const { contentDir, shadow } = await setup();
    const { cw, sv } = datedCommits(shadow);

    // Cycle 1: write `a.md`, save → checkpoint K1 (so K1's tree has a.md)
    writeFileSync(resolve(contentDir, 'a.md'), '# A v1\n');
    const aWipSha = await cw('WIP: a v1');
    await sv();

    // Cycle 2: simulate rename a → b on disk, then commit; rename commit
    // becomes the chain anchor. Dated commits keep K1 strictly before R.
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    // Cycle 3: more WIP at b
    writeFileSync(resolve(contentDir, 'b.md'), '# B v2\n');
    const bWipSha = await cw('WIP: b v2');

    // Wire the rename-log index
    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(shas).toContain(aWipSha); // pre-rename
    expect(shas).toContain(renameSha); // rename event
    expect(shas).toContain(bWipSha); // post-rename
  });

  test('FR2: un-renamed doc → empty rename log → identical results to pre-spec behavior', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'plain.md'), '# v1\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: v1');
    writeFileSync(resolve(contentDir, 'plain.md'), '# v2\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: v2');

    setRenameLogIndex(shadow.gitDir, createEmptyIndex());

    const result = await getDocumentHistory(shadow, { docName: 'plain' }, 'content/docs');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.message.startsWith('WIP:'))).toBe(true);
  });

  test('chained A→B→C: timeline of `c` spans all three name epochs', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    // Cycle 1: a.md
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    const aSha = await cw('WIP: a');
    await sv();

    // Cycle 2: rename a → b
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');
    const renameAB = await cw('rename: a -> b');
    await sv();

    // Cycle 3: rename b → c
    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'c.md'), '# C\n');
    const renameBC = await cw('rename: b -> c');

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameAB }), index);
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'b', to: 'c', commitSha: renameBC }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'c' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(shas).toContain(aSha);
    expect(shas).toContain(renameAB);
    expect(shas).toContain(renameBC);
    // Three commitWip + two saveVersion + getDocumentHistory over real git;
    // the explicit timeout buys headroom under full-suite git/filesystem
    // contention. Same shape applies to the other multi-cycle tests below.
  }, 15_000);

  test('name-reuse contamination: timeline of `b` does NOT include new-`a` commits', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    // Cycle 1: a, save → K1 reaches a-only
    writeFileSync(resolve(contentDir, 'a.md'), '# A old\n');
    await cw('WIP: a old');
    await sv();

    // Cycle 2: rename a → b
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    // Cycle 3: NEW a.md (b deleted to ensure new-a commit's tree is a-only)
    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'a.md'), '# A new (unrelated)\n');
    const newASha = await cw('WIP: new-a');
    await sv();

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const bResult = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    const bShas = bResult.entries.map((e) => e.sha);
    expect(bShas).not.toContain(newASha); // contamination rejected by cycle bound

    // Querying the new-a doc returns only its own history (no log entry on it).
    const aResult = await getDocumentHistory(shadow, { docName: 'a' }, 'content/docs');
    const aShas = aResult.entries.map((e) => e.sha);
    expect(aShas).toContain(newASha);
  }, 15_000);

  test('perf: chain depth 5 query completes in bounded latency', async () => {
    const { contentDir, shadow } = await setup();
    // Build a chain of 5 renames a → b → c → d → e → f, each with one
    // saveVersion. Heavy enough to exercise the cycle-bound + per-predecessor
    // rev-list path, light enough to run inside a test budget.
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const index = createEmptyIndex();
    let prevName: string | null = null;
    for (const name of names) {
      if (prevName) {
        try {
          rmSync(resolve(contentDir, `${prevName}.md`));
        } catch {}
      }
      writeFileSync(resolve(contentDir, `${name}.md`), `# ${name}\n`);
      const sha = await commitWip(shadow, human, 'content/docs', `WIP: ${name}`);
      if (prevName) {
        appendRenameLogEntry(
          shadow.gitDir,
          entry({ from: prevName, to: name, commitSha: sha }),
          index,
        );
      }
      await saveVersion(shadow, 'content/docs', [human]);
      prevName = name;
    }
    setRenameLogIndex(shadow.gitDir, index);

    const t0 = performance.now();
    const result = await getDocumentHistory(shadow, { docName: 'f' }, 'content/docs');
    const elapsed = performance.now() - t0;
    expect(result.entries.length).toBeGreaterThan(0);
    // Generous CI-safe bound. Local dev sees well under 200ms; this is the
    // shape-correctness gate, not the perf budget.
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  test('perf: chain depth 5 + 100 checkpoints stays within NFR target', async () => {
    const { contentDir, shadow } = await setup();
    // read-side chain depth 5 with 100 checkpoints ≤ 200ms
    // wall-clock. This test stretches the existing depth-5 perf gate by adding
    // ~17 saveVersion checkpoints per name epoch (≈102 total) so the per-
    // predecessor `buildSeeds` + `batchCheckExistence` work is realistic.
    const names = ['a', 'b', 'c', 'd', 'e', 'f']; // 5 renames between 6 epochs
    const index = createEmptyIndex();
    let prevName: string | null = null;
    for (const name of names) {
      if (prevName) {
        try {
          rmSync(resolve(contentDir, `${prevName}.md`));
        } catch {}
      }
      writeFileSync(resolve(contentDir, `${name}.md`), `# ${name} v0\n`);
      const renameSha = await commitWip(shadow, human, 'content/docs', `WIP: ${name} v0`);
      if (prevName) {
        appendRenameLogEntry(
          shadow.gitDir,
          entry({ from: prevName, to: name, commitSha: renameSha }),
          index,
        );
      }
      // ~17 saveVersions per epoch × 6 epochs ≈ 102 checkpoints across the
      // chain. Each saveVersion needs a fresh WIP commit on top.
      for (let i = 1; i <= 17; i++) {
        writeFileSync(resolve(contentDir, `${name}.md`), `# ${name} v${i}\n`);
        await commitWip(shadow, human, 'content/docs', `WIP: ${name} v${i}`);
        await saveVersion(shadow, 'content/docs', [human]);
      }
      prevName = name;
    }
    setRenameLogIndex(shadow.gitDir, index);

    // Warm-up run — discard. Cold caches, page faults, and JIT skew the first
    // measurement; spec NFR is steady-state p99 not first-hit.
    await getDocumentHistory(shadow, { docName: 'f' }, 'content/docs');

    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const result = await getDocumentHistory(shadow, { docName: 'f' }, 'content/docs');
      runs.push(performance.now() - t0);
      expect(result.entries.length).toBeGreaterThan(0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[1] ?? runs[0] ?? 0;

    console.log(
      `[perf] chain depth 5 + ~100 checkpoints median: ${median.toFixed(1)}ms ` +
        `(NFR ≤ 200ms; runs: ${runs.map((r) => r.toFixed(0)).join('ms, ')}ms)`,
    );

    // CI-tolerant ceiling: shared-runner kernels + slow IO push CI variance
    // ~5-10× over local-dev. The 1000ms cap fails if the read path has
    // genuinely regressed an order of magnitude past the NFR; local dev
    // should comfortably stay under 200ms.
    expect(median).toBeLessThan(1_000);
    // The ~102-checkpoint git setup is wall-clock-bound; under the full
    // `bun run check` concurrent load it can exceed a 60s budget before the
    // measurement runs. 180s buys headroom — the real perf gate is the median
    // assertion above, which is unaffected by this framework timeout.
  }, 180_000);

  test('lazy-population window: empty-commitSha entry → chain truncates → behavior matches no-rename-history', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    const bWipSha = await commitWip(shadow, human, 'content/docs', 'WIP: b v1');

    const index = createEmptyIndex();
    // Empty commitSha → entry is skipped
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: '' }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    expect(result.entries.map((e) => e.sha)).toEqual([bWipSha]);
  });

  test('per-step error isolation: failure on one predecessor preserves others', async () => {
    // Build a chain A→B→C where step 0 (a→b) has a bogus commitSha that will
    // fail the predecessor `git log` invocation, while step 1 (b→c) is real.
    // Without per-step error isolation, the failure on step 0 also drops
    // step 1's predecessor commits. With isolation, step 1's commits survive.
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    // Cycle 1: a, save → checkpoint K1 reaches the original a
    writeFileSync(resolve(contentDir, 'a.md'), '# A v1\n');
    const aWipSha = await cw('WIP: a v1');
    await sv();

    // Cycle 2: rename a → b at a real commit, more WIP at b
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    await cw('rename: a -> b');
    writeFileSync(resolve(contentDir, 'b.md'), '# B v2\n');
    const bWipSha = await cw('WIP: b v2');
    await sv();

    // Cycle 3: rename b → c at a real commit
    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'c.md'), '# C v1\n');
    const renameBC = await cw('rename: b -> c');

    const index = createEmptyIndex();
    // Step 0: a→b with a BOGUS commitSha — passes the hex40 validator but
    // doesn't resolve to any real commit. buildSeeds catches `git show`
    // failure and falls back to [bogusSha], then `sg.raw('log', bogusSha,
    // ...)` throws, exercising the per-step catch.
    const bogusSha = '0123456789abcdef0123456789abcdef01234567';
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: bogusSha }), index);
    // Step 1: b→c with the real rename commit
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'b', to: 'c', commitSha: renameBC }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const origWarn = console.warn;
    let warnedSkip = false;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('predecessor walk failed for step')) warnedSkip = true;
    };
    try {
      const result = await getDocumentHistory(shadow, { docName: 'c' }, 'content/docs');
      const shas = result.entries.map((e) => e.sha);
      // Step 1 (b→c) succeeded — bWipSha (the WIP at `b` post-rename-AB,
      // pre-rename-BC) must be in the timeline.
      expect(shas).toContain(bWipSha);
      // Step 0 (a→b) failed — aWipSha was visible only via the predecessor
      // walk on path `a`, which threw. Confirms the failure path was hit.
      expect(shas).not.toContain(aWipSha);
      // Rename commits at the current path are reachable through the
      // unbounded current-name walk and survive regardless of step 0's fate.
      expect(shas).toContain(renameBC);
    } finally {
      console.warn = origWarn;
    }
    expect(warnedSkip).toBe(true);
  }, 15_000);

  test('checkpoint-only fast path: pre-rename checkpoint visible after rename', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    // Cycle 1: write a, save → checkpoint K1 captures a-only tree
    writeFileSync(resolve(contentDir, 'a.md'), '# A pre-rename\n');
    await cw('WIP: a');
    await sv();

    // Cycle 2: rename a → b
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B post-rename\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    // Query the checkpoint-only fast path (separate code from the full DAG
    // walk; the rename-aware filter is shared but the surrounding ref
    // enumeration + branch-cutoff is fast-path specific).
    const result = await getDocumentHistory(
      shadow,
      { docName: 'b', type: 'checkpoint' },
      'content/docs',
    );
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    expect(result.entries.every((e) => e.type === 'checkpoint')).toBe(true);
  });
});

describe('depth-bound history walk (PRD-6972 FR3 / D14)', () => {
  test('historyWalkCap: 3x(offset+limit) with a 500-commit ceiling', () => {
    expect(historyWalkCap(0, 50)).toBe(150); // 3 * 50
    expect(historyWalkCap(0, 2)).toBe(6);
    expect(historyWalkCap(100, 50)).toBe(450); // 3 * 150
    expect(historyWalkCap(200, 50)).toBe(500); // 3 * 250 = 750 → ceiling 500
    expect(historyWalkCap(10_000, 10)).toBe(500); // ceiling
    // The 3x slack guarantees the requested window is always inside the cap
    // until the ceiling — an offset can only fall "beyond the window" at 500.
    for (const [o, l] of [
      [0, 50],
      [50, 50],
      [149, 50],
    ] as const) {
      expect(historyWalkCap(o, l)).toBeGreaterThan(o);
    }
  });

  // Deep linear WIP chain via a single `git fast-import` (one subprocess for N
  // commits instead of ~3N git spawns). Each commit changes intro.md so the
  // pathspec walk includes every commit; commits carry no ok-actor line, so the
  // doc post-filter's actors.length===0 passthrough includes them (the "legacy
  // commit" path). The right tool for a >500-commit fixture.
  function buildDeepDocChain(shadow: Awaited<ReturnType<typeof setup>>['shadow'], n: number) {
    const ref = 'refs/wip/main/human-ada';
    let stream = `reset ${ref}\n`;
    for (let i = 0; i < n; i++) {
      const content = `# Edit ${i}\n`;
      const msg = `wip: edit ${i}`;
      const ts = 1_700_000_000 + i; // monotonically increasing author/commit date
      const blobMark = 2 * i + 1;
      const commitMark = 2 * i + 2;
      stream += `blob\nmark :${blobMark}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      stream += `commit ${ref}\nmark :${commitMark}\n`;
      stream += `author Ada <ada@example.com> ${ts} +0000\n`;
      stream += `committer Ada <ada@example.com> ${ts} +0000\n`;
      stream += `data ${Buffer.byteLength(msg)}\n${msg}\n`;
      // First commit seeds the ref; later commits auto-parent on its current tip.
      stream += `M 100644 :${blobMark} content/docs/intro.md\n\n`;
    }
    stream += 'done\n';
    execFileSync('git', ['fast-import', '--done'], {
      cwd: shadow.workTree,
      env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      input: stream,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  }

  test('bounds the walk on a >500-commit doc; saturates hasMore; paginates within window', async () => {
    const { shadow } = await setup();
    // 505-commit linear WIP chain, each commit changing the file so the
    // pathspec walk includes every commit.
    buildDeepDocChain(shadow, 505);

    // Default-ish page: cap = 3*50 = 150 < 505 → walk is bounded, window saturated.
    const page0 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 50, offset: 0 },
      'content/docs',
    );
    expect(page0.entries).toHaveLength(50);
    // total is the bounded gathered set, NOT the full 505 (proves no full-depth walk).
    expect(page0.total).toBeLessThanOrEqual(150);
    expect(page0.hasMore).toBe(true);

    // Pagination within the window returns the next slice.
    const page1 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 50, offset: 50 },
      'content/docs',
    );
    expect(page1.entries).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    // Disjoint from page 0 (correct pagination, not repeated rows).
    const page0Shas = new Set(page0.entries.map((e) => e.sha));
    expect(page1.entries.every((e) => !page0Shas.has(e.sha))).toBe(true);

    // Offset past the gathered window → empty page with hasMore=FALSE. The
    // bounded walk is deterministic, so paging further can never surface new
    // rows; an ungated saturation term would keep hasMore=true on every empty
    // page and spin an auto-paginating consumer forever (reads must not
    // self-amplify). Saturation still signals truncation on the populated pages
    // above (page0/page1 hasMore=true).
    const beyond = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 10, offset: 500 },
      'content/docs',
    );
    expect(beyond.entries).toHaveLength(0);
    expect(beyond.hasMore).toBe(false);
  }, 180_000);

  test('does NOT falsely saturate when commits are under the cap', async () => {
    const { shadow, contentDir } = await setup();
    for (let i = 0; i < 5; i++) {
      writeFileSync(resolve(contentDir, 'intro.md'), `# Edit ${i}\n`);
      await commitWip(shadow, human, 'content/docs', `WIP: edit ${i}`);
    }
    // 5 commits, limit 50 → cap 150, walk returns 5 (< cap) → not saturated.
    const result = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 50, offset: 0 },
      'content/docs',
    );
    expect(result.entries.length).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  test('noise-dominated multi-writer fixture still fills a full page (slack absorbs filtering)', async () => {
    const { shadow, contentDir } = await setup();
    // Two writers alternating on the same doc. Each writer's WIP snapshot is the
    // full content tree, so the other writer's commits surface as fan-out noise
    // that the ok-actor post-filter drops. The 3x slack keeps the page full.
    for (let i = 0; i < 24; i++) {
      const w = i % 2 === 0 ? human : agent;
      writeFileSync(resolve(contentDir, 'intro.md'), `# Edit ${i}\n`);
      await commitWip(shadow, w, 'content/docs', `WIP: edit ${i}`);
    }
    const result = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 10, offset: 0 },
      'content/docs',
    );
    // A full page despite multi-writer fan-out noise within the bounded window.
    expect(result.entries).toHaveLength(10);
  }, 60_000);
});
