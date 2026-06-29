import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'bun:test';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { emitToleranceFire, OK_DIR } from '@inkeep/open-knowledge-core';
import { context, metrics, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { parseKeepaliveConnectionId } from './mcp-mount.ts';
import { shutdownTelemetry } from './telemetry.ts';

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
    expect(existsSync(resolve(contentDir, '.git/ok'))).toBe(false);
  });

  test('rejects with kind=config when .ok/ exists but config.yml is missing (State B)', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'state-b-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    const okDir = resolve(contentDir, '.ok');
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
    const projectDir = mkdtempSync(resolve(tmpDir, 'projectdir-preflight-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);
    const contentDir = resolve(projectDir, 'docs');
    mkdirSync(contentDir, { recursive: true });
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
      await booted.ready;

      const contentLocalDir = resolve(contentDir, '.ok');
      expect(existsSync(contentLocalDir)).toBe(false);

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
      emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'smoke-doc');
    } finally {
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

      const deadline = Date.now() + 3_000;
      while (booted.httpServer.listening && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(booted.httpServer.listening).toBe(false);
    } finally {
      await booted.destroy();
    }
  });
});

describe('bootServer — reactShellDistDir + ui.lock advertisement', () => {
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
      const stillRaw = await import('node:fs/promises').then((m) =>
        m.readFile(resolve(lockDir, 'ui.lock'), 'utf-8'),
      );
      const still = JSON.parse(stillRaw) as typeof peerSnapshot;
      expect(still.port).toBe(65432);
      expect(still.runtimeVersion).toBe('0.0.0-test-peer');
    } finally {
      await booted.destroy();
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
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.port).toBe(booted.port);
    } finally {
      await booted.destroy();
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
  test('serves the React shell, bundled assets, content assets, and API on one port', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'shell-e2e-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

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
    const fontBytes = Buffer.from('woff2-bundle-bytes', 'utf-8');
    writeFileSync(resolve(shellDistDir, 'assets', 'inter-cafebabe.woff2'), fontBytes);

    mkdirSync(resolve(projectDir, 'docs'), { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(resolve(projectDir, 'docs', 'image.png'), pngBytes);

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

      const rootRes = await fetch(`${base}/`);
      expect(rootRes.status).toBe(200);
      const rootBody = await rootRes.text();
      expect(rootBody).toContain('data-test="shell"');

      const deepRes = await fetch(`${base}/some/unknown/route`);
      expect(deepRes.status).toBe(200);
      expect(await deepRes.text()).toContain('data-test="shell"');

      const bundleRes = await fetch(`${base}/assets/app-deadbeef.js`);
      expect(bundleRes.status).toBe(200);
      expect(await bundleRes.text()).toContain('console.log');

      const fontRes = await fetch(`${base}/assets/inter-cafebabe.woff2`);
      expect(fontRes.status).toBe(200);
      expect(Buffer.from(await fontRes.arrayBuffer()).equals(fontBytes)).toBe(true);

      const uploadRes = await fetch(`${base}/assets/upload.png`);
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.headers.get('content-disposition')).toBe('inline');
      expect(Buffer.from(await uploadRes.arrayBuffer()).equals(uploadBytes)).toBe(true);

      const imageRes = await fetch(`${base}/docs/image.png`);
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get('content-disposition')).toBe('inline');
      const imageGot = Buffer.from(await imageRes.arrayBuffer());
      expect(imageGot.equals(pngBytes)).toBe(true);

      const apiRes = await fetch(`${base}/api/nonexistent-endpoint`);
      expect(apiRes.status).toBe(404);
      expect(apiRes.headers.get('content-type')).toBe('application/problem+json');

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
      expect(typeof bootSpan?.attributes['ok.worktree.gitdir']).toBe('string');
      const gitdirAttr = bootSpan?.attributes['ok.worktree.gitdir'] as string;
      expect(gitdirAttr.split('/').filter(Boolean).length).toBeLessThanOrEqual(3);
    } finally {
      await booted.destroy();
    }
  });

  test('linked worktree: ok.boot span has worktree.kind=linked', async () => {
    const repoRoot = mkdtempSync(resolve(tmpDir, 'span-linked-repo-'));
    await execFileAsync('git', ['init', '--initial-branch=main', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(repoRoot, 'README.md'), '# test\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', '.']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'init']);

    const wtPath = mkdtempSync(resolve(tmpDir, 'span-linked-wt-'));
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
    expect(bootSpan?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  test('cross-invocation: main first, linked second — kinds flip correctly with no state leakage', async () => {
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

    const spans = exporter?.getFinishedSpans() ?? [];
    const bootSpans = spans.filter((s) => s.name === 'ok.boot');
    expect(bootSpans.length).toBe(2);
    expect(bootSpans[0]?.attributes['ok.worktree.kind']).toBe('main');
    expect(bootSpans[1]?.attributes['ok.worktree.kind']).toBe('linked');
    expect(bootSpans[0]?.attributes['ok.worktree.gitdir']).not.toBe(
      bootSpans[1]?.attributes['ok.worktree.gitdir'],
    );
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
    expect(
      parseKeepaliveConnectionId('/collab/keepalive?connectionId=user%2Fagent%3D1%262'),
    ).toBeNull();
  });

  test('rejects connectionId containing CR/LF (log-injection defense)', () => {
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
    expect(() => parseKeepaliveConnectionId('?connectionId=foo')).not.toThrow();
    expect(parseKeepaliveConnectionId('?connectionId=foo')).toBe('foo');
  });

  test('never throws on garbage input', () => {
    expect(() => parseKeepaliveConnectionId('not a url at all')).not.toThrow();
    expect(parseKeepaliveConnectionId('/collab/keepalive')).toBeNull();
  });
});
