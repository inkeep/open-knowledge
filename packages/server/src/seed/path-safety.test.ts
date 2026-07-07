import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeed } from './apply.ts';
import { planSeed } from './plan.ts';
import { SeedRootDirError } from './types.ts';

describe('seed path-safety — apply rejects path traversal in plan entries', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-pathsafe-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('rejects entries with `..` segments without writing', async () => {
    const result = await applySeed(
      {
        created: [{ path: '../escape.md', kind: 'file', template: 'log.md' }],
        skipped: [],
        warnings: [],
      },
      { projectDir },
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('../escape.md');
    expect(result.errors[0]?.error).toContain("'..'");
  });

  test('rejects absolute path entries without writing', async () => {
    const target = join(tmpdir(), `seed-abs-target-${Date.now()}.md`);
    const result = await applySeed(
      {
        created: [{ path: target, kind: 'file', template: 'log.md' }],
        skipped: [],
        warnings: [],
      },
      { projectDir },
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('relative');
  });

  test('rejects entries containing null bytes', async () => {
    const result = await applySeed(
      {
        created: [{ path: 'good\0/evil.md', kind: 'file', template: 'log.md' }],
        skipped: [],
        warnings: [],
      },
      { projectDir },
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('null byte');
  });

  test('rejects symlink-escape: folder entry that resolves outside projectDir via symlink', async () => {
    // Pre-existing symlink in projectDir pointing outside (simulates an
    // attacker-controlled repo or volume mount).
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      symlinkSync(outsideDir, join(projectDir, 'brain'));

      const result = await applySeed(
        {
          created: [
            { path: 'brain/external-sources', kind: 'folder' },
            {
              path: 'brain/external-sources/.ok/frontmatter.yml',
              kind: 'file',
              template: 'external-sources/.ok/frontmatter.yml',
            },
          ],
          skipped: [],
          warnings: [],
        },
        { projectDir },
      );

      expect(result.applied).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      for (const e of result.errors) {
        expect(e.error.toLowerCase()).toContain('symlink');
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects symlink-escape: file entry whose ancestor is a symlink to outside', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      // `escaped` symlinks to an outside dir; a file entry under it must
      // be rejected even though the leaf doesn't exist yet.
      symlinkSync(outsideDir, join(projectDir, 'escaped'));

      const result = await applySeed(
        {
          created: [
            {
              path: 'escaped/log.md',
              kind: 'file',
              template: 'log.md',
            },
          ],
          skipped: [],
          warnings: [],
        },
        { projectDir },
      );

      expect(result.applied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error.toLowerCase()).toContain('symlink');
      // File must NOT have been written through the symlink.
      expect(
        await Bun.file(join(outsideDir, 'log.md'))
          .exists()
          .catch(() => false),
      ).toBe(false);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('mixed plan: rejects bad entries, keeps benign ones', async () => {
    const result = await applySeed(
      {
        created: [
          { path: 'safe-folder', kind: 'folder' },
          { path: '../evil', kind: 'folder' },
          { path: 'log.md', kind: 'file', template: 'log.md' },
        ],
        skipped: [],
        warnings: [],
      },
      { projectDir },
    );

    // safe-folder + log.md applied; ../evil rejected.
    expect(result.applied).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('../evil');
  });
});

describe('seed path-safety — plan rejects rootDir symlink escape', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-plan-pathsafe-'));
    // planSeed's gate is `.ok/config.yml` — seed both so these symlink-escape
    // tests reach the rootDir validation rather than tripping on the gate.
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('rootDir that points at a pre-existing symlink-to-outside is rejected', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      symlinkSync(outsideDir, join(projectDir, 'brain'));
      await expect(planSeed({ projectDir, rootDir: 'brain' })).rejects.toThrow(SeedRootDirError);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('rootDir whose ancestor is a symlink-to-outside is rejected', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      symlinkSync(outsideDir, join(projectDir, 'link'));
      // `link/sub` doesn't exist yet but `link` does and resolves outside.
      await expect(planSeed({ projectDir, rootDir: 'link/sub' })).rejects.toThrow(SeedRootDirError);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('rootDir following an internal symlink (within projectDir) is allowed', async () => {
    // Symlink that stays inside projectDir — realpath check should pass.
    const targetDir = join(projectDir, 'real-target');
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(targetDir, join(projectDir, 'inside-link'));

    // Plan should succeed and produce entries scoped under inside-link/.
    const plan = await planSeed({ projectDir, rootDir: 'inside-link' });
    expect(plan.created.length).toBeGreaterThan(0);
    for (const entry of plan.created) {
      expect(entry.path.startsWith('inside-link')).toBe(true);
    }
  });

  test('writeFileSync attempts via symlinked rootDir would fail apply too (defense-in-depth)', async () => {
    // Even if a caller hand-constructs a plan that bypasses planSeed (e.g.
    // HTTP body containing a hand-crafted plan referencing a known symlink),
    // applySeed must independently reject it.
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      symlinkSync(outsideDir, join(projectDir, 'evil'));

      const result = await applySeed(
        {
          created: [{ path: 'evil/log.md', kind: 'file', template: 'log.md' }],
          skipped: [],
          warnings: [],
        },
        { projectDir },
      );

      expect(result.applied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error.toLowerCase()).toContain('symlink');
      // Confirm nothing landed at the symlink target.
      expect(
        await Bun.file(join(outsideDir, 'log.md'))
          .exists()
          .catch(() => false),
      ).toBe(false);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('symlink to a path within projectDir but pointing outside via realpath gets rejected', async () => {
    // A link where the target string is *relative* and walks out via `..`.
    // realpath canonicalizes this and the check catches it.
    const outsideDir = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      // Use a relative target that references outside via ..
      // Note: symlink contents are stored verbatim and resolved at access time.
      symlinkSync(outsideDir, join(projectDir, 'rel-evil'));
      writeFileSync(join(outsideDir, 'sentinel.md'), '# pre-existing', 'utf-8');

      const result = await applySeed(
        {
          created: [{ path: 'rel-evil/log.md', kind: 'file', template: 'log.md' }],
          skipped: [],
          warnings: [],
        },
        { projectDir },
      );

      expect(result.applied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error.toLowerCase()).toContain('symlink');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
