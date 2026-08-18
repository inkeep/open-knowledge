/**
 * Every MCP tool must advertise its `inputSchema` / `outputSchema` as JSON
 * Schema 2020-12.
 *
 * The SDK converts our Zod v4 schemas with no target, which lands on
 * draft-07. Clients that validate structured output against the declared
 * dialect then reject the tool before it ever runs, taking down the whole
 * tool surface rather than degrading one tool. An Ajv 2020 instance refuses
 * every draft-07-declaring schema with `no schema with key or ref
 * "http://json-schema.org/draft-07/schema#"`.
 *
 * Black-box: assertions read the `tools/list` result off a real client
 * connected over an in-memory transport, so they observe exactly the wire
 * bytes a Claude Code or Claude Desktop client would parse.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { installJsonSchemaDialect, JSON_SCHEMA_DIALECT_2020_12 } from './json-schema-dialect.ts';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'json-schema-dialect-test', version: '0.0.0' });
  server.registerTool(
    'exec_like',
    {
      description: 'Mirrors the shape every OK tool registers: both schemas present.',
      inputSchema: { command: z.string(), cwd: z.string().optional() },
      outputSchema: { text: z.string(), exitCode: z.number() },
    },
    async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { text: 'ok', exitCode: 0 },
    }),
  );
  return server;
}

async function listToolsOverWire(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();
  return result;
}

describe('installJsonSchemaDialect', () => {
  test('the SDK default is draft-07, which is the bug this guards', async () => {
    const { tools } = await listToolsOverWire(buildServer());
    expect(tools).toHaveLength(1);
    expect(tools[0]?.inputSchema?.$schema).toBe(DRAFT_07);
    expect(tools[0]?.outputSchema?.$schema).toBe(DRAFT_07);
  });

  test('re-declares both schema channels as 2020-12', async () => {
    const server = buildServer();
    installJsonSchemaDialect(server);

    const { tools } = await listToolsOverWire(server);
    expect(tools[0]?.inputSchema?.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
    expect(tools[0]?.outputSchema?.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
  });

  test('leaves the rest of the schema untouched', async () => {
    const before = (await listToolsOverWire(buildServer())).tools[0];
    const server = buildServer();
    installJsonSchemaDialect(server);
    const after = (await listToolsOverWire(server)).tools[0];

    const strip = (s: unknown) => {
      const { $schema: _drop, ...rest } = (s ?? {}) as Record<string, unknown>;
      return rest;
    };
    expect(strip(after?.inputSchema)).toEqual(strip(before?.inputSchema));
    expect(strip(after?.outputSchema)).toEqual(strip(before?.outputSchema));
  });

  test('is idempotent', async () => {
    const server = buildServer();
    installJsonSchemaDialect(server);
    installJsonSchemaDialect(server);

    const { tools } = await listToolsOverWire(server);
    expect(tools[0]?.outputSchema?.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
  });

  test('warns instead of throwing when installed before any tool is registered', async () => {
    // The ordering contract: the SDK installs its `tools/list` handler lazily
    // on the first `registerTool`, so an install hoisted above tool
    // registration silently does nothing. Fail loud rather than ship draft-07.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new McpServer({ name: 'json-schema-dialect-test', version: '0.0.0' });

    expect(() => installJsonSchemaDialect(server)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[json-schema-dialect]'));
    warn.mockRestore();
  });

  test('a tool registered after install still gets re-declared', async () => {
    // The wrapper defers to the SDK handler, which reads the live tool
    // registry per request, so late registrations flow through it.
    const server = buildServer();
    installJsonSchemaDialect(server);
    server.registerTool(
      'late_tool',
      { description: 'registered after install', outputSchema: { text: z.string() } },
      async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { text: 'ok' },
      }),
    );

    const { tools } = await listToolsOverWire(server);
    const late = tools.find((t) => t.name === 'late_tool');
    expect(late?.outputSchema?.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
  });
});
