/**
 * Defense-in-depth test for the bootServer() git preflight.
 *
 * Companion to `git-preflight-boot.test.ts`, which verifies the in-process
 * throw contract: bootServer emits telemetry, writes install guidance to
 * stderr, flushes the exporter, then re-throws the typed error. This file
 * proves the same contract survives the SUBPROCESS BOUNDARY.
 *
 * The Electron-packaged path spawns a detached server child
 * (`child_process.spawn` + `ELECTRON_RUN_AS_NODE=1` + `.unref()`); if the
 * user uninstalls git between the main-process preflight and the spawn, the
 * child must still exit cleanly with EX_CONFIG (78) — not crash with a
 * generic stack trace or hang.
 *
 * The test:
 *   1. mkdtemp a project dir + seed .ok/{config.yml,.gitignore} so
 *      `bootServer`'s pre-listen MissingOkConfigError check passes.
 *   2. Spawn a fresh `bun` subprocess via `Bun.spawnSync` that imports
 *      `bootServer` + the typed errors and invokes `bootServer({})` with
 *      a forced-failure `gitPreflight`. The inline driver mirrors the
 *      CLI wrapper's catch handler: catch the typed error, exit 78.
 *   3. Assert the subprocess EXIT CODE is 78 and its STDERR contains the
 *      install guidance.
 *
 * Failure-recovery contract: when the child exits 78, the Electron main
 * process's existing server-spawn-failure handling (lines around the
 * spawnDetachedServer site in packages/desktop/src/main/index.ts) surfaces
 * the failure to the user. We do NOT redesign that path here — this file
 * only proves the child exits cleanly so the main process has something
 * stable to react to.
 *
 * No new production code lands. The test verifies the
 * gate already wired in boot.ts continues to fire when bootServer is
 * invoked from a fresh subprocess.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';

/**
 * Path of the server-package root (where `package.json` lives). The
 * `import.meta.dir` for this file is `<server>/src/`; strip the trailing
 * `/src` to get the package root that the spawned `bun` uses as its cwd
 * for workspace resolution.
 */
const SERVER_PACKAGE_ROOT = import.meta.dir.replace(/\/src$/, '');

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

      // Inline driver. Imports the same module surface used in production
      // — bootServer + the typed error. The forced-failure `gitPreflight`
      // mirrors the `BootServerOptions` injection point used by the
      // in-process boot test.
      //
      // Mirrors the CLI wrapper's catch handler: bootServer throws the
      // typed error (after emitting telemetry + writing stderr); the
      // wrapper catches and maps to EX_CONFIG (78). The parent test asserts
      // the subprocess exit code matches.
      //
      // Why pass `projectDir` via env rather than string-interpolating it
      // into the inline JS? Path literals on macOS can contain `'`, `"`,
      // backslashes, spaces — anything that survives the test runner's
      // mkdtemp would survive an env round-trip without quoting drama.
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
            attachUiSibling: false,
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
        cmd: ['bun', '--conditions=development', '-e', inlineDriver],
        cwd: SERVER_PACKAGE_ROOT,
        env: {
          ...process.env,
          NO_COLOR: '1',
          OK_TEST_PROJECT_DIR: projectDir,
          // Disable OTEL so the subprocess doesn't try to initialize the
          // SDK; the preflight catch path doesn't depend on OTEL but
          // initTelemetry() is at the top of bootServer.
          OTEL_SDK_DISABLED: 'true',
        },
      });

      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();

      // The contract: 78 = EX_CONFIG, the stable scriptable signal
      // the main process branches on. Sentinel exits 96/97/99 in the
      // driver surface specific failure modes if the wiring drifts.
      expect(result.exitCode).toBe(78);
      expect(stderr).toContain('OpenKnowledge needs Git');
      expect(stderr).toContain('sudo apt install git');
      expect(stderr).not.toContain('UNEXPECTED-CATCH');
      expect(stderr).not.toContain('PREFLIGHT-DID-NOT-FIRE');
      // stdout is not part of the preflight contract — quiet:true
      // suppresses the boot banner — but assert it's empty so a future
      // change that leaks logs to stdout fails the test.
      expect(stdout).toBe('');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('subprocess that throws GitTooOldError exits 78 with too-old message', async () => {
    const projectDir = await mkdtemp(resolve(tmpdir(), 'ok-spawn-preflight-too-old-'));
    try {
      seedOkScaffold(projectDir);

      // Same shape as the not-available case but throws GitTooOldError
      // to prove BOTH typed-error branches survive the subprocess
      // boundary. The wrapper's catch maps both typed errors to exit 78,
      // and the test pins that the version-specific detail string reaches
      // the child's stderr.
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
            attachUiSibling: false,
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
        cmd: ['bun', '--conditions=development', '-e', inlineDriver],
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
