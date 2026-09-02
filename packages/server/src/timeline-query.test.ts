import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { templateContentDocName } from '@inkeep/open-knowledge-core';
import { formatOkActor, type OkActorEntry } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from './logger.ts';
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
import { getDocumentHistory, getFolderTimeline, historyWalkCap } from './timeline-query';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-timeline-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const projectRoot = resolve(tmpDir, 'project');
  const contentDir = resolve(projectRoot, 'content/docs');
  mkdirSync(contentDir, { recursive: true });

  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');

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

    writeFileSync(resolve(contentDir, 'intro.md'), '# WIP\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: human edit');

    writeFileSync(resolve(contentDir, 'intro.md'), '# Upstream\n');
    await commitUpstreamImport(shadow, 'content/docs', 'abc', 'def');

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

    writeFileSync(resolve(contentDir, 'intro.md'), '# Real\n');
    await commitWip(shadow, human, 'content/docs', 'WIP: real edit');

    for (const docName of ['../intro', '../../etc/passwd', 'foo/../../bar', 'foo\0bar']) {
      const result = await getDocumentHistory(shadow, { docName }, 'content/docs');
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    }
  });

  test("multi-writer fan-out: writer A's commit touching only doc-a does NOT surface in doc-b's timeline", async () => {
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

    writeFileSync(resolve(contentDir, 'doc-a.md'), '# A v1\n');
    const a1 = await commitWriter(writerA, ['doc-a'], 'doc-a v1');

    writeFileSync(resolve(contentDir, 'doc-b.md'), '# B v1\n');
    const b1 = await commitWriter(writerB, ['doc-b'], 'doc-b v1');

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

    const result = await getDocumentHistory(
      shadow,
      { docName: '__skill__/project/my-skill' },
      'content/docs',
    );
    expect(result.entries.map((e) => e.sha)).toContain(sha);

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

    await saveVersion(shadow, 'content/docs', [human]);

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');

    const shas = result.entries.map((e) => e.sha);
    const uniqueShas = new Set(shas);
    expect(uniqueShas.size).toBe(shas.length);
  });
});

describe('getDocumentHistory — byte-identical no-op row filtering', () => {
  function dates() {
    let t = Date.parse('2026-06-01T12:00:00.000Z');
    return () => {
      t += 1000;
      return new Date(t).toISOString();
    };
  }

  test('drops a fan-out commit whose doc blob is byte-identical to the adjacent-older version', async () => {
    const { contentDir, shadow } = await setup();
    const next = dates();

    writeFileSync(resolve(contentDir, 'intro.md'), '# V1\n');
    const h1 = await commitWip(shadow, human, 'content/docs', 'WIP: v1', 'main', {
      date: next(),
    });
    writeFileSync(resolve(contentDir, 'intro.md'), '# V2\n');
    const h2 = await commitWip(shadow, human, 'content/docs', 'WIP: v2', 'main', {
      date: next(),
    });

    const g1 = await commitWip(shadow, agent, 'content/docs', 'WIP: agent no-op', 'main', {
      date: next(),
    });

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);

    expect(shas).not.toContain(g1);
    expect(shas).toEqual([h2, h1]);
    expect(result.total).toBe(2);
  });

  test('keeps a frontmatter-only edit (whole-file blob differs)', async () => {
    const { contentDir, shadow } = await setup();
    const next = dates();

    writeFileSync(resolve(contentDir, 'intro.md'), '---\ntitle: A\n---\n# Body\n');
    const h1 = await commitWip(shadow, human, 'content/docs', 'WIP: fm A', 'main', {
      date: next(),
    });
    writeFileSync(resolve(contentDir, 'intro.md'), '---\ntitle: B\n---\n# Body\n');
    const h2 = await commitWip(shadow, human, 'content/docs', 'WIP: fm B', 'main', {
      date: next(),
    });

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    expect(result.entries.map((e) => e.sha)).toEqual([h2, h1]);
  });

  test('never drops a checkpoint even when its doc bytes are unchanged', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# V1\n');
    const h1 = await commitWip(shadow, human, 'content/docs', 'WIP: v1');
    const { checkpointRef } = await saveVersion(shadow, 'content/docs', [human]);
    const cp = checkpointRef.split('/').at(-1) as string;

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(shas).toContain(cp);
    expect(shas).toContain(h1);
    expect(result.entries.find((e) => e.sha === cp)?.type).toBe('checkpoint');
  });

  test('a byte-identical upstream import loses to the authored row (keeps the author)', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'intro.md'), '# V\n');
    const imp = await commitUpstreamImport(shadow, 'content/docs', 'old', 'new', 'main');
    const authored = await commitWip(shadow, human, 'content/docs', 'reconcile: intro', 'main', {
      date: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);

    expect(shas).toContain(authored);
    expect(shas).not.toContain(imp);
    expect(result.entries.map((e) => e.type)).not.toContain('upstream');
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

    writeFileSync(resolve(contentDir, 'a.md'), '# A v1\n');
    const aWipSha = await cw('WIP: a v1');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    writeFileSync(resolve(contentDir, 'b.md'), '# B v2\n');
    const bWipSha = await cw('WIP: b v2');

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(shas).toContain(aWipSha);
    expect(shas).toContain(renameSha);
    expect(shas).toContain(bWipSha);
  });

  test('byte-preserving rename a → b: the rename commit survives the no-op row filter', async () => {
    const { contentDir, shadow } = await setup();
    const { cw, sv } = datedCommits(shadow);

    writeFileSync(resolve(contentDir, 'a.md'), '# A v1\n');
    const aWipSha = await cw('WIP: a v1');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# A v1\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    writeFileSync(resolve(contentDir, 'b.md'), '# A v2\n');
    const bWipSha = await cw('WIP: b v2');

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(shas).toContain(aWipSha);
    expect(shas).toContain(renameSha);
    expect(shas).toContain(bWipSha);
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

    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    const aSha = await cw('WIP: a');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');
    const renameAB = await cw('rename: a -> b');
    await sv();

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
  }, 15_000);

  test('name-reuse contamination: timeline of `b` does NOT include new-`a` commits', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    writeFileSync(resolve(contentDir, 'a.md'), '# A old\n');
    await cw('WIP: a old');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'a.md'), '# A new (unrelated)\n');
    const newASha = await cw('WIP: new-a');
    await sv();

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const bResult = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    const bShas = bResult.entries.map((e) => e.sha);
    expect(bShas).not.toContain(newASha);

    const aResult = await getDocumentHistory(shadow, { docName: 'a' }, 'content/docs');
    const aShas = aResult.entries.map((e) => e.sha);
    expect(aShas).toContain(newASha);
  }, 15_000);

  test('perf: chain depth 5 query completes in bounded latency', async () => {
    const { contentDir, shadow } = await setup();
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
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  test('perf: chain depth 5 + 100 checkpoints stays within NFR target', async () => {
    const { contentDir, shadow } = await setup();
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
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
      for (let i = 1; i <= 17; i++) {
        writeFileSync(resolve(contentDir, `${name}.md`), `# ${name} v${i}\n`);
        await commitWip(shadow, human, 'content/docs', `WIP: ${name} v${i}`);
        await saveVersion(shadow, 'content/docs', [human]);
      }
      prevName = name;
    }
    setRenameLogIndex(shadow.gitDir, index);

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

    expect(median).toBeLessThan(1_000);
  }, 180_000);

  test('lazy-population window: empty-commitSha entry → chain truncates → behavior matches no-rename-history', async () => {
    const { contentDir, shadow } = await setup();

    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    const bWipSha = await commitWip(shadow, human, 'content/docs', 'WIP: b v1');

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: '' }), index);
    setRenameLogIndex(shadow.gitDir, index);

    const result = await getDocumentHistory(shadow, { docName: 'b' }, 'content/docs');
    expect(result.entries.map((e) => e.sha)).toEqual([bWipSha]);
  });

  test('per-step error isolation: failure on one predecessor preserves others', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    writeFileSync(resolve(contentDir, 'a.md'), '# A v1\n');
    const aWipSha = await cw('WIP: a v1');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B v1\n');
    await cw('rename: a -> b');
    writeFileSync(resolve(contentDir, 'b.md'), '# B v2\n');
    const bWipSha = await cw('WIP: b v2');
    await sv();

    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'c.md'), '# C v1\n');
    const renameBC = await cw('rename: b -> c');

    const index = createEmptyIndex();
    const bogusSha = '0123456789abcdef0123456789abcdef01234567';
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: bogusSha }), index);
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'b', to: 'c', commitSha: renameBC }), index);
    setRenameLogIndex(shadow.gitDir, index);

    let warnedSkip = false;
    const warnSpy = vi
      .spyOn(getLogger('timeline'), 'warn')
      .mockImplementation((_data: unknown, msg: string) => {
        if (msg.includes('predecessor walk failed for step')) warnedSkip = true;
      });
    try {
      const result = await getDocumentHistory(shadow, { docName: 'c' }, 'content/docs');
      const shas = result.entries.map((e) => e.sha);
      expect(shas).toContain(bWipSha);
      expect(shas).not.toContain(aWipSha);
      expect(shas).toContain(renameBC);
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnedSkip).toBe(true);
  }, 15_000);

  test('checkpoint-only fast path: pre-rename checkpoint visible after rename', async () => {
    const { contentDir, shadow } = await setup();

    const { cw, sv } = datedCommits(shadow);

    writeFileSync(resolve(contentDir, 'a.md'), '# A pre-rename\n');
    await cw('WIP: a');
    await sv();

    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B post-rename\n');
    const renameSha = await cw('rename: a -> b');
    await sv();

    const index = createEmptyIndex();
    appendRenameLogEntry(shadow.gitDir, entry({ from: 'a', to: 'b', commitSha: renameSha }), index);
    setRenameLogIndex(shadow.gitDir, index);

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
    expect(historyWalkCap(0, 50)).toBe(150);
    expect(historyWalkCap(0, 2)).toBe(6);
    expect(historyWalkCap(100, 50)).toBe(450);
    expect(historyWalkCap(200, 50)).toBe(500);
    expect(historyWalkCap(10_000, 10)).toBe(500);
    for (const [o, l] of [
      [0, 50],
      [50, 50],
      [149, 50],
    ] as const) {
      expect(historyWalkCap(o, l)).toBeGreaterThan(o);
    }
  });

  function buildDeepDocChain(shadow: Awaited<ReturnType<typeof setup>>['shadow'], n: number) {
    const ref = 'refs/wip/main/human-ada';
    let stream = `reset ${ref}\n`;
    for (let i = 0; i < n; i++) {
      const content = `# Edit ${i}\n`;
      const msg = `wip: edit ${i}`;
      const ts = 1_700_000_000 + i;
      const blobMark = 2 * i + 1;
      const commitMark = 2 * i + 2;
      stream += `blob\nmark :${blobMark}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      stream += `commit ${ref}\nmark :${commitMark}\n`;
      stream += `author Ada <ada@example.com> ${ts} +0000\n`;
      stream += `committer Ada <ada@example.com> ${ts} +0000\n`;
      stream += `data ${Buffer.byteLength(msg)}\n${msg}\n`;
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
    buildDeepDocChain(shadow, 505);

    const page0 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 50, offset: 0 },
      'content/docs',
    );
    expect(page0.entries).toHaveLength(50);
    expect(page0.total).toBeLessThanOrEqual(150);
    expect(page0.hasMore).toBe(true);

    const page1 = await getDocumentHistory(
      shadow,
      { docName: 'intro', limit: 50, offset: 50 },
      'content/docs',
    );
    expect(page1.entries).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    const page0Shas = new Set(page0.entries.map((e) => e.sha));
    expect(page1.entries.every((e) => !page0Shas.has(e.sha))).toBe(true);

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
    expect(result.entries).toHaveLength(10);
  }, 60_000);
});

describe('getDocumentHistory + getFolderTimeline — templates as content (FR6 / D11)', () => {
  const httpWriter: WriterIdentity = {
    id: 'agent-11111111-1111-4111-1111-111111111111',
    name: 'template-http',
    email: 'agent-11111111-1111-4111-1111-111111111111@openknowledge.local',
  };

  function increasingDates() {
    let t = Date.parse('2026-07-01T12:00:00.000Z');
    return () => {
      t += 1000;
      return new Date(t).toISOString();
    };
  }

  async function commitTemplate(
    shadow: ShadowHandle,
    contentDir: string,
    folderRel: string,
    name: string,
    subject: string,
    body: string,
    date: string,
    writer: WriterIdentity = httpWriter,
  ): Promise<string> {
    const docKey = templateContentDocName(folderRel, name);
    const abs = resolve(contentDir, `${docKey}.md`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
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
      docs: [docKey],
    };
    const message = `${subject}\n\n${formatOkActor(actor)}`;
    return commitWip(shadow, writer, 'content/docs', message, 'main', { date });
  }

  test('doc history is one continuous chain across typed lifecycle writes and wip editor edits', async () => {
    const { contentDir, shadow } = await setup();
    const next = increasingDates();
    const docName = templateContentDocName('notes', 'standup');

    const createSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-create: notes/.ok/templates/standup',
      '---\ntemplate:\n  title: Standup\n---\n# v1\n',
      next(),
    );
    const editSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-edit: notes/.ok/templates/standup',
      '---\ntemplate:\n  title: Standup\n---\n# v2\n',
      next(),
    );

    const wipSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'wip: notes/.ok/templates/standup',
      '---\ntemplate:\n  title: Standup\n---\n# v3 edited in the editor\n',
      next(),
      human,
    );

    const result = await getDocumentHistory(shadow, { docName }, 'content/docs');
    const shas = result.entries.map((e) => e.sha);
    expect(new Set(shas)).toEqual(new Set([createSha, editSha, wipSha]));

    for (const entry of result.entries) {
      expect(entry.contributors.some((c) => c.docs.includes(docName))).toBe(true);
    }
  });

  test('folder timeline keeps the four typed lifecycle subjects and drops import + wip', async () => {
    const { contentDir, shadow } = await setup();
    const next = increasingDates();
    const docName = templateContentDocName('notes', 'standup');

    const createSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-create: notes/.ok/templates/standup',
      '# create\n',
      next(),
    );
    const editSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-edit: notes/.ok/templates/standup',
      '# edit\n',
      next(),
    );
    const renameSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-rename: notes/.ok/templates/scrum -> notes/.ok/templates/standup',
      '# rename\n',
      next(),
    );
    const deleteSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-delete: notes/.ok/templates/standup',
      '# delete\n',
      next(),
    );
    const importSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'template-import: notes/.ok/templates/standup',
      '# import\n',
      next(),
    );
    const wipSha = await commitTemplate(
      shadow,
      contentDir,
      'notes',
      'standup',
      'wip: notes/.ok/templates/standup',
      '# editor edit\n',
      next(),
      human,
    );

    const folder = await getFolderTimeline(shadow, 'notes', 'content/docs');
    const folderShas = folder.entries.map((e) => e.sha);
    expect(folderShas).toContain(createSha);
    expect(folderShas).toContain(editSha);
    expect(folderShas).toContain(renameSha);
    expect(folderShas).toContain(deleteSha);
    expect(folderShas).not.toContain(importSha);
    expect(folderShas).not.toContain(wipSha);
    expect(folder.entries).toHaveLength(4);

    const doc = await getDocumentHistory(shadow, { docName }, 'content/docs');
    expect(doc.entries.map((e) => e.sha)).toContain(wipSha);
  });
});
