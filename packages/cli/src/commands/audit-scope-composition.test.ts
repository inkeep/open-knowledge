import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  ProblemDetailsSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { ConfigSchema, readServerLock } from '@inkeep/open-knowledge-server';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, test as baseTest, beforeAll, describe, expect, vi } from 'vitest';
import type { BootedServer } from '../../../server/src/boot.ts';
import { bootCompositionRig } from '../../../server/src/composition-rig.test-helper.ts';
import {
  auditScopeNotFoundTitle,
  resolveAuditScope,
} from '../../../server/src/lint/audit-scope.ts';
import { connectMcpTestClient } from '../../../server/src/mcp/client.test-helper.ts';
import { watchCliOwner } from './cli-owner.test-helper.ts';

const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = join(CLI_PACKAGE_ROOT, 'dist/cli.mjs');
const CLI_OWNER_PRELOAD = new URL('./cli-owner-preload.test-helper.mjs', import.meta.url).href;
const CLI_COMPLETION_RESERVE_MS = 1_000;
const CONFIG = 'contentRules:\n  markdownlint:\n    enabled: true\nvalidation:\n  links: warning\n';
const TABBED = '# Guide\n\nA\ttab.\n\nSee [[scope-cli-missing-target]].\n';
let root: string;
let headless: string;
let server: BootedServer;
let client: Awaited<ReturnType<typeof connectMcpTestClient>>;

function seed(directory: string, path: string, body: string): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), body);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliChild {
  stdout: Readable;
  stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

type Cli = (cwd: string, args: string[], child?: CliChild) => Promise<CliResult>;

const test = baseTest.extend<{ cli: Cli }>({
  cli: async ({ task }, use) => {
    const deadline = Date.now() + task.timeout - CLI_COMPLETION_RESERVE_MS;
    await withCli(deadline, use);
  },
});

async function withCli(deadline: number, use: (cli: Cli) => Promise<void>): Promise<void> {
  const active = new Set<CliChild>();
  try {
    await use((cwd, args, child = spawnCli(cwd, args)) => {
      active.add(child);
      child.on('close', () => active.delete(child));
      return runCli(deadline, cwd, args, child);
    });
  } finally {
    for (const child of active) child.kill('SIGKILL');
  }
}

function spawnCli(cwd: string, args: string[]) {
  return spawnCliProcess(CLI_ENTRY, ['--cwd', cwd, '--log-level', 'silent', ...args]);
}

function spawnCliProcess(entry: string, args: string[]) {
  return spawn(process.execPath, ['--import', CLI_OWNER_PRELOAD, entry, ...args], {
    cwd: CLI_PACKAGE_ROOT,
    env: { ...process.env, NO_COLOR: '1', OK_BUNDLE_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessByStdio<null, Readable, Readable>;
}

async function runCli(
  deadline: number,
  cwd: string,
  args: string[],
  child: CliChild,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const command = args.join(' ');
  const failure = (message: string, options?: ErrorOptions) =>
    new Error(`${message}\ncwd: ${cwd}\nstdout: ${stdout}\nstderr: ${stderr}`, options);
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(
      () => {
        reject(failure(`CLI child liveness bound expired: ${command}`));
        child.kill('SIGKILL');
      },
      Math.max(0, deadline - Date.now()),
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(failure(`CLI child ${command} errored: ${error.message}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === null) {
        reject(failure(`CLI child ${command} terminated by ${signal ?? 'unknown signal'}`));
        return;
      }
      resolveResult({ code, stdout, stderr });
    });
  });
}

function lintPlane(output: string): ValidationAuditResponse {
  const result = ValidationAuditResponseSchema.parse(JSON.parse(output));
  return { ...result, files: result.files.filter((file) => file.diagnostics.length > 0) };
}

async function http(name: string, path: string): Promise<ValidationAuditResponse> {
  const endpoint = name === 'lint' ? '/api/lint/audit' : '/api/audit';
  const response = await fetch(
    `http://127.0.0.1:${server.port}${endpoint}?path=${encodeURIComponent(path)}`,
  );
  expect(response.status).toBe(200);
  return ValidationAuditResponseSchema.parse(await response.json());
}

beforeAll(() => {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      'Build the CLI first: pnpm exec turbo run build --filter=@inkeep/open-knowledge',
    );
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-cli-scope-')));
  headless = realpathSync(mkdtempSync(join(tmpdir(), 'ok-headless-scope-')));
  for (const directory of [root, headless]) {
    seed(directory, '.ok/config.yml', CONFIG);
    seed(directory, 'guides/solo.md', TABBED);
    seed(directory, 'guides/dual.md', '# MD\n\n\tMD tab.\n');
    seed(directory, 'guides/dual.mdx', TABBED);
    seed(directory, 'guides/mdx-only.mdx', TABBED);
    seed(directory, 'guides/clean.md', '# Clean\n\nClean paragraph.\n');
    seed(directory, 'ignored/guide.md', TABBED);
    seed(directory, '.gitignore', 'ignored/\n');
    seed(directory, '.hidden.md', TABBED);
    seed(directory, 'parent', 'regular file');
    mkdirSync(join(directory, 'empty'));
    symlinkSync(join(directory, 'loop'), join(directory, 'loop'));
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (headless) rmSync(headless, { recursive: true, force: true });
});

class RecordingCliChild extends EventEmitter implements CliChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  closeOnSignal = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.closeOnSignal) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

describe('CLI child supervision', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('lets a progressing CLI child finish within its test budget', async ({ cli, task }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const child = new RecordingCliChild();
    const completion = cli(root, ['audit', 'empty', '--json'], child).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(task.timeout * 0.9);
      expect(child.signals).toEqual([]);
      child.emit('close', 0, null);
      expect(await completion).toEqual({ result: expect.objectContaining({ code: 0 }) });
    } finally {
      child.emit('close', 0, null);
      await completion;
      vi.useRealTimers();
    }
  });

  test('reports the active CLI step before the enclosing test expires', async ({ cli, task }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let enclosingExpired = false;
    setTimeout(() => {
      enclosingExpired = true;
    }, task.timeout);
    const first = new RecordingCliChild();
    const firstCompletion = cli(root, ['audit', 'empty', '--json'], first);
    await vi.advanceTimersByTimeAsync(task.timeout / 2);
    first.emit('close', 0, null);
    await firstCompletion;
    const child = new RecordingCliChild();
    child.closeOnSignal = false;
    let outcome: { result: CliResult } | { error: unknown } | undefined;
    const completion = cli(root, ['audit', 'ignored', '--json'], child).then(
      (result) => {
        outcome = { result };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    try {
      await vi.advanceTimersToNextTimerAsync();
      expect(enclosingExpired).toBe(false);
      expect(outcome).toEqual({
        error: expect.objectContaining({
          message: expect.stringMatching(/CLI child liveness.*audit ignored/),
        }),
      });
      expect(child.signals).toEqual(['SIGKILL']);
    } finally {
      child.emit('close', 0, null);
      await completion;
      vi.useRealTimers();
    }
  });

  test.for([true, false])('stops a CLI after owner loss from connected=%s', (connected) => {
    const owner = Object.assign(new EventEmitter(), { connected, channel: { unref() {} } });
    const stops: string[] = [];
    watchCliOwner(owner, () => stops.push('owner-lost'));
    if (connected) {
      expect(stops).toEqual([]);
      owner.connected = false;
      owner.emit('disconnect');
    }
    expect(stops).toEqual(['owner-lost']);
  });

  test('stops the CLI lifetime fixture after its owner exits', async ({ cli, task }) => {
    const fixture = fileURLToPath(new URL('./cli-owner-exit.test-helper.mjs', import.meta.url));
    const child = spawnCliProcess(fixture, [
      String(Date.now() + task.timeout - CLI_COMPLETION_RESERVE_MS),
    ]);
    const result = await cli(root, ['owner-exit'], child);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ code: 1 });
    expect(result.stderr).toContain('CLI child owner disconnected:');
  });

  test('cleans up a CLI child when its test scope ends', async ({ task }) => {
    const child = new RecordingCliChild();
    let completion: Promise<unknown> | undefined;
    try {
      await withCli(Date.now() + task.timeout, async (cli) => {
        completion = cli(root, ['audit', 'empty', '--json'], child).catch(() => undefined);
      });
      expect(child.signals).toEqual(['SIGKILL']);
    } finally {
      child.emit('close', 0, null);
      await completion;
    }
  });

  test('reports a CLI child terminated by a signal', async ({ cli }) => {
    const child = new RecordingCliChild();
    const completion = cli(root, ['audit', 'empty', '--json'], child);
    const observed = expect(completion).rejects.toThrow(/audit empty.*SIGABRT/);
    child.emit('close', null, 'SIGABRT');
    await observed;
  });

  test('reports a CLI child that fails to start', async ({ cli }) => {
    const child = new RecordingCliChild();
    const startFailure = new Error('spawn node ENOENT');
    const completion = cli(root, ['audit', 'empty', '--json'], child);
    const observed = expect(completion).rejects.toMatchObject({
      message: expect.stringMatching(/audit empty.*spawn node ENOENT/),
      cause: startFailure,
    });
    child.emit('error', startFailure);
    await observed;
  });
});

describe('CLI scope parity across real process, HTTP and MCP boundaries', () => {
  beforeAll(async () => {
    server = await bootCompositionRig(root, { config: ConfigSchema.parse({}) });
    seed(root, '.ok/config.yml', CONFIG);
    await server.ready;
    client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
    expect(readServerLock(server.lockDir)?.port).toBe(server.port);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await server?.destroy();
  });

  test('headless lint exits with a not-found problem when content.dir is missing', async ({
    cli,
  }) => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'ok-missing-lint-content-')));
    try {
      seed(project, '.ok/config.yml', 'content:\n  dir: missing-content\n');
      expect(existsSync(join(project, 'missing-content'))).toBe(false);
      expect(resolveAuditScope(undefined, join(project, 'missing-content')).ok).toBe(false);
      for (const args of [
        ['lint', '--json'],
        ['lint', '.', '--json'],
      ]) {
        const result = await cli(project, args);
        expect(existsSync(join(project, 'missing-content'))).toBe(false);
        expect(result.code, result.stderr).toBe(1);
        expect(ProblemDetailsSchema.parse(JSON.parse(result.stdout))).toMatchObject({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: expect.stringContaining('Set content.dir to an existing directory.'),
        });
      }
      mkdirSync(join(project, 'missing-content'));
      seed(project, 'outside.md', '# Outside\n');
      const existing = await cli(project, ['lint', '.', '--json']);
      expect(existing.code, existing.stderr).toBe(0);
      expect(JSON.parse(existing.stdout)).toMatchObject({
        fileCount: 0,
        files: [],
      });
      const outerFile = await cli(project, ['lint', 'outside.md', '--json']);
      expect(outerFile.code, outerFile.stderr).toBe(0);
      expect(JSON.parse(outerFile.stdout)).toMatchObject({
        fileCount: 1,
        files: [{ file: '../outside.md' }],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  test('audit exits with a not-found problem for a missing root through the HTTP boundary', async ({
    cli,
  }) => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'ok-missing-audit-content-')));
    const contentDir = join(project, 'missing-content');
    const seenPaths: string[] = [];
    const httpServer = createServer((req, res) => {
      seenPaths.push(req.url ?? '');
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(
        JSON.stringify({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: `Content directory ${JSON.stringify(contentDir)} was not found. Set content.dir to an existing directory.`,
          instance: 'urn:uuid:00000000-0000-4000-8000-000000000001',
        }),
      );
    });
    try {
      seed(project, '.ok/config.yml', 'content:\n  dir: missing-content\n');
      await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
      const address = httpServer.address();
      if (address === null || typeof address === 'string') throw new Error('Missing HTTP port');
      seed(
        project,
        '.ok/local/server.lock',
        JSON.stringify({ pid: process.pid, hostname: hostname(), port: address.port }),
      );
      for (const args of [
        ['audit', '--json'],
        ['audit', '.', '--json'],
      ]) {
        const result = await cli(project, args);
        expect(result.code, result.stderr).toBe(1);
        expect(ProblemDetailsSchema.parse(JSON.parse(result.stdout))).toMatchObject({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: expect.stringContaining('Set content.dir to an existing directory.'),
        });
      }
      expect(seenPaths).toEqual(['/api/audit', '/api/audit']);
    } finally {
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  test.for(['lint', 'audit'])(
    '%s explicit and extensionless paths select the same validation plane',
    { timeout: 120_000 },
    async (name, { cli }) => {
      await expect
        .poll(
          async () => {
            const result = await http('audit', 'guides/solo.md');
            return result.files
              .flatMap((file) => file.diagnostics)
              .some((diagnostic) => diagnostic.source === 'links');
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      for (const [short, full] of [
        ['solo', 'solo.md'],
        ['dual', 'dual.mdx'],
      ]) {
        const planes: ValidationAuditResponse[] = [];
        for (const path of [short, full]) {
          const result = await cli(join(root, 'guides'), [name, path, '--json']);
          expect(result.code, result.stderr).toBe(1);
          expect(result.stdout.trim(), result.stderr).not.toBe('');
          const plane = lintPlane(result.stdout);
          expect(plane.fileCount).toBe(1);
          expect(plane.files.map((file) => file.file)).toEqual([`guides/${full}`]);
          planes.push(plane);
          const remote = await http(name, `guides/${path}`);
          expect(plane).toEqual(remote);
          const mcp = CallToolResultSchema.parse(
            await client.callTool({ name, arguments: { path: `guides/${path}` } }),
          );
          expect(mcp.isError).toBeUndefined();
          expect(
            ValidationAuditResponseSchema.parse({ warnings: [], ...mcp.structuredContent }),
          ).toEqual(remote);
        }
        expect(planes[0]).toEqual(planes[1]);
      }
    },
  );

  test.for(['lint', 'audit'])(
    '%s preserves not-found problems and teaches the original path',
    { timeout: 120_000 },
    async (name, { cli }) => {
      for (const path of ['unknown', 'guides/mdx-only.md', 'parent/child']) {
        const result = await cli(root, [
          name,
          path,
          '--json',
          ...(name === 'lint' ? ['--fix'] : []),
        ]);
        expect(result.code, result.stderr).toBe(1);
        expect(ProblemDetailsSchema.parse(JSON.parse(result.stdout))).toMatchObject({
          type: 'urn:ok:error:not-found',
          title: auditScopeNotFoundTitle(path),
          status: 404,
        });
      }
      const text = await cli(root, [name, 'unknown']);
      expect(text.code, text.stderr).toBe(1);
      expect(text.stderr).toContain(auditScopeNotFoundTitle('unknown'));
      expect(readFileSync(join(root, 'guides/mdx-only.mdx'), 'utf8')).toBe(TABBED);
    },
  );

  test.for(['overlong segment', 'symlink loop'])(
    '%s produces a teaching ProblemDetails envelope from live and headless CLI processes',
    { timeout: 120_000 },
    async (kind, { cli }) => {
      const path = kind === 'overlong segment' ? 'x'.repeat(300) : 'loop';
      for (const [cwd, name] of [
        [root, 'lint'],
        [root, 'audit'],
        [headless, 'lint'],
      ]) {
        const result = await cli(cwd, [name, path, '--json']);
        expect(result.code, result.stderr).toBe(1);
        expect(result.stdout.trim(), result.stderr).not.toBe('');
        expect(ProblemDetailsSchema.parse(JSON.parse(result.stdout))).toMatchObject({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: auditScopeNotFoundTitle(path),
        });
        expect(result.stderr).not.toContain('    at ');
      }
    },
  );

  test.for(['lint', 'audit'])(
    '%s distinguishes ignored and empty scopes from nonempty clean checks',
    { timeout: 150_000 },
    async (name, { cli }) => {
      for (const path of ['empty', 'ignored']) {
        const result = await cli(root, [name, path, '--json']);
        expect(result.code, result.stderr).toBe(0);
        expect(lintPlane(result.stdout)).toMatchObject({
          files: [],
          fileCount: 0,
          errorCount: 0,
          warningCount: 0,
          warnings: [expect.stringContaining('No documents were checked')],
        });
      }
      const empty = await cli(root, [name, 'empty']);
      expect(empty.code, empty.stderr).toBe(0);
      expect(empty.stdout).toContain('No documents were checked.');
      expect(empty.stdout).not.toContain('No problems');
      const clean = await cli(root, [name, 'guides/clean']);
      expect(clean.code, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('No problems in 1 file');
    },
  );

  test.for(['lint', 'audit'])(
    '%s checks explicitly requested ignored files across CLI, HTTP and MCP',
    { timeout: 60_000 },
    async (name, { cli }) => {
      const path = 'ignored/guide.md';
      const result = await cli(root, [name, path, '--json']);
      expect(result.code, result.stderr).toBe(1);
      const plane = lintPlane(result.stdout);
      expect(plane.fileCount).toBe(1);
      expect(plane.files.map((file) => file.file)).toEqual([path]);
      expect(plane.files[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'MD010')).toBe(
        true,
      );
      expect(plane.warnings).toEqual([]);
      expect(plane).toEqual(await http(name, path));
      const mcp = CallToolResultSchema.parse(await client.callTool({ name, arguments: { path } }));
      expect(mcp.isError).toBeUndefined();
      expect(
        ValidationAuditResponseSchema.parse({ warnings: [], ...mcp.structuredContent }),
      ).toEqual(plane);
    },
  );

  test('headless lint retains hidden-file admission and resolves without a server', async ({
    cli,
  }) => {
    const hidden = await cli(headless, ['lint', '.hidden', '--json', '--errors-only']);
    expect(hidden.code, hidden.stderr).toBe(0);
    expect(lintPlane(hidden.stdout)).toMatchObject({
      fileCount: 1,
      files: [{ file: '.hidden.md' }],
    });
    const valid = await cli(join(headless, 'guides'), ['lint', 'solo', '--json', '--errors-only']);
    expect(valid.code, valid.stderr).toBe(0);
    expect(lintPlane(valid.stdout).fileCount).toBe(1);
    const missing = await cli(headless, ['lint', 'guides/mdx-only.md', '--fix', '--json']);
    expect(missing.code, missing.stderr).toBe(1);
    expect(ProblemDetailsSchema.parse(JSON.parse(missing.stdout)).title).toBe(
      auditScopeNotFoundTitle('guides/mdx-only.md'),
    );
    expect(readFileSync(join(headless, 'guides/mdx-only.mdx'), 'utf8')).toBe(TABBED);
  }, 90_000);
});
