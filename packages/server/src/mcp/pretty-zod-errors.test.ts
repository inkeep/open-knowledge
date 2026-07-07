/**
 * `write_document` (and every other MCP tool that registers a
 * Zod input schema) must surface validation failures that NAME the missing
 * field AND list the allowed values, instead of the default Zod v4 message
 * which is a JSON dump of the issues array.
 *
 * These tests exercise `installPrettyZodErrors` against a real `McpServer`
 * instance — registering a representative tool with the same enum shape as
 * `write_document`'s `position` argument, then driving the SDK's internal
 * `validateToolInput` path directly so we observe the exact `McpError`
 * messages that the MCP SDK would surface to a client.
 *
 * Black-box assertions only: the test reads what an agent or human would
 * see in the chat surface (`McpError.message`), not how the formatter is
 * structured internally. Keeps the test resilient to formatter changes.
 */
import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { installPrettyZodErrors } from './pretty-zod-errors.ts';

interface RegisteredTool {
  inputSchema?: unknown;
}

function buildServerWithWriteDocLikeTool(): {
  server: McpServer;
  tool: RegisteredTool;
} {
  const server = new McpServer({ name: 'pretty-zod-errors-test', version: '0.0.0' });
  server.registerTool(
    'write_document',
    {
      description: 'test tool with the same shape as the production write_document',
      inputSchema: {
        docName: z.string().describe('Document name to write to'),
        markdown: z.string().optional(),
        position: z.enum(['append', 'prepend', 'replace']).describe('Where to insert the content'),
        summary: z.string().max(200).optional(),
      },
    },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
  installPrettyZodErrors(server);
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools.write_document;
  return { server, tool };
}

async function callValidateToolInput(
  server: McpServer,
  tool: RegisteredTool,
  args: unknown,
  toolName: string,
): Promise<{ kind: 'ok'; value: unknown } | { kind: 'mcp_error'; error: McpError }> {
  const target = server as unknown as {
    validateToolInput: (tool: RegisteredTool, args: unknown, toolName: string) => Promise<unknown>;
  };
  try {
    const value = await target.validateToolInput(tool, args, toolName);
    return { kind: 'ok', value };
  } catch (err) {
    if (err instanceof McpError) return { kind: 'mcp_error', error: err };
    throw err;
  }
}

describe('installPrettyZodErrors — PRD-6659', () => {
  test('missing required `position` enum: error names the field AND lists allowed values', async () => {
    const { server, tool } = buildServerWithWriteDocLikeTool();
    const outcome = await callValidateToolInput(
      server,
      tool,
      { docName: 'foo', markdown: 'hi' },
      'write_document',
    );
    expect(outcome.kind).toBe('mcp_error');
    if (outcome.kind !== 'mcp_error') return;
    expect(outcome.error.code).toBe(ErrorCode.InvalidParams);
    const text = outcome.error.message;
    // Field name surfaced — the original failure mode hid this entirely.
    expect(text).toContain('position');
    // All allowed values surfaced — the original failure mode never enumerated them.
    expect(text).toContain('append');
    expect(text).toContain('prepend');
    expect(text).toContain('replace');
    // Tool name preserved so callers know which call site failed.
    expect(text).toContain('write_document');
    // Anti-regression: must NOT be a bare "Required" with no other context,
    // and must NOT be the raw Zod v4 JSON dump of the issues array — which
    // is what `ZodError.message` returns by default and what the SDK
    // surfaces unless `validateToolInput` is patched. The JSON dump
    // contains "position"/"append"/etc. too, but only as quoted JSON
    // values inside `"path":` / `"values":` keys, so checking field names
    // alone wouldn't distinguish the two formats. The JSON-key markers
    // below pin the structural difference.
    expect(text.trim()).not.toBe('Required');
    expect(text).not.toContain('"code":');
    expect(text).not.toContain('"path":');
    expect(text).not.toContain('"values":');
  });

  test('invalid `position` value: error names the field AND lists allowed values', async () => {
    const { server, tool } = buildServerWithWriteDocLikeTool();
    const outcome = await callValidateToolInput(
      server,
      tool,
      { docName: 'foo', markdown: 'hi', position: 'middle' },
      'write_document',
    );
    expect(outcome.kind).toBe('mcp_error');
    if (outcome.kind !== 'mcp_error') return;
    expect(outcome.error.message).toContain('position');
    expect(outcome.error.message).toContain('append');
    expect(outcome.error.message).toContain('prepend');
    expect(outcome.error.message).toContain('replace');
    expect(outcome.error.message).not.toContain('"code":');
    expect(outcome.error.message).not.toContain('"path":');
  });

  test('missing required `docName` string: error names the field', async () => {
    const { server, tool } = buildServerWithWriteDocLikeTool();
    const outcome = await callValidateToolInput(
      server,
      tool,
      { markdown: 'hi', position: 'append' },
      'write_document',
    );
    expect(outcome.kind).toBe('mcp_error');
    if (outcome.kind !== 'mcp_error') return;
    expect(outcome.error.message).toContain('docName');
    expect(outcome.error.message.trim()).not.toBe('Required');
    expect(outcome.error.message).not.toContain('"code":');
    expect(outcome.error.message).not.toContain('"path":');
  });

  test('valid args pass through and return the parsed object', async () => {
    const { server, tool } = buildServerWithWriteDocLikeTool();
    const outcome = await callValidateToolInput(
      server,
      tool,
      { docName: 'foo', markdown: 'hi', position: 'append' },
      'write_document',
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value).toMatchObject({
      docName: 'foo',
      markdown: 'hi',
      position: 'append',
    });
  });

  test('tool without inputSchema passes through to the SDK default path', async () => {
    const server = new McpServer({ name: 'pretty-zod-errors-test', version: '0.0.0' });
    // `server.registerTool(name, { description }, handler)` — no input schema.
    server.registerTool('no_schema_tool', { description: 'no schema' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    installPrettyZodErrors(server);
    const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools.no_schema_tool;
    const outcome = await callValidateToolInput(server, tool, {}, 'no_schema_tool');
    // SDK contract: no inputSchema → validateToolInput returns undefined.
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value).toBeUndefined();
  });

  test('idempotent: calling installPrettyZodErrors twice does not double-wrap', async () => {
    const server = new McpServer({ name: 'pretty-zod-errors-test', version: '0.0.0' });
    server.registerTool(
      'write_document',
      {
        description: 'description',
        inputSchema: {
          docName: z.string(),
          position: z.enum(['append', 'prepend', 'replace']),
        },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    installPrettyZodErrors(server);
    installPrettyZodErrors(server);
    const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools.write_document;
    const outcome = await callValidateToolInput(server, tool, { docName: 'x' }, 'write_document');
    expect(outcome.kind).toBe('mcp_error');
    if (outcome.kind !== 'mcp_error') return;
    expect(outcome.error.message).toContain('position');
    expect(outcome.error.message).toContain('append');
  });
});
