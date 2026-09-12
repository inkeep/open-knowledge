import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, test } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerEdit } from './edit.ts';
import { startFetchTestServer } from './fetch-test-server.test-helper.ts';
import type { ServerInstance } from './shared.ts';
import { register as registerWrite } from './write.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const REPAIR_HEADER = 'broken outbound link';

function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text).join('\n');
}

function docOf(r: ToolResult): Record<string, unknown> {
  return (r.structuredContent?.document ?? {}) as Record<string, unknown>;
}

function batchOf(r: ToolResult): Array<Record<string, unknown>> {
  return (r.structuredContent?.documents ?? []) as Array<Record<string, unknown>>;
}

interface CapturedTool {
  handler: Handler;
  clientSchema: Record<string, unknown>;
}

interface StubbedTools {
  write: Handler;
  edit: Handler;
  writeTool: CapturedTool;
  editTool: CapturedTool;
}

async function withStub(
  payload: Record<string, unknown>,
  body: (tools: StubbedTools) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-mcp-link-suppression-'));
  const stub = await startFetchTestServer({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return Response.json({ error: 'unexpected' }, { status: 404 });
      const reqBody = (await req.json()) as { docName?: string };
      return Response.json({
        docName: reqBody.docName,
        systemSubscriberCount: 1,
        timestamp: '2026-08-28T00:00:00.000Z',
        ...payload,
      });
    },
  });
  const capture = <D>(register: (server: ServerInstance, deps: D) => void): CapturedTool => {
    let captured: CapturedTool | undefined;
    const server = {
      registerTool(_name: string, cfg: { outputSchema?: unknown }, handler: Handler) {
        const normalized = normalizeObjectSchema(cfg.outputSchema);
        if (!normalized) throw new Error('outputSchema did not normalize to an object schema');
        captured = {
          handler,
          clientSchema: toJsonSchemaCompat(normalized, {
            strictUnions: true,
            pipeStrategy: 'output',
          }) as Record<string, unknown>,
        };
      },
    } as unknown as ServerInstance;
    register(server, {
      serverUrl: `http://127.0.0.1:${stub.port}`,
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
    } as unknown as D);
    if (!captured) throw new Error('tool did not register');
    return captured;
  };
  try {
    const writeTool = capture(registerWrite);
    const editTool = capture(registerEdit);
    await body({
      write: writeTool.handler,
      edit: editTool.handler,
      writeTool,
      editTool,
    });
  } finally {
    stub.stop(true);
  }
}

const SUPPRESSED_TWO = {
  brokenLinks: [],
  brokenLinkSuppression: { reason: 'reserved-log-policy', count: 2 },
};

describe('write/edit relay a policy suppression instead of a bare empty list', () => {
  test('a suppressed single-doc write reports the count and no repair work', async () => {
    await withStub(SUPPRESSED_TWO, async ({ write }) => {
      const r = await write({ document: { path: 'notes/log', content: '# Log\n' } });
      expect(r.isError).toBeUndefined();
      expect(docOf(r).brokenLinks).toEqual([]);
      expect(docOf(r).brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
      const text = textOf(r);
      expect(text).toContain('2');
      expect(text).not.toContain(REPAIR_HEADER);
    });
  });

  test('a suppressed body edit reports the count and no repair work', async () => {
    await withStub(SUPPRESSED_TWO, async ({ edit }) => {
      const r = await edit({ document: { path: 'notes/log', find: 'a', replace: 'b' } });
      expect(r.isError).toBeUndefined();
      expect(docOf(r).brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
      expect(textOf(r)).not.toContain(REPAIR_HEADER);
    });
  });

  test('a suppressed frontmatter edit reports the count', async () => {
    await withStub(SUPPRESSED_TWO, async ({ edit }) => {
      const r = await edit({ document: { path: 'notes/log', frontmatter: { title: 'Log' } } });
      expect(r.isError).toBeUndefined();
      expect(docOf(r).brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
    });
  });

  test('a suppressed batch entry carries its own count', async () => {
    await withStub(
      { brokenLinks: [], brokenLinkSuppression: { reason: 'reserved-log-policy', count: 1 } },
      async ({ write }) => {
        const r = await write({
          documents: [
            { path: 'notes/log', content: '# Log\n' },
            { path: 'archive/log', content: '# Archive log\n' },
          ],
        });
        expect(r.isError).toBeUndefined();
        const entries = batchOf(r);
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
          expect(entry.brokenLinks).toEqual([]);
          expect(entry.brokenLinkSuppression).toEqual({
            reason: 'reserved-log-policy',
            count: 1,
          });
        }
        const text = textOf(r);
        expect(text).toContain('1 broken-link finding withheld');
        expect(text).not.toContain(REPAIR_HEADER);
      },
    );
  });

  test('a suppressed body validates against the schema the client enforces', async () => {
    await withStub(SUPPRESSED_TWO, async ({ write, edit, writeTool, editTool }) => {
      const validator = new AjvJsonSchemaValidator();
      const cases: Array<[CapturedTool, ToolResult]> = [
        [writeTool, await write({ document: { path: 'notes/log', content: '# Log\n' } })],
        [editTool, await edit({ document: { path: 'notes/log', find: 'a', replace: 'b' } })],
      ];
      for (const [tool, result] of cases) {
        expect(docOf(result).brokenLinkSuppression).toBeDefined();
        const validate = validator.getValidator(tool.clientSchema);
        expect(validate(result.structuredContent)).toMatchObject({ valid: true });
      }
    });
  });

  test('the text says an empty list is not a clean bill of health', async () => {
    await withStub(SUPPRESSED_TWO, async ({ write }) => {
      const r = await write({ document: { path: 'notes/log', content: '# Log\n' } });
      expect(textOf(r)).toContain('does NOT mean every link resolves');
    });
  });

  test('a policy this build predates still qualifies the empty list on both channels', async () => {
    await withStub(
      { brokenLinks: [], brokenLinkSuppression: { reason: 'some-future-policy', count: 2 } },
      async ({ write, writeTool }) => {
        const r = await write({ document: { path: 'notes/log', content: '# Log\n' } });
        expect(docOf(r).brokenLinkSuppression).toEqual({
          reason: 'some-future-policy',
          count: 2,
        });
        expect(textOf(r)).toContain('does NOT mean every link resolves');
        expect(textOf(r)).not.toContain(REPAIR_HEADER);
        const validate = new AjvJsonSchemaValidator().getValidator(writeTool.clientSchema);
        expect(validate(r.structuredContent)).toMatchObject({ valid: true });
      },
    );
  });
});

describe('an unsuppressed response is relayed exactly as before', () => {
  test('real broken links keep their repair lines and carry no suppression', async () => {
    await withStub(
      { brokenLinks: [{ href: './gone.md', resolvedTo: 'gone', reason: 'no-such-doc' }] },
      async ({ write, edit }) => {
        for (const r of [
          await write({ document: { path: 'notes/plan', content: '# Plan\n' } }),
          await edit({ document: { path: 'notes/plan', find: 'a', replace: 'b' } }),
        ]) {
          expect(r.isError).toBeUndefined();
          expect(docOf(r).brokenLinkSuppression).toBeUndefined();
          expect(textOf(r)).toContain('1 broken outbound link — fix or remove');
          expect(textOf(r)).toContain('./gone.md → gone (no-such-doc)');
        }
      },
    );
  });

  test('a clean write carries neither repair lines nor a suppression field', async () => {
    await withStub({ brokenLinks: [] }, async ({ write }) => {
      const r = await write({ document: { path: 'notes/plan', content: '# Plan\n' } });
      expect(docOf(r).brokenLinks).toEqual([]);
      expect(docOf(r).brokenLinkSuppression).toBeUndefined();
      expect(textOf(r)).not.toContain('withheld');
    });
  });

  test('a malformed suppression object is dropped rather than relayed, because a write advisory has no untyped warnings channel to disclose it through', async () => {
    await withStub(
      { brokenLinks: [], brokenLinkSuppression: { reason: 'reserved-log-policy', count: 0 } },
      async ({ write }) => {
        const r = await write({ document: { path: 'notes/log', content: '# Log\n' } });
        expect(docOf(r).brokenLinkSuppression).toBeUndefined();
        expect(textOf(r)).not.toContain('withheld');
      },
    );
  });
});
