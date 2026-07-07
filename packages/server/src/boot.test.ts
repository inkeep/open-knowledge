import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): subprocess or git child spawns; Bun fails to reap children on ubuntu-latest GHA runners (oven-sh/bun#11892).
// Tests run normally locally; follow-up will narrow the leak surface.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { emitToleranceFire, OK_DIR } from '@inkeep/open-knowledge-core';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { bootServer } from './boot.ts';
import { getBootTimings } from './boot-timings.ts';
import { ConfigSchema } from './config/schema.ts';
import { parseKeepaliveConnectionId } from './mcp-mount.ts';
import { shutdownTelemetry } from './telemetry.ts';

/**
 * `bootServer`'s pre-listen check refuses when `<projectDir>/.ok/config.yml`
 * is absent. Tests that don't exercise that codepath need a stub on disk so
 * boot can reach `createServer`. `.ok/.gitignore` is included so the State C
 * one-time hygiene warning doesn't pollute test stderr.
 */
function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

const execFileAsync = promisify(execFile);
const TEST_CONFIG = ConfigSchema.parse({});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-boot-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('bootServer — MissingOkConfigError pre-listen check', () => {
  test('rejects with kind=okdir when .ok/ directory is absent (State A)', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'state-a-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    // No seedOkScaffold — entire .ok/ is absent.

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { kind?: string; projectDir?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('okdir');
    expect(e.projectDir).toBe(contentDir);
    expect(e.message).toContain('OpenKnowledge config not found at .ok/config.yml');
    expect(e.message).toContain('Run ok init');
    // No shadow dir created (no partial state on fail-fast).
    expect(existsSync(resolve(contentDir, '.git/ok'))).toBe(false);
  });

  test('rejects with kind=config when .ok/ exists but config.yml is missing (State B)', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'state-b-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    const okDir = resolve(contentDir, '.ok');
    // Create .ok/ but NOT config.yml.
    writeFileSync(resolve(contentDir, 'placeholder'), '');
    await execFileAsync('mkdir', [okDir]);

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { kind?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('config');
    expect(e.message).toContain('OpenKnowledge config not found at .ok/config.yml');
    expect(existsSync(resolve(contentDir, '.git/ok'))).toBe(false);
  });

  test('preflight checks projectDir/.ok/config.yml when projectDir != contentDir', async () => {
    // Regression: prior to fix, the preflight resolved against `contentDir`,
    // so a project with `content.dir: docs` would be rejected with State A
    // even though config.yml lives at <projectDir>/.ok/config.yml. Seed the
    // scaffold at projectDir only and confirm boot succeeds.
    const projectDir = mkdtempSync(resolve(tmpDir, 'projectdir-preflight-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);
    const contentDir = resolve(projectDir, 'docs');
    mkdirSync(contentDir, { recursive: true });
    // Deliberately do NOT seed contentDir/.ok — proves the check is on projectDir.
    expect(existsSync(resolve(contentDir, '.ok', 'config.yml'))).toBe(false);

    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        projectDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      if (booted) await booted.destroy();
    }
  });

  test('rejects when projectDir/.ok/config.yml is missing even though contentDir/.ok/config.yml exists', async () => {
    // Inverse regression: prior to fix, seeding `<contentDir>/.ok/config.yml`
    // would cause the preflight to (incorrectly) succeed. After fix, the
    // preflight is anchored to `projectDir`, so a config-shaped scaffold under
    // contentDir does NOT satisfy it.
    const projectDir = mkdtempSync(resolve(tmpDir, 'projectdir-only-content-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    const contentDir = resolve(projectDir, 'docs');
    mkdirSync(contentDir, { recursive: true });
    seedOkScaffold(contentDir); // wrong place: config under contentDir, not projectDir

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        projectDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { kind?: string; projectDir?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('okdir');
    expect(e.projectDir).toBe(projectDir);
  });

  test('proceeds and emits a one-time stderr warning when only .ok/.gitignore is missing (State C)', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'state-c-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    const okDir = resolve(contentDir, '.ok');
    await execFileAsync('mkdir', [okDir]);
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    // Note: NO .gitignore.

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      const bootWarnings = warnings.filter((w) => w.startsWith('[boot]'));
      expect(bootWarnings.length).toBe(1);
      expect(bootWarnings[0]).toContain('.ok/.gitignore');
      expect(bootWarnings[0]).toContain('ok init');
    } finally {
      console.warn = originalWarn;
      if (booted) await booted.destroy();
    }
  });
});

describe('bootServer — runtime state lives at projectDir, not contentDir', () => {
  // When `content.dir` points at a sub-folder of the project (e.g.
  // `~/agents-cookbook` with `content.dir: template-projects`), per-project
  // runtime state — server lock, principal, server-instance state-manifest,
  // AND the default-on log + telemetry file-sinks — must live at
  // `<projectDir>/.ok/local/`, not `<contentDir>/.ok/local/`.
  // Otherwise the project ends up with TWO `.ok/` directories: one at the
  // project root (committed config) and one inside the content sub-folder
  // (per-machine runtime). Dev tooling, backups, sync, and visual inspection
  // all see two directories where the user expects one.
  test('boot writes server.lock, principal.json, state.json under projectDir, not contentDir', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);
    const contentDir = resolve(projectDir, 'template-projects');
    mkdirSync(contentDir, { recursive: true });

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      // Wait for async init (loadPrincipal, state-manifest write) to settle.
      await booted.ready;

      // What the user reported: NO `.ok/` directory inside the content
      // sub-folder. Pre-fix this directory was created by `loadPrincipal`,
      // `acquireServerLock`, the state-manifest writer, AND the log/telemetry
      // file-sinks — all routing through a `contentDir`-anchored `.ok/local/`.
      // A single absence check covers every one of those writers: any sink or
      // runtime file landing under contentDir would materialize this dir.
      const contentLocalDir = resolve(contentDir, '.ok');
      expect(existsSync(contentLocalDir)).toBe(false);

      // Per-project runtime state lives under projectDir.
      const projectLocalDir = resolve(projectDir, '.ok', 'local');
      expect(existsSync(resolve(projectLocalDir, 'server.lock'))).toBe(true);
      expect(existsSync(resolve(projectLocalDir, 'principal.json'))).toBe(true);
      expect(existsSync(resolve(projectLocalDir, 'state.json'))).toBe(true);
    } finally {
      await booted.destroy();
    }
  });
});

describe('bootServer — tolerance-telemetry writer wired through the real boot path', () => {
  // OK_BRIDGE_TOLERANCE_TELEMETRY=1 is an advertised operator flag (the
  // aggregator CLI reads the file it produces). The writer self-gates on the
  // env var and is wired in bootServer alongside initTelemetry; destroy
  // drains the appender. This smoke pins flag -> hook -> JSONL on disk so
  // the flag can never regress to a documented no-op again.
  test('flag=1 boot produces tolerance-telemetry.jsonl from an emitToleranceFire', async () => {
    const prevFlag = process.env.OK_BRIDGE_TOLERANCE_TELEMETRY;
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    const projectDir = mkdtempSync(resolve(tmpDir, 'tolerance-telemetry-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const booted = await bootServer({
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      await booted.ready;
      // The hook is the process-global core singleton boot just registered —
      // fire through the same entry the watchdog uses in production.
      emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'smoke-doc');
    } finally {
      // destroy() runs teardownToleranceTelemetry, draining the appender.
      await booted.destroy();
      if (prevFlag === undefined) delete process.env.OK_BRIDGE_TOLERANCE_TELEMETRY;
      else process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = prevFlag;
    }

    const logPath = resolve(projectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n')[0] ?? '');
    expect(record.event).toBe('bridge-tolerance-fire');
    expect(record.class).toBe('crlf');
    expect(record.document).toBe('smoke-doc');
  });
});

describe('bootServer — idle-shutdown runs full destroy', () => {
  // Regression: prior to fix, idle-shutdown's onShutdown only awaited
  // destroyHocuspocus(), so when the timer fired the http.Server LISTEN
  // socket stayed bound and the process never exited. Combined with
  // `attachIdleShutdown`'s `fired=true` latch, every fired-but-not-exited
  // server became a permanent zombie listener. This test boots with a 50ms
  // threshold, waits for the timer to fire, and asserts the listener
  // actually closes.
  test('after idle-shutdown fires with zero WS clients, httpServer is no longer listening', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'idle-full-destroy-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: 50,
      attachUiSibling: false,
    });

    try {
      expect(booted.httpServer.listening).toBe(true);

      // Poll until the listener closes or we hit a deadline well past the
      // 50ms threshold. Idle-shutdown's onShutdown is async (it awaits the
      // full destroy chain) so we can't synchronously read the result.
      const deadline = Date.now() + 3_000;
      while (booted.httpServer.listening && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(booted.httpServer.listening).toBe(false);
    } finally {
      // destroy() is idempotent — safe to call even after idle-shutdown ran.
      await booted.destroy();
    }
  });
});

describe('bootServer — reactShellDistDir + ui.lock advertisement', () => {
  // `ui.lock` is treated as advertisement, NOT mutex. When --react-shell-dist-dir
  // is set, bootServer TRIES to write `ui.lock` so external agent-harness
  // preview-URL consumers can discover the bound port. If a live holder
  // already owns the lock (a co-existing `ok ui` sibling, a prior-session
  // detached server), we YIELD: their port is already a valid preview URL.
  // Stale locks (dead pid) are pruned automatically by acquireProcessLock.
  // Only the writer releases on destroy.

  test('writes ui.lock with the bound port when --react-shell-dist-dir is set and no live holder exists', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-shell-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const shellDistDir = mkdtempSync(resolve(tmpDir, 'fake-shell-dist-'));
    writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted.ready;
      const uiLockPath = resolve(projectDir, '.ok', 'local', 'ui.lock');
      expect(existsSync(uiLockPath)).toBe(true);
      const raw = await import('node:fs/promises').then((m) => m.readFile(uiLockPath, 'utf-8'));
      const parsed = JSON.parse(raw) as { port: number; pid: number };
      expect(parsed.port).toBeGreaterThan(0);
      expect(parsed.port).toBe(booted.port);
      expect(parsed.pid).toBe(process.pid);
    } finally {
      await booted.destroy();
    }
  });

  test('does NOT write ui.lock when reactShellDistDir is omitted (CLI default)', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-no-shell-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      await booted.ready;
      const uiLockPath = resolve(projectDir, '.ok', 'local', 'ui.lock');
      expect(existsSync(uiLockPath)).toBe(false);
    } finally {
      await booted.destroy();
    }
  });

  test('yields to a live holder of ui.lock — no UiLockCollisionError, lock unchanged, boot succeeds', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-yield-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const shellDistDir = mkdtempSync(resolve(tmpDir, 'fake-shell-dist-yield-'));
    writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

    // Seed a ui.lock pointing at our parent shell's pid — a different live
    // process — to simulate a co-existing `ok ui` peer. process.ppid is
    // guaranteed alive while this test runs, and is NOT process.pid (which
    // would otherwise trigger acquireProcessLock's same-pid idempotent
    // rewrite path instead of the live-collision path).
    const lockDir = resolve(projectDir, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    const peerSnapshot = {
      pid: process.ppid,
      hostname: hostname(),
      port: 65432,
      startedAt: new Date().toISOString(),
      worktreeRoot: projectDir,
      protocolVersion: 1,
      runtimeVersion: '0.0.0-test-peer',
    };
    writeFileSync(resolve(lockDir, 'ui.lock'), JSON.stringify(peerSnapshot), 'utf-8');

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted.ready;
      expect(booted.port).toBeGreaterThan(0);
      // ui.lock was NOT overwritten — peer's advertisement survives.
      // (process-lock's same-pid idempotent rewrite would normally overwrite,
      // but the peer's startedAt and runtimeVersion are distinct sentinels
      // we can verify.)
      const stillRaw = await import('node:fs/promises').then((m) =>
        m.readFile(resolve(lockDir, 'ui.lock'), 'utf-8'),
      );
      const still = JSON.parse(stillRaw) as typeof peerSnapshot;
      expect(still.port).toBe(65432);
      expect(still.runtimeVersion).toBe('0.0.0-test-peer');
    } finally {
      await booted.destroy();
      // Yield-on-collision means bootServer must NOT release the peer's
      // ui.lock on destroy — the advertisement must survive past our quit.
      const lockStillExists = existsSync(resolve(lockDir, 'ui.lock'));
      expect(lockStillExists).toBe(true);
    }
  });

  test('prunes a stale ui.lock (dead pid) and writes its own', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-prune-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const shellDistDir = mkdtempSync(resolve(tmpDir, 'fake-shell-dist-prune-'));
    writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

    // Stale lock — spawn a throwaway child, await its exit, then reuse
    // its pid. Guarantees a structurally-dead pid by the time the test
    // reads it (Linux `pid_max` defaults to 4M so picking a literal like
    // 999999 isn't guaranteed dead, especially on long-running CI runners
    // with pid recycling). The kernel doesn't immediately recycle this
    // pid; isProcessAlive() returns false → acquireProcessLock prunes.
    const stalePid = await new Promise<number>((res, rej) => {
      const cp = execFile('true', (err) => {
        if (err) rej(err);
        else res(cp.pid ?? 0);
      });
    });
    expect(stalePid).toBeGreaterThan(0);
    const lockDir = resolve(projectDir, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      resolve(lockDir, 'ui.lock'),
      JSON.stringify({
        pid: stalePid,
        hostname: hostname(),
        port: 11111,
        startedAt: new Date().toISOString(),
        worktreeRoot: projectDir,
        protocolVersion: 1,
        runtimeVersion: '0.0.0-stale',
      }),
      'utf-8',
    );

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted.ready;
      const raw = await import('node:fs/promises').then((m) =>
        m.readFile(resolve(lockDir, 'ui.lock'), 'utf-8'),
      );
      const parsed = JSON.parse(raw) as { pid: number; port: number };
      // Our pid replaced the stale entry.
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.port).toBe(booted.port);
    } finally {
      await booted.destroy();
      // We owned the lock (acquired by replacing the stale entry), so we
      // release on destroy.
      expect(existsSync(resolve(lockDir, 'ui.lock'))).toBe(false);
    }
  });

  test('destroy() releases ui.lock so a later boot can advertise', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-release-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const shellDistDir = mkdtempSync(resolve(tmpDir, 'fake-shell-dist-release-'));
    writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

    const booted1 = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      reactShellDistDir: shellDistDir,
    });
    await booted1.ready;
    const uiLockPath = resolve(projectDir, '.ok', 'local', 'ui.lock');
    expect(existsSync(uiLockPath)).toBe(true);
    await booted1.destroy();
    expect(existsSync(uiLockPath)).toBe(false);

    // A second boot for the same project acquires cleanly.
    const booted2 = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted2.ready;
      expect(existsSync(uiLockPath)).toBe(true);
    } finally {
      await booted2.destroy();
    }
  });
});

describe('bootServer — reactShellDistDir end-to-end HTTP shape', () => {
  // End-to-end: boot the real server with
  // reactShellDistDir + serveContentAssets, exercise every surface
  // (SPA shell, bundled asset, content asset, /api/*) over real HTTP
  // and verify each lands the right way. The earlier mcp-mount unit
  // tests cover the dispatcher logic against fakes; this verifies the
  // composed boot path that Electron utility wires up.

  test('serves the React shell, bundled assets, content assets, and API on one port', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'shell-e2e-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    // Create a minimal bundled-React-app dist tree.
    const shellDistDir = mkdtempSync(resolve(tmpDir, 'shell-e2e-dist-'));
    writeFileSync(
      resolve(shellDistDir, 'index.html'),
      '<!DOCTYPE html><html><body data-test="shell">ok</body></html>',
      'utf-8',
    );
    mkdirSync(resolve(shellDistDir, 'assets'));
    writeFileSync(
      resolve(shellDistDir, 'assets', 'app-deadbeef.js'),
      'console.log("bundle");',
      'utf-8',
    );
    // A bundled font under /assets/ — `.woff2` IS in ASSET_EXTENSIONS, so the
    // content middleware fail-closes (404 without next()) on a content-dir
    // miss. Without the `/assets/`-tries-shell-first branch in mcp-mount this
    // 404s even though the file lives in the SPA dist (the original bug:
    // fonts/images 404 under `ok start` / Electron HTTP exposure while js/css
    // — not asset extensions — served fine).
    const fontBytes = Buffer.from('woff2-bundle-bytes', 'utf-8');
    writeFileSync(resolve(shellDistDir, 'assets', 'inter-cafebabe.woff2'), fontBytes);

    // Drop a user-content asset under contentDir so contentAsset priority
    // can be exercised against a real upload.
    mkdirSync(resolve(projectDir, 'docs'), { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(resolve(projectDir, 'docs', 'image.png'), pngBytes);

    // A user upload under <contentDir>/assets/ — doc-referenced media
    // normalizes to a server-absolute `/assets/...` URL. The `/assets/`-first
    // branch must still let this fall through to the content middleware when
    // the SPA dist has no such file, so uploads keep serving.
    mkdirSync(resolve(projectDir, 'assets'), { recursive: true });
    const uploadBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33, 0x44]);
    writeFileSync(resolve(projectDir, 'assets', 'upload.png'), uploadBytes);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
      serveContentAssets: true,
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted.ready;
      const base = `http://127.0.0.1:${booted.port}`;

      // 1. Root → SPA shell index.html.
      const rootRes = await fetch(`${base}/`);
      expect(rootRes.status).toBe(200);
      const rootBody = await rootRes.text();
      expect(rootBody).toContain('data-test="shell"');

      // 2. Unknown deep-link route → SPA fallback (single: true).
      const deepRes = await fetch(`${base}/some/unknown/route`);
      expect(deepRes.status).toBe(200);
      expect(await deepRes.text()).toContain('data-test="shell"');

      // 3. Bundled SPA asset under /assets/<hash>.js served from dist.
      const bundleRes = await fetch(`${base}/assets/app-deadbeef.js`);
      expect(bundleRes.status).toBe(200);
      expect(await bundleRes.text()).toContain('console.log');

      // 3b. Bundled SPA FONT under /assets/<hash>.woff2 — regression guard.
      // `.woff2` is an asset extension, so the content middleware would
      // fail-close 404 before the shell was tried (content-first ordering).
      const fontRes = await fetch(`${base}/assets/inter-cafebabe.woff2`);
      expect(fontRes.status).toBe(200);
      expect(Buffer.from(await fontRes.arrayBuffer()).equals(fontBytes)).toBe(true);

      // 3c. A user upload under /assets/ with no matching SPA-dist file still
      // serves via the content middleware (shell-first falls through on miss).
      const uploadRes = await fetch(`${base}/assets/upload.png`);
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.headers.get('content-disposition')).toBe('inline');
      expect(Buffer.from(await uploadRes.arrayBuffer()).equals(uploadBytes)).toBe(true);

      // 4. User-uploaded content asset takes priority over the SPA dist.
      // (contentAssetMiddleware runs before reactShellMiddleware.)
      const imageRes = await fetch(`${base}/docs/image.png`);
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get('content-disposition')).toBe('inline');
      const imageGot = Buffer.from(await imageRes.arrayBuffer());
      expect(imageGot.equals(pngBytes)).toBe(true);

      // 5. /api/* is NOT shadowed by the SPA — unknown endpoint returns
      // problem+json 404, NOT index.html.
      const apiRes = await fetch(`${base}/api/nonexistent-endpoint`);
      expect(apiRes.status).toBe(404);
      expect(apiRes.headers.get('content-type')).toBe('application/problem+json');

      // 6. ui.lock advertises the bound port — agent-harness preview-browser
      // flows read this file to find a clickable URL. Lock-write happens
      // AFTER listen() resolves, so the port stored is the actual port the
      // server is reachable on (no port=0 sentinel leaking to consumers).
      // Yield-to-live-holder semantics mean this assertion only holds when
      // no live peer was holding the lock — for a clean test environment
      // this is always true.
      const uiLockPath = resolve(projectDir, '.ok', 'local', 'ui.lock');
      expect(existsSync(uiLockPath)).toBe(true);
      const lockRaw = await import('node:fs/promises').then((m) => m.readFile(uiLockPath, 'utf-8'));
      const parsed = JSON.parse(lockRaw) as { port: number };
      expect(parsed.port).toBe(booted.port);
    } finally {
      await booted.destroy();
    }
  });
});

describe('bootServer — ok.boot OTel span attributes', () => {
  let exporter: InMemorySpanExporter | null = null;
  let provider: BasicTracerProvider | null = null;
  let savedDisableLocalSink: string | undefined;

  beforeEach(() => {
    trace.disable();
    metrics.disable();
    context.disable();
    // Suppress bootServer's local-sink file pipeline so it doesn't override
    // the test's manually-installed InMemorySpanExporter via initTelemetry's
    // `trace.setGlobalTracerProvider` call. This test only cares about the
    // computed span attributes — the file SpanExporter has its own coverage
    // in telemetry-file-sink.test.ts and telemetry.test.ts.
    savedDisableLocalSink = process.env.OK_DISABLE_LOCAL_SINK;
    process.env.OK_DISABLE_LOCAL_SINK = '1';
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await shutdownTelemetry();
    await provider?.shutdown();
    trace.disable();
    metrics.disable();
    context.disable();
    exporter = null;
    provider = null;
    if (savedDisableLocalSink === undefined) {
      delete process.env.OK_DISABLE_LOCAL_SINK;
    } else {
      process.env.OK_DISABLE_LOCAL_SINK = savedDisableLocalSink;
    }
  });

  test('main worktree: ok.boot span has worktree.kind=main', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'span-main-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      const spans = exporter?.getFinishedSpans() ?? [];
      const bootSpan = spans.find((s) => s.name === 'ok.boot');
      expect(bootSpan).toBeDefined();
      expect(bootSpan?.attributes['ok.worktree.kind']).toBe('main');
      // gitdir is present for main worktrees (resolveGitDir returns the .git path)
      expect(typeof bootSpan?.attributes['ok.worktree.gitdir']).toBe('string');
      // Cardinality discipline: normalized path is at most last-two-segments
      // form (`.../<dir>/<file>`) — should NOT contain user-home segments.
      const gitdirAttr = bootSpan?.attributes['ok.worktree.gitdir'] as string;
      expect(gitdirAttr.split('/').filter(Boolean).length).toBeLessThanOrEqual(3);
    } finally {
      await booted.destroy();
    }
  });

  test('linked worktree: ok.boot span has worktree.kind=linked', async () => {
    // Build a real worktree: parent repo with one commit, then `git worktree add` a sibling.
    const repoRoot = mkdtempSync(resolve(tmpDir, 'span-linked-repo-'));
    await execFileAsync('git', ['init', '--initial-branch=main', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', '.']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'init']);

    const wtPath = mkdtempSync(resolve(tmpDir, 'span-linked-wt-'));
    // git worktree add wants the path to NOT pre-exist
    await rm(wtPath, { recursive: true, force: true });
    await execFileAsync('git', [
      '-C',
      repoRoot,
      'worktree',
      'add',
      '-b',
      `wt-span-${Date.now()}`,
      wtPath,
    ]);
    seedOkScaffold(wtPath);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: wtPath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      const spans = exporter?.getFinishedSpans() ?? [];
      const bootSpan = spans.find((s) => s.name === 'ok.boot');
      expect(bootSpan).toBeDefined();
      expect(bootSpan?.attributes['ok.worktree.kind']).toBe('linked');
      const gitdirAttr = bootSpan?.attributes['ok.worktree.gitdir'] as string;
      expect(typeof gitdirAttr).toBe('string');
      expect(gitdirAttr.split('/').filter(Boolean).length).toBeLessThanOrEqual(3);
    } finally {
      await booted.destroy();
    }
  });

  test('boot failure (MissingOkConfigError): span still records the worktree kind', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'span-fail-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    // No seedOkScaffold — boot will throw MissingOkConfigError.

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const spans = exporter?.getFinishedSpans() ?? [];
    const bootSpan = spans.find((s) => s.name === 'ok.boot');
    expect(bootSpan).toBeDefined();
    expect(bootSpan?.attributes['ok.worktree.kind']).toBe('main');
    // Span status is ERROR because withSpan records exceptions
    expect(bootSpan?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  test('cross-invocation: main first, linked second — kinds flip correctly with no state leakage', async () => {
    // Single test, single tracer provider — proves there's no per-invocation
    // state leakage in computeWorktreeAttributes between sequential boots.
    // (Sibling tests reset the exporter in beforeEach, so each runs against
    // a fresh provider; this test deliberately does not, to exercise the
    // span-attribute computation against the same captured stream.)

    // Boot 1: main worktree.
    const mainDir = mkdtempSync(resolve(tmpDir, 'flip-main-'));
    await execFileAsync('git', ['init', '--initial-branch=main', mainDir]);
    seedOkScaffold(mainDir);
    const bootedMain = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: mainDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    await bootedMain.destroy();

    // Boot 2: linked worktree (real `git worktree add`).
    const repoRoot = mkdtempSync(resolve(tmpDir, 'flip-linked-repo-'));
    await execFileAsync('git', ['init', '--initial-branch=main', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', '.']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'init']);
    const wtPath = mkdtempSync(resolve(tmpDir, 'flip-linked-wt-'));
    await rm(wtPath, { recursive: true, force: true });
    await execFileAsync('git', [
      '-C',
      repoRoot,
      'worktree',
      'add',
      '-b',
      `wt-flip-${Date.now()}`,
      wtPath,
    ]);
    seedOkScaffold(wtPath);
    const bootedLinked = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: wtPath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    await bootedLinked.destroy();

    // Both ok.boot spans should be present in the same exporter, in order.
    const spans = exporter?.getFinishedSpans() ?? [];
    const bootSpans = spans.filter((s) => s.name === 'ok.boot');
    expect(bootSpans.length).toBe(2);
    expect(bootSpans[0]?.attributes['ok.worktree.kind']).toBe('main');
    expect(bootSpans[1]?.attributes['ok.worktree.kind']).toBe('linked');
    // Sanity — gitdir attribute differs between the two boots (proves the
    // computation isn't returning a memoized value from the previous run).
    expect(bootSpans[0]?.attributes['ok.worktree.gitdir']).not.toBe(
      bootSpans[1]?.attributes['ok.worktree.gitdir'],
    );
  });

  test('OK_STARTUP_TRACEPARENT (valid): ok.boot joins the desktop-main launch trace', async () => {
    // A well-formed W3C traceparent, as the Electron main process injects into
    // the spawned server's env. Running `ok.boot` inside the extracted context
    // must parent it to that trace, so main → server show as one trace.
    const parentTraceId = '0af7651916cd43dd8448eb211c80319c';
    const prev = process.env.OK_STARTUP_TRACEPARENT;
    process.env.OK_STARTUP_TRACEPARENT = `00-${parentTraceId}-b7ad6b7169203331-01`;
    // The harness runs telemetry in spans-only mode (initTelemetry no-ops with
    // the local sink disabled + push off), so opt this one case into real W3C
    // propagation to exercise the actual join, not just no-throw. afterEach's
    // context.disable() tears the manager back down.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const contentDir = mkdtempSync(resolve(tmpDir, 'traceparent-valid-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);

    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      const bootSpan = (exporter?.getFinishedSpans() ?? []).find((s) => s.name === 'ok.boot');
      expect(bootSpan).toBeDefined();
      expect(bootSpan?.spanContext().traceId).toBe(parentTraceId);
    } finally {
      if (booted) await booted.destroy();
      if (prev === undefined) delete process.env.OK_STARTUP_TRACEPARENT;
      else process.env.OK_STARTUP_TRACEPARENT = prev;
    }
  });

  test('OK_STARTUP_TRACEPARENT (malformed): boot still completes; ok.boot is a fresh root', async () => {
    // The meaningful failure mode: a garbage env value must never break boot.
    // The W3C propagator degrades to an unparented context, so `ok.boot` gets a
    // fresh trace-id rather than throwing.
    const prev = process.env.OK_STARTUP_TRACEPARENT;
    process.env.OK_STARTUP_TRACEPARENT = 'not-a-valid-traceparent';
    const contentDir = mkdtempSync(resolve(tmpDir, 'traceparent-malformed-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);

    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      expect(booted.port).toBeGreaterThan(0);
      const bootSpan = (exporter?.getFinishedSpans() ?? []).find((s) => s.name === 'ok.boot');
      expect(bootSpan).toBeDefined();
      expect(bootSpan?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (booted) await booted.destroy();
      if (prev === undefined) delete process.env.OK_STARTUP_TRACEPARENT;
      else process.env.OK_STARTUP_TRACEPARENT = prev;
    }
  });
});

describe('bootServer — boot timings recorded end-to-end', () => {
  test('a full boot populates httpListen / seedWalk / indexes / ready / fileCount', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'boot-timings-e2e-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);
    // One markdown file so fileCount is a meaningful non-zero count.
    writeFileSync(resolve(projectDir, 'note.md'), '# note\n', 'utf-8');

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      await booted.ready;
      // startBootTimings ran at the top of bootServer; the phases are recorded
      // across boot.ts (httpListen) and initAsync (seedWalk/indexes/ready +
      // fileCount, the last two via the always-run finally). Assert the whole
      // pipeline landed rather than any single site.
      const timings = getBootTimings();
      expect(timings).toBeDefined();
      expect(typeof timings?.startedAt).toBe('string');
      expect(typeof timings?.httpListenMs).toBe('number');
      expect(typeof timings?.seedWalkMs).toBe('number');
      expect(typeof timings?.indexesMs).toBe('number');
      expect(typeof timings?.readyMs).toBe('number');
      expect(typeof timings?.fileCount).toBe('number');
      expect(timings?.fileCount).toBeGreaterThanOrEqual(1);
    } finally {
      await booted.destroy();
    }
  });
});

describe('parseKeepaliveConnectionId', () => {
  test('returns null for undefined URL (defensive)', () => {
    expect(parseKeepaliveConnectionId(undefined)).toBeNull();
  });

  test('returns null for empty URL', () => {
    expect(parseKeepaliveConnectionId('')).toBeNull();
  });

  test('returns null when connectionId query param is absent', () => {
    expect(parseKeepaliveConnectionId('/collab/keepalive?pid=1234')).toBeNull();
  });

  test('returns null when connectionId is present but empty', () => {
    expect(parseKeepaliveConnectionId('/collab/keepalive?pid=1234&connectionId=')).toBeNull();
  });

  test('returns the connectionId when present (happy path)', () => {
    expect(parseKeepaliveConnectionId('/collab/keepalive?pid=1234&connectionId=uuid-A')).toBe(
      'uuid-A',
    );
  });

  test('rejects percent-encoded connectionId values that decode to invalid chars', () => {
    // `user%2Fagent%3D1%262` decodes to `user/agent=1&2` which fails the
    // AGENT_ID_RE character class (`/`, `=`, `&` are disallowed). Pre-fix
    // the function would have returned the decoded string and the close
    // handler would have called `clearPresence('user/agent=1&2')`,
    // potentially colliding with other agents' map keys. Post-fix the
    // value is rejected outright → TTL-only cleanup.
    expect(
      parseKeepaliveConnectionId('/collab/keepalive?connectionId=user%2Fagent%3D1%262'),
    ).toBeNull();
  });

  test('rejects connectionId containing CR/LF (log-injection defense)', () => {
    // `abc%0D%0Aadmin` decodes to `abc\r\nadmin`; returning the raw value
    // would let an attacker inject a newline into structured log lines.
    // Rejected by the shared AGENT_ID_RE.
    expect(parseKeepaliveConnectionId('/collab/keepalive?connectionId=abc%0D%0Aadmin')).toBeNull();
  });

  test('tolerates query order', () => {
    expect(parseKeepaliveConnectionId('/collab/keepalive?connectionId=foo&pid=1')).toBe('foo');
  });

  test('tolerates a UUID-shaped connectionId', () => {
    expect(
      parseKeepaliveConnectionId(
        '/collab/keepalive?connectionId=abcdef12-3456-7890-abcd-ef1234567890',
      ),
    ).toBe('abcdef12-3456-7890-abcd-ef1234567890');
  });

  test('does not throw on a blatantly malformed URL', () => {
    // Leading `?` with no path is still parseable; the method must not throw.
    expect(() => parseKeepaliveConnectionId('?connectionId=foo')).not.toThrow();
    expect(parseKeepaliveConnectionId('?connectionId=foo')).toBe('foo');
  });

  test('never throws on garbage input', () => {
    expect(() => parseKeepaliveConnectionId('not a url at all')).not.toThrow();
    // '/collab' path with no query → no connectionId
    expect(parseKeepaliveConnectionId('/collab/keepalive')).toBeNull();
  });
});
