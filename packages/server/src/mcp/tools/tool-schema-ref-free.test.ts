import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { describe, expect, test } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { registerAllTools } from './index.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface Registration {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

function captureAllRegistrations(cwd: string): Registration[] {
  const captured: Registration[] = [];
  const server = {
    registerTool(name: string, cfg: { inputSchema?: unknown; outputSchema?: unknown }) {
      captured.push({ name, inputSchema: cfg.inputSchema, outputSchema: cfg.outputSchema });
    },
    tool() {},
  } as unknown as ServerInstance;
  registerAllTools(server, {
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
    serverUrl: undefined,
  });
  return captured;
}

function refOffenders(rawShape: unknown, pipeStrategy: 'input' | 'output'): string[] {
  const normalized = normalizeObjectSchema(rawShape);
  if (!normalized) return [];
  const json = toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy }) as Record<
    string,
    unknown
  >;
  const serialized = JSON.stringify(json);
  const refs = [...serialized.matchAll(/#\/(?:definitions|\$defs)\/[A-Za-z0-9_]+/g)].map(
    (m) => m[0],
  );
  const offenders = [...new Set(refs)];
  if ('definitions' in json) offenders.push('<top-level definitions block>');
  if ('$defs' in json) offenders.push('<top-level $defs block>');
  return offenders;
}

describe('MCP tool schema portability — no intra-schema $ref (LM Studio / Gemini compat)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-reffree-'));
  mkdirSync(join(cwd, '.ok'), { recursive: true });
  const registrations = captureAllRegistrations(cwd);

  test('registration sweep is non-empty (guards against a broken capture)', () => {
    expect(registrations.length).toBeGreaterThan(10);
  });

  for (const { name, inputSchema, outputSchema } of registrations) {
    test(`${name}: input + output schemas are $ref-free`, () => {
      expect({ input: refOffenders(inputSchema, 'input') }).toEqual({ input: [] });
      expect({ output: refOffenders(outputSchema, 'output') }).toEqual({ output: [] });
    });
  }
});
