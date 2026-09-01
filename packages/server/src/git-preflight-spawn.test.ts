import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

const SERVER_PACKAGE_ROOT = resolve(import.meta.dir, '..');

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

describe('bootServer() preflight survives the subprocess boundary (FR6 / US-005)', () => {
  test('subprocess that throws GitNotAvailableError from gitPreflight exits 78 with install guidance on stderr', async () => {
    const projectDir = await mkdtemp(resolve(tmpdir(), 'ok-spawn-preflight-'));
    try {
      seedOkScaffold(projectDir);

      const inlineDriver = `
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { bootServer } = await import('./src/boot.ts');
        const { ConfigSchema } = await import('./src/config/schema.ts');
        const { GitNotAvailableError, GitTooOldError } = await import('./src/git-preflight.ts');

        const projectDir = process.env.OK_TEST_PROJECT_DIR;
        if (!projectDir) {
          console.error('missing OK_TEST_PROJECT_DIR');
          process.exit(99);
        }

        const guidance = {
          product: 'Git',
          platform: 'linux',
          url: 'https://git-scm.com/download/linux',
          options: [
            { label: 'Install with apt', command: 'sudo apt install git', requiresAdmin: true },
          ],
        };

        try {
          await bootServer({
            config: ConfigSchema.parse({}),
            contentDir: projectDir,
            port: 0,
            quiet: true,
            gitEnabled: true,
            idleShutdownMs: null,
            gitPreflight: () => { throw new GitNotAvailableError('linux', guidance); },
          });
        } catch (err) {
          if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
            process.exit(78);
          }
          // Any non-typed error reaching this catch is a regression in the
          // gate's classification logic. Surface with exit code 97 so the
          // parent test sees a distinct, greppable failure mode.
          console.error('UNEXPECTED-CATCH: ' + (err && err.message));
          process.exit(97);
        }

        // bootServer resolved without throwing — preflight didn't fire.
        // Exit 96 so the parent test catches a regression where the
        // preflight check is silently removed from boot.ts.
        console.error('PREFLIGHT-DID-NOT-FIRE');
        process.exit(96);
      `;

      const result = Bun.spawnSync({
        cmd: ['node', '--import', 'tsx', '--conditions=development', '-e', inlineDriver],
        cwd: SERVER_PACKAGE_ROOT,
        env: {
          ...process.env,
          NO_COLOR: '1',
          OK_TEST_PROJECT_DIR: projectDir,
          OTEL_SDK_DISABLED: 'true',
        },
      });

      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();

      expect(result.exitCode).toBe(78);
      expect(stderr).toContain('OpenKnowledge needs Git');
      expect(stderr).toContain('sudo apt install git');
      expect(stderr).not.toContain('UNEXPECTED-CATCH');
      expect(stderr).not.toContain('PREFLIGHT-DID-NOT-FIRE');
      expect(stdout).toBe('');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('subprocess that throws GitTooOldError exits 78 with too-old message', async () => {
    const projectDir = await mkdtemp(resolve(tmpdir(), 'ok-spawn-preflight-too-old-'));
    try {
      seedOkScaffold(projectDir);

      const inlineDriver = `
        const { bootServer } = await import('./src/boot.ts');
        const { ConfigSchema } = await import('./src/config/schema.ts');
        const { GitNotAvailableError, GitTooOldError } = await import('./src/git-preflight.ts');

        const projectDir = process.env.OK_TEST_PROJECT_DIR;
        if (!projectDir) {
          console.error('missing OK_TEST_PROJECT_DIR');
          process.exit(99);
        }

        const guidance = {
          product: 'Git',
          platform: 'linux',
          url: 'https://git-scm.com/download/linux',
          options: [
            { label: 'Install with apt', command: 'sudo apt install git', requiresAdmin: true },
          ],
        };

        try {
          await bootServer({
            config: ConfigSchema.parse({}),
            contentDir: projectDir,
            port: 0,
            quiet: true,
            gitEnabled: true,
            idleShutdownMs: null,
            gitPreflight: () => {
              throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', guidance);
            },
          });
        } catch (err) {
          if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
            process.exit(78);
          }
          console.error('UNEXPECTED-CATCH: ' + (err && err.message));
          process.exit(97);
        }

        console.error('PREFLIGHT-DID-NOT-FIRE');
        process.exit(96);
      `;

      const result = Bun.spawnSync({
        cmd: ['node', '--import', 'tsx', '--conditions=development', '-e', inlineDriver],
        cwd: SERVER_PACKAGE_ROOT,
        env: {
          ...process.env,
          NO_COLOR: '1',
          OK_TEST_PROJECT_DIR: projectDir,
          OTEL_SDK_DISABLED: 'true',
        },
      });

      const stderr = result.stderr.toString();

      expect(result.exitCode).toBe(78);
      expect(stderr).toContain('OpenKnowledge requires Git 2.31.0 or newer');
      expect(stderr).toContain('detected 2.20.0 at /usr/bin/git');
      expect(stderr).not.toContain('UNEXPECTED-CATCH');
      expect(stderr).not.toContain('PREFLIGHT-DID-NOT-FIRE');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});
