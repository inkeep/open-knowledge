import { spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import {
  ProblemDetailsSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { ConfigSchema, readServerLock } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from '../../../server/src/boot.ts';
import { bootCompositionRig } from '../../../server/src/composition-rig.test-helper.ts';
import {
  auditScopeNotFoundTitle,
  resolveAuditScope,
} from '../../../server/src/lint/audit-scope.ts';
import { connectMcpTestClient } from '../../../server/src/mcp/client.test-helper.ts';

const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = join(CLI_PACKAGE_ROOT, 'src/cli.ts');
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
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, args: string[]): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--conditions=development',
      CLI_ENTRY,
      '--cwd',
      cwd,
      '--log-level',
      'silent',
      ...args,
    ],
    {
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1', OK_BUNDLE_PROXY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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

beforeAll(async () => {
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
  server = await bootCompositionRig(root, { config: ConfigSchema.parse({}) });
  seed(root, '.ok/config.yml', CONFIG);
  await server.ready;
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
  expect(readServerLock(server.lockDir)?.port).toBe(server.port);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  if (root) rmSync(root, { recursive: true, force: true });
  if (headless) rmSync(headless, { recursive: true, force: true });
});

describe('CLI scope parity across real process, HTTP and MCP boundaries', () => {
  test('headless lint exits with a not-found problem when content.dir is missing', async () => {
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

  test('audit exits with a not-found problem for a missing root through the HTTP boundary', async () => {
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

  test.each(['lint', 'audit'])(
    '%s explicit and extensionless paths select the same validation plane',
    async (name) => {
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
          const mcp = await client.callTool({ name, arguments: { path: `guides/${path}` } });
          expect(mcp.isError).toBeUndefined();
          expect(
            ValidationAuditResponseSchema.parse({ warnings: [], ...mcp.structuredContent }),
          ).toEqual(remote);
        }
        expect(planes[0]).toEqual(planes[1]);
      }
    },
    120_000,
  );

  test.each(['lint', 'audit'])(
    '%s preserves not-found problems and teaches the original path',
    async (name) => {
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
      expect(text.code).toBe(1);
      expect(text.stderr).toContain(auditScopeNotFoundTitle('unknown'));
      expect(readFileSync(join(root, 'guides/mdx-only.mdx'), 'utf8')).toBe(TABBED);
    },
    120_000,
  );

  test.each(['overlong segment', 'symlink loop'])(
    '%s produces a teaching ProblemDetails envelope from live and headless CLI processes',
    async (kind) => {
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
    120_000,
  );

  test.each(['lint', 'audit'])(
    '%s distinguishes ignored and empty scopes from nonempty clean checks',
    async (name) => {
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
    150_000,
  );

  test.each(['lint', 'audit'])(
    '%s checks explicitly requested ignored files across CLI, HTTP and MCP',
    async (name) => {
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
      const mcp = await client.callTool({ name, arguments: { path } });
      expect(mcp.isError).toBeUndefined();
      expect(
        ValidationAuditResponseSchema.parse({ warnings: [], ...mcp.structuredContent }),
      ).toEqual(plane);
    },
    60_000,
  );

  test('headless lint retains hidden-file admission and resolves without a server', async () => {
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
