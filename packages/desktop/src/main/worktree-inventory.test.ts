import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BridgeWorktreeEntry } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  classifyLocation,
  isAllowedInventoryAnchor,
  WorktreeInventoryService,
} from './worktree-inventory.ts';

const execFileAsync = promisify(execFile);

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly internal: string;
  readonly external: string;
}

let fixture: Fixture | null = null;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-worktree-inventory-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'packages', 'docs'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'notes'), { recursive: true });
  mkdirSync(join(repo, '.ok'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'docs', '.ok'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'notes', '.ok'), { recursive: true });
  writeFileSync(join(repo, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(repo, 'packages', 'docs', '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(repo, 'packages', 'notes', '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(repo, 'packages', 'docs', 'README.md'), 'docs\n');
  writeFileSync(join(repo, 'packages', 'notes', 'README.md'), 'notes\n');
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
  const internal = join(repo, '.ok', 'worktrees', 'dev');
  const external = join(root, 'repo-prefix-external');
  mkdirSync(join(repo, '.ok', 'worktrees'), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', 'dev', internal);
  await git(repo, 'worktree', 'add', '-b', 'external', external);
  return { root, repo, internal, external };
}

afterEach(() => {
  if (fixture !== null) rmSync(fixture.root, { recursive: true, force: true });
  fixture = null;
});

describe('WorktreeInventoryService', () => {
  test('projects the repository registry onto one nested OpenKnowledge project scope', async () => {
    fixture = await makeFixture();
    const service = new WorktreeInventoryService();
    const result = await service.inventory(join(fixture.repo, 'packages', 'docs'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory.projectSubPath).toBe(join('packages', 'docs'));
    expect(result.inventory.entries).toHaveLength(3);
    const byLocation = new Map(result.inventory.entries.map((entry) => [entry.location, entry]));
    expect([...byLocation.keys()].toSorted()).toEqual(['external', 'internal', 'primary']);
    expect(byLocation.get('primary')?.projectPath).toBe(join(fixture.repo, 'packages', 'docs'));
    expect(byLocation.get('internal')?.projectPath).toBe(
      join(fixture.internal, 'packages', 'docs'),
    );
    expect(byLocation.get('external')?.projectPath).toBe(
      join(fixture.external, 'packages', 'docs'),
    );
  });

  test('keeps two nested projects in the same repository as separate scopes', async () => {
    fixture = await makeFixture();
    const service = new WorktreeInventoryService();
    const docs = await service.inventory(join(fixture.repo, 'packages', 'docs'));
    const notes = await service.inventory(join(fixture.repo, 'packages', 'notes'));
    expect(docs.ok && docs.inventory.projectSubPath).toBe(join('packages', 'docs'));
    expect(notes.ok && notes.inventory.projectSubPath).toBe(join('packages', 'notes'));
  });

  test('marks a checkout unavailable when the projected directory is not an exact project root', async () => {
    fixture = await makeFixture();
    unlinkSync(join(fixture.external, 'packages', 'docs', '.ok', 'config.yml'));
    const service = new WorktreeInventoryService();
    const result = await service.inventory(join(fixture.repo, 'packages', 'docs'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.inventory.entries.find((entry) => entry.checkoutRoot === fixture.external),
    ).toMatchObject({
      availability: 'missing',
      location: 'external',
    });
  });

  test('refuses a projected project symlink that escapes its registered checkout', async () => {
    fixture = await makeFixture();
    const outside = join(fixture.root, 'outside-project');
    mkdirSync(join(outside, '.ok'), { recursive: true });
    writeFileSync(join(outside, '.ok', 'config.yml'), 'content:\n  dir: .\n');
    const projected = join(fixture.external, 'packages', 'docs');
    rmSync(projected, { recursive: true, force: true });
    symlinkSync(outside, projected);
    const service = new WorktreeInventoryService();
    const result = await service.inventory(join(fixture.repo, 'packages', 'docs'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.inventory.entries.find((entry) => entry.checkoutRoot === fixture.external),
    ).toMatchObject({
      projectPath: outside,
      availability: 'unreadable',
      location: 'external',
    });
  });

  test('preserves detached and locked facts while keeping an available locked entry openable', async () => {
    fixture = await makeFixture();
    await git(fixture.external, 'checkout', '--detach', 'HEAD');
    await git(fixture.repo, 'worktree', 'lock', fixture.internal);
    const service = new WorktreeInventoryService();
    const result = await service.inventory(fixture.repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory.entries.find((entry) => entry.location === 'external')).toMatchObject({
      branch: null,
      availability: 'available',
    });
    const locked = result.inventory.entries.find((entry) => entry.location === 'internal');
    expect(locked).toMatchObject({ locked: true, availability: 'available', prunable: false });
    if (locked === undefined) throw new Error('missing locked entry');
    const validated = await service.validateOpen({
      anchorProjectPath: fixture.repo,
      gitCommonDir: result.inventory.gitCommonDir,
      projectSubPath: result.inventory.projectSubPath,
      checkoutRoot: locked.checkoutRoot,
      projectPath: locked.projectPath,
    });
    expect(validated).toEqual({ ok: true, projectPath: locked.projectPath });
  });

  test('reports initial enumeration failure instead of an empty inventory', async () => {
    const service = new WorktreeInventoryService({
      classifyProject: async () => ({
        gitCommonDir: '/repo/.git',
        mainRoot: '/repo',
        checkoutRoot: '/repo',
        projectSubPath: '',
        isLinkedWorktree: false,
      }),
      readSnapshot: async () => ({ ok: false }),
      availability: () => 'available',
      checkoutAvailability: () => 'available',
      canonicalize: (path) => path,
      now: () => 0,
    });
    await expect(service.inventory('/repo')).resolves.toEqual({
      ok: false,
      reason: 'enumeration-failed',
    });
  });

  test('deduplicates concurrent raw snapshots and reuses a successful snapshot within the TTL', async () => {
    let reads = 0;
    let release: ((result: { ok: true; entries: readonly BridgeWorktreeEntry[] }) => void) | null =
      null;
    const pending = new Promise<{ ok: true; entries: readonly BridgeWorktreeEntry[] }>(
      (resolve) => {
        release = resolve;
      },
    );
    const service = new WorktreeInventoryService({
      classifyProject: async () => ({
        gitCommonDir: '/repo/.git',
        mainRoot: '/repo',
        checkoutRoot: '/repo',
        projectSubPath: '',
        isLinkedWorktree: false,
      }),
      readSnapshot: async () => {
        reads += 1;
        return pending;
      },
      availability: () => 'available',
      checkoutAvailability: () => 'available',
      canonicalize: (path) => path,
      now: () => 100,
    });
    const first = service.inventory('/repo');
    const second = service.inventory('/repo');
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
    release?.({
      ok: true,
      entries: [
        {
          path: '/repo',
          branch: 'main',
          headSha: '1',
          locked: false,
          prunable: false,
        },
      ],
    });
    await Promise.all([first, second]);
    await service.inventory('/repo');
    expect(reads).toBe(1);
  });

  test('invalidation forces a new snapshot and prevents an older read from replacing it', async () => {
    const releases: Array<(result: { ok: true; entries: readonly BridgeWorktreeEntry[] }) => void> =
      [];
    let reads = 0;
    const service = new WorktreeInventoryService({
      classifyProject: async () => ({
        gitCommonDir: '/repo/.git',
        mainRoot: '/repo',
        checkoutRoot: '/repo',
        projectSubPath: '',
        isLinkedWorktree: false,
      }),
      readSnapshot: async () => {
        reads += 1;
        return new Promise((resolve) => releases.push(resolve));
      },
      availability: () => 'available',
      checkoutAvailability: () => 'available',
      canonicalize: (path) => path,
      now: () => 100,
    });
    const stale = service.inventory('/repo');
    await Promise.resolve();
    service.invalidate('/repo/.git');
    const fresh = service.inventory('/repo');
    await Promise.resolve();
    expect(reads).toBe(2);
    releases[1]?.({
      ok: true,
      entries: [{ path: '/repo', branch: 'fresh', headSha: '2', locked: false, prunable: false }],
    });
    await fresh;
    releases[0]?.({
      ok: true,
      entries: [{ path: '/repo', branch: 'stale', headSha: '1', locked: false, prunable: false }],
    });
    await stale;
    const cached = await service.inventory('/repo');
    expect(cached.ok && cached.inventory.entries[0]?.branch).toBe('fresh');
    expect(reads).toBe(2);
  });

  test('rejects malformed inventory and open requests before reading Git', async () => {
    let classified = 0;
    const service = new WorktreeInventoryService({
      classifyProject: async () => {
        classified += 1;
        throw new Error('must not classify invalid input');
      },
      readSnapshot: async () => ({ ok: false }),
      availability: () => 'available',
      checkoutAvailability: () => 'available',
      canonicalize: (path) => path,
      now: () => 0,
    });
    await expect(service.inventory('relative/repo')).resolves.toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    await expect(service.inventory('/repo\0other')).resolves.toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    const valid = {
      anchorProjectPath: '/repo',
      gitCommonDir: '/repo/.git',
      projectSubPath: 'packages/docs',
      checkoutRoot: '/repo',
      projectPath: '/repo/packages/docs',
    } as const;
    const malformed = [
      { ...valid, anchorProjectPath: 'repo' },
      { ...valid, gitCommonDir: 'repo/.git' },
      { ...valid, checkoutRoot: 'repo' },
      { ...valid, projectPath: 'repo/packages/docs' },
      { ...valid, projectSubPath: '/packages/docs' },
      { ...valid, projectSubPath: 'packages/../docs' },
      { ...valid, projectPath: '/repo/packages/docs\0other' },
    ];
    for (const request of malformed) {
      await expect(service.validateOpen(request)).resolves.toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
    expect(classified).toBe(0);
  });

  test('refuses prunable, missing, and differently resolved open identities', async () => {
    const raw: BridgeWorktreeEntry[] = [
      {
        path: '/repo',
        branch: 'main',
        headSha: '1',
        locked: false,
        prunable: false,
      },
      {
        path: '/gone',
        branch: 'gone',
        headSha: '2',
        locked: false,
        prunable: true,
      },
      {
        path: '/missing',
        branch: 'missing',
        headSha: '3',
        locked: false,
        prunable: false,
      },
    ];
    const service = new WorktreeInventoryService({
      classifyProject: async () => ({
        gitCommonDir: '/repo/.git',
        mainRoot: '/repo',
        checkoutRoot: '/repo',
        projectSubPath: '',
        isLinkedWorktree: false,
      }),
      readSnapshot: async () => ({ ok: true, entries: raw }),
      availability: (path) => (path === '/repo' ? 'available' : 'missing'),
      checkoutAvailability: (path) => (path === '/repo' ? 'available' : 'missing'),
      canonicalize: (path) => path,
      now: () => 0,
    });
    await expect(
      service.validateOpen({
        anchorProjectPath: '/repo',
        gitCommonDir: '/repo/.git',
        projectSubPath: '',
        checkoutRoot: '/gone',
        projectPath: '/gone',
      }),
    ).resolves.toEqual({ ok: false, reason: 'prunable' });
    await expect(
      service.validateOpen({
        anchorProjectPath: '/repo',
        gitCommonDir: '/repo/.git',
        projectSubPath: '',
        checkoutRoot: '/missing',
        projectPath: '/missing',
      }),
    ).resolves.toEqual({ ok: false, reason: 'project-unavailable' });
    await expect(
      service.validateOpen({
        anchorProjectPath: '/repo',
        gitCommonDir: '/other/.git',
        projectSubPath: '',
        checkoutRoot: '/repo',
        projectPath: '/repo',
      }),
    ).resolves.toEqual({ ok: false, reason: 'repository-changed' });
  });
});

describe('classifyLocation', () => {
  test('uses segment-aware containment and rejects same-prefix external paths', () => {
    expect(classifyLocation('/repo', '/repo')).toBe('primary');
    expect(classifyLocation('/repo', '/repo/.ok/worktrees/dev')).toBe('internal');
    expect(classifyLocation('/repo', '/repo/.ok/worktrees-prefix/dev')).toBe('external');
    expect(classifyLocation('/repo', '/repo-copy/.ok/worktrees/dev')).toBe('external');
  });
});

describe('isAllowedInventoryAnchor', () => {
  test('accepts only the active project and persisted recent projects', () => {
    expect(isAllowedInventoryAnchor('/repo/current', '/repo/current', ['/repo/other'])).toBe(true);
    expect(isAllowedInventoryAnchor('/repo/other', '/repo/current', ['/repo/other'])).toBe(true);
    expect(isAllowedInventoryAnchor('/private/repo', '/repo/current', ['/repo/other'])).toBe(false);
    expect(isAllowedInventoryAnchor('relative', '/repo/current', ['/repo/other'])).toBe(false);
  });
});
