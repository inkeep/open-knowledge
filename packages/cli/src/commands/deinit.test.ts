import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';
import { describe, expect, test, vi } from 'vitest';
import { deinitCommand, runDeinit } from './deinit.ts';
import { buildManagedServerEntry } from './editors.ts';

const OWN_ENTRY = buildManagedServerEntry({ mode: 'published' });

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A temp home containing a temp OK project. The project is a CHILD of `home`
 * rather than home itself: `runDeinit` now refuses `projectRoot === home`,
 * because at home `.ok/` is OpenKnowledge's user-global directory rather than a
 * project marker. The old fixtures passed `home: dir` with `dir` also being the
 * project, which would trip that refusal in every case.
 */
function seedHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-deinit-home-'));
}

/** A temp OK project with a realistic footprint + a markdown content file. */
function seedProject(home: string = seedHome()): string {
  const dir = mkdtempSync(join(home, 'ok-deinit-'));
  write(join(dir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  write(join(dir, '.ok', 'local', 'server.lock'), '{}');
  write(join(dir, '.okignore'), 'secret.md\n');
  write(
    join(dir, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { mine: { command: 'x' }, [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`,
  );
  write(join(dir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'), '# ok\n');
  // The user's actual content — must survive.
  write(join(dir, 'notes.md'), '# my notes\n');
  return dir;
}

describe('runDeinit', () => {
  test('no-op with a clear message when the dir is not an OK project', async () => {
    const dir = mkdtempSync(join(seedHome(), 'ok-deinit-'));
    try {
      const result = await runDeinit({ cwd: dir, home: dirname(dir), yes: true });
      expect(result.status).toBe('no-op');
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run shows the plan and removes nothing', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dirname(dir), dryRun: true });
      expect(result.status).toBe('dry-run');
      expect(result.message).toContain('Remove');
      expect(existsSync(join(dir, '.ok'))).toBe(true); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty prompt input (bare Enter) aborts — defaults to No', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        confirmStream: Readable.from(['\n']),
      });
      expect(result.status).toBe('cancelled');
      expect(existsSync(join(dir, '.ok'))).toBe(true); // nothing removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes the project footprint while leaving markdown content untouched', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dirname(dir), yes: true });
      expect(result.status).toBe('done');
      expect(result.exitCode).toBe(0);
      // OK footprint gone.
      expect(existsSync(join(dir, '.ok'))).toBe(false);
      expect(existsSync(join(dir, '.okignore'))).toBe(false);
      expect(existsSync(join(dir, '.claude', 'skills', 'open-knowledge'))).toBe(false);
      // .mcp.json: OK entry surgically removed, the user's other server kept.
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
      expect(mcp.mcpServers.mine).toEqual({ command: 'x' });
      // Markdown content survives.
      expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# my notes\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json without --yes is rejected (no interactive prompt possible)', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dirname(dir), json: true });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports failed + exit 1 when an op fails (a server won’t stop)', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        yes: true,
        runRemovalDeps: {
          // The project's SIGTERM fails → the stop-server op is `failed`.
          stopServer: () => ({ stopped: 0, failed: [{ pid: 77, error: 'EPERM' }] }),
        },
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `cd ~ && ok deinit` used to build a real removal plan: the only precondition
 * was `existsSync(join(projectRoot, '.ok'))`, and `~/.ok/` exists on every
 * machine because it is OpenKnowledge's USER-GLOBAL directory. The plan queued
 * `remove-path` for it, taking `global.yml`, `skills/` (the user's own
 * unversioned skills), `auth.yml` and `secrets.yml` with it.
 */
describe('runDeinit — refuses the home directory', () => {
  test('refuses instead of planning removal of the user-global ~/.ok', async () => {
    const home = seedHome();
    try {
      // Exactly the shape a real home has: OK's user-global directory, which
      // the old `.ok` existence check read as a project marker.
      write(join(home, '.ok', 'global.yml'), 'appearance:\n  theme: dark\n');
      write(join(home, '.ok', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
      write(join(home, '.ok', 'auth.yml'), 'token: secret\n');

      // `--yes`: the destructive prompt is exactly what a scripted run skips.
      const result = await runDeinit({ cwd: home, home, yes: true });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(64);
      expect(result.message).toContain('home directory');
      // The refusal is only worth anything if the store survives it.
      expect(existsSync(join(home, '.ok', 'global.yml'))).toBe(true);
      expect(existsSync(join(home, '.ok', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symlinked spelling of home is refused too', async () => {
    const home = seedHome();
    const link = join(tmpdir(), `ok-deinit-home-link-${process.pid}`);
    try {
      write(join(home, '.ok', 'global.yml'), 'appearance:\n  theme: dark\n');
      symlinkSync(home, link);

      const result = await runDeinit({ cwd: link, home, yes: true });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(64);
      expect(existsSync(join(home, '.ok', 'global.yml'))).toBe(true);
    } finally {
      rmSync(link, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the command action exits 64 rather than 0 at home', async () => {
    // The refusal is only scriptable if the exit code carries it: an exit 0
    // would be indistinguishable from the no-op case. Same command-level pin
    // the init suite has, since the wiring is a separate line from runDeinit's
    // return value.
    const home = seedHome();
    const savedExitCode = process.exitCode;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      write(join(home, '.ok', 'global.yml'), 'appearance:\n  theme: dark\n');
      vi.stubEnv('HOME', home);

      await deinitCommand().parseAsync([home, '--yes'], { from: 'user' });

      expect(process.exitCode).toBe(64);
      const printed = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toContain('home directory');
      expect(existsSync(join(home, '.ok', 'global.yml'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
      stdoutSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('still deinits a project that lives inside home', async () => {
    const home = seedHome();
    const dir = seedProject(home);
    try {
      const result = await runDeinit({ cwd: dir, home, dryRun: true });
      expect(result.status).toBe('dry-run');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
