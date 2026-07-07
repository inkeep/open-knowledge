/**
 * RED tests for MCP `outputSchema` strictness regression.
 *
 * Reproduces the client-side `Structured content does not match the tool's
 * output schema: data must NOT have additional properties` failure. Mirrors
 * the MCP TS-SDK's emission + validation pipeline so the test fails the same
 * way Claude fails today:
 *
 *   1. `registerTool({outputSchema})` ships a JSON Schema to the client (via
 *      `toJsonSchemaCompat(normalizeObjectSchema(shape), {pipeStrategy: 'output'})`).
 *      Zod's default `z.object(...)` emits `additionalProperties: false`.
 *   2. The client validates `tools/call` results' `structuredContent` against
 *      that JSON Schema with AJV (`AjvJsonSchemaValidator`).
 *   3. `textPlusStructured` auto-injects `text` into `structuredContent`,
 *      but no tool's `outputSchema` declares `text`. AJV strict-mode rejects
 *      it. Tool call is unusable.
 *
 * These tests fail on broken code and pass once the fix lands (a single
 * `outputSchemaWithText` helper that declares `text` on every shape that
 * goes through `textPlusStructured`).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `@modelcontextprotocol/sdk/server/zod-compat` and `.../zod-json-schema-compat`
// are reachable only through the SDK's wildcard `./*` export — they are
// internal-shaped compat-layer modules, not part of the named-export surface.
// Importing them lets this test mirror exactly the JSON-schema pipeline the
// SDK uses on `tools/list` (`normalizeObjectSchema` → `toJsonSchemaCompat`
// with `pipeStrategy: 'output'`, `strictUnions: true`). The SDK is pinned to
// an exact version in `packages/{server,cli}/package.json` so a minor bump
// can't silently rename or split these helpers; on every intentional SDK
// upgrade, re-validate that both import paths still resolve.
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv.js';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerConfig } from './config.ts';
import { registerAllTools } from './index.ts';
import { register as registerPalette } from './palette.ts';
import { register as registerSearch } from './search.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type AnyHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Captured {
  cfg: {
    outputSchema?: Record<string, unknown>;
  };
  handler: AnyHandler;
}

function captureRegistration<TDeps>(
  register: (server: ServerInstance, deps: TDeps) => void,
  deps: TDeps,
): Captured {
  let captured: Captured | null = null;
  const server = {
    registerTool(_name: string, cfg: Captured['cfg'], handler: AnyHandler) {
      captured = { cfg, handler };
    },
    tool() {
      throw new Error('not used');
    },
  } as unknown as ServerInstance;
  register(server, deps);
  if (!captured) throw new Error('tool did not register');
  return captured;
}

function newProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-output-strict-'));
  mkdirSync(join(cwd, '.ok'), { recursive: true });
  return cwd;
}

/**
 * Compile the SDK's view of the tool's outputSchema → JSON Schema, exactly the
 * way the SDK does it in `mcp.js#setRequestHandler('tools/list')`. Mirrors
 * `pipeStrategy: 'output'` and `strictUnions: true`.
 */
function compileOutputSchemaForClient(rawShape: unknown): Record<string, unknown> {
  const normalized = normalizeObjectSchema(rawShape);
  if (!normalized) {
    throw new Error('outputSchema did not normalize to an object schema');
  }
  return toJsonSchemaCompat(normalized, {
    strictUnions: true,
    pipeStrategy: 'output',
  }) as Record<string, unknown>;
}

describe('MCP outputSchema strictness — every registerTool+textPlusStructured tool must admit `text`', () => {
  // Schema-only regression guard for the other six tools that share the same
  // dual-API combination. Each tool's outputSchema must declare `text` so the
  // mirror channel `textPlusStructured` injects does not violate the
  // client-side AJV check.
  //
  // Schema-level rather than handler-level: tools like `search` need a live
  // Hocuspocus server, which is out of scope for a unit-tier regression test.
  // Compiling the outputSchema and validating a probe payload with `text`
  // alone catches the regression deterministically without network setup.
  function compileFromRegistration<TDeps>(
    register: (server: ServerInstance, deps: TDeps) => void,
    deps: TDeps,
  ): Record<string, unknown> {
    const captured = captureRegistration(register, deps);
    return compileOutputSchemaForClient(captured.cfg.outputSchema);
  }

  const cwd = newProject();
  const deps = { config: BASE_CONFIG, resolveCwd: async () => cwd };
  const depsWithServer = {
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
    serverUrl: undefined,
  };

  const cases: Array<{ name: string; build: () => Record<string, unknown> }> = [
    { name: 'config', build: () => compileFromRegistration(registerConfig, deps) },
    {
      name: 'palette',
      build: () => compileFromRegistration(registerPalette, deps),
    },
    { name: 'search', build: () => compileFromRegistration(registerSearch, depsWithServer) },
  ];

  for (const { name, build } of cases) {
    test(`${name}: outputSchema admits the auto-injected \`text\` field`, () => {
      const jsonSchema = build();
      // Probe with ONLY `text` set — pre-fix, this fails on
      // `additionalProperties: false`. Post-fix, the schema declares
      // `text` as optional so the probe passes regardless of which other
      // (also-optional or required-but-tested-elsewhere) fields exist.
      const validator = new AjvJsonSchemaValidator();
      const probe = { text: 'mirror body' };
      const fn = validator.getValidator(jsonSchema);
      const result = fn(probe);
      // Required fields may make this validation fail for reasons OTHER
      // than `text` rejection — that's fine, we only care that the
      // failure isn't `data must NOT have additional properties` on
      // the `text` key.
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});

describe('MCP outputSchema strictness — auto-discovered registerTool sweep (no new tools may regress)', () => {
  // Self-maintaining sweep: drives the canonical `registerAllTools`
  // registrar with a recording server, captures every `registerTool`
  // registration (regardless of whether the maintainer remembered to add
  // it to the explicit case list above), and verifies each compiled
  // outputSchema admits `text`. Any new tool joining the
  // `registerTool` + `textPlusStructured` + `outputSchema` combination
  // automatically lands in this sweep — the maintainer cannot silently
  // re-introduce the regression by forgetting
  // `outputSchemaWithText`.
  //
  // Tools that legitimately return WITHOUT `textPlusStructured` (e.g. a
  // future tool that returns only a typed structuredContent and no
  // text-mirror channel) can opt out by NOT routing their schema through
  // `outputSchemaWithText` AND not calling `textPlusStructured`; their
  // structuredContent will not carry `text` so AJV will not see an extra
  // field to reject. The probe below is robust to this case because it
  // sends `{ text: 'mirror body' }`: a stricter schema that omits `text`
  // would fail this probe with "additional property" — which is exactly
  // the regression signature, so the test correctly flags the omission.

  interface RegisterToolCapture {
    name: string;
    outputSchema?: unknown;
  }

  function captureAllRegistrations(cwd: string): RegisterToolCapture[] {
    const captured: RegisterToolCapture[] = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }, _handler: unknown) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {
        // Legacy `server.tool()` API bypasses strict output-schema
        // validation; not relevant to this sweep.
      },
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    return captured;
  }

  // Named floor: the sweep MUST discover every tool we already know uses
  // `outputSchemaWithText`. A name-based assertion (rather
  // than an opaque count floor) distinguishes "all 8 expected tools
  // present" from "8 unrelated tools present" — if a tool silently reverts
  // to `server.tool()` (the legacy API that bypasses strict
  // output-schema validation), the named floor catches the drop even when
  // some other tool is added at the same time. The set is the canonical
  // catalog of `registerTool` callers; adding a new tool means appending
  // to the set, which is the right surface to require a deliberate update.
  const KNOWN_REGISTER_TOOL_NAMES = new Set([
    'palette',
    'config',
    'preview_url',
    'resolve_conflict',
    'search',
    'share_link',
    // Version flow — output schemas added so the `version` field is
    // machine-visible (history surfaces `entries[].version`).
    'history',
    'checkpoint',
    'restore_version',
    // Write-spine + workflow output schemas (bounded per-target/per-kind unions).
    'delete',
    'move',
    'conflicts',
    'workflow',
    'exec',
    'edit',
    'write',
    'links',
  ]);

  test('every registerTool registration declares `text` in its outputSchema', () => {
    const cwd = newProject();
    const registrations = captureAllRegistrations(cwd);

    const capturedNames = new Set(registrations.map((r) => r.name));
    for (const name of KNOWN_REGISTER_TOOL_NAMES) {
      expect(capturedNames).toContain(name);
    }
    // Defense-in-depth floor: even if a future refactor renames a known
    // tool, the count still requires at least the same number of
    // schema-backed callers. New tools push the floor up via the
    // KNOWN_REGISTER_TOOL_NAMES set above.
    expect(registrations.length).toBeGreaterThanOrEqual(KNOWN_REGISTER_TOOL_NAMES.size);

    // Known `textPlusStructured` tools MUST declare `outputSchema` — the
    // schema is the surface the mirror-channel guard validates against. If
    // a known tool ever drops its `outputSchema` (regression), the offender
    // loop below would silently skip it via the `continue`. Catch the drop
    // here before the loop so the regression is named in the failure.
    const missingSchema = registrations
      .filter((r) => KNOWN_REGISTER_TOOL_NAMES.has(r.name) && r.outputSchema === undefined)
      .map((r) => r.name);
    expect(missingSchema).toEqual([]);

    const offenders: Array<{ name: string; error: string }> = [];
    const validator = new AjvJsonSchemaValidator();
    for (const { name, outputSchema } of registrations) {
      if (outputSchema === undefined) continue;
      const jsonSchema = compileOutputSchemaForClient(outputSchema);
      const probe = fn(validator, jsonSchema);
      if (!probe.valid && /additional propert/i.test(probe.errorMessage ?? '')) {
        offenders.push({ name, error: probe.errorMessage ?? '' });
      }
    }
    expect(offenders).toEqual([]);
  });

  // Helper isolates the probe shape so the test body reads as intent.
  function fn(
    validator: AjvJsonSchemaValidator,
    jsonSchema: Record<string, unknown>,
  ): { valid: boolean; errorMessage?: string } {
    const validate = validator.getValidator(jsonSchema);
    const probe = { text: 'mirror body' };
    return validate(probe) as { valid: boolean; errorMessage?: string };
  }
});

describe('move outputSchema admits the cross-level skill-move payloads (CORR-1)', () => {
  // The `{text}`-only sweep above can't catch a payload that carries a field the
  // schema omits but the sweep never sends. `moveSkillCrossScope` emits
  // `crossScope` (success) and `bothScopes` (partial-failure) via
  // `textPlusStructured`, so the SDK-compiled `move` schema must declare both —
  // otherwise a strict client (Claude/AJV) rejects the whole result with
  // "data must NOT have additional properties" and the agent loses the
  // recovery instruction. Validate the EXACT structuredContent both branches
  // produce, not a synthetic probe.
  function moveOutputJsonSchema(): Record<string, unknown> {
    const cwd = newProject();
    const captured: Array<{ name: string; outputSchema?: unknown }> = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {},
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    const move = captured.find((r) => r.name === 'move');
    if (!move?.outputSchema) throw new Error('move tool did not register an outputSchema');
    return compileOutputSchemaForClient(move.outputSchema);
  }

  // structuredContent = { ...structured, text } — exactly what
  // `textPlusStructured(message, structured, isError?)` injects.
  const crossScopeSuccess = {
    ok: true,
    kind: 'skill',
    committed: false,
    crossScope: true,
    text: 'Moved skill "trip-log" (Project) → "trip-log" (Global). …',
  };
  const crossScopePartialFailure = {
    ok: false,
    kind: 'skill',
    error: 'source delete failed',
    bothScopes: true,
    text: 'Partially moved skill … exists in BOTH levels …',
  };

  for (const [label, payload] of [
    ['cross-level success', crossScopeSuccess],
    ['cross-level partial-failure (both levels)', crossScopePartialFailure],
  ] as const) {
    test(`${label} structuredContent validates against the compiled move schema`, () => {
      const validator = new AjvJsonSchemaValidator();
      const validate = validator.getValidator(moveOutputJsonSchema());
      const result = validate(payload) as { valid: boolean; errorMessage?: string };
      expect(result.valid).toBe(true);
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});

describe('share_link outputSchema admits the freshness success payloads (S3)', () => {
  // The `{text}`-only sweep can't catch a handler-emitted field the schema
  // omits (it never sends `freshness`), so validate the EXACT success
  // structuredContent — with and without freshness — against the compiled
  // share_link schema. A strict client (Claude/AJV) rejects the whole result
  // with "additional properties" if `freshness` isn't declared, and the agent
  // silently loses the warning it was supposed to relay.
  function shareLinkOutputJsonSchema(): Record<string, unknown> {
    const cwd = newProject();
    const captured: Array<{ name: string; outputSchema?: unknown }> = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {},
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    const shareLink = captured.find((r) => r.name === 'share_link');
    if (!shareLink?.outputSchema) {
      throw new Error('share_link tool did not register an outputSchema');
    }
    return compileOutputSchemaForClient(shareLink.outputSchema);
  }

  const base = {
    ok: true,
    shareUrl: 'https://openknowledge.ai/d/enc',
    sharedUrl: 'https://github.com/o/r/blob/main/notes.md',
    branch: 'main',
    resolvedKind: 'doc',
    previewUrl: null,
  };
  const withFreshness = {
    ...base,
    freshness: 'stale',
    text: 'This doc has unpushed changes. Recipients will see the last pushed version.\n\nShare link for doc `notes` on branch `main`:\nhttps://openknowledge.ai/d/enc',
  };
  const withoutFreshness = {
    ...base,
    text: 'Share link for doc `notes` on branch `main`:\nhttps://openknowledge.ai/d/enc',
  };

  for (const [label, payload] of [
    ['success with freshness', withFreshness],
    ['success without freshness (happy-path passthrough)', withoutFreshness],
  ] as const) {
    test(`${label} structuredContent validates against the compiled share_link schema`, () => {
      const validator = new AjvJsonSchemaValidator();
      const validate = validator.getValidator(shareLinkOutputJsonSchema());
      const result = validate(payload) as { valid: boolean; errorMessage?: string };
      expect(result.valid).toBe(true);
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});
