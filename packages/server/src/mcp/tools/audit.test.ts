import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import type { AuditDeps } from './audit.ts';
import { AUDIT_WARNING_CAP, DESCRIPTION, register } from './audit.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
import type { ServerInstance } from './shared.ts';
import {
  AUDIT_FILE_CAP,
  AUDIT_FILE_DIAGNOSTIC_CAP,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
} from './shared.ts';

// Skip-on-CI gate (oven-sh/bun#11892): same git-child-reaping issue the sibling
// MCP tool tests guard against on ubuntu-latest GHA runners.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface AuditHandlerArgs {
  path?: string;
}

interface RegisteredTool {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  handler: (args: AuditHandlerArgs) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      cfg: { description?: string; annotations?: Record<string, unknown> },
      handler: (args: AuditHandlerArgs) => Promise<ToolResult>,
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

function makeDeps(serverUrl: string | undefined, cwdDir: string): AuditDeps {
  return { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwdDir };
}

let testServer: FetchTestServer;
let baseUrl: string;
let tmpDir: string;
const seenRequests: string[] = [];

// Stub diagnostics mirror the real `/api/audit` plane (pinned by the
// audit-http integration test): the lint validator emits markdownlint
// warnings; the links validator emits `links/dead-link` errors whose message
// names the unresolved target.
function lintWarning(line: number) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
  };
}

function deadLinkError(line: number, target: string) {
  return {
    range: { start: { line, character: 4 }, end: { line, character: 4 } },
    severity: 'error',
    source: 'links',
    code: 'dead-link',
    message: `Link target "${target}" does not resolve to an existing document.`,
  };
}

// A local-target (image) finding as the links validator emits it: the graph
// triple plus additive `localTarget` evidence and an image-specific message.
function deadImageWarning(line: number, href: string, resolved: string) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 0 } },
    severity: 'warning',
    source: 'links',
    code: 'dead-link',
    message: `Image target "${href}" does not resolve to an existing file.`,
    localTarget: {
      href,
      targetKind: 'file',
      role: 'image',
      sourceForm: 'markdown-inline',
      resolvedTarget: resolved,
      reason: 'no-such-file',
      resolutionMethod: 'source-relative',
    },
  };
}

function auditPayloadOf(fileCount: number, diagnosticsPerFile: number) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: `doc-${String(i).padStart(2, '0')}.md`,
    diagnostics: Array.from({ length: diagnosticsPerFile }, (_, line) =>
      line % 2 === 0 ? lintWarning(line) : deadLinkError(line, 'ghost'),
    ),
  }));
  const all = files.flatMap((f) => f.diagnostics);
  const errorCount = all.filter((d) => d.severity === 'error').length;
  return {
    ok: true,
    files,
    fileCount,
    errorCount,
    warningCount: all.length - errorCount,
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
      if (url.pathname === '/api/audit') {
        const path = url.searchParams.get('path');
        if (path === 'clean') {
          return Response.json({
            ok: true,
            files: [],
            fileCount: 4,
            errorCount: 0,
            warningCount: 0,
            warnings: [],
          });
        }
        if (path === 'over-cap') {
          return Response.json(auditPayloadOf(AUDIT_FILE_CAP + 2, AUDIT_FILE_DIAGNOSTIC_CAP + 3));
        }
        if (path === 'degraded') {
          // A validator degraded (e.g. no backlink index): no problems found,
          // but the run is incomplete — a warning, no files.
          return Response.json({
            ok: true,
            files: [],
            fileCount: 3,
            errorCount: 0,
            warningCount: 0,
            warnings: ['links validation unavailable: backlink index is not configured'],
          });
        }
        if (path === 'local-targets') {
          return Response.json({
            ok: true,
            files: [
              {
                file: 'notes/pics.md',
                diagnostics: [deadImageWarning(3, './logo.png', 'assets/logo.png')],
              },
            ],
            fileCount: 1,
            errorCount: 0,
            warningCount: 1,
            warnings: [],
          });
        }
        if (path === 'problems-and-warnings') {
          return Response.json({
            ok: true,
            files: [{ file: 'notes/ideas.md', diagnostics: [deadLinkError(9, 'ghost')] }],
            fileCount: 3,
            errorCount: 1,
            warningCount: 0,
            warnings: ['could not read drafts: EACCES'],
          });
        }
        if (path === 'many-warnings') {
          return Response.json({
            ok: true,
            files: [],
            fileCount: 20,
            errorCount: 0,
            warningCount: 0,
            warnings: Array.from(
              { length: AUDIT_WARNING_CAP + 5 },
              (_, i) => `could not read dir-${i}: EACCES`,
            ),
          });
        }
        return Response.json({
          ok: true,
          files: [
            { file: 'guides/tabs.md', diagnostics: [lintWarning(2)] },
            { file: 'notes/ideas.md', diagnostics: [deadLinkError(9, 'ghost')] },
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
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-audit-test-'));
  seenRequests.length = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('audit — registration + DESCRIPTION', () => {
  test('registers exactly one tool named "audit"', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().name).toBe('audit');
  });

  test('declares read-only tool annotations', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  test('DESCRIPTION routes link-validation intent here and away from the navigation reader', () => {
    expect(DESCRIPTION).toContain('markdownlint');
    expect(DESCRIPTION).toContain('broken');
    expect(DESCRIPTION).toContain('`links`');
    expect(DESCRIPTION).toContain('navigation');
    expect(DESCRIPTION).toContain('`path`');
  });

  test('returns Hocuspocus-unavailable error when no serverUrl is configured', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined, tmpDir));
    const result = await getTool().handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('audit — unified project audit', () => {
  test('no args hits /api/audit and returns both validator sources tagged', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({});
    expect(seenRequests).toContain('/api/audit?');
    const s = result.structuredContent as {
      files: Array<{ file: string; diagnostics: Array<{ source: string; severity: string }> }>;
      fileCount: number;
      errorCount: number;
      warningCount: number;
    };
    expect(s.files).toHaveLength(2);
    expect(s.files.map((f) => f.file)).toEqual(['guides/tabs.md', 'notes/ideas.md']);
    expect(s.files[0]?.diagnostics[0]?.source).toBe('markdownlint');
    expect(s.files[1]?.diagnostics[0]?.source).toBe('links');
    expect(s.files[1]?.diagnostics[0]?.severity).toBe('error');
    expect(s.fileCount).toBe(4);
    expect(s.errorCount).toBe(1);
    expect(s.warningCount).toBe(1);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('1 error');
    expect(text).toContain('1 warning');
    expect(text).toContain('markdownlint/MD010');
    expect(text).toContain('links/dead-link');
    // Text output displays 1-based lines from the 0-based wire range.
    expect(text).toContain('line 10');
    expect(text).toContain('"ghost"');
  });

  test('preserves local-target evidence in structured output; text message stays intelligible', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'local-targets' });
    const s = result.structuredContent as {
      files: Array<{ diagnostics: Array<{ localTarget?: Record<string, unknown> }> }>;
    };
    // The additive evidence survives the MCP structured channel verbatim.
    expect(s.files[0]?.diagnostics[0]?.localTarget).toEqual({
      href: './logo.png',
      targetKind: 'file',
      role: 'image',
      sourceForm: 'markdown-inline',
      resolvedTarget: 'assets/logo.png',
      reason: 'no-such-file',
      resolutionMethod: 'source-relative',
    });
    // The human-facing text distinguishes an image-file break from a doc link
    // without relying on the structured evidence.
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Image target "./logo.png" does not resolve to an existing file');
    expect(text).toContain('links/dead-link');
  });

  test('passes a sub-path scope through to the audit endpoint', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    await getTool().handler({ path: 'sub/dir' });
    expect(seenRequests).toContain('/api/audit?path=sub%2Fdir');
  });

  test('a clean scope reports no problems with the scanned-doc total', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'clean' });
    const s = result.structuredContent as {
      files: unknown[];
      fileCount: number;
      errorCount: number;
      warningCount: number;
    };
    expect(s.files).toHaveLength(0);
    expect(s.fileCount).toBe(4);
    expect(s.errorCount).toBe(0);
    expect(s.warningCount).toBe(0);
    expect(result.content[0]?.text).toContain('No problems across 4 documents');
  });
});

describe('audit — degradation visibility', () => {
  test('a degraded run surfaces the warning in text and is not reported as clean', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'degraded' });
    const text = result.content[0]?.text ?? '';
    // The warning reaches the text channel (the channel an agent reads)...
    expect(text).toContain('links validation unavailable: backlink index is not configured');
    // ...and the summary flags the run as incomplete, not a bare "No problems.".
    expect(text).toContain('could not fully complete');
    expect(text).toContain('Audit incomplete');
    const s = result.structuredContent as { warnings?: string[] };
    expect(s.warnings).toEqual(['links validation unavailable: backlink index is not configured']);
  });

  test('warnings surface alongside problems, not only in the structured channel', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'problems-and-warnings' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('links/dead-link');
    expect(text).toContain('could not read drafts: EACCES');
    expect(text).toContain('Audit incomplete');
  });

  test('the warnings channel is capped like the diagnostics channels', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ path: 'many-warnings' });
    const s = result.structuredContent as { warnings?: string[]; omittedWarningCount?: number };
    expect(s.warnings).toHaveLength(AUDIT_WARNING_CAP);
    expect(s.omittedWarningCount).toBe(5);
    expect(result.content[0]?.text ?? '').toContain('… and 5 more warnings');
  });
});

describe('audit — output cap', () => {
  interface AuditStructured {
    files: Array<{
      file: string;
      diagnostics: Array<{ source?: string }>;
      omittedDiagnosticCount?: number;
    }>;
    fileCount: number;
    errorCount: number;
    warningCount: number;
    omittedFileCount?: number;
  }

  test('over-cap audits truncate both channels but keep totals uncapped', async () => {
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
    // The stub alternates warning/error, so of 13 per file, 6 are errors.
    const perFile = AUDIT_FILE_DIAGNOSTIC_CAP + 3;
    const errorsPerFile = Math.floor(perFile / 2);
    expect(s.fileCount).toBe(AUDIT_FILE_CAP + 2);
    expect(s.errorCount).toBe((AUDIT_FILE_CAP + 2) * errorsPerFile);
    expect(s.warningCount).toBe((AUDIT_FILE_CAP + 2) * (perFile - errorsPerFile));

    const text = result.content[0]?.text ?? '';
    expect(text).toContain(`${AUDIT_FILE_CAP + 2} of ${AUDIT_FILE_CAP + 2} documents`);
    expect(text).toContain('… and 3 more problems');
    expect(text).toContain('… and 2 more files with problems');
    // Both validator sources survive the capped view.
    expect(text).toContain('markdownlint/MD010');
    expect(text).toContain('links/dead-link');
    const shownFileHeaders = text.match(/^doc-\d+\.md:$/gm) ?? [];
    expect(shownFileHeaders).toHaveLength(AUDIT_FILE_CAP);
  });
});
