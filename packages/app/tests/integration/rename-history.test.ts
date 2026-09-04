import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test } from 'vitest';
import {
  loadRenameLogIndex,
  type RenameLogEntry,
  renameLogPath,
  resetRenameLogIndexCache,
} from '../../../server/src/rename-log';
import {
  agentWriteMd,
  createRestartableServer,
  pollUntil,
  type RestartableServer,
  wait,
} from './test-harness';

interface TimelineResponse {
  entries: Array<{
    sha: string;
    type: 'wip' | 'checkpoint' | 'upstream' | 'rollback';
    message: string;
    authorEmail?: string;
    authorDate?: string;
  }>;
  total: number;
  hasMore: boolean;
}

interface RollbackResponse {
  type?: string;
  title?: string;
}

interface RenameResponse {
  renamed?: Array<{ fromDocName: string; toDocName: string }>;
  type?: string;
  title?: string;
}

interface DocumentListEntry {
  kind?: 'document' | 'asset' | 'folder';
  docName?: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  resetRenameLogIndexCache();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function bootServer(): Promise<RestartableServer> {
  const server = await createRestartableServer({
    gitEnabled: true,
    commitDebounceMs: 50,
  });
  cleanups.push(() => server.shutdown());
  return server;
}

async function getHistory(
  port: number,
  docName: string,
  opts?: { branch?: string; limit?: number },
): Promise<TimelineResponse> {
  const params = new URLSearchParams({ docName });
  if (opts?.branch) params.set('branch', opts.branch);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const res = await fetch(`http://127.0.0.1:${port}/api/history?${params}`);
  return (await res.json()) as TimelineResponse;
}

async function getHistoryVersion(
  port: number,
  docName: string,
  sha: string,
): Promise<{
  status: number;
  body: { ok: boolean; sha?: string; content?: string; error?: string };
}> {
  const params = new URLSearchParams({ docName });
  const res = await fetch(`http://127.0.0.1:${port}/api/history/${sha}?${params}`);
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; sha?: string; content?: string; error?: string },
  };
}

async function rollback(
  port: number,
  body: { docName: string; commitSha: string; agentId?: string; agentName?: string },
): Promise<{ status: number; body: RollbackResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RollbackResponse;
  return { status: res.status, body: json };
}

async function renamePath(
  port: number,
  body: {
    kind: 'file' | 'folder';
    fromPath: string;
    toPath: string;
    agentId?: string;
    agentName?: string;
    summary?: string;
  },
): Promise<{ status: number; body: RenameResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RenameResponse;
  return { status: res.status, body: json };
}

async function deletePath(
  port: number,
  body: { kind: 'file' | 'folder'; path: string; agentId?: string; agentName?: string },
): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

async function saveVersion(
  port: number,
  opts?: { agentId?: string; agentName?: string; message?: string },
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/save-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: opts?.agentId,
      agentName: opts?.agentName,
      message: opts?.message,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`save-version failed: ${res.status} ${text}`);
  }
}

async function getWipShas(server: RestartableServer, docName: string): Promise<Set<string>> {
  const history = await getHistory(server.port, docName);
  return new Set(history.entries.filter((e) => e.type === 'wip').map((e) => e.sha));
}

function readRenameLogEntries(server: RestartableServer): RenameLogEntry[] {
  const shadow = resolveShadowDir(server.contentDir);
  const path = renameLogPath(shadow);
  if (!existsSync(path)) return [];
  const index = loadRenameLogIndex(shadow);
  return [...index.byTo.values()];
}

function isDocumentListDoc(entry: DocumentListEntry): entry is DocumentListEntry & {
  docName: string;
} {
  return entry.kind === 'document' && typeof entry.docName === 'string';
}

async function pollForBackfill(
  server: RestartableServer,
  expectedFromTo: Array<{ from: string; to: string }>,
  timeoutMs = 10_000,
): Promise<RenameLogEntry[]> {
  await pollUntil(
    () => {
      const entries = readRenameLogEntries(server);
      const filledForExpected = expectedFromTo.every((e) =>
        entries.some(
          (le) => le.from === e.from && le.to === e.to && /^[0-9a-f]{40}$/.test(le.commitSha),
        ),
      );
      return filledForExpected;
    },
    timeoutMs,
    50,
  );
  return readRenameLogEntries(server);
}

async function awaitWipCommit(
  server: RestartableServer,
  docName: string,
  beforeShas: Set<string>,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const intervals = [100, 250, 500, 1000];
  let attempt = 0;
  while (Date.now() < deadline) {
    const flushRes = await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, {
      method: 'POST',
    });
    if (!flushRes.ok) {
      console.warn(`[awaitWipCommit] test-flush-git returned ${flushRes.status} — continuing poll`);
    }
    const h = await getHistory(server.port, docName);
    const newWip = h.entries.find((e) => e.type === 'wip' && !beforeShas.has(e.sha));
    if (newWip !== undefined) return newWip.sha;
    await wait(intervals[Math.min(attempt++, intervals.length - 1)]);
  }
  throw new Error(`awaitWipCommit: no NEW WIP commit for ${docName} within ${timeoutMs}ms`);
}

async function agentWriteMdAndAwaitWip(
  server: RestartableServer,
  markdown: string,
  opts: NonNullable<Parameters<typeof agentWriteMd>[2]> & { docName: string },
): Promise<string> {
  const beforeShas = await getWipShas(server, opts.docName);
  await agentWriteMd(server.port, markdown, opts);
  return await awaitWipCommit(server, opts.docName, beforeShas);
}

async function crossSecondBoundary(): Promise<void> {
  await wait(1100);
}

const AGENT = { agentId: 'claude-1', agentName: 'Claude' };

describe('Timeline rename-history mitigation — integration', () => {
  test('file rename round-trip: history spans rename; rollback to pre-rename SHA reverts content; name unchanged', async () => {
    const server = await bootServer();
    const aDoc = 'rename-roundtrip-a';
    const bDoc = 'rename-roundtrip-b';

    await agentWriteMdAndAwaitWip(server, '# A v1\n\nfirst body\n', {
      docName: aDoc,
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    await agentWriteMdAndAwaitWip(server, '\nmore body line\n', {
      docName: aDoc,
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const preRename = await getHistory(server.port, aDoc);
    const preRenameSha = preRename.entries.find((e) => e.type === 'checkpoint')?.sha;
    expect(preRenameSha).toBeDefined();
    if (!preRenameSha) throw new Error('preRenameSha unset');
    await crossSecondBoundary();

    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: `${aDoc}.md`,
      toPath: `${bDoc}.md`,
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    await agentWriteMdAndAwaitWip(server, '\npost-rename body\n', {
      docName: bDoc,
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    const entries = await pollForBackfill(server, [{ from: aDoc, to: bDoc }]);
    const renameEntry = entries.find((e) => e.from === aDoc && e.to === bDoc);
    expect(renameEntry).toBeDefined();
    expect(renameEntry?.kind).toBe('file');

    await pollUntil(
      async () => {
        if (renameEntry?.commitSha === undefined) {
          return false;
        }
        const h = await getHistory(server.port, bDoc);
        const shaSet = new Set(h.entries.map((e) => e.sha));
        return shaSet.has(preRenameSha) && shaSet.has(renameEntry.commitSha);
      },
      45_000,
      50,
    );

    const postRename = await getHistory(server.port, bDoc);
    expect(postRename.entries).toBeDefined();
    const shas = postRename.entries.map((e) => e.sha);
    expect(shas).toContain(preRenameSha);
    expect(shas).toContain(renameEntry?.commitSha);

    const rb = await rollback(server.port, {
      docName: bDoc,
      commitSha: preRenameSha,
      ...AGENT,
    });
    expect(rb.status).toBe(200);

    await pollUntil(() => existsSync(join(server.contentDir, `${bDoc}.md`)), 5_000, 25);

    expect(existsSync(join(server.contentDir, `${bDoc}.md`))).toBe(true);
    expect(existsSync(join(server.contentDir, `${aDoc}.md`))).toBe(false);
  }, 180_000);

  test('folder rename of 3 docs → 3 jsonl entries with shared groupId, shared commitSha after backfill', async () => {
    const server = await bootServer();

    mkdirSync(join(server.contentDir, 'articles'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# auth\n', {
      docName: 'articles/auth',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# sso\n', {
      docName: 'articles/sso',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# oauth\n', {
      docName: 'articles/oauth',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'articles',
      toPath: 'essays',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed?.map((r) => r.toDocName).sort()).toEqual([
      'essays/auth',
      'essays/oauth',
      'essays/sso',
    ]);

    await agentWriteMdAndAwaitWip(server, '\nbackfill trigger\n', {
      docName: 'essays/auth',
      position: 'append',
      ...AGENT,
    });

    const expectedPairs = [
      { from: 'articles/auth', to: 'essays/auth' },
      { from: 'articles/sso', to: 'essays/sso' },
      { from: 'articles/oauth', to: 'essays/oauth' },
    ];
    const entries = await pollForBackfill(server, expectedPairs);
    const folderEntries = entries.filter((e) => e.kind === 'folder');
    expect(folderEntries).toHaveLength(3);

    const groupIds = new Set(folderEntries.map((e) => e.groupId));
    expect(groupIds.size).toBe(1);
    const commitShas = new Set(folderEntries.map((e) => e.commitSha));
    expect(commitShas.size).toBe(1);
  }, 60_000);

  test('chained A→B→C: timeline of `c` spans all three name epochs', async () => {
    const server = await bootServer();

    await agentWriteMdAndAwaitWip(server, '# A\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const aHistory = await getHistory(server.port, 'a');
    const aWipSha = aHistory.entries.find((e) => e.type === 'wip')?.sha;
    expect(aWipSha).toBeDefined();
    await crossSecondBoundary();

    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nmore at b\n', {
      docName: 'b',
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    await crossSecondBoundary();

    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'b.md', toPath: 'c.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nmore at c\n', {
      docName: 'c',
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    await pollForBackfill(server, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);

    const cHistory = await getHistory(server.port, 'c');
    expect(cHistory.entries).toBeDefined();
    const shas = cHistory.entries.map((e) => e.sha);
    expect(shas).toContain(aWipSha);
    const renameAB = readRenameLogEntries(server).find((e) => e.from === 'a' && e.to === 'b');
    const renameBC = readRenameLogEntries(server).find((e) => e.from === 'b' && e.to === 'c');
    expect(shas).toContain(renameAB?.commitSha);
    expect(shas).toContain(renameBC?.commitSha);
  }, 90_000);

  test('name-reuse contamination: timeline of `b` excludes the later same-name draft', async () => {
    const server = await bootServer();

    await agentWriteMdAndAwaitWip(server, '# A old\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    await crossSecondBoundary();

    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nB body\n', {
      docName: 'b',
      position: 'append',
      ...AGENT,
    });
    await pollForBackfill(server, [{ from: 'a', to: 'b' }]);
    await saveVersion(server.port, AGENT);

    expect((await deletePath(server.port, { kind: 'file', path: 'b.md', ...AGENT })).status).toBe(
      200,
    );
    await crossSecondBoundary();

    await agentWriteMdAndAwaitWip(server, '# A NEW (unrelated)\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    const newAHistory = await getHistory(server.port, 'a');
    const newAWipSha = newAHistory.entries.find((e) => e.type === 'wip')?.sha;
    expect(newAWipSha).toBeDefined();

    const bHistory = await getHistory(server.port, 'b');
    expect(bHistory.entries.map((e) => e.sha)).not.toContain(newAWipSha);
  }, 90_000);

  test('rename → full chain visible immediately on /api/history (spine drains contributors before response)', async () => {
    const server = await bootServer();

    await agentWriteMdAndAwaitWip(server, '# A v1\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const preRename = await getHistory(server.port, 'a');
    const preWipSha = preRename.entries.find((e) => e.type === 'wip')?.sha;
    expect(preWipSha).toBeDefined();
    await crossSecondBoundary();

    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);

    const entries = readRenameLogEntries(server);
    const entry = entries.find((e) => e.from === 'a' && e.to === 'b');
    expect(entry).toBeDefined();
    expect(entry?.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const fullQuery = await getHistory(server.port, 'b');
    expect(fullQuery.entries.map((e) => e.sha)).toContain(preWipSha);
  }, 60_000);

  test('timeline filters out backlink-rewrite topological noise from sibling renames', async () => {
    const server = await bootServer();
    mkdirSync(join(server.contentDir, 'parent'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# overview\n\nbody\n', {
      docName: 'parent/overview',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# faq\n\nbody\n', {
      docName: 'parent/faq',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(
      server,
      '# getting-started\n\nSee [[parent/overview]] and [[parent/faq]].\n',
      {
        docName: 'parent/getting-started',
        position: 'replace',
        ...AGENT,
      },
    );

    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/faq.md',
      toPath: 'parent/faq-renamed.md',
      ...AGENT,
    });
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/overview.md',
      toPath: 'parent/overview-renamed.md',
      ...AGENT,
    });
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/getting-started.md',
      toPath: 'parent/getting-started-renamed.md',
      ...AGENT,
    });

    const hist = await getHistory(server.port, 'parent/getting-started-renamed');
    expect(hist.entries).toBeDefined();

    const subjects = hist.entries.map((e) => e.message);
    expect(
      subjects.some((s) => s.includes('parent/getting-started') && s.includes('renamed')),
    ).toBe(true);
    expect(subjects.some((s) => s.includes('parent/faq -> parent/faq-renamed'))).toBe(false);
    expect(subjects.some((s) => s.includes('parent/overview -> parent/overview-renamed'))).toBe(
      false,
    );
  }, 60_000);

  test('timeline filters out multi-writer-fan-out topological noise', async () => {
    const server = await bootServer();
    mkdirSync(join(server.contentDir, 'multi'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# alpha\n', {
      docName: 'multi/alpha',
      position: 'replace',
      ...AGENT,
    });

    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'multi/alpha.md',
      toPath: 'multi/alpha-renamed.md',
      ...AGENT,
    });

    const OTHER_AGENT = { agentId: 'claude-other', agentName: 'Other' };
    await agentWriteMdAndAwaitWip(server, '# beta\n', {
      docName: 'multi/beta',
      position: 'replace',
      ...OTHER_AGENT,
    });

    const hist = await getHistory(server.port, 'multi/alpha-renamed');
    const writerIds = new Set<string>();
    for (const entry of hist.entries) {
      for (const c of entry.contributors) writerIds.add(c.id);
    }
    expect([...writerIds].every((id) => id.startsWith('agent-claude-1'))).toBe(true);

    for (const entry of hist.entries) {
      for (const c of entry.contributors) {
        expect(c.docs).not.toContain('multi/beta');
      }
    }
  }, 60_000);

  test('folder rename — user-supplied summary appears exactly once in OkActorEntry.summaries (no per-doc duplication)', async () => {
    const server = await bootServer();
    mkdirSync(join(server.contentDir, 'src-folder'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# a\n', {
      docName: 'src-folder/a',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# b\n', {
      docName: 'src-folder/b',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# c\n', {
      docName: 'src-folder/c',
      position: 'replace',
      ...AGENT,
    });

    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'src-folder',
      toPath: 'dst-folder',
      summary: 'Renamed src-folder → dst-folder',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toHaveLength(3);

    const entries = readRenameLogEntries(server);
    const folderEntries = entries.filter(
      (e) => e.from.startsWith('src-folder/') && e.to.startsWith('dst-folder/'),
    );
    expect(folderEntries).toHaveLength(3);
    const renameSha = folderEntries[0].commitSha;
    expect(renameSha).toMatch(/^[0-9a-f]{40}$/);
    for (const e of folderEntries) expect(e.commitSha).toBe(renameSha);

    const { execSync } = await import('node:child_process');
    const shadow = resolveShadowDir(server.contentDir);
    const body = execSync(`git --git-dir=${shadow} show -s --format=%B ${renameSha}`, {
      encoding: 'utf-8',
    });
    const okActorLine = body.split('\n').find((l) => l.startsWith('ok-actor:')) ?? '';
    const okActor = JSON.parse(okActorLine.slice('ok-actor: '.length)) as {
      summaries?: string[];
      previous_paths?: Array<{ from: string; to: string }>;
    };
    expect(okActor.summaries).toEqual(['Renamed src-folder → dst-folder']);
    expect(okActor.previous_paths).toHaveLength(3);
  }, 60_000);

  test('user-supplied summary lands on the same commit as the rename event (no leak across drains)', async () => {
    const server = await bootServer();
    writeFileSync(join(server.contentDir, 'summary-a.md'), '# A\n', 'utf-8');
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      if (!res.ok) return false;
      const data = (await res.json()) as { documents?: DocumentListEntry[] };
      return (data.documents ?? []).some((d) => isDocumentListDoc(d) && d.docName === 'summary-a');
    }, 10_000);

    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: 'summary-a.md',
      toPath: 'summary-b.md',
      summary: 'Renamed summary-a → summary-b',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    const entries = readRenameLogEntries(server);
    const entry = entries.find((e) => e.from === 'summary-a' && e.to === 'summary-b');
    expect(entry?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const renameSha = entry?.commitSha ?? '';

    const { execSync } = await import('node:child_process');
    const shadow = resolveShadowDir(server.contentDir);
    const body = execSync(`git --git-dir=${shadow} show -s --format=%B ${renameSha}`, {
      encoding: 'utf-8',
    });
    const okActorLine = body.split('\n').find((l) => l.startsWith('ok-actor:')) ?? '';
    const okActorBody = okActorLine.slice('ok-actor: '.length);
    const okActor = JSON.parse(okActorBody) as { summaries?: string[]; previous_paths?: unknown };
    expect(okActor.summaries).toBeDefined();
    expect(okActor.summaries).toContain('Renamed summary-a → summary-b');
    expect(okActor.previous_paths).toBeDefined();

    await agentWriteMdAndAwaitWip(server, '# Unrelated\n', {
      docName: 'unrelated-doc',
      position: 'replace',
      ...AGENT,
    });
    const unrelatedHist = await getHistory(server.port, 'unrelated-doc');
    const latestSha = unrelatedHist.entries[0]?.sha ?? '';
    expect(latestSha).not.toBe(renameSha);
    const latestBody = execSync(`git --git-dir=${shadow} show -s --format=%B ${latestSha}`, {
      encoding: 'utf-8',
    });
    expect(latestBody).not.toContain('summary-a → summary-b');
  }, 60_000);

  test('GET /api/history/:sha for a pre-rename commit returns historical content (rename-chain walk)', async () => {
    const server = await bootServer();
    await agentWriteMdAndAwaitWip(server, '# Haiku v1\n\noriginal body\n', {
      docName: 'haiku',
      position: 'replace',
      ...AGENT,
    });
    const preRename = await getHistory(server.port, 'haiku');
    const wipAtHaiku = preRename.entries.find((e) => e.type === 'wip');
    expect(wipAtHaiku).toBeDefined();
    const preRenameSha = wipAtHaiku?.sha ?? '';

    await crossSecondBoundary();
    expect(
      (
        await renamePath(server.port, {
          kind: 'file',
          fromPath: 'haiku.md',
          toPath: 'writing-haiku.md',
          ...AGENT,
        })
      ).status,
    ).toBe(200);

    const versionRes = await getHistoryVersion(server.port, 'writing-haiku', preRenameSha);
    expect(versionRes.status).toBe(200);
    expect(versionRes.body.content).toContain('Haiku v1');
    expect(versionRes.body.content).toContain('original body');
  }, 60_000);

  test('pure rename without subsequent edit → commitSha backfilled before /api/rename-path response returns', async () => {
    const server = await bootServer();
    writeFileSync(join(server.contentDir, 'pure-a.md'), '# Pure A\n', 'utf-8');
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      if (!res.ok) return false;
      const data = (await res.json()) as { documents?: DocumentListEntry[] };
      return (data.documents ?? []).some((d) => isDocumentListDoc(d) && d.docName === 'pure-a');
    }, 10_000);

    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: 'pure-a.md',
      toPath: 'pure-b.md',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    const jsonlPath = renameLogPath(resolveShadowDir(server.contentDir));
    const raw = readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const matching = lines
      .map((l) => JSON.parse(l) as RenameLogEntry)
      .filter((e) => e.from === 'pure-a' && e.to === 'pure-b');
    expect(matching).toHaveLength(1);
    expect(matching[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test('1000-doc folder rename completes within budget; jsonl size stays under hard cap', async () => {
    const server = await bootServer();

    const COUNT = 1000;
    mkdirSync(join(server.contentDir, 'big'), { recursive: true });
    for (let i = 0; i < COUNT; i++) {
      writeFileSync(join(server.contentDir, 'big', `doc-${i}.md`), `# doc-${i}\n`, 'utf-8');
    }

    const rescanRes = await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`, {
      method: 'POST',
    });
    expect(rescanRes.status).toBe(200);

    const docsRes = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(docsRes.status).toBe(200);
    const docsData = (await docsRes.json()) as { documents?: DocumentListEntry[] };
    const indexedCount = (docsData.documents ?? []).filter(
      (d) => isDocumentListDoc(d) && d.docName.startsWith('big/doc-'),
    ).length;
    if (indexedCount !== COUNT) {
      throw new Error(`file index has ${indexedCount}/${COUNT} 'big/doc-' docs after rescan`);
    }

    const t0 = performance.now();
    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'big',
      toPath: 'huge',
      ...AGENT,
    });
    const elapsed = performance.now() - t0;
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toHaveLength(COUNT);

    const entries = readRenameLogEntries(server);
    const folderEntries = entries.filter(
      (e) => e.from.startsWith('big/doc-') && e.to.startsWith('huge/doc-'),
    );
    expect(folderEntries).toHaveLength(COUNT);

    expect(elapsed).toBeLessThan(90_000);

    const jsonlPath = renameLogPath(resolveShadowDir(server.contentDir));
    const stat = readFileSync(jsonlPath);
    expect(stat.byteLength).toBeLessThan(1_000_000);
  }, 180_000);
});
