import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { STARTER_PACKS } from '@inkeep/open-knowledge-server';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { runSeed } from './seed.ts';

const STARTER_FOLDERS = STARTER_PACKS['knowledge-base'].folders;

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ok-seed-cmd-test-'));
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function scaffoldOkDir(dir: string, configYml = 'content:\n  dir: .\n'): void {
  mkdirSync(join(dir, OK_DIR), { recursive: true });
  writeFileSync(join(dir, OK_DIR, CONFIG_FILENAME), configYml, 'utf-8');
}

function yes(): NodeJS.ReadableStream {
  return Readable.from(['y\n']);
}

function no(): NodeJS.ReadableStream {
  return Readable.from(['n\n']);
}

describe('runSeed — happy path', () => {
  test('applies plan with --yes flag', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, yes: true });

    expect(result.status).toBe('applied');
    expect(result.exitCode).toBe(0);
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, folder.path))).toBe(true);
    }
    expect(existsSync(join(testDir, 'log.md'))).toBe(true);
    // Folder defaults now land at nested `<folder>/.ok/frontmatter.yml`
    // (`config.yml folders:` write path retired).
    for (const folder of STARTER_FOLDERS) {
      const fmPath = join(testDir, folder.path, '.ok', 'frontmatter.yml');
      expect(existsSync(fmPath)).toBe(true);
      expect(readFileSync(fmPath, 'utf-8')).toContain(folder.title);
    }
  });

  test('applies plan when user confirms Y via stream', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, confirmStream: yes() });
    expect(result.status).toBe('applied');
    expect(result.exitCode).toBe(0);
  });

  test('cancels when user responds n', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, confirmStream: no() });
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(0);
    // No changes applied
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, folder.path))).toBe(false);
    }
  });
});

describe('runSeed — --dry-run', () => {
  test('prints plan but does not write', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.exitCode).toBe(0);
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, folder.path))).toBe(false);
    }
    expect(existsSync(join(testDir, 'log.md'))).toBe(false);
  });

  test('surfaces the pack rationale (per-folder why) + anti-clone note for inspiration', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, pack: 'worldbuilding', dryRun: true });
    expect(result.status).toBe('dry-run');
    const pack = STARTER_PACKS.worldbuilding;
    // The dry-run message carries each folder's authored "why" (rationale), so
    // the reader can adapt the pattern — not just a file tree to clone.
    for (const folder of pack.folders) {
      expect(result.message).toContain(folder.description);
    }
    expect(result.message.toLowerCase()).toContain('adapt'); // anti-clone framing
    // …and still writes nothing.
    for (const folder of pack.folders) {
      expect(existsSync(join(testDir, folder.path))).toBe(false);
    }
  });

  test('previews in an uninitialized dir without requiring `ok init`', async () => {
    // No scaffoldOkDir — the whole point of a dry-run is to preview a pack
    // before adopting it. The prerequisite gate must not block this path.
    const result = await runSeed({ cwd: testDir, pack: 'knowledge-base', dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.exitCode).toBe(0);
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, folder.path))).toBe(false);
    }
    expect(existsSync(join(testDir, OK_DIR, CONFIG_FILENAME))).toBe(false);
  });

  test('returns no-op (not dry-run) when the directory is already fully seeded', async () => {
    // The already-seeded guard fires before the dry-run branch — pin that
    // ordering so callers branching on `status === 'dry-run'` stay correct.
    scaffoldOkDir(testDir);
    await runSeed({ cwd: testDir, yes: true });
    const result = await runSeed({ cwd: testDir, dryRun: true });
    expect(result.status).toBe('no-op');
    expect(result.exitCode).toBe(0);
  });
});

describe('runSeed — no-op', () => {
  test('reports already-seeded on re-run', async () => {
    scaffoldOkDir(testDir);
    await runSeed({ cwd: testDir, yes: true });

    const second = await runSeed({ cwd: testDir, yes: true });
    expect(second.status).toBe('no-op');
    expect(second.exitCode).toBe(0);
    expect(second.message).toContain('already seeded');
  });
});

describe('runSeed — prerequisite', () => {
  test('exits 1 when .ok/ is absent', async () => {
    const result = await runSeed({ cwd: testDir });
    expect(result.status).toBe('prerequisite-missing');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('ok init');
  });
});

describe('runSeed — --root', () => {
  test('scaffolds the starter pack inside a new subfolder', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, root: 'brain', yes: true });
    expect(result.status).toBe('applied');
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, 'brain', folder.path))).toBe(true);
      expect(existsSync(join(testDir, folder.path))).toBe(false);
    }
    expect(existsSync(join(testDir, 'brain', 'log.md'))).toBe(true);
    // Each starter folder under `brain/` gets its nested .ok/frontmatter.yml.
    for (const folder of STARTER_FOLDERS) {
      const fmPath = join(testDir, 'brain', folder.path, '.ok', 'frontmatter.yml');
      expect(existsSync(fmPath)).toBe(true);
    }
  });

  test('reuses an existing subfolder without error', async () => {
    scaffoldOkDir(testDir);
    mkdirSync(join(testDir, 'knowledge'), { recursive: true });
    writeFileSync(join(testDir, 'knowledge', '.keep'), '', 'utf-8');
    const result = await runSeed({ cwd: testDir, root: 'knowledge', yes: true });
    expect(result.status).toBe('applied');
    // Pre-existing user file is untouched.
    expect(existsSync(join(testDir, 'knowledge', '.keep'))).toBe(true);
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, 'knowledge', folder.path))).toBe(true);
    }
  });

  test('root "." matches default project-root behavior', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, root: '.', yes: true });
    expect(result.status).toBe('applied');
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, folder.path))).toBe(true);
    }
  });

  test('re-running with the same root is a no-op', async () => {
    scaffoldOkDir(testDir);
    await runSeed({ cwd: testDir, root: 'brain', yes: true });
    const second = await runSeed({ cwd: testDir, root: 'brain', yes: true });
    expect(second.status).toBe('no-op');
  });

  test('two distinct roots coexist', async () => {
    scaffoldOkDir(testDir);
    await runSeed({ cwd: testDir, root: 'work', yes: true });
    const second = await runSeed({ cwd: testDir, root: 'personal', yes: true });
    expect(second.status).toBe('applied');
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(testDir, 'work', folder.path))).toBe(true);
      expect(existsSync(join(testDir, 'personal', folder.path))).toBe(true);
      // Each root has its own per-folder nested frontmatter.
      expect(existsSync(join(testDir, 'work', folder.path, '.ok', 'frontmatter.yml'))).toBe(true);
      expect(existsSync(join(testDir, 'personal', folder.path, '.ok', 'frontmatter.yml'))).toBe(
        true,
      );
    }
  });

  test('rejects absolute root paths with a failed status', async () => {
    scaffoldOkDir(testDir);
    const result = await runSeed({ cwd: testDir, root: '/tmp/escape', yes: true });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });
});

describe('runSeed — path argument', () => {
  test('operates on explicit path rather than cwd', async () => {
    scaffoldOkDir(testDir);
    const previousCwd = process.cwd();
    // Move process cwd somewhere else to ensure explicit cwd wins
    const otherDir = mkdtempSync(join(tmpdir(), 'other-'));
    try {
      process.chdir(otherDir);
      const result = await runSeed({ cwd: testDir, yes: true });
      expect(result.status).toBe('applied');
      for (const folder of STARTER_FOLDERS) {
        expect(existsSync(join(testDir, folder.path))).toBe(true);
      }
    } finally {
      process.chdir(previousCwd);
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
