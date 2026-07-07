import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sanitizeClientName } from '@inkeep/open-knowledge-server';
import {
  countWorktrees,
  findProjectDir,
  resolveStickyProjectDir,
  rootUriToFsPath,
  tryListRootsFallback,
} from './server.ts';

describe('findProjectDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-resolve-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seedProjectMarker(dir: string): void {
    mkdirSync(resolve(dir, '.ok'), { recursive: true });
    writeFileSync(resolve(dir, '.ok', 'config.yml'), '', 'utf-8');
  }

  test('returns the dir itself when `.ok/config.yml` is at the start', () => {
    seedProjectMarker(tmpDir);
    expect(findProjectDir(tmpDir)).toBe(resolve(tmpDir));
  });

  test('walks up from a subdirectory to the nearest project root', () => {
    seedProjectMarker(tmpDir);
    const sub = resolve(tmpDir, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    expect(findProjectDir(sub)).toBe(resolve(tmpDir));
  });

  test('throws with a clear message when no `.ok/config.yml` ancestor exists', () => {
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('rejects a regular file named `.ok` and keeps walking up', () => {
    // Sibling stray `.ok` file in tmpDir should NOT be treated as a project root.
    writeFileSync(resolve(tmpDir, '.ok'), 'oops');
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('rejects a dangling symlink at `.ok` and keeps walking up', () => {
    symlinkSync(resolve(tmpDir, 'does-not-exist'), resolve(tmpDir, '.ok'));
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('rejects an empty `.ok/` directory with no config.yml and keeps walking up', () => {
    // Bare .ok/ — looks like a nested folder-rule sidecar would. The walk
    // must NOT stop here, otherwise tool calls bind to the wrong project root.
    mkdirSync(resolve(tmpDir, '.ok'), { recursive: true });
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('rejects a folder-rule-style `.ok/frontmatter.yml` without config.yml', () => {
    // Mimics what `set_folder_rule` writes inside a subfolder — sidecar
    // metadata that must not register as a project marker.
    mkdirSync(resolve(tmpDir, '.ok'), { recursive: true });
    writeFileSync(resolve(tmpDir, '.ok', 'frontmatter.yml'), 'title: oops\n', 'utf-8');
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('rejects a directory at `.ok/config.yml` (not a file) and keeps walking up', () => {
    // Pathological: someone created config.yml as a directory. The marker
    // must be a regular file.
    mkdirSync(resolve(tmpDir, '.ok', 'config.yml'), { recursive: true });
    expect(() => findProjectDir(tmpDir)).toThrow(/No OpenKnowledge project found/);
  });

  test('walks past a folder-rule `.ok/` sidecar to the real project root above', () => {
    // Real project root at tmpDir. A nested subfolder has folder-rule metadata
    // (`.ok/frontmatter.yml` only) — the walk MUST step past it and resolve
    // to tmpDir, not the inner subfolder.
    seedProjectMarker(tmpDir);
    const inner = resolve(tmpDir, 'specs', 'foo');
    mkdirSync(resolve(inner, '.ok'), { recursive: true });
    writeFileSync(resolve(inner, '.ok', 'frontmatter.yml'), 'title: x\n', 'utf-8');
    expect(findProjectDir(inner)).toBe(resolve(tmpDir));
  });

  test('prefers the nearest project root over a deeper stray `.ok` file', () => {
    // Outer dir has a real .ok/config.yml, inner has a regular `.ok` file.
    // The inner file must NOT short-circuit the walk.
    seedProjectMarker(tmpDir);
    const inner = resolve(tmpDir, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(resolve(inner, '.ok'), 'oops');
    expect(findProjectDir(inner)).toBe(resolve(tmpDir));
  });
});

describe('sanitizeClientName', () => {
  test('returns fallback for undefined input', () => {
    expect(sanitizeClientName(undefined, 'fallback-id')).toBe('fallback-id');
  });

  test('returns fallback for empty string', () => {
    expect(sanitizeClientName('', 'fallback-id')).toBe('fallback-id');
  });

  test('returns fallback for whitespace-only input', () => {
    expect(sanitizeClientName('   \t\n  ', 'fallback-id')).toBe('fallback-id');
  });

  test('strips ASCII control characters (0x00-0x1F, 0x7F)', () => {
    // \x00=NUL, \x07=BEL, \x1F=US, \x7F=DEL — each becomes a space, then
    // adjacent spaces collapse and the trim drops trailing whitespace.
    expect(sanitizeClientName('cl\x00aud\x07e\x1Fco\x7Fde', 'fb')).toBe('cl aud e co de');
  });

  test('collapses runs of whitespace to a single space', () => {
    expect(sanitizeClientName('claude    code\t\tcli', 'fb')).toBe('claude code cli');
  });

  test('truncates at 128 chars', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeClientName(long, 'fb').length).toBe(128);
  });

  test('preserves ordinary printable input unchanged', () => {
    expect(sanitizeClientName('Claude v2.1.0', 'fb')).toBe('Claude v2.1.0');
  });
});

describe('rootUriToFsPath', () => {
  test('decodes a standard file:// URI to an absolute path', () => {
    expect(rootUriToFsPath('file:///Users/me/proj')).toBe('/Users/me/proj');
  });

  test('decodes percent-encoded path components', () => {
    expect(rootUriToFsPath('file:///Users/me/My%20Project')).toBe('/Users/me/My Project');
  });

  test('returns undefined for non-file: schemes', () => {
    expect(rootUriToFsPath('http://example.com/proj')).toBeUndefined();
    expect(rootUriToFsPath('ws://localhost:8080')).toBeUndefined();
    expect(rootUriToFsPath('vscode://settings')).toBeUndefined();
  });

  test('returns undefined for malformed URIs', () => {
    expect(rootUriToFsPath('not a uri')).toBeUndefined();
    expect(rootUriToFsPath('')).toBeUndefined();
  });
});

describe('tryListRootsFallback', () => {
  // Sentinel that fails the test if the dependency is touched — the early
  // returns must short-circuit before listRoots() is called.
  const failIfCalled = (): never => {
    throw new Error('listRoots() should not be called');
  };

  test('returns undefined when client has no roots capability', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({}),
      listRoots: failIfCalled,
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when getClientCapabilities returns undefined', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => undefined,
      listRoots: failIfCalled,
    });
    expect(result).toBeUndefined();
  });

  test('returns the fsPath of the sole file:// root', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: 'file:///Users/me/proj' }] }),
    });
    expect(result).toBe('/Users/me/proj');
  });

  test('returns undefined when the client advertises zero roots', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [] }),
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when the client advertises multiple roots', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ uri: 'file:///a' }, { uri: 'file:///b' }],
      }),
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined for a non-file scheme root', async () => {
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: 'vscode://settings' }] }),
    });
    expect(result).toBeUndefined();
  });

  test('logs when the single root URI cannot be resolved to a fs path', async () => {
    // Symmetric to the listRoots-throws diagnostic — operators chasing a
    // single-root client whose roots can't be resolved (non-`file:`,
    // malformed) get a breadcrumb instead of just the generic tool error.
    const logs: string[] = [];
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: 'vscode://settings' }] }),
      log: (msg) => logs.push(msg),
    });
    expect(result).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('single root URI not usable as fs path');
    expect(logs[0]).toContain('vscode://settings');
  });

  test('returns undefined when the listRoots response omits the roots array', async () => {
    // Pins the `?? []` defensive fallback at the JSON-RPC trust boundary —
    // the SDK type says `roots` is always present, but a buggy or older
    // client could return `{}`. Without this test, removing the `?? []`
    // would silently introduce a runtime crash on the implicit-cwd path.
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({}) as unknown as { roots: { uri: string }[] },
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined and logs when listRoots() throws', async () => {
    const logs: string[] = [];
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        throw new Error('transport closed');
      },
      log: (msg) => logs.push(msg),
    });
    expect(result).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('listRoots fallback failed');
    expect(logs[0]).toContain('transport closed');
  });

  test('coerces non-Error throwables in the log message', async () => {
    const logs: string[] = [];
    const result = await tryListRootsFallback({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        throw 'string-shaped failure';
      },
      log: (msg) => logs.push(msg),
    });
    expect(result).toBeUndefined();
    expect(logs[0]).toContain('string-shaped failure');
  });
});

describe('resolveStickyProjectDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-resolve-cwd-'));
    mkdirSync(resolve(tmpDir, '.ok'), { recursive: true });
    writeFileSync(resolve(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('explicit cwd wins over the fallback and becomes the next sticky anchor', async () => {
    let fallbackCalls = 0;
    const r = await resolveStickyProjectDir(tmpDir, undefined, async () => {
      fallbackCalls += 1;
      return undefined;
    });
    expect(r.projectDir).toBe(resolve(tmpDir));
    expect(r.viaRootGuess).toBe(false);
    expect(r.nextSticky).toBe(resolve(tmpDir));
    expect(fallbackCalls).toBe(0);
  });

  test('reuses the sticky anchor when cwd is omitted, never consulting the fallback', async () => {
    let fallbackCalls = 0;
    const r = await resolveStickyProjectDir(undefined, resolve(tmpDir), async () => {
      fallbackCalls += 1;
      return undefined;
    });
    expect(r.projectDir).toBe(resolve(tmpDir));
    expect(r.viaRootGuess).toBe(false); // sticky is the agent's named intent, not a guess
    expect(r.nextSticky).toBe(resolve(tmpDir));
    expect(fallbackCalls).toBe(0);
  });

  test('falls through to the root guess only with no explicit and no sticky, flagging viaRootGuess; a guess never sticks', async () => {
    const r = await resolveStickyProjectDir(undefined, undefined, async () => tmpDir);
    expect(r.projectDir).toBe(resolve(tmpDir));
    expect(r.viaRootGuess).toBe(true);
    expect(r.nextSticky).toBeUndefined();
  });

  test('returns no project (no throw) when cwd omitted, no sticky, and the fallback returns undefined', async () => {
    const r = await resolveStickyProjectDir(undefined, undefined, async () => undefined);
    expect(r.projectDir).toBeUndefined();
    expect(r.viaRootGuess).toBe(false);
    expect(r.nextSticky).toBeUndefined();
  });

  test('throws (via findProjectDir) when explicit cwd has no .ok ancestor', async () => {
    const noOkDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-no-project-'));
    try {
      await expect(
        resolveStickyProjectDir(noOkDir, undefined, async () => undefined),
      ).rejects.toThrow(/No OpenKnowledge project found/);
    } finally {
      await rm(noOkDir, { recursive: true, force: true });
    }
  });

  test('throws (via findProjectDir) when the root guess returns a non-OK path', async () => {
    // Symmetric coverage of the explicit-cwd test: the guessed branch
    // must also walk up to a project root, so a refactor returning the raw
    // root would regress here.
    const noOkDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-fallback-no-project-'));
    try {
      await expect(
        resolveStickyProjectDir(undefined, undefined, async () => noOkDir),
      ).rejects.toThrow(/No OpenKnowledge project found/);
    } finally {
      await rm(noOkDir, { recursive: true, force: true });
    }
  });

  test('re-validates the sticky anchor on reuse: a deleted sticky path throws instead of resolving silently', async () => {
    // A worktree removed mid-session leaves a stale sticky anchor. Reuse must
    // walk it back through findProjectDir so the gone path surfaces as the
    // directive error rather than routing to a dead directory. A refactor that
    // returned the raw sticky would regress here.
    const goneDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-sticky-gone-'));
    await rm(goneDir, { recursive: true, force: true });
    await expect(
      resolveStickyProjectDir(undefined, goneDir, async () => undefined),
    ).rejects.toThrow(/No OpenKnowledge project found/);
  });
});

describe('countWorktrees', () => {
  test('returns 0 for a non-git directory (no ambiguity → no nudge)', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-no-git-'));
    try {
      expect(await countWorktrees(dir)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
