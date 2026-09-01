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

function seedHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-deinit-home-'));
}

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
      expect(existsSync(join(dir, '.ok'))).toBe(true);
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
      expect(existsSync(join(dir, '.ok'))).toBe(true);
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
      expect(existsSync(join(dir, '.ok'))).toBe(false);
      expect(existsSync(join(dir, '.okignore'))).toBe(false);
      expect(existsSync(join(dir, '.claude', 'skills', 'open-knowledge'))).toBe(false);
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
      expect(mcp.mcpServers.mine).toEqual({ command: 'x' });
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

describe('runDeinit — refuses the home directory', () => {
  test('refuses instead of planning removal of the user-global ~/.ok', async () => {
    const home = seedHome();
    try {
      write(join(home, '.ok', 'global.yml'), 'appearance:\n  theme: dark\n');
      write(join(home, '.ok', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
      write(join(home, '.ok', 'auth.yml'), 'token: secret\n');

      const result = await runDeinit({ cwd: home, home, yes: true });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(64);
      expect(result.message).toContain('home directory');
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

describe('runDeinit attached-client disclosure', () => {
  test('names attached clients in the plan without gating the removal', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        dryRun: true,
        probeClients: async () => 2,
      });
      expect(result.status).toBe('dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('2 collaboration clients');
      expect(result.message).toContain('restarting will NOT recover them');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no disclosure line when nothing is attached', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        dryRun: true,
        probeClients: async () => 0,
      });
      expect(result.message).not.toContain('collaboration client');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json --dry-run carries the probe result', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        dryRun: true,
        json: true,
        probeClients: async () => 2,
      });
      const json = JSON.parse(result.message);
      expect(json.mode).toBe('dry-run');
      expect(json.attachedClients).toHaveLength(1);
      expect(json.attachedClients[0]).toContain('2 collaboration clients');
      expect(json.attachedClients[0]).toContain('restarting will NOT recover them');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json --dry-run reports an empty probe result when nothing is attached', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        dryRun: true,
        json: true,
        probeClients: async () => 0,
      });
      expect(JSON.parse(result.message).attachedClients).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json --yes carries the probe result on the applied outcome too', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        yes: true,
        json: true,
        probeClients: async () => 3,
        runRemovalDeps: {
          stopServer: async () => ({ stopped: 1, failed: [] }),
        },
      });
      const json = JSON.parse(result.message);
      expect(json.mode).toBe('applied');
      expect(json.attachedClients).toHaveLength(1);
      expect(json.attachedClients[0]).toContain('3 collaboration clients');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--yes still removes with clients attached (disclosure, not a gate)', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dirname(dir),
        yes: true,
        probeClients: async () => 4,
        runRemovalDeps: {
          stopServer: async () => ({ stopped: 1, failed: [] }),
        },
      });
      expect(result.status).toBe('done');
      expect(existsSync(join(dir, '.ok'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
