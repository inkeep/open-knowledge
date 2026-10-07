import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import {
  AGENT_SESSION_CAPACITY_DETAIL,
  AGENT_SESSION_CAPACITY_EXTENSIONS,
  AGENT_SESSION_CAPACITY_TITLE,
  AGENT_SESSION_CAPACITY_TYPE,
} from '../../http/agent-session-capacity.ts';
import { register as registerEdit } from './edit.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
import { register as registerLint } from './lint.ts';
import type { ServerInstance } from './shared.ts';
import { register as registerWrite } from './write.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const REFUSAL_TEXT = `${AGENT_SESSION_CAPACITY_TITLE} (${AGENT_SESSION_CAPACITY_DETAIL}) Retry after ${AGENT_SESSION_CAPACITY_EXTENSIONS.retryAfterSeconds}s.`;

function capacityRefusal(): Response {
  return Response.json(
    {
      type: AGENT_SESSION_CAPACITY_TYPE,
      title: AGENT_SESSION_CAPACITY_TITLE,
      status: 503,
      instance: 'urn:uuid:11111111-2222-4333-8444-555555555555',
      detail: AGENT_SESSION_CAPACITY_DETAIL,
      ...AGENT_SESSION_CAPACITY_EXTENSIONS,
    },
    {
      status: 503,
      headers: { 'Retry-After': String(AGENT_SESSION_CAPACITY_EXTENSIONS.retryAfterSeconds) },
    },
  );
}

const STALE_TITLE = 'Edit retained; disk write blocked by a stale external-write conflict.';
const STALE_DETAIL =
  'Your edit was applied and is retained in memory, but its Markdown disk write was skipped. Do not repeat this edit.';

function staleExternalWrite(): Response {
  return Response.json(
    {
      type: 'urn:ok:error:stale-external-write',
      title: STALE_TITLE,
      status: 409,
      instance: 'urn:uuid:22222222-3333-4444-8555-666666666666',
      detail: STALE_DETAIL,
    },
    { status: 409 },
  );
}

const INVALID_TITLE = 'Frontmatter patch rejected: schema validation failed.';

function invalidFrontmatterPatch(): Response {
  return Response.json(
    {
      type: 'urn:ok:error:invalid-frontmatter-patch',
      title: INVALID_TITLE,
      status: 400,
      instance: 'urn:uuid:33333333-4444-4555-8666-777777777777',
      fieldErrors: { status: "'status' is not a recognized key" },
    },
    { status: 400 },
  );
}

describe('MCP write paths relaying an agent-session capacity refusal', () => {
  let testServer: FetchTestServer;
  let cwd: string;
  const handlers = new Map<string, Handler>();

  beforeAll(async () => {
    testServer = await startFetchTestServer({
      hostname: '127.0.0.1',
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/api/agent-write-md') {
          const body = (await request.json()) as { docName?: string };
          if (body.docName?.startsWith('notes/templated')) {
            return Response.json({ ok: true, docName: body.docName });
          }
          return capacityRefusal();
        }
        if (pathname === '/api/frontmatter-patch') {
          const body = (await request.json()) as { docName?: string };
          if (body.docName === 'notes/templated-stale') return staleExternalWrite();
          if (body.docName === 'notes/templated-invalid') return invalidFrontmatterPatch();
          return capacityRefusal();
        }
        if (pathname === '/api/agent-patch' || pathname === '/api/lint/fix') {
          return capacityRefusal();
        }
        return Response.json({ error: `unexpected route ${pathname}` }, { status: 500 });
      },
    });
    cwd = mkdtempSync(join(tmpdir(), 'ok-session-capacity-refusal-'));
    mkdirSync(join(cwd, '.ok'), { recursive: true });
    mkdirSync(join(cwd, 'notes', '.ok', 'templates'), { recursive: true });
    writeFileSync(
      join(cwd, 'notes', '.ok', 'templates', 'note.md'),
      '---\ntitle: Note\ndescription: A plain note\n---\n\n# Note\n',
    );

    const deps = {
      serverUrl: `http://127.0.0.1:${testServer.port}`,
      config: ConfigSchema.parse({}),
      resolveCwd: async () => cwd,
    };
    for (const [name, register] of [
      ['write', registerWrite],
      ['edit', registerEdit],
      ['lint', registerLint],
    ] as const) {
      const server = {
        registerTool(_name: string, _cfg: unknown, toolHandler: Handler) {
          handlers.set(name, toolHandler);
        },
      } as unknown as ServerInstance;
      register(server, deps);
    }
  });

  afterAll(() => {
    testServer.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  function tool(name: string): Handler {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`${name} tool did not register`);
    return handler;
  }

  it('write shows the detail and retry interval', async () => {
    const result = await tool('write')({
      document: { path: 'notes/plain', content: '# Plain\n', position: 'replace' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`Error: ${REFUSAL_TEXT}`);
  });

  it('write from a template says only its frontmatter was refused and how to apply it alone', async () => {
    const result = await tool('write')({
      document: { path: 'notes/templated', template: 'note', frontmatter: { status: 'draft' } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `Error: document created from template "note", but its frontmatter patch was refused, so the document exists without that frontmatter: ${REFUSAL_TEXT} Apply the frontmatter alone with edit({ document: { path: "notes/templated", frontmatter } }); do not repeat the templated write.`,
    );
  });

  it('write from a template does not claim a frontmatter patch that failed after applying was refused', async () => {
    const result = await tool('write')({
      document: {
        path: 'notes/templated-stale',
        template: 'note',
        frontmatter: { status: 'draft' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `Error: document created from template "note", but its frontmatter patch failed, and this response does not show whether the frontmatter was applied: ${STALE_TITLE} (${STALE_DETAIL}) Re-read the document before changing it; do not repeat the templated write.`,
    );
  });

  it('write from a template treats a frontmatter validation rejection as nothing applied', async () => {
    const result = await tool('write')({
      document: {
        path: 'notes/templated-invalid',
        template: 'note',
        frontmatter: { status: 'draft' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `Error: document created from template "note", but its frontmatter patch was refused, so the document exists without that frontmatter: ${INVALID_TITLE} Apply the frontmatter alone with edit({ document: { path: "notes/templated-invalid", frontmatter } }); do not repeat the templated write.`,
    );
  });

  it('edit find/replace shows the detail and retry interval', async () => {
    const result = await tool('edit')({
      document: { path: 'notes/plain', find: 'Plain', replace: 'Changed' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`Error: ${REFUSAL_TEXT}`);
  });

  it('edit frontmatter shows the detail and retry interval', async () => {
    const result = await tool('edit')({
      document: { path: 'notes/plain', frontmatter: { status: 'draft' } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`Error: ${REFUSAL_TEXT}`);
  });

  it('lint fix shows the detail and retry interval', async () => {
    const result = await tool('lint')({ document: 'notes/plain', fix: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`Error: ${REFUSAL_TEXT}`);
  });
});
