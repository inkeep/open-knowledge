import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
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
    expect(text).toContain('position');
    expect(text).toContain('append');
    expect(text).toContain('prepend');
    expect(text).toContain('replace');
    expect(text).toContain('write_document');
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
    server.registerTool('no_schema_tool', { description: 'no schema' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    installPrettyZodErrors(server);
    const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools.no_schema_tool;
    const outcome = await callValidateToolInput(server, tool, {}, 'no_schema_tool');
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
