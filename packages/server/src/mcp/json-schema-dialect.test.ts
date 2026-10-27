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

function buildNullableServer(): McpServer {
  const server = new McpServer({ name: 'json-schema-dialect-test', version: '0.0.0' });
  server.registerTool(
    'nullable_like',
    {
      description: 'Nullable fields at the top level, inside an object and inside an array item.',
      inputSchema: { cursor: z.string().nullable() },
      outputSchema: {
        label: z.string().nullable(),
        nested: z.object({ count: z.number().nullable() }),
        items: z.array(z.string().nullable()),
      },
    },
    async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { label: null, nested: { count: null }, items: [null] },
    }),
  );
  return server;
}

function typeArrayPaths(node: unknown, path = ''): string[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node))
    return node.flatMap((entry, index) => typeArrayPaths(entry, `${path}[${index}]`));
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'type' && Array.isArray(value)
      ? [path]
      : typeArrayPaths(value, path ? `${path}.${key}` : key),
  );
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

  test('leaves a schema with no type arrays unchanged apart from $schema', async () => {
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

  test('the SDK serves nullable fields as type arrays on Zod 4.6, which the split guards', async () => {
    const { tools } = await listToolsOverWire(buildNullableServer());
    expect(typeArrayPaths(tools[0]?.inputSchema)).not.toEqual([]);
    expect(typeArrayPaths(tools[0]?.outputSchema)).not.toEqual([]);
  });

  test('serves every nullable field as anyOf of bare types, nested ones included', async () => {
    const server = buildNullableServer();
    installJsonSchemaDialect(server);

    const { tools } = await listToolsOverWire(server);
    const input = tools[0]?.inputSchema as { properties: Record<string, unknown> };
    const output = tools[0]?.outputSchema as {
      properties: {
        label: unknown;
        nested: { properties: { count: unknown } };
        items: { items: unknown };
      };
    };
    expect(typeArrayPaths(input)).toEqual([]);
    expect(typeArrayPaths(output)).toEqual([]);
    expect(input.properties.cursor).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(output.properties.label).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(output.properties.nested.properties.count).toEqual({
      anyOf: [{ type: 'number' }, { type: 'null' }],
    });
    expect(output.properties.items.items).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  test('is idempotent', async () => {
    const server = buildServer();
    installJsonSchemaDialect(server);
    installJsonSchemaDialect(server);

    const { tools } = await listToolsOverWire(server);
    expect(tools[0]?.outputSchema?.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
  });

  test('warns instead of throwing when installed before any tool is registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new McpServer({ name: 'json-schema-dialect-test', version: '0.0.0' });

    expect(() => installJsonSchemaDialect(server)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[json-schema-dialect]'));
    warn.mockRestore();
  });

  test('a tool registered after install still gets re-declared', async () => {
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
