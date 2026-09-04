import { describe as _bunDescribe, afterEach, beforeEach, expect, test, vi } from 'vitest';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

const describeEvenOnCI = _bunDescribe;

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { emitToleranceFire, OK_DIR, resolveServerRuntimeConfig } from '@inkeep/open-knowledge-core';
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
import { getLogger } from './logger.ts';
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
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    seedOkScaffold(contentDir);

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

    const warnSpy = vi.spyOn(getLogger('boot'), 'warn');
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
      });
      const bootWarnings = warnSpy.mock.calls
        .map((call) => String(call[1] ?? ''))
        .filter((w) => w.includes('.gitignore is missing'));
      expect(bootWarnings.length).toBe(1);
      expect(bootWarnings[0]).toContain('.ok/.gitignore');
      expect(bootWarnings[0]).toContain('ok init');
    } finally {
      warnSpy.mockRestore();
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

describe('bootServer — reactShellDistDir + server.lock ui advertisement', () => {
  test('server.lock advertises the ui capability when --react-shell-dist-dir is set', async () => {
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
      reactShellDistDir: shellDistDir,
    });
    try {
      await booted.ready;
      const serverLockPath = resolve(projectDir, '.ok', 'local', 'server.lock');
      const raw = await import('node:fs/promises').then((m) => m.readFile(serverLockPath, 'utf-8'));
      const parsed = JSON.parse(raw) as { port: number; pid: number; capabilities?: string[] };
      expect(parsed.capabilities).toContain('ui');
      expect(parsed.port).toBe(booted.port);
      expect(parsed.pid).toBe(process.pid);
      expect(existsSync(resolve(projectDir, '.ok', 'local', 'ui.lock'))).toBe(false);
    } finally {
      await booted.destroy();
    }
  });

  test('server.lock omits the ui capability when reactShellDistDir is absent (CLI default)', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'fake-repo-no-shell-'));
    await execFileAsync('git', ['init', '--initial-branch=main', projectDir]);
    seedOkScaffold(projectDir);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    try {
      await booted.ready;
      const serverLockPath = resolve(projectDir, '.ok', 'local', 'server.lock');
      const raw = await import('node:fs/promises').then((m) => m.readFile(serverLockPath, 'utf-8'));
      const parsed = JSON.parse(raw) as { capabilities?: string[] };
      expect(parsed.capabilities ?? []).not.toContain('ui');
    } finally {
      await booted.destroy();
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

      const serverLockPath = resolve(projectDir, '.ok', 'local', 'server.lock');
      expect(existsSync(serverLockPath)).toBe(true);
      const lockRaw = await import('node:fs/promises').then((m) =>
        m.readFile(serverLockPath, 'utf-8'),
      );
      const parsed = JSON.parse(lockRaw) as { port: number; capabilities?: string[] };
      expect(parsed.port).toBe(booted.port);
      expect(parsed.capabilities).toContain('ui');
    } finally {
      await booted.destroy();
    }
  });
});

describeEvenOnCI('bootServer — MCP internal RPC stays loopback under a public externalUrl', () => {
  const MCP_PROTOCOL_VERSION = '2025-06-18';
  const UNREACHABLE_EXTERNAL_URL = 'https://prd-8062-unreachable.invalid';

  async function mcpFetch(port: number, headers: Record<string, string>, body: unknown) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  test('MCP write succeeds when externalUrl is a public, non-loopback origin', async () => {
    const projectDir = mkdtempSync(resolve(tmpDir, 'mcp-loopback-'));
    seedOkScaffold(projectDir);

    const config = ConfigSchema.parse({
      server: { externalUrl: UNREACHABLE_EXTERNAL_URL, allowExternal: true },
    });
    expect(resolveServerRuntimeConfig(config).externalUrl).toBe(UNREACHABLE_EXTERNAL_URL);

    const booted = await bootServer({
      host: '127.0.0.1',
      config,
      projectDir,
      contentDir: projectDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    try {
      await booted.ready;
      const port = booted.port;

      const init = await mcpFetch(
        port,
        {},
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'prd-8062-test', version: '0.0.0' },
          },
        },
      );
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const sessionHeaders = {
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      };

      const initialized = await mcpFetch(port, sessionHeaders, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      expect(initialized.status).toBe(202);

      const write = await mcpFetch(port, sessionHeaders, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'write',
          arguments: {
            document: { path: 'prd-8062-note', content: '# PRD-8062\n\nLoopback write.\n' },
            cwd: projectDir,
          },
        },
      });
      expect(write.status).toBe(200);
      const body = (await write.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
        error?: unknown;
      };
      expect(body.error).toBeUndefined();
      const text = body.result?.content?.map((c) => c.text ?? '').join('') ?? '';
      expect(body.result?.isError ?? false, `write returned an error: ${text}`).toBe(false);
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
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const spans = exporter?.getFinishedSpans() ?? [];
    const bootSpan = spans.find((s) => s.name === 'ok.boot');
    expect(bootSpan).toBeDefined();
    expect(bootSpan?.attributes['ok.worktree.kind']).toBe('main');
    expect(bootSpan?.status.code).toBe(2);
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

  test('OK_STARTUP_TRACEPARENT (valid): ok.boot joins the desktop-main launch trace', async () => {
    const parentTraceId = '0af7651916cd43dd8448eb211c80319c';
    const prev = process.env.OK_STARTUP_TRACEPARENT;
    process.env.OK_STARTUP_TRACEPARENT = `00-${parentTraceId}-b7ad6b7169203331-01`;
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
    });
    try {
      await booted.ready;
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

describeEvenOnCI('bootServer — exposure consent interlock', () => {
  async function tryBoot(
    server: Record<string, unknown>,
    passServerRuntime = false,
  ): Promise<unknown> {
    const contentDir = mkdtempSync(resolve(tmpDir, 'interlock-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    const config = ConfigSchema.parse({ server });
    try {
      const booted = await bootServer({
        host: '127.0.0.1',
        config,
        ...(passServerRuntime ? { serverRuntime: resolveServerRuntimeConfig(config) } : {}),
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
      });
      await booted.destroy();
    } catch (err) {
      return err;
    }
    return null;
  }

  test('non-loopback bind without consent refuses to boot with the one-line fix', async () => {
    const err = await tryBoot({ bind: ['127.0.0.1', '100.64.0.7'] });
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.constructor.name).toBe('ExposureConsentError');
    expect(e.message).toContain('would bind a non-loopback address');
    expect(e.message).toContain('OK_ALLOW_EXTERNAL=1');
    expect(e.message).toContain('.ok/local/config.yml');
  });

  test('a committed externalUrl under a loopback bind is inert — boots, no lockout (CLI path)', async () => {
    const err = await tryBoot({ externalUrl: 'https://notes.example.com' }, true);
    expect((err as Error | null)?.constructor.name).not.toBe('ExposureConsentError');
  });

  test('a committed externalUrl under a loopback bind is inert — boots on the desktop / embedder path too', async () => {
    const err = await tryBoot({ externalUrl: 'https://notes.example.com' });
    expect((err as Error | null)?.constructor.name).not.toBe('ExposureConsentError');
  });

  test('a loopback-only server with no externalUrl never trips the interlock', async () => {
    const err = await tryBoot({});
    expect((err as Error | null)?.constructor.name).not.toBe('ExposureConsentError');
  });

  test('an externalUrl + consent on a loopback bind boots outright', async () => {
    const err = await tryBoot(
      { externalUrl: 'https://myproject.ngrok.app', allowExternal: true },
      true,
    );
    expect(err).toBeNull();
  });

  test('an explicit (scope-correct) serverRuntime with consent admits a non-loopback bind', async () => {
    const err = await tryBoot({ bind: ['127.0.0.1', '100.64.0.7'], allowExternal: true }, true);
    expect((err as Error | null)?.constructor.name).not.toBe('ExposureConsentError');
  });

  test('config-derived allowExternal does NOT satisfy the interlock (desktop / embedder path)', async () => {
    const err = await tryBoot({ bind: ['0.0.0.0'], allowExternal: true });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toBe('ExposureConsentError');
  });

  test('a non-loopback host with no bind/serverRuntime still trips the interlock (single-file shape)', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'interlock-host-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    let err: unknown = null;
    try {
      const booted = await bootServer({
        host: '0.0.0.0',
        config: ConfigSchema.parse({}),
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
      });
      await booted.destroy();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toBe('ExposureConsentError');
    expect((err as Error).message).toContain('0.0.0.0');
  });
});

describeEvenOnCI('bootServer — multi-address bind', () => {
  test('every bind address answers on the same port; teardown closes all listeners', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'multibind-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    const booted = await bootServer({
      host: '127.0.0.1',
      bind: ['127.0.0.1', '::1'],
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    try {
      expect(booted.port).toBeGreaterThan(0);
      const v4 = await fetch(`http://127.0.0.1:${booted.port}/healthz`);
      expect(v4.status).toBe(200);
      const v6 = await fetch(`http://[::1]:${booted.port}/healthz`);
      expect(v6.status).toBe(200);
    } finally {
      await booted.destroy();
    }
    await expect(fetch(`http://[::1]:${booted.port}/healthz`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${booted.port}/healthz`)).rejects.toThrow();
  });

  test('the listen record names the bound port, pid and every address, and agrees with the lock', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'listenlog-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    const entries: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const noop = (): void => {};
    const captureLogger = {
      info: (fields: Record<string, unknown>, msg: string) => entries.push({ fields, msg }),
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      fatal: noop,
      level: 'info',
      silent: noop,
      bindings: () => ({}),
      child: () => captureLogger,
    };
    const booted = await bootServer({
      host: '127.0.0.1',
      bind: ['127.0.0.1', '::1'],
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      log: captureLogger as never,
    });
    try {
      const listened = entries.filter((e) => e.fields.event === 'server-listening');
      expect(listened).toHaveLength(1);
      const fields = listened[0]?.fields ?? {};
      expect(fields.port).toBe(booted.port);
      expect(fields.pid).toBe(process.pid);
      expect(fields.addresses).toEqual(['127.0.0.1', '::1']);
      expect(typeof fields.url).toBe('string');
      expect(String(fields.url)).toContain(String(booted.port));

      const lock = JSON.parse(
        readFileSync(resolve(contentDir, OK_DIR, 'local', 'server.lock'), 'utf-8'),
      ) as { port: number };
      expect(fields.port).toBe(lock.port);
    } finally {
      await booted.destroy();
    }
  });

  test('duplicate bind entries collapse instead of failing with EADDRINUSE', async () => {
    const contentDir = mkdtempSync(resolve(tmpDir, 'multibind-dup-'));
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    const booted = await bootServer({
      host: '127.0.0.1',
      bind: ['127.0.0.1', '127.0.0.1'],
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${booted.port}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await booted.destroy();
    }
  });
});
