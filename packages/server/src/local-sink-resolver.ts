
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';

export interface ResolveLocalSinkArgs {
  projectDir: string;
}

export interface ResolvedLocalSink {
  telemetry: {
    projectDir: string;
    spansMaxBytes: number;
    attributeDenylist: readonly string[];
  };
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

function readRawSinkBlock(absPath: string): RawLocalSinkBlock {
  if (!existsSync(absPath)) return {};
  let parsed: unknown;
  try {
    const source = readFileSync(absPath, 'utf-8');
    parsed = parseYaml(source);
  } catch (err) {
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

export function resolveLocalSinkConfig(args: ResolveLocalSinkArgs): ResolvedLocalSink | null {
  if (process.env.OK_DISABLE_LOCAL_SINK === '1' || process.env.OK_DISABLE_LOCAL_SINK === 'true') {
    return null;
  }

  const projectSink = readRawSinkBlock(resolveConfigPath('project', args.projectDir));
  const localSink = readRawSinkBlock(resolveConfigPath('project-local', args.projectDir));

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
