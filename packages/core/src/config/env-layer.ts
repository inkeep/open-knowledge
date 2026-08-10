/**
 * Environment-variable config layer — the mechanical `OK_*` mapping rule.
 *
 * Naming rule (the only one there is, so no per-key naming decisions ever
 * again): a leaf under the `server.` section maps to bare `OK_<LEAF>`
 * (`server.publicUrl` → `OK_PUBLIC_URL`); every other section maps to
 * `OK_<SECTION>_<LEAF>` (`autoSync.mode` → `OK_AUTO_SYNC_MODE`). camelCase
 * segments render as underscore-separated uppercase. One pinned exception:
 * `server.port` is read from unprefixed `PORT` — the platform-injection
 * contract (Heroku/Railway/Cloud Run) — never `OK_PORT`.
 *
 * RECOGNITION IS GATED to the ratified set below. Env names lock the moment a
 * release ships them and betas cut per merge, so recognizing every config
 * leaf mechanically would irreversibly lock an env name per leaf in one
 * unreviewed shot. The machinery underneath (name table, leaf-typed parsing)
 * is generic; widening the surface is a one-line allowlist addition once a
 * name is ratified.
 *
 * Precedence: flags > env > project-local > project > user > defaults —
 * callers merge the returned layer above the file-merged config and let
 * explicit CLI flags override the result. Values parse by the leaf's own
 * schema type (boolean: exactly `1`/`0`/`true`/`false`, never
 * presence-checked; lists: space-separated, replace never merge; numbers:
 * integers) and then validate against the leaf schema itself, so a bad value
 * fails loud at boot naming the env var — not later as an opaque config
 * error. An empty/whitespace value reads as unset (the `PORT=''` platform
 * quirk), never as an error.
 *
 * Unrecognized `OK_*` vars are mostly legitimate operational toggles
 * (`OK_LOCK_KIND`, `OK_RECLAIM_DISABLE`, …), so diagnostics are deliberately
 * conservative: warn only on an exact mechanical match to a config leaf that
 * is not env-configurable, or a near-miss (edit distance ≤ 2) of a recognized
 * name. Everything else stays silent.
 */

import type { z } from 'zod';
import { ConfigSchema } from './schema.ts';
import { resolveLeafSchema } from './schema-leaf.ts';

/** A single env-var override, parsed and leaf-validated. */
export interface EnvOverride {
  /** Config path the value applies to, e.g. `['server', 'bind']`. */
  path: readonly string[];
  /** The environment variable the value came from. */
  envVar: string;
  /** Parsed value, already validated against the leaf schema. */
  value: unknown;
}

/** Non-fatal env-layer observation (unknown-var did-you-mean, etc.). */
export interface EnvDiagnostic {
  envVar: string;
  message: string;
}

export interface EnvConfigLayer {
  overrides: EnvOverride[];
  /**
   * Deep-partial config assembled from `overrides` — merge it above the
   * project-local file layer. Lists and scalars replace; nothing merges.
   */
  layer: Record<string, unknown>;
  diagnostics: EnvDiagnostic[];
}

/** Fatal env-var parse/validation failure — boot error with a one-line fix. */
export class EnvVarError extends Error {
  readonly envVar: string;
  constructor(envVar: string, message: string) {
    super(`${envVar}: ${message}`);
    this.name = 'EnvVarError';
    this.envVar = envVar;
  }
}

/**
 * The ratified env surface (config-surface decision, Tables 1–2). Key: env
 * var; value: config path. `server.trustedProxies` is deferred with its key;
 * `auth.*` is deferred entirely — neither appears here until ratified.
 */
export const RECOGNIZED_ENV_VARS: ReadonlyMap<string, readonly string[]> = new Map([
  ['PORT', ['server', 'port']],
  ['OK_BIND', ['server', 'bind']],
  ['OK_PUBLIC_URL', ['server', 'publicUrl']],
  ['OK_ALLOW_EXTERNAL', ['server', 'allowExternal']],
  ['OK_OPEN_BROWSER', ['server', 'openBrowser']],
  ['OK_IDLE_SHUTDOWN', ['server', 'idleShutdown']],
]);

function camelToScreamingSnake(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The mechanical naming rule. Exported for the name-table pin test. */
export function mechanicalEnvName(path: readonly string[]): string {
  const segments = path[0] === 'server' ? path.slice(1) : path;
  return `OK_${segments.map(camelToScreamingSnake).join('_')}`;
}

type AnyZ = z.ZodType<unknown>;

function unwrapLeaf(schema: unknown): unknown {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    const def = (cur as { _zod?: { def?: { type?: string; innerType?: unknown } } })?._zod?.def;
    if (def === undefined) return cur;
    if (def.type !== 'default' && def.type !== 'optional' && def.type !== 'nullable') return cur;
    cur = def.innerType;
  }
  return cur;
}

function leafTypeTag(schema: unknown): string | undefined {
  return (unwrapLeaf(schema) as { _zod?: { def?: { type?: string } } })?._zod?.def?.type;
}

/**
 * Enumerate every leaf path in a ZodObject tree. Objects recurse; anything
 * else (scalars, arrays, records, unions) is a leaf. Wrapper layers
 * (`.default()` / `.optional()` / `.nullable()`) are transparent.
 */
export function listConfigLeafPaths(root: AnyZ = ConfigSchema): string[][] {
  const out: string[][] = [];
  const visit = (schema: unknown, path: string[]): void => {
    const unwrapped = unwrapLeaf(schema);
    const shape = (unwrapped as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def
      ?.shape;
    if (shape === undefined) {
      if (path.length > 0) out.push(path);
      return;
    }
    for (const [key, child] of Object.entries(shape)) visit(child, [...path, key]);
  };
  visit(root, []);
  return out;
}

/**
 * The full mechanical name table over every config leaf — reverse-lookup
 * source for diagnostics ("OK_AUTO_SYNC_MODE maps to autoSync.mode, which is
 * not env-configurable") and the surface a future ratification widens into.
 */
export function mechanicalEnvNameTable(): ReadonlyMap<string, readonly string[]> {
  const table = new Map<string, readonly string[]>();
  for (const path of listConfigLeafPaths()) table.set(mechanicalEnvName(path), path);
  return table;
}

function parseByLeafType(envVar: string, raw: string, leaf: AnyZ): unknown {
  switch (leafTypeTag(leaf)) {
    case 'boolean': {
      if (raw === '1' || raw === 'true') return true;
      if (raw === '0' || raw === 'false') return false;
      throw new EnvVarError(
        envVar,
        `expected a boolean (1/0/true/false), got ${JSON.stringify(raw)}`,
      );
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new EnvVarError(envVar, `expected a number, got ${JSON.stringify(raw)}`);
      }
      return n;
    }
    case 'array':
      // Space-separated (Redis-style bind lists). Lists replace, never merge.
      return raw.split(/\s+/).filter((entry) => entry !== '');
    default:
      return raw;
  }
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = prev[j] as number;
      prev[j] = next;
    }
  }
  return prev[b.length] as number;
}

function diagnoseUnknownOkVar(
  envVar: string,
  mechanicalTable: ReadonlyMap<string, readonly string[]>,
): EnvDiagnostic | null {
  // `server.port`'s mechanical spelling — the ratified name is unprefixed PORT.
  if (envVar === 'OK_PORT') {
    return { envVar, message: 'OK_PORT is not read — the port variable is unprefixed PORT.' };
  }
  const mapped = mechanicalTable.get(envVar);
  if (mapped !== undefined) {
    return {
      envVar,
      message: `${envVar} maps to config key ${mapped.join('.')}, which is not env-configurable — set it in the config file instead.`,
    };
  }
  for (const known of RECOGNIZED_ENV_VARS.keys()) {
    if (known !== 'PORT' && levenshtein(envVar, known) <= 2) {
      return { envVar, message: `Unknown variable ${envVar} — did you mean ${known}?` };
    }
  }
  return null;
}

/**
 * Overlay a higher-precedence config layer (env values, flag values) onto a
 * base config object. Plain objects merge; scalars and arrays replace (lists
 * replace, never merge). Scope-agnostic by design — precedence between the
 * FILE layers is `mergeLayered`'s job; an env/flag layer sits above all of
 * them and its values are already leaf-validated.
 */
export function applyConfigOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainRecord(value) && isPlainRecord(existing) ? applyConfigOverlay(existing, value) : value;
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the recognized env surface out of `env`. Throws {@link EnvVarError}
 * on a malformed value (boot error); returns did-you-mean diagnostics for
 * suspicious unknown `OK_*` vars. Pure — pass `process.env` at the call site.
 */
export function resolveEnvConfigLayer(env: Record<string, string | undefined>): EnvConfigLayer {
  const overrides: EnvOverride[] = [];
  const diagnostics: EnvDiagnostic[] = [];
  const mechanicalTable = mechanicalEnvNameTable();

  for (const [envVar, path] of RECOGNIZED_ENV_VARS) {
    const raw = env[envVar];
    // Empty/whitespace reads as unset — the `PORT=''` platform quirk, and
    // consistent with the pre-engine `process.env.PORT ? … : undefined` read.
    if (raw === undefined || raw.trim() === '') continue;
    const leaf = resolveLeafSchema(ConfigSchema, path);
    if (leaf === undefined) {
      throw new EnvVarError(envVar, `internal: config path ${path.join('.')} does not resolve`);
    }
    const parsed = parseByLeafType(envVar, raw.trim(), leaf);
    const checked = leaf.safeParse(parsed);
    if (!checked.success) {
      // Surface every validation issue, not just the first — a leaf can fail
      // more than one refinement and reporting one at a time is a slow fix loop.
      const detail = checked.error.issues.map((i) => i.message).join('; ') || 'invalid value';
      throw new EnvVarError(envVar, `${detail} (got ${JSON.stringify(raw)})`);
    }
    overrides.push({ path, envVar, value: checked.data });
  }

  for (const envVar of Object.keys(env)) {
    if (!envVar.startsWith('OK_') || RECOGNIZED_ENV_VARS.has(envVar)) continue;
    if (env[envVar] === undefined) continue;
    const diagnostic = diagnoseUnknownOkVar(envVar, mechanicalTable);
    if (diagnostic !== null) diagnostics.push(diagnostic);
  }

  const layer: Record<string, unknown> = {};
  for (const { path, value } of overrides) {
    let cursor = layer;
    for (const segment of path.slice(0, -1)) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path[path.length - 1] as string] = value;
  }

  return { overrides, layer, diagnostics };
}
