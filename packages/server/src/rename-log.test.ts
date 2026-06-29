import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import {
  appendRenameLogEntry,
  backfillRenameLogCommitSha,
  batchCheckExistence,
  buildAncestorShaSet,
  buildSeeds,
  createAncestorShaSetCache,
  createEmptyIndex,
  createSeedsCache,
  expandPredecessors,
  gcRenameLog,
  loadRenameLogIndex,
  MAX_PREDECESSOR_CHAIN_DEPTH,
  RENAME_LOG_HARD_CAP_BYTES,
  type RenameLogEntry,
  renameLogPath,
  resolveDocPathAtCommit,
  serializeIndexToString,
  sweepLazyPopOrphans,
} from './rename-log.ts';
import {
  commitWip,
  initShadowRepo,
  type ShadowHandle,
  saveVersion,
  type WriterIdentity,
} from './shadow-repo.ts';

let shadowDir: string;

beforeEach(async () => {
  shadowDir = await mkdtemp(resolve(tmpdir(), 'ok-rename-log-test-'));
});

afterEach(async () => {
  await rm(shadowDir, { recursive: true, force: true });
});

function entry(overrides: Partial<RenameLogEntry> = {}): RenameLogEntry {
  return {
    v: 1,
    from: 'articles/auth',
    to: 'essays/auth',
    at: '2026-05-05T12:00:00.000Z',
    commitSha: '',
    branch: 'main',
    groupId: '01234567-89ab-cdef-0123-456789abcdef',
    kind: 'file',
    actor: { writerId: 'agent-conn-abc', displayName: 'Claude' },
    ...overrides,
  };
}

describe('renameLogPath', () => {
  test('resolves <shadowDir>/renames.jsonl', () => {
    expect(renameLogPath('/tmp/shadow')).toBe(resolve('/tmp/shadow', 'renames.jsonl'));
  });
});

describe('loadRenameLogIndex', () => {
  test('missing file → empty index', () => {
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(0);
    expect(index.byFrom.size).toBe(0);
  });

  test('zero-byte file → empty index', () => {
    writeFileSync(renameLogPath(shadowDir), '');
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(0);
    expect(index.byFrom.size).toBe(0);
  });

  test('well-formed jsonl → fully populated index (byTo + byFrom)', () => {
    const e1 = entry({ from: 'a', to: 'b' });
    const e2 = entry({ from: 'b', to: 'c', at: '2026-05-05T12:01:00.000Z' });
    const body = `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(2);
    expect(index.byTo.get('b')).toMatchObject({ from: 'a', to: 'b' });
    expect(index.byTo.get('c')).toMatchObject({ from: 'b', to: 'c' });
    expect(index.byFrom.get('a')?.[0]?.to).toBe('b');
    expect(index.byFrom.get('b')?.[0]?.to).toBe('c');
  });

  test('byFrom collects multiple entries when same `from` reused as predecessor', () => {
    const e1 = entry({ from: 'shared', to: 'first', at: '2026-05-01T00:00:00.000Z' });
    const e2 = entry({ from: 'shared', to: 'second', at: '2026-05-02T00:00:00.000Z' });
    const body = `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byFrom.get('shared')).toHaveLength(2);
    expect(index.byFrom.get('shared')?.map((e) => e.to)).toEqual(['first', 'second']);
  });

  test('final line missing newline → drops final line (and warns)', () => {
    const e1 = entry({ from: 'a', to: 'b' });
    const e2 = entry({ from: 'b', to: 'c' });
    const body = `${JSON.stringify(e1)}\n${JSON.stringify(e2)}`; // no trailing newline
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(1);
    expect(index.byTo.get('b')).toBeDefined();
    expect(index.byTo.get('c')).toBeUndefined();
  });

  test('mid-file unparseable line → drop + continue with surrounding valid entries', () => {
    const e1 = entry({ from: 'a', to: 'b' });
    const e3 = entry({ from: 'c', to: 'd' });
    const body = `${JSON.stringify(e1)}\n{not valid json\n${JSON.stringify(e3)}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(2);
    expect(index.byTo.get('b')).toBeDefined();
    expect(index.byTo.get('d')).toBeDefined();
  });

  test('schema-invalid line (wrong v, missing fields) → dropped', () => {
    const valid = entry({ from: 'a', to: 'b' });
    const invalidV = JSON.stringify({ ...valid, v: 2 });
    const missingActor = JSON.stringify({ ...valid, actor: undefined });
    const wrongKind = JSON.stringify({ ...valid, kind: 'symlink' });
    const body = `${JSON.stringify(valid)}\n${invalidV}\n${missingActor}\n${wrongKind}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(1);
    expect(index.byTo.get('b')).toBeDefined();
  });

  test('non-empty commitSha that is not a 40-char hex string → entry rejected at parse boundary', () => {
    const valid = entry({ from: 'a', to: 'b', commitSha: 'a'.repeat(40) });
    const bogusShape = entry({ from: 'c', to: 'd', commitSha: 'not-a-sha' });
    const tooShort = entry({ from: 'e', to: 'f', commitSha: 'abc123' });
    const nonHex = entry({ from: 'g', to: 'h', commitSha: 'g'.repeat(40) });
    const body = [
      JSON.stringify(valid),
      JSON.stringify(bogusShape),
      JSON.stringify(tooShort),
      JSON.stringify(nonHex),
      '',
    ].join('\n');
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(1);
    expect(index.byTo.get('b')).toBeDefined();
    expect(index.byTo.get('d')).toBeUndefined();
    expect(index.byTo.get('f')).toBeUndefined();
    expect(index.byTo.get('h')).toBeUndefined();
  });

  test('empty commitSha is allowed (lazy-population window)', () => {
    const lazyPop = entry({ from: 'a', to: 'b', commitSha: '' });
    const body = `${JSON.stringify(lazyPop)}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.get('b')?.commitSha).toBe('');
  });

  test('empty lines (consecutive newlines) are skipped silently', () => {
    const e1 = entry({ from: 'a', to: 'b' });
    const body = `${JSON.stringify(e1)}\n\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    const index = loadRenameLogIndex(shadowDir);
    expect(index.byTo.size).toBe(1);
  });
});

describe('appendRenameLogEntry', () => {
  test('round-trip: append + load → same entry recovered', () => {
    const index = createEmptyIndex();
    const e = entry({ from: 'a', to: 'b' });
    appendRenameLogEntry(shadowDir, e, index);

    expect(index.byTo.get('b')).toEqual(e);
    expect(index.byFrom.get('a')?.[0]).toEqual(e);

    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.get('b')).toEqual(e);
  });

  test('multiple appends preserve order and accumulate index', () => {
    const index = createEmptyIndex();
    const e1 = entry({ from: 'a', to: 'b' });
    const e2 = entry({ from: 'b', to: 'c' });
    const e3 = entry({ from: 'c', to: 'd' });
    appendRenameLogEntry(shadowDir, e1, index);
    appendRenameLogEntry(shadowDir, e2, index);
    appendRenameLogEntry(shadowDir, e3, index);
    expect(index.byTo.size).toBe(3);

    const raw = readFileSync(renameLogPath(shadowDir), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).to).toBe('b');
    expect(JSON.parse(lines[1]).to).toBe('c');
    expect(JSON.parse(lines[2]).to).toBe('d');
  });

  test('persists empty commitSha for lazy-population window', () => {
    const index = createEmptyIndex();
    const e = entry({ from: 'a', to: 'b', commitSha: '' });
    appendRenameLogEntry(shadowDir, e, index);

    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.get('b')?.commitSha).toBe('');
  });

  test('refuses to append schema-invalid entry', () => {
    const index = createEmptyIndex();
    const malformed = { ...entry(), v: 2 } as unknown as RenameLogEntry;
    expect(() => appendRenameLogEntry(shadowDir, malformed, index)).toThrow();
    expect(index.byTo.size).toBe(0);
    expect(existsSync(renameLogPath(shadowDir))).toBe(false);
  });

  test('refuses to append entry exceeding 4 KB line cap', () => {
    const index = createEmptyIndex();
    const huge = entry({ from: 'a'.repeat(2000), to: 'b'.repeat(2100) });
    expect(() => appendRenameLogEntry(shadowDir, huge, index)).toThrow();
    expect(index.byTo.size).toBe(0);
  });

  test('survives anonymous-actor entry (FR13 service-writer)', () => {
    const index = createEmptyIndex();
    const e = entry({
      actor: { writerId: 'openknowledge-service', displayName: 'OpenKnowledge (service)' },
    });
    appendRenameLogEntry(shadowDir, e, index);
    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.get('essays/auth')?.actor.writerId).toBe('openknowledge-service');
  });

  test('handles folder-rename siblings sharing a groupId', () => {
    const index = createEmptyIndex();
    const groupId = '01234567-aaaa-bbbb-cccc-444444444444';
    const e1 = entry({ from: 'articles/auth', to: 'essays/auth', kind: 'folder', groupId });
    const e2 = entry({ from: 'articles/sso', to: 'essays/sso', kind: 'folder', groupId });
    const e3 = entry({ from: 'articles/oauth', to: 'essays/oauth', kind: 'folder', groupId });
    appendRenameLogEntry(shadowDir, e1, index);
    appendRenameLogEntry(shadowDir, e2, index);
    appendRenameLogEntry(shadowDir, e3, index);
    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.size).toBe(3);
    for (const e of reloaded.byTo.values()) {
      expect(e.groupId).toBe(groupId);
      expect(e.kind).toBe('folder');
    }
  });

  test('overwrite of same `to` removes the displaced entry from byFrom', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'a', to: 'b', commitSha: 'a'.repeat(40) }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'c', to: 'b', commitSha: 'c'.repeat(40) }),
      index,
    );
    expect(index.byTo.get('b')?.from).toBe('c');
    expect(index.byFrom.has('a')).toBe(false);
    expect(index.byFrom.get('c')?.[0]?.to).toBe('b');
  });

  test('warns when existing file already exceeds hard cap', () => {
    const path = renameLogPath(shadowDir);
    const filler = 'x'.repeat(RENAME_LOG_HARD_CAP_BYTES + 100);
    writeFileSync(path, filler);

    const index = createEmptyIndex();
    let warned = false;
    const orig = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('exceeds hard cap')) warned = true;
    };
    try {
      appendRenameLogEntry(shadowDir, entry(), index);
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
  });
});

describe('expandPredecessors', () => {
  test('un-renamed doc → returns [{path: doc, renameCommit: null}]', () => {
    const index = createEmptyIndex();
    const { chain, skipped } = expandPredecessors('essays/auth', 'main', index);
    expect(chain).toEqual([{ path: 'essays/auth', renameCommit: null }]);
    expect(skipped).toBe(0);
  });

  test('single rename → 2-element chain (predecessor first, current last)', () => {
    const index = createEmptyIndex();
    const e = entry({
      from: 'articles/auth',
      to: 'essays/auth',
      commitSha: 'a'.repeat(40),
    });
    appendRenameLogEntry(shadowDir, e, index);
    const { chain, skipped } = expandPredecessors('essays/auth', 'main', index);
    expect(chain).toEqual([
      { path: 'articles/auth', renameCommit: 'a'.repeat(40) },
      { path: 'essays/auth', renameCommit: null },
    ]);
    expect(skipped).toBe(0);
  });

  test('chained A→B→C → 3-element chain in correct order', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'a', to: 'b', commitSha: 'a'.repeat(40) }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'b', to: 'c', commitSha: 'b'.repeat(40) }),
      index,
    );
    const { chain } = expandPredecessors('c', 'main', index);
    expect(chain).toEqual([
      { path: 'a', renameCommit: 'a'.repeat(40) },
      { path: 'b', renameCommit: 'b'.repeat(40) },
      { path: 'c', renameCommit: null },
    ]);
  });

  test('cycle-poisoned index (A→B, B→A) terminates with warning', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'a', to: 'b', commitSha: 'a'.repeat(40) }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'b', to: 'a', commitSha: 'b'.repeat(40) }),
      index,
    );
    let warned = false;
    const orig = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('cycle detected')) warned = true;
    };
    try {
      const { chain } = expandPredecessors('a', 'main', index);
      expect(chain[chain.length - 1]).toEqual({ path: 'a', renameCommit: null });
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
  });

  test('missing entry mid-chain → chain stops cleanly', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'b', to: 'c', commitSha: 'b'.repeat(40) }),
      index,
    );
    const { chain } = expandPredecessors('c', 'main', index);
    expect(chain).toEqual([
      { path: 'b', renameCommit: 'b'.repeat(40) },
      { path: 'c', renameCommit: null },
    ]);
  });

  test('deleted-then-recreated (no entry on the new doc) → chain returns just [newDoc]', () => {
    const index = createEmptyIndex();
    const { chain } = expandPredecessors('orphan', 'main', index);
    expect(chain).toEqual([{ path: 'orphan', renameCommit: null }]);
  });

  test('lazy-pop entry with empty commitSha → predecessor entry omitted; skipped count surfaced', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(shadowDir, entry({ from: 'a', to: 'b', commitSha: '' }), index);
    const { chain, skipped } = expandPredecessors('b', 'main', index);
    expect(chain).toEqual([{ path: 'b', renameCommit: null }]);
    expect(skipped).toBe(1);
  });

  test('branch mismatch → chain stops at the mismatched step', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ from: 'a', to: 'b', branch: 'feature-x', commitSha: 'a'.repeat(40) }),
      index,
    );
    const { chain } = expandPredecessors('b', 'main', index);
    expect(chain).toEqual([{ path: 'b', renameCommit: null }]);
  });

  test('chain depth > MAX_PREDECESSOR_CHAIN_DEPTH truncates with warning', () => {
    const index = createEmptyIndex();
    const depth = MAX_PREDECESSOR_CHAIN_DEPTH + 5;
    for (let i = 0; i < depth; i++) {
      appendRenameLogEntry(
        shadowDir,
        entry({
          from: `step-${i}`,
          to: `step-${i + 1}`,
          commitSha: i.toString(16).padStart(40, '0'),
        }),
        index,
      );
    }

    let warned = false;
    const origWarn = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('chain depth exceeded')) warned = true;
    };
    try {
      const { chain } = expandPredecessors(`step-${depth}`, 'main', index);
      expect(chain.length).toBe(MAX_PREDECESSOR_CHAIN_DEPTH + 1);
      expect(chain[chain.length - 1]).toEqual({ path: `step-${depth}`, renameCommit: null });
    } finally {
      console.warn = origWarn;
    }
    expect(warned).toBe(true);
  });
});

describe('buildSeeds — monotonicity property', () => {
  test('adding any post-R checkpoint never grows the seed set', () => {
    const renameAuthorDate = '2026-05-05T12:00:00.000Z';
    const candidates: Array<{ date: string; sha: string }> = [
      { date: '2026-05-05T11:59:59.000Z', sha: 'pre-1'.padEnd(40, '0') }, // < R → in seeds
      { date: '2026-05-05T12:00:00.000Z', sha: 'eq-r'.padEnd(40, '0') }, // === R → excluded
      { date: '2026-05-05T12:00:01.000Z', sha: 'post-1'.padEnd(40, '0') }, // > R → excluded
      { date: '2025-01-01T00:00:00.000Z', sha: 'old-1'.padEnd(40, '0') }, // < R → in seeds
    ];
    const filtered = candidates
      .filter((c) => c.date < renameAuthorDate)
      .map((c) => c.sha)
      .sort();
    expect(filtered).toEqual(['old-1'.padEnd(40, '0'), 'pre-1'.padEnd(40, '0')]);
    const post2 = { date: '2026-05-05T13:00:00.000Z', sha: 'post-2'.padEnd(40, '0') };
    const filteredAfter = [...candidates, post2]
      .filter((c) => c.date < renameAuthorDate)
      .map((c) => c.sha)
      .sort();
    expect(filteredAfter).toEqual(filtered);
  });
});

describe('rename-log read primitives (shadow-repo backed)', () => {
  let projectRoot: string;
  let shadow: ShadowHandle;
  let contentRoot: string;
  let realShadowDir: string;

  const writer: WriterIdentity = {
    id: 'human-ada',
    name: 'Ada',
    email: 'ada@example.com',
  };

  async function checkpointSha(branch = 'main'): Promise<string> {
    const sg = simpleGit({ baseDir: shadow.workTree }).env({
      GIT_DIR: shadow.gitDir,
      GIT_WORK_TREE: shadow.workTree,
    });
    const refs = (
      await sg.raw(
        'for-each-ref',
        '--sort=-creatordate',
        '--format=%(objectname)',
        `refs/checkpoints/${branch}/`,
      )
    ).trim();
    const top = refs.split('\n')[0];
    return top;
  }

  async function commit(text: string, file: string, msg: string, date?: string): Promise<string> {
    const path = resolve(contentRoot, file);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return commitWip(shadow, writer, 'content', msg, 'main', date ? { date } : undefined);
  }

  async function save(date?: string): Promise<unknown> {
    return saveVersion(shadow, 'content', [writer], 'main', undefined, date ? { date } : undefined);
  }

  function makeTick(startIso = '2026-05-05T12:00:00.000Z') {
    let t = Date.parse(startIso);
    return () => {
      t += 1000;
      return new Date(t).toISOString();
    };
  }

  beforeEach(async () => {
    projectRoot = resolve(shadowDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    contentRoot = resolve(projectRoot, 'content');
    mkdirSync(contentRoot, { recursive: true });

    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');

    shadow = await initShadowRepo(projectRoot);
    realShadowDir = shadow.gitDir;
  });

  test('batchCheckExistence — empty probes → empty result', async () => {
    const result = await batchCheckExistence(shadow, []);
    expect(result).toEqual([]);
  });

  test('batchCheckExistence — single existing path → [true]', async () => {
    const sha = await commit('# Hello\n', 'a.md', 'WIP: a');
    const result = await batchCheckExistence(shadow, [{ sha, path: 'content/a.md' }]);
    expect(result).toEqual([true]);
  });

  test('batchCheckExistence — single missing path → [false]', async () => {
    const sha = await commit('# Hello\n', 'a.md', 'WIP: a');
    const result = await batchCheckExistence(shadow, [{ sha, path: 'content/missing.md' }]);
    expect(result).toEqual([false]);
  });

  test('batchCheckExistence — mixed batch preserves order', async () => {
    const sha = await commit('# A\n', 'a.md', 'WIP: a');
    const result = await batchCheckExistence(shadow, [
      { sha, path: 'content/missing.md' },
      { sha, path: 'content/a.md' },
      { sha, path: 'content/also-missing.md' },
    ]);
    expect(result).toEqual([false, true, false]);
  });

  test('batchCheckExistence — exactly one git child process spawned per call regardless of probe count (FR16)', async () => {
    const sha = await commit('# Hello\n', 'a.md', 'WIP: a');
    const cp = await import('node:child_process');
    const { spyOn } = await import('bun:test');
    const spy = spyOn(cp, 'spawn');
    try {
      const probes = Array.from({ length: 50 }, (_, i) => ({
        sha,
        path: i === 0 ? 'content/a.md' : `content/missing-${i}.md`,
      }));
      const result = await batchCheckExistence(shadow, probes);
      expect(result).toHaveLength(50);
      expect(result[0]).toBe(true);
      expect(result.slice(1).every((b) => b === false)).toBe(true);
      const gitInvocations = spy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0] === 'git',
      );
      expect(gitInvocations).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('buildSeeds — no checkpoints → seeds === [renameCommit]', async () => {
    const sha = await commit('# A\n', 'a.md', 'WIP: a');
    const seeds = await buildSeeds(shadow, sha, 'main');
    expect(seeds).toEqual([sha]);
  });

  test('buildSeeds — git show fails for bogus rename commit → falls back to [renameCommit]', async () => {
    const bogusSha = '0123456789abcdef0123456789abcdef01234567';
    const orig = console.warn;
    let warned = false;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('buildSeeds: git show failed')) warned = true;
    };
    try {
      const seeds = await buildSeeds(shadow, bogusSha, 'main');
      expect(seeds).toEqual([bogusSha]);
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
  });

  test('buildSeeds — checkpoint earlier than R → included; checkpoint later than R → excluded', async () => {
    const at = makeTick();

    await commit('# A v1\n', 'a.md', 'WIP: a v1', at());
    await save(at());
    const k1 = await checkpointSha('main');

    const renameSha = await commit('# A v2 — rename\n', 'a.md', 'rename: a -> b', at());

    await commit('# B v1\n', 'b.md', 'WIP: b', at());
    await save(at());
    const k2 = await checkpointSha('main');

    const seeds = await buildSeeds(shadow, renameSha, 'main');
    expect(seeds).toContain(renameSha);
    expect(seeds).toContain(k1);
    expect(seeds).not.toContain(k2);
  });

  test('buildAncestorShaSet — empty seeds → empty set', async () => {
    const set = await buildAncestorShaSet(shadow, [], 'main');
    expect(set.size).toBe(0);
  });

  test('buildAncestorShaSet — one seed → set contains seed and ancestors', async () => {
    const sha1 = await commit('# v1\n', 'a.md', 'WIP: v1');
    const sha2 = await commit('# v2\n', 'a.md', 'WIP: v2');
    const set = await buildAncestorShaSet(shadow, [sha2], 'main');
    expect(set.has(sha1)).toBe(true);
    expect(set.has(sha2)).toBe(true);
  });

  test('buildAncestorShaSet — cache hit on identical seeds key', async () => {
    const sha = await commit('# v1\n', 'a.md', 'WIP: v1');
    const cache = createAncestorShaSetCache();
    const set1 = await buildAncestorShaSet(shadow, [sha], 'main', cache);
    const set2 = await buildAncestorShaSet(shadow, [sha], 'main', cache);
    expect(set1).toBe(set2);
  });

  test('resolveDocPathAtCommit — unrenamed doc, current path exists at sha → returns current path', async () => {
    const sha = await commit('# A\n', 'a.md', 'WIP: a');
    const index = createEmptyIndex();
    const path = await resolveDocPathAtCommit(
      shadow,
      'a',
      sha,
      'main',
      index,
      (n) => `content/${n}.md`,
    );
    expect(path).toBe('content/a.md');
  });

  test('resolveDocPathAtCommit — unrelated sha → returns null', async () => {
    const index = createEmptyIndex();
    const fakeSha = 'deadbeef'.repeat(5);
    const path = await resolveDocPathAtCommit(
      shadow,
      'a',
      fakeSha,
      'main',
      index,
      (n) => `content/${n}.md`,
    );
    expect(path).toBeNull();
  });

  test('resolveDocPathAtCommit — renamed doc, sha at predecessor name → returns historical path', async () => {
    const at = makeTick();

    const commitA = await commit('# A pre-rename\n', 'a.md', 'WIP: a', at());
    await save(at());

    const renameCommit = await commit('# B post-rename\n', 'b.md', 'rename: a -> b', at());

    const index = createEmptyIndex();
    appendRenameLogEntry(
      realShadowDir,
      entry({ from: 'a', to: 'b', commitSha: renameCommit }),
      index,
    );

    const path = await resolveDocPathAtCommit(
      shadow,
      'b',
      commitA,
      'main',
      index,
      (n) => `content/${n}.md`,
    );
    expect(path).toBe('content/a.md');
  });

  test('resolveDocPathAtCommit — name-reuse contamination rejected by cycle bound', async () => {
    const at = makeTick();

    await commit('# A old\n', 'a.md', 'WIP: a', at());
    await save(at());

    rmSync(resolve(contentRoot, 'a.md'));
    const renameCommit = await commit('# B fresh\n', 'b.md', 'rename: a -> b', at());
    await save(at());

    rmSync(resolve(contentRoot, 'b.md'));
    const newACommit = await commit('# A new (unrelated)\n', 'a.md', 'WIP: new-a', at());
    await save(at());

    const index = createEmptyIndex();
    appendRenameLogEntry(
      realShadowDir,
      entry({ from: 'a', to: 'b', commitSha: renameCommit }),
      index,
    );

    const path = await resolveDocPathAtCommit(
      shadow,
      'b',
      newACommit,
      'main',
      index,
      (n) => `content/${n}.md`,
    );
    expect(path).toBeNull();
  });

  test('over-cap append schedules microtask GC that actually shrinks the file (FR11)', async () => {
    const path = renameLogPath(realShadowDir);
    const filler = 'x'.repeat(RENAME_LOG_HARD_CAP_BYTES + 100);
    writeFileSync(path, filler);
    const sizeBefore = statSync(path).size;
    expect(sizeBefore).toBeGreaterThan(RENAME_LOG_HARD_CAP_BYTES);

    const index = createEmptyIndex();
    const orig = console.warn;
    let warned = false;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('exceeds hard cap')) warned = true;
    };
    try {
      appendRenameLogEntry(
        realShadowDir,
        entry({
          from: 'a',
          to: 'b',
          commitSha: 'a'.repeat(40),
          actor: { writerId: 'agent-test', displayName: 'T' },
        }),
        index,
        shadow,
      );
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
    expect(index.byTo.size).toBe(1);

    let drained = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (index.byTo.size === 0) {
        drained = true;
        break;
      }
    }
    expect(drained).toBe(true);

    const sizeAfter = statSync(path).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
    expect(sizeAfter).toBeLessThan(RENAME_LOG_HARD_CAP_BYTES);
  });
});

describe('batchCheckExistence timeout fallback (FR16 / D-T7)', () => {
  let projectRoot: string;
  let shadow: ShadowHandle;
  let fakeBinDir: string;

  beforeEach(async () => {
    projectRoot = resolve(shadowDir, 'timeout-project');
    mkdirSync(projectRoot, { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    shadow = await initShadowRepo(projectRoot);

    fakeBinDir = resolve(shadowDir, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(resolve(fakeBinDir, 'git'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  });

  test('git binary hang → timeout fires, returns all-false, warns', async () => {
    const origPath = process.env.PATH ?? '';
    const origTimeout = process.env.OK_GIT_TIMEOUT_MS;
    process.env.PATH = `${fakeBinDir}:${origPath}`;
    process.env.OK_GIT_TIMEOUT_MS = '200';

    const orig = console.warn;
    let warnedTimeout = false;
    let warnMsg: string | null = null;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('timed out')) {
        warnedTimeout = true;
        warnMsg = msg;
      }
    };

    try {
      const t0 = performance.now();
      const result = await batchCheckExistence(shadow, [
        { sha: 'a'.repeat(40), path: 'content/x.md' },
        { sha: 'b'.repeat(40), path: 'content/y.md' },
        { sha: 'c'.repeat(40), path: 'content/z.md' },
      ]);
      const elapsed = performance.now() - t0;

      expect(result).toEqual([false, false, false]);
      expect(warnedTimeout).toBe(true);
      expect(warnMsg).toContain('200ms');
      expect(warnMsg).toContain('3 probes');
      expect(elapsed).toBeLessThan(2000);
    } finally {
      console.warn = orig;
      process.env.PATH = origPath;
      if (origTimeout !== undefined) process.env.OK_GIT_TIMEOUT_MS = origTimeout;
      else process.env.OK_GIT_TIMEOUT_MS = undefined;
    }
  }, 5000);
});

describe('backfillRenameLogCommitSha (US-007)', () => {
  test('updates entries with empty commitSha + matching writerId; rewrites jsonl', () => {
    const index = createEmptyIndex();
    const sha = 'a'.repeat(40);
    const e = entry({
      from: 'a',
      to: 'b',
      commitSha: '',
      actor: { writerId: 'agent-claude-1', displayName: 'Claude' },
    });
    appendRenameLogEntry(shadowDir, e, index);

    const result = backfillRenameLogCommitSha(shadowDir, 'agent-claude-1', sha, index);
    expect(result.updated).toBe(1);
    expect(index.byTo.get('b')?.commitSha).toBe(sha);

    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.get('b')?.commitSha).toBe(sha);
  });

  test('does not update entries with non-empty commitSha', () => {
    const index = createEmptyIndex();
    const e = entry({
      commitSha: 'b'.repeat(40),
      actor: { writerId: 'agent-claude-1', displayName: 'Claude' },
    });
    appendRenameLogEntry(shadowDir, e, index);

    const result = backfillRenameLogCommitSha(shadowDir, 'agent-claude-1', 'c'.repeat(40), index);
    expect(result.updated).toBe(0);
    expect(index.byTo.get('essays/auth')?.commitSha).toBe('b'.repeat(40));
  });

  test('does not update entries with mismatched writerId', () => {
    const index = createEmptyIndex();
    const e = entry({
      from: 'a',
      to: 'b',
      commitSha: '',
      actor: { writerId: 'agent-other', displayName: 'Other' },
    });
    appendRenameLogEntry(shadowDir, e, index);

    const result = backfillRenameLogCommitSha(shadowDir, 'agent-claude-1', 'c'.repeat(40), index);
    expect(result.updated).toBe(0);
    expect(index.byTo.get('b')?.commitSha).toBe('');
  });

  test('updates multiple matching entries (folder rename siblings)', () => {
    const index = createEmptyIndex();
    const groupId =
      'a'.repeat(8) +
      '-' +
      'b'.repeat(4) +
      '-' +
      'c'.repeat(4) +
      '-' +
      'd'.repeat(4) +
      '-' +
      'e'.repeat(12);
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'a/x',
        to: 'b/x',
        commitSha: '',
        kind: 'folder',
        groupId,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'a/y',
        to: 'b/y',
        commitSha: '',
        kind: 'folder',
        groupId,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'a/z',
        to: 'b/z',
        commitSha: '',
        kind: 'folder',
        groupId,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );

    const sha = 'f'.repeat(40);
    const result = backfillRenameLogCommitSha(shadowDir, 'agent-1', sha, index);
    expect(result.updated).toBe(3);
    for (const to of ['b/x', 'b/y', 'b/z']) {
      expect(index.byTo.get(to)?.commitSha).toBe(sha);
    }
    const reloaded = loadRenameLogIndex(shadowDir);
    for (const to of ['b/x', 'b/y', 'b/z']) {
      expect(reloaded.byTo.get(to)?.commitSha).toBe(sha);
    }
  });

  test('idempotent: calling twice with same writer SHA → second call updates 0', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ commitSha: '', actor: { writerId: 'agent-1', displayName: 'A' } }),
      index,
    );
    const sha = 'a'.repeat(40);
    backfillRenameLogCommitSha(shadowDir, 'agent-1', sha, index);
    const second = backfillRenameLogCommitSha(shadowDir, 'agent-1', sha, index);
    expect(second.updated).toBe(0);
  });

  test('FR15 lazy-pop transition: pre-backfill chain truncates, post-backfill chain materializes', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: '',
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );

    const pre = expandPredecessors('b', 'main', index);
    expect(pre.chain).toEqual([{ path: 'b', renameCommit: null }]);
    expect(pre.skipped).toBe(1);

    backfillRenameLogCommitSha(shadowDir, 'agent-1', 'a'.repeat(40), index);

    const post = expandPredecessors('b', 'main', index);
    expect(post.chain).toEqual([
      { path: 'a', renameCommit: 'a'.repeat(40) },
      { path: 'b', renameCommit: null },
    ]);
    expect(post.skipped).toBe(0);
  });
});

describe('sweepLazyPopOrphans (US-007 boot orphan cleanup)', () => {
  test('drops entries with empty commitSha at boot', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'orphan-from',
        to: 'orphan-to',
        commitSha: '',
        actor: { writerId: 'agent-orphan', displayName: 'Orphan' },
      }),
      index,
    );
    const result = sweepLazyPopOrphans(shadowDir, index);
    expect(result.dropped).toBe(1);
    expect(index.byTo.get('orphan-to')).toBeUndefined();
    expect(index.byFrom.get('orphan-from')).toBeUndefined();

    const reloaded = loadRenameLogIndex(shadowDir);
    expect(reloaded.byTo.size).toBe(0);
  });

  test('preserves entries with non-empty commitSha', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: 'a'.repeat(40),
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    appendRenameLogEntry(
      shadowDir,
      entry({
        from: 'orphan-from',
        to: 'orphan-to',
        commitSha: '',
        actor: { writerId: 'agent-orphan', displayName: 'Orphan' },
      }),
      index,
    );

    const result = sweepLazyPopOrphans(shadowDir, index);
    expect(result.dropped).toBe(1);
    expect(index.byTo.get('b')).toBeDefined();
    expect(index.byTo.get('orphan-to')).toBeUndefined();
  });

  test('no-op when nothing to drop', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ commitSha: 'a'.repeat(40), actor: { writerId: 'agent-1', displayName: 'A' } }),
      index,
    );
    const result = sweepLazyPopOrphans(shadowDir, index);
    expect(result.dropped).toBe(0);
  });
});

describe('gcRenameLog (US-008 reachability + rebuild)', () => {
  let projectRoot: string;
  let shadow: import('./shadow-repo.ts').ShadowHandle;
  let contentRoot: string;
  const writer: WriterIdentity = {
    id: 'human-ada',
    name: 'Ada',
    email: 'ada@example.com',
  };

  beforeEach(async () => {
    projectRoot = resolve(shadowDir, 'gc-project');
    mkdirSync(projectRoot, { recursive: true });
    contentRoot = resolve(projectRoot, 'content');
    mkdirSync(contentRoot, { recursive: true });

    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');

    shadow = await initShadowRepo(projectRoot);
  });

  test('drops entries whose commitSha is not reachable from any wip/checkpoint ref', async () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: 'a'.repeat(40), // 40-char hex but not a real commit
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    const result = await gcRenameLog(shadow, index);
    expect(result.scanned).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.retained).toBe(0);
  });

  test('retains entries whose commitSha is reachable from refs/wip', async () => {
    writeFileSync(resolve(contentRoot, 'a.md'), '# A\n');
    const sha = await commitWip(shadow, writer, 'content', 'WIP: a');

    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: sha,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    const result = await gcRenameLog(shadow, index);
    expect(result.scanned).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.retained).toBe(1);
  });

  test('retains entries whose commitSha is reachable through a checkpoint (Q2 sub-DAG topology)', async () => {
    writeFileSync(resolve(contentRoot, 'a.md'), '# A\n');
    const sha = await commitWip(shadow, writer, 'content', 'WIP: a');
    await saveVersion(shadow, 'content', [writer]);

    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: sha,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );
    const result = await gcRenameLog(shadow, index);
    expect(result.dropped).toBe(0);
    expect(result.retained).toBe(1);
  });

  test('aborts (preserves all entries) when for-each-ref fails transiently', async () => {
    writeFileSync(resolve(contentRoot, 'a.md'), '# A\n');
    const realSha = await commitWip(shadow, writer, 'content', 'WIP: a');
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: realSha,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );

    const brokenGitDir = resolve(shadowDir, 'not-a-repo');
    mkdirSync(brokenGitDir, { recursive: true });
    const brokenShadow: ShadowHandle = {
      gitDir: brokenGitDir,
      workTree: shadow.workTree,
    };

    const origWarn = console.warn;
    let warned = false;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('aborted')) warned = true;
    };
    try {
      const result = await gcRenameLog(brokenShadow, index);
      expect(result.scanned).toBe(0);
      expect(result.dropped).toBe(0);
      expect(result.retained).toBe(0);
    } finally {
      console.warn = origWarn;
    }
    expect(warned).toBe(true);
    expect(index.byTo.get('b')?.commitSha).toBe(realSha);
    const reloaded = loadRenameLogIndex(shadow.gitDir);
    expect(reloaded.byTo.get('b')?.commitSha).toBe(realSha);
  });

  test('aborts (preserves all entries) when rev-list fails after for-each-ref succeeds', async () => {
    writeFileSync(resolve(contentRoot, 'a.md'), '# A\n');
    const realSha = await commitWip(shadow, writer, 'content', 'WIP: a');
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: realSha,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );

    const corruptRefDir = resolve(shadow.gitDir, 'refs', 'wip', 'main');
    mkdirSync(corruptRefDir, { recursive: true });
    writeFileSync(
      resolve(corruptRefDir, 'corrupt-writer'),
      `${'0123456789abcdef0123456789abcdef01234567'}\n`,
    );

    const origWarn = console.warn;
    let warned = false;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('aborted')) warned = true;
    };
    try {
      const result = await gcRenameLog(shadow, index);
      expect(result.dropped).toBe(0);
    } finally {
      console.warn = origWarn;
    }
    expect(warned).toBe(true);
    expect(index.byTo.get('b')?.commitSha).toBe(realSha);
  });

  test('rebuild=true reconstructs entries from OkActorEntry.previous_paths body fields (D2)', async () => {
    writeFileSync(resolve(contentRoot, 'b.md'), '# B\n');
    const sg = simpleGit({ baseDir: shadow.workTree }).env({
      GIT_DIR: shadow.gitDir,
      GIT_WORK_TREE: shadow.workTree,
    });
    const okActor =
      'ok-actor: ' +
      JSON.stringify({
        v: 1,
        writer_id: 'agent-rebuild',
        principal: null,
        agent_session: 'rebuild',
        agent_type: null,
        client_name: null,
        client_version: null,
        label: null,
        display_name: 'Rebuilder',
        color_seed: 'rebuild',
        docs: ['b'],
        previous_paths: [{ from: 'a', to: 'b' }],
      });
    const message = `rename: a -> b\n\n${okActor}`;
    await sg.raw('add', 'content/b.md');
    const builtTree = (await sg.raw('write-tree')).trim();
    const builtSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'Rebuilder',
          GIT_AUTHOR_EMAIL: 'r@example.com',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'service@openknowledge.local',
        })
        .raw('commit-tree', builtTree, '-m', message)
    ).trim();
    await sg.raw('update-ref', 'refs/wip/main/agent-rebuild', builtSha);

    const index = createEmptyIndex();
    const result = await gcRenameLog(shadow, index, { rebuild: true });
    expect(result.rebuilt).toBeGreaterThan(0);
    expect(index.byTo.get('b')).toBeDefined();
    expect(index.byTo.get('b')?.commitSha).toBe(builtSha);
    expect(index.byTo.get('b')?.actor.writerId).toBe('agent-rebuild');
  });

  test('rebuild — rename commit reachable only via feature-branch ref → entry attributed to feature branch', async () => {
    writeFileSync(resolve(contentRoot, 'b.md'), '# B\n');
    const sg = simpleGit({ baseDir: shadow.workTree }).env({
      GIT_DIR: shadow.gitDir,
      GIT_WORK_TREE: shadow.workTree,
    });
    const okActor =
      'ok-actor: ' +
      JSON.stringify({
        v: 1,
        writer_id: 'agent-feat',
        principal: null,
        agent_session: 'feat',
        agent_type: null,
        client_name: null,
        client_version: null,
        label: null,
        display_name: 'Featured',
        color_seed: 'feat',
        docs: ['b'],
        previous_paths: [{ from: 'a', to: 'b' }],
      });
    const message = `rename: a -> b\n\n${okActor}`;
    await sg.raw('add', 'content/b.md');
    const builtTree = (await sg.raw('write-tree')).trim();
    const builtSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'Featured',
          GIT_AUTHOR_EMAIL: 'f@example.com',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'service@openknowledge.local',
        })
        .raw('commit-tree', builtTree, '-m', message)
    ).trim();
    await sg.raw('update-ref', 'refs/wip/feature-x/agent-feat', builtSha);

    const index = createEmptyIndex();
    const result = await gcRenameLog(shadow, index, { rebuild: true });
    expect(result.rebuilt).toBeGreaterThan(0);
    expect(index.byTo.get('b')?.branch).toBe('feature-x');
  });

  test('rebuild — commit reachable from refs that have no parseable branch → falls back to "main"', async () => {
    writeFileSync(resolve(contentRoot, 'b.md'), '# B\n');
    const sg = simpleGit({ baseDir: shadow.workTree }).env({
      GIT_DIR: shadow.gitDir,
      GIT_WORK_TREE: shadow.workTree,
    });
    const okActor =
      'ok-actor: ' +
      JSON.stringify({
        v: 1,
        writer_id: 'agent-fallback',
        principal: null,
        agent_session: 'fb',
        agent_type: null,
        client_name: null,
        client_version: null,
        label: null,
        display_name: 'Fallback',
        color_seed: 'fb',
        docs: ['b'],
        previous_paths: [{ from: 'a', to: 'b' }],
      });
    const message = `rename: a -> b\n\n${okActor}`;
    await sg.raw('add', 'content/b.md');
    const builtTree = (await sg.raw('write-tree')).trim();
    const builtSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'Fallback',
          GIT_AUTHOR_EMAIL: 'fb@example.com',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'service@openknowledge.local',
        })
        .raw('commit-tree', builtTree, '-m', message)
    ).trim();
    await sg.raw('update-ref', 'refs/wip/orphan-ref-no-branch', builtSha);

    const index = createEmptyIndex();
    const result = await gcRenameLog(shadow, index, { rebuild: true });
    expect(result.rebuilt).toBeGreaterThan(0);
    expect(index.byTo.get('b')?.branch).toBe('main');
  });

  test('rebuild does NOT duplicate entries that already exist in jsonl', async () => {
    writeFileSync(resolve(contentRoot, 'b.md'), '# B\n');
    const sg = simpleGit({ baseDir: shadow.workTree }).env({
      GIT_DIR: shadow.gitDir,
      GIT_WORK_TREE: shadow.workTree,
    });
    const okActor =
      'ok-actor: ' +
      JSON.stringify({
        v: 1,
        writer_id: 'agent-rebuild',
        principal: null,
        agent_session: 'rebuild',
        agent_type: null,
        client_name: null,
        client_version: null,
        label: null,
        display_name: 'Rebuilder',
        color_seed: 'rebuild',
        docs: ['b'],
        previous_paths: [{ from: 'a', to: 'b' }],
      });
    const message = `rename: a -> b\n\n${okActor}`;
    await sg.raw('add', 'content/b.md');
    const builtTree = (await sg.raw('write-tree')).trim();
    const builtSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'Rebuilder',
          GIT_AUTHOR_EMAIL: 'r@example.com',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'service@openknowledge.local',
        })
        .raw('commit-tree', builtTree, '-m', message)
    ).trim();
    await sg.raw('update-ref', 'refs/wip/main/agent-rebuild', builtSha);

    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: builtSha,
        actor: { writerId: 'agent-rebuild', displayName: 'Rebuilder' },
      }),
      index,
    );
    const before = index.byTo.size;
    const result = await gcRenameLog(shadow, index, { rebuild: true });
    expect(result.rebuilt).toBe(0);
    expect(index.byTo.size).toBe(before);
  });

  test('GC returns scanned=0, dropped=0, retained=0 on empty index', async () => {
    const index = createEmptyIndex();
    const result = await gcRenameLog(shadow, index);
    expect(result.scanned).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.retained).toBe(0);
    expect(result.rebuilt).toBe(0);
  });
});

describe('serializeIndexToString', () => {
  test('empty index → empty string', () => {
    expect(serializeIndexToString(createEmptyIndex())).toBe('');
  });

  test('round-trips through load', () => {
    const index = createEmptyIndex();
    const e1 = entry({ from: 'a', to: 'b' });
    const e2 = entry({ from: 'b', to: 'c' });
    appendRenameLogEntry(shadowDir, e1, index);
    appendRenameLogEntry(shadowDir, e2, index);

    const serialized = serializeIndexToString(index);
    const fresh = resolve(shadowDir, 'fresh');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(renameLogPath(fresh), serialized);
    const reloaded = loadRenameLogIndex(fresh);
    expect(reloaded.byTo.size).toBe(2);
    expect(reloaded.byTo.get('b')).toEqual(e1);
    expect(reloaded.byTo.get('c')).toEqual(e2);
  });
});

describe('validateEntry self-rename rejection', () => {
  test('append refuses entry where from === to (defense-in-depth)', () => {
    const index = createEmptyIndex();
    expect(() =>
      appendRenameLogEntry(shadowDir, entry({ from: 'same', to: 'same' }), index),
    ).toThrow();
    expect(index.byTo.size).toBe(0);
    expect(existsSync(renameLogPath(shadowDir))).toBe(false);
  });

  test('boot loader drops self-rename lines instead of polluting byTo', () => {
    const selfRename = entry({ from: 'x', to: 'x' });
    const valid = entry({ from: 'a', to: 'b' });
    const body = `${JSON.stringify(selfRename)}\n${JSON.stringify(valid)}\n`;
    writeFileSync(renameLogPath(shadowDir), body);
    let warned = false;
    const orig = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('corrupt entry at line 1')) warned = true;
    };
    try {
      const index = loadRenameLogIndex(shadowDir);
      expect(index.byTo.has('x')).toBe(false);
      expect(index.byTo.get('b')).toBeDefined();
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
  });
});

describe('backfillRenameLogCommitSha SHA validation', () => {
  test('rejects empty commitSha with a warning and zero updates', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ commitSha: '', actor: { writerId: 'agent-x', displayName: 'X' } }),
      index,
    );
    let warned = false;
    const orig = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('rejected invalid commitSha')) warned = true;
    };
    try {
      const result = backfillRenameLogCommitSha(shadowDir, 'agent-x', '', index);
      expect(result.updated).toBe(0);
      expect(index.byTo.get('essays/auth')?.commitSha).toBe('');
    } finally {
      console.warn = orig;
    }
    expect(warned).toBe(true);
  });

  test('rejects truncated SHA (less than 40 hex chars)', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ commitSha: '', actor: { writerId: 'agent-x', displayName: 'X' } }),
      index,
    );
    const orig = console.warn;
    console.warn = () => {};
    try {
      const result = backfillRenameLogCommitSha(shadowDir, 'agent-x', 'abc123', index);
      expect(result.updated).toBe(0);
    } finally {
      console.warn = orig;
    }
    expect(index.byTo.get('essays/auth')?.commitSha).toBe('');
  });

  test('rejects non-hex string of correct length', () => {
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadowDir,
      entry({ commitSha: '', actor: { writerId: 'agent-x', displayName: 'X' } }),
      index,
    );
    const orig = console.warn;
    console.warn = () => {};
    try {
      const result = backfillRenameLogCommitSha(shadowDir, 'agent-x', 'g'.repeat(40), index);
      expect(result.updated).toBe(0);
    } finally {
      console.warn = orig;
    }
  });
});

describe('buildSeeds — SeedsCache (Consider C2)', () => {
  let projectRoot: string;
  let shadow: ShadowHandle;
  const writer: WriterIdentity = {
    id: 'human-cache',
    name: 'Cache',
    email: 'cache@example.com',
  };

  beforeEach(async () => {
    projectRoot = resolve(shadowDir, 'cache-project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(resolve(projectRoot, 'content'), { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 't@t.com');
    shadow = await initShadowRepo(projectRoot);
  });

  test('cache hit returns the same array reference for identical key', async () => {
    writeFileSync(resolve(projectRoot, 'content', 'a.md'), '# A\n');
    const sha = await commitWip(shadow, writer, 'content', 'WIP: a');
    const cache = createSeedsCache();
    const first = await buildSeeds(shadow, sha, 'main', cache);
    const second = await buildSeeds(shadow, sha, 'main', cache);
    expect(second).toBe(first);
  });

  test('cache miss when branch differs even with same renameCommit', async () => {
    writeFileSync(resolve(projectRoot, 'content', 'a.md'), '# A\n');
    const sha = await commitWip(shadow, writer, 'content', 'WIP: a');
    const cache = createSeedsCache();
    const main = await buildSeeds(shadow, sha, 'main', cache);
    const feature = await buildSeeds(shadow, sha, 'feature-x', cache);
    expect(feature).not.toBe(main);
    expect(cache.size).toBe(2);
  });
});

describe('gcRenameLog concurrency dedup (Finding 4)', () => {
  let projectRoot: string;
  let shadow: ShadowHandle;
  const writer: WriterIdentity = {
    id: 'human-dedup',
    name: 'Dedup',
    email: 'd@d.com',
  };

  beforeEach(async () => {
    projectRoot = resolve(shadowDir, 'dedup-project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(resolve(projectRoot, 'content'), { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 't@t.com');
    shadow = await initShadowRepo(projectRoot);
  });

  test('overlapping invocations: second call short-circuits with zero counts', async () => {
    writeFileSync(resolve(projectRoot, 'content', 'a.md'), '# A\n');
    const realSha = await commitWip(shadow, writer, 'content', 'WIP: a');
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({
        from: 'a',
        to: 'b',
        commitSha: realSha,
        actor: { writerId: 'agent-1', displayName: 'A' },
      }),
      index,
    );

    const [first, second] = await Promise.all([
      gcRenameLog(shadow, index),
      gcRenameLog(shadow, index),
    ]);

    const real = first.scanned > 0 ? first : second;
    const skipped = first.scanned > 0 ? second : first;
    expect(real.scanned).toBe(1);
    expect(skipped.scanned).toBe(0);
    expect(skipped.dropped).toBe(0);
    expect(skipped.retained).toBe(0);
  });
});
