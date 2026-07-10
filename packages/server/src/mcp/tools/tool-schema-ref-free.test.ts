/**
 * Portability guard: no MCP tool schema may advertise an intra-schema `$ref`.
 *
 * `zod-to-json-schema` (and Zod v4's native emitter) hoist a reused/recursive
 * schema into a top-level `definitions`/`$defs` block and reference it with
 * `"$ref": "#/definitions/__schemaN"`. Lenient clients (Claude) resolve that;
 * constrained-decoding hosts (LM Studio) and some function-calling APIs (Gemini)
 * do NOT — they reject the whole tool with a schema-conversion error. The
 * regression that motivated this: `write`/`edit` advertised a recursive
 * `frontmatter` value → `$ref: "#/definitions/__schema0"` → LM Studio 400.
 *
 * This sweep compiles EVERY registered tool's input AND output schema through
 * the SDK's exact `tools/list` pipeline and fails if any emits a `$ref` or a
 * `definitions`/`$defs` block — so a future recursive/reused schema can't
 * silently re-break local-inference and function-calling clients.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Internal SDK compat modules — the exact conversion `mcp.js` runs on
// `tools/list`. Reachable only via the SDK's wildcard `./*` export; the SDK is
// pinned to an exact version so a minor bump can't silently rename them.
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
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
    // Legacy `server.tool()` API bypasses schema compilation; not relevant here.
    tool() {},
  } as unknown as ServerInstance;
  registerAllTools(server, {
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
    serverUrl: undefined,
  });
  return captured;
}

/** Every `$ref` pointer + whether a definitions/$defs block is present. */
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
