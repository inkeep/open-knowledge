/**
 * Resolve the `telemetry.localSink` block from a project's config files,
 * shared by every server boot path (CLI `bootServer`, Electron utility,
 * Vite dev plugin → `createServer`).
 *
 * Reads project + project-local configs as raw YAML so we can detect
 * explicit presence: schema-defaulted values from `readConfigSafely` would
 * otherwise make project-local always shadow project (project commits
 * `enabled: false` → sink stays on because local's empty config defaults
 * to `enabled: true`). The cascade is per-leaf: project-local explicit
 * wins; project explicit wins next; schema defaults backstop.
 *
 * Returns `null` when the sink is disabled — the caller skips both the file
 * SpanExporter wiring and the Pino fileSink wiring on null.
 *
 * Project-local override exists because the field-registry scope for the
 * leaves is `project` (defaults shared across collaborators), but a single
 * developer may want to disable the sink on one machine without committing
 * the change.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';

export interface ResolveLocalSinkArgs {
  /**
   * Project root (where `.ok/` lives). Drives both the config lookups AND the
   * sink file location — the spans/logs land under `<projectDir>/.ok/local/`,
   * anchored on the project root like `server.lock` / `principal.json` /
   * `state.json` (`getLocalDir`). Anchoring on `content.dir` instead would
   * spawn a SECOND `.ok/` inside the content sub-folder whenever
   * `content.dir != '.'`.
   */
  projectDir: string;
}

export interface ResolvedLocalSink {
  /** For `initTelemetry({ localSink: ... })` — the file SpanExporter config. */
  telemetry: {
    projectDir: string;
    spansMaxBytes: number;
    attributeDenylist: readonly string[];
  };
  /** For `PinoFileSink` — the log destination config. */
  logs: {
    projectDir: string;
    maxBytes: number;
  };
}

interface RawLocalSinkBlock {
  enabled?: unknown;
  spans?: { maxBytes?: unknown } | null;
  logs?: { maxBytes?: unknown } | null;
  attributeDenylist?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse the raw YAML at `absPath` and extract the `telemetry.localSink`
 * sub-tree, preserving explicit presence vs absence. Returns `{}` when the
 * file is missing, unreadable, malformed, or doesn't carry that block —
 * downstream cascade then falls through to the next layer or to the schema
 * default. We deliberately avoid `readConfigSafely` here: it applies schema
 * defaults, which would make project-local always shadow project even when
 * the user left the local file empty.
 */
function readRawSinkBlock(absPath: string): RawLocalSinkBlock {
  if (!existsSync(absPath)) return {};
  let parsed: unknown;
  try {
    const source = readFileSync(absPath, 'utf-8');
    parsed = parseYaml(source);
  } catch (err) {
    // Surface the parse failure: silent fallback re-enables the sink to the
    // schema default even when the user explicitly set `enabled: false` in a
    // config that later developed a YAML error. The structured logger isn't
    // available yet (telemetry init reads this), so console.warn is the only
    // observable channel here.
    console.warn(
      `[telemetry.localSink] failed to parse ${absPath}; falling back to schema defaults — ` +
        'any explicit telemetry.localSink fields in this file are being ignored. ' +
        `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (!isObject(parsed)) return {};
  const telemetry = parsed.telemetry;
  if (!isObject(telemetry)) return {};
  const localSink = telemetry.localSink;
  if (!isObject(localSink)) return {};
  return localSink as RawLocalSinkBlock;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value as readonly string[];
}

function readMaxBytes(
  block: RawLocalSinkBlock['spans'] | RawLocalSinkBlock['logs'],
): number | undefined {
  if (!isObject(block)) return undefined;
  return readPositiveNumber(block.maxBytes);
}

/**
 * Read project + project-local configs and resolve `telemetry.localSink`.
 * Returns `null` when the sink is disabled (caller skips file wiring).
 *
 * Best-effort: failing reads fall back to schema defaults via the raw-YAML
 * helper's `{}` return. The sink stays default-on even when the config file
 * is missing or corrupt — diagnostics should be captured for the exact bug
 * reports that would otherwise produce nothing.
 */
export function resolveLocalSinkConfig(args: ResolveLocalSinkArgs): ResolvedLocalSink | null {
  // Test-only opt-out — set by integration tests that pre-install their own
  // OTel global provider (e.g. boot.test.ts's `ok.boot OTel span attributes`
  // suite that wires an InMemorySpanExporter). With the env var set, bootServer
  // skips the file pipeline so it doesn't overwrite the test's provider via
  // `trace.setGlobalTracerProvider`. Not a production knob — the canonical
  // disable path is `telemetry.localSink.enabled: false` in config.yml.
  if (process.env.OK_DISABLE_LOCAL_SINK === '1' || process.env.OK_DISABLE_LOCAL_SINK === 'true') {
    return null;
  }

  const projectSink = readRawSinkBlock(resolveConfigPath('project', args.projectDir));
  const localSink = readRawSinkBlock(resolveConfigPath('project-local', args.projectDir));

  // Per-leaf cascade — project-local explicit > project explicit > schema
  // default. Each `read*` helper only returns a value when the leaf is
  // explicitly present in the parsed YAML; an absent key is `undefined` and
  // falls through to the next layer.
  const enabled = readBoolean(localSink.enabled) ?? readBoolean(projectSink.enabled) ?? true;
  if (enabled === false) {
    return null;
  }

  const spansMaxBytes =
    readMaxBytes(localSink.spans) ?? readMaxBytes(projectSink.spans) ?? DEFAULT_SPANS_MAX_BYTES;
  const logsMaxBytes =
    readMaxBytes(localSink.logs) ?? readMaxBytes(projectSink.logs) ?? DEFAULT_LOGS_MAX_BYTES;
  const attributeDenylist =
    readStringArray(localSink.attributeDenylist) ??
    readStringArray(projectSink.attributeDenylist) ??
    DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST;

  return {
    telemetry: {
      projectDir: args.projectDir,
      spansMaxBytes,
      attributeDenylist,
    },
    logs: {
      projectDir: args.projectDir,
      maxBytes: logsMaxBytes,
    },
  };
}
