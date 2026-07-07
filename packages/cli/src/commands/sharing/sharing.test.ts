/**
 * Integration tests for `ok config-sharing share` / `ok config-sharing unshare` /
 * `ok config-sharing status`. Drives the Commander commands via `parseAsync` so
 * the same code path that hits the user's terminal is exercised.
 *
 * The refusal path and the `git rm --cached` recovery path live here;
 * the module-level
 * mechanics are pinned in `../../sharing/git-exclude.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sharingShareCommand } from './share.ts';
import { sharingStatusCommand } from './status.ts';
import { sharingUnshareCommand } from './unshare.ts';

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
}

function readExclude(dir: string): string {
  return readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
}

/**
 * Capture stdout + stderr while a Promise runs. Each `process.stdout.write`
 * and `process.stderr.write` is intercepted; the originals are restored
 * after. Returns the captured strings + the promise's resolved value.
 *
 * The sharing commands write a mix of human-readable lines to stderr and
 * JSON payloads to stdout (matching the ok clone --json convention), so we
 * need both streams.
 */
async function capture<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: unknown) => {
    stdout +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('ok config-sharing unshare → share round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-cmd-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('unshare appends OK artifact paths to .git/info/exclude (8 paths in default repo)', async () => {
    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    const exclude = readExclude(dir);
    expect(exclude).toContain('.ok/');
    expect(exclude).toContain('.mcp.json');
    expect(exclude).toContain('.claude/skills/open-knowledge/');
    expect(exclude).toContain('.claude/launch.json');
    expect(process.exitCode).not.toBe(1);
  });

  it('share removes OK artifact paths and leaves the rest byte-identical', async () => {
    // Seed: write a user-authored exclude with an OK line mixed in.
    const original = '# user header\n*.tmp\n';
    writeFileSync(join(dir, '.git', 'info', 'exclude'), original, 'utf-8');
    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    const afterUnshare = readExclude(dir);
    expect(afterUnshare.startsWith(original)).toBe(true);
    expect(afterUnshare).toContain('.ok/');

    await capture(async () => {
      await sharingShareCommand().parseAsync(['node', 'share', '--project', dir]);
    });
    // After share, the user's two lines survive byte-identical, OK lines gone.
    expect(readExclude(dir)).toBe(original);
  });

  it('survives a hand-edit-friendly cycle — user lines persist across share→unshare→share', async () => {
    const original = '# user notes\n*.tmp\nbuild/\n';
    writeFileSync(join(dir, '.git', 'info', 'exclude'), original, 'utf-8');
    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    await capture(async () => {
      await sharingShareCommand().parseAsync(['node', 'share', '--project', dir]);
    });
    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    await capture(async () => {
      await sharingShareCommand().parseAsync(['node', 'share', '--project', dir]);
    });
    expect(readExclude(dir)).toBe(original);
  });
});

describe('ok config-sharing unshare — §5.5 tracked-files refusal', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-refuse-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('refuses with exit code 1 and a remediation message when an OK path is tracked upstream', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const { stderr } = await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('Cannot switch OpenKnowledge to local-only');
    expect(stderr).toContain('git rm --cached .mcp.json');
    expect(stderr).toContain('your teammates will see a deletion on their next pull');

    // Critically: no OK paths landed in the exclude file (git init seeds
    // its own default template, so we assert the OK markers are absent).
    const after = readExclude(dir);
    expect(after).not.toContain('.ok/');
    expect(after).not.toContain('.mcp.json');
  });

  it('JSON form emits a refused-tracked report on stdout (no stderr)', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const { stdout, stderr } = await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir, '--json']);
    });
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({
      type: 'sharing-unshare',
      mode: 'refused-tracked',
      tracked: ['.mcp.json'],
    });
    expect(typeof parsed.remediation).toBe('string');
  });

  it('proceeds after the user runs `git rm --cached` on the tracked path (recovery path)', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['rm', '--cached', '.mcp.json'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    expect(process.exitCode).not.toBe(1);
    expect(readExclude(dir)).toContain('.mcp.json');
    expect(readExclude(dir)).toContain('.ok/');
  });
});

describe('ok config-sharing status', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-status-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('reports `shared` for a fresh repo with no excluded OK paths', async () => {
    const { stdout } = await capture(async () => {
      await sharingStatusCommand().parseAsync(['node', 'status', '--project', dir, '--json']);
    });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.mode).toBe('shared');
    expect(parsed.excluded).toEqual([]);
    expect(parsed.trackedUpstream).toEqual([]);
  });

  it('reports `local-only` after unshare', async () => {
    await capture(async () => {
      await sharingUnshareCommand().parseAsync(['node', 'unshare', '--project', dir]);
    });
    const { stdout } = await capture(async () => {
      await sharingStatusCommand().parseAsync(['node', 'status', '--project', dir, '--json']);
    });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.mode).toBe('local-only');
    expect(parsed.excluded.length).toBeGreaterThan(0);
  });

  it('lists tracked-upstream OK paths when present', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const { stdout } = await capture(async () => {
      await sharingStatusCommand().parseAsync(['node', 'status', '--project', dir, '--json']);
    });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.trackedUpstream).toEqual(['.mcp.json']);
  });

  it('reports `no-git` for a non-git directory', async () => {
    const nonGit = uniqueDir('sharing-status-nongit');
    mkdirSync(nonGit, { recursive: true });
    try {
      const { stdout } = await capture(async () => {
        await sharingStatusCommand().parseAsync(['node', 'status', '--project', nonGit, '--json']);
      });
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.mode).toBe('no-git');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
