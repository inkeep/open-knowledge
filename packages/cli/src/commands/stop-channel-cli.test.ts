import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const packageRoot = resolve(import.meta.dir, '../..');

describe('stop CLI channel refusal', () => {
  test.each([{ options: [] }, { options: ['--format', 'json-v1'] }])(
    'refuses a Stable server from a Beta CLI with options $options',
    async ({ options }) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'ok-stop-channel-'));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      try {
        expect(child.pid).toBeDefined();
        const lockDir = join(projectRoot, '.ok', 'local');
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(join(projectRoot, '.ok', 'config.yml'), '{}\n');
        writeFileSync(
          join(lockDir, 'server.lock'),
          JSON.stringify({
            pid: child.pid,
            port: 4242,
            hostname: hostname(),
            channel: 'stable',
          }),
        );
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=development',
            'src/cli.ts',
            'stop',
            projectRoot,
            ...options,
          ],
          {
            cwd: packageRoot,
            env: { ...process.env, OK_CHANNEL: 'beta', NO_COLOR: '1' },
            encoding: 'utf8',
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        if (options.length === 0) {
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('OpenKnowledge (Stable)');
          expect(result.stderr).toContain('--force');
        } else {
          const document = JSON.parse(result.stdout);
          expect(result.stdout).toBe(`${JSON.stringify(document)}\n`);
          expect(document.result).toMatchObject({ kind: 'refused', code: 'channel-mismatch' });
          expect(document.targets[0]).toMatchObject({ pid: child.pid, code: 'channel-mismatch' });
          expect(document.targets[0].detail).toContain('--force');
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
