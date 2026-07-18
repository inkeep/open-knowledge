import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
import {
  AUDIT_FILE_CAP,
  AUDIT_FILE_DIAGNOSTIC_CAP,
  DESCRIPTION,
  type LintDeps,
  register,
} from './lint.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

// Skip-on-CI gate (oven-sh/bun#11892): same git-child-reaping issue the sibling
// MCP tool tests guard against on ubuntu-latest GHA runners.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface LintHandlerArgs {
  document?: string;
  path?: string;
  fix?: boolean;
}

interface RegisteredTool {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  handler: (args: LintHandlerArgs) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      cfg: { description?: string; annotations?: Record<string, unknown> },
      handler: (args: LintHandlerArgs) => Promise<ToolResult>,
    ) {
      registered = {
        name,
        description: cfg.description ?? '',
        annotations: cfg.annotations,
        handler,
      };
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(): RegisteredTool {
      if (!registered) throw new Error('Tool was not registered');
      return registered;
    },
  };
}

function makeDeps(serverUrl: string | undefined, cwdDir: string): LintDeps {
  return { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwdDir };
}

let testServer: FetchTestServer;
let baseUrl: string;
let tmpDir: string;
const seenRequests: string[] = [];

function warningDiagnostic(line: number) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
  };
}

function auditPayloadOf(fileCount: number, diagnosticsPerFile: number) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: `doc-${String(i).padStart(2, '0')}.md`,
    diagnostics: Array.from({ length: diagnosticsPerFile }, (_, line) => warningDiagnostic(line)),
  }));
  return {
    ok: true,
    files,
    fileCount,
    errorCount: 0,
    warningCount: fileCount * diagnosticsPerFile,
    warnings: [],
  };
}

beforeAll(async () => {
  testServer = await startFetchTestServer({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      seenRequests.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname === '/api/lint/fix') {
        // The server's attributed auto-fix. Two fixed, one non-fixable remains.
        return Response.json({
          ok: true,
          file: 'notes.md',
          fixedCount: 2,
          diagnostics: [
            {
              range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } },
              severity: 'warning',
              source: 'markdownlint',
              code: 'MD041',
              message: 'First line in file should be a top-level heading',
            },
          ],
          errorCount: 0,
          warningCount: 1,
        });
      }
      if (url.pathname === '/api/lint') {
        const doc = url.searchParams.get('doc');
        if (doc === 'clean') return Response.json({ ok: true, file: 'clean.md', diagnostics: [] });
        if (doc === 'fixable') {
          return Response.json({
            ok: true,
            file: 'fixable.md',
            diagnostics: [
              {
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
                severity: 'warning',
                source: 'markdownlint',
                code: 'MD010',
                message: 'Hard tabs',
                fixes: [
                  {
                    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
                    newText: '  ',
                  },
                ],
              },
            ],
          });
        }
        return Response.json({
          ok: true,
          file: `${doc}.md`,
          diagnostics: [
            {
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
              severity: 'warning',
              source: 'markdownlint',
              code: 'MD010',
              message: 'Hard tabs',
            },
          ],
        });
      }
      if (url.pathname === '/api/lint/audit') {
        const path = url.searchParams.get('path');
        if (path === 'over-cap') {
          return Response.json(auditPayloadOf(AUDIT_FILE_CAP + 2, AUDIT_FILE_DIAGNOSTIC_CAP + 3));
        }
        if (path === 'at-cap') {
          return Response.json(auditPayloadOf(AUDIT_FILE_CAP, AUDIT_FILE_DIAGNOSTIC_CAP));
        }
        return Response.json({
          ok: true,
          files: [
            {
              file: 'dirty.md',
              diagnostics: [
                {
                  range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
                  severity: 'warning',
                  source: 'markdownlint',
                  code: 'MD010',
                  message: 'Hard tabs',
                },
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  severity: 'error',
                  source: 'frontmatter',
                  code: 'required',
                  message: 'Missing required property: title',
                },
              ],
            },
          ],
          fileCount: 4,
          errorCount: 1,
          warningCount: 1,
          warnings: [],
        });
      }
      return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer.stop();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-lint-test-'));
  seenRequests.length = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('lint — registration + DESCRIPTION', () => {
  test('registers exactly one tool named "lint"', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().name).toBe('lint');
  });

  test('declares mutating (fix-capable) tool annotations', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    // Not read-only: `fix: true` mutates the doc (recoverable content write).
    expect(getTool().annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  test('DESCRIPTION documents both shapes and the fix mode', () => {
    expect(DESCRIPTION).toContain('`document`');
    expect(DESCRIPTION).toContain('audit');
    expect(DESCRIPTION).toContain('severity');
    expect(DESCRIPTION).toContain('`fix: true`');
  });

  test('returns Hocuspocus-unavailable error when no serverUrl is configured', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined, tmpDir));
    const result = await getTool().handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('lint — single document', () => {
  test('hits /api/lint with a normalized docName and returns its diagnostics', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'notes.md' });
    expect(seenRequests).toContain('/api/lint?doc=notes');
    const s = result.structuredContent as {
      files: Array<{ file: string; diagnostics: unknown[] }>;
      errorCount: number;
      warningCount: number;
    };
    expect(s.files).toHaveLength(1);
    expect(s.files[0]?.diagnostics).toHaveLength(1);
    expect(s.errorCount).toBe(0);
    expect(s.warningCount).toBe(1);
    expect(result.content[0]?.text).toContain('markdownlint/MD010');
    expect(result.content[0]?.text).toContain('line 3');
  });

  test('a clean doc reports no problems', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'clean' });
    const s = result.structuredContent as { warningCount: number; errorCount: number };
    expect(s.warningCount).toBe(0);
    expect(s.errorCount).toBe(0);
    expect(result.content[0]?.text).toContain('No problems');
  });
});

describe('lint — project audit', () => {
  test('omitting document hits /api/lint/audit and summarizes counts', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({});
    expect(seenRequests.some((r) => r.startsWith('/api/lint/audit'))).toBe(true);
    const s = result.structuredContent as {
      files: unknown[];
      fileCount: number;
      errorCount: number;
      warningCount: number;
    };
    expect(s.files).toHaveLength(1);
    expect(s.fileCount).toBe(4);
    expect(s.errorCount).toBe(1);
    expect(s.warningCount).toBe(1);
    expect(result.content[0]?.text).toContain('dirty.md');
    expect(result.content[0]?.text).toContain('1 error');
  });

  test('passes a sub-path scope through to the audit endpoint', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    await getTool().handler({ path: 'sub/dir' });
    expect(seenRequests).toContain('/api/lint/audit?path=sub%2Fdir');
  });
});

describe('lint — audit output cap', () => {
  interface AuditStructured {
    files: Array<{
      file: string;
      diagnostics: unknown[];
      omittedDiagnosticCount?: number;
    }>;
    fileCount: number;
    errorCount: number;
    warningCount: number;
    omittedFileCount?: number;
  }

  test('over-cap audits truncate both channels but keep totals accurate', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'over-cap' });

    const s = result.structuredContent as unknown as AuditStructured;
    expect(s.files).toHaveLength(AUDIT_FILE_CAP);
    expect(s.omittedFileCount).toBe(2);
    for (const file of s.files) {
      expect(file.diagnostics).toHaveLength(AUDIT_FILE_DIAGNOSTIC_CAP);
      expect(file.omittedDiagnosticCount).toBe(3);
    }
    // Totals mirror the server's full-scan counts, not the truncated view.
    expect(s.fileCount).toBe(AUDIT_FILE_CAP + 2);
    expect(s.warningCount).toBe((AUDIT_FILE_CAP + 2) * (AUDIT_FILE_DIAGNOSTIC_CAP + 3));

    const text = result.content[0]?.text ?? '';
    expect(text).toContain(`${AUDIT_FILE_CAP + 2} of ${AUDIT_FILE_CAP + 2} documents`);
    expect(text).toContain('… and 3 more problems');
    expect(text).toContain('… and 2 more files with problems');
    const shownFileHeaders = text.match(/^doc-\d+\.md:$/gm) ?? [];
    expect(shownFileHeaders).toHaveLength(AUDIT_FILE_CAP);
  });

  test('an audit exactly at the cap is complete, with no truncation indicators', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'at-cap' });

    const s = result.structuredContent as unknown as AuditStructured;
    expect(s.files).toHaveLength(AUDIT_FILE_CAP);
    expect(s.omittedFileCount).toBeUndefined();
    for (const file of s.files) {
      expect(file.diagnostics).toHaveLength(AUDIT_FILE_DIAGNOSTIC_CAP);
      expect(file.omittedDiagnosticCount).toBeUndefined();
    }

    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('… and');
  });
});

describe('lint — fix mode', () => {
  test('fix:true POSTs /api/lint/fix and reports fixed + remaining', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'notes.md', fix: true });
    expect(seenRequests.some((r) => r.startsWith('/api/lint/fix'))).toBe(true);
    const s = result.structuredContent as {
      fixedCount: number;
      files: Array<{ diagnostics: unknown[] }>;
      warningCount: number;
    };
    expect(s.fixedCount).toBe(2);
    expect(s.files[0]?.diagnostics).toHaveLength(1);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Fixed 2 problems in notes.md');
    expect(text).toContain('1 problem remain');
    expect(text).toContain('`edit`/`write`');
  });

  test('fix:true without a document is an error and hits no endpoint', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ fix: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('requires `document`');
    expect(seenRequests.some((r) => r.startsWith('/api/lint/fix'))).toBe(false);
  });
});

describe('lint — fixability hint', () => {
  test('a single-doc report quantifies how many violations `fix: true` would resolve', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'fixable' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('auto-fixable');
    expect(text).toContain('`fix: true`');
  });
});
