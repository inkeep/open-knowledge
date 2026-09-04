import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLogger } from './logger.ts';
import { PROTOCOL_VERSION, RUNTIME_VERSION, STATE_SCHEMA_VERSION } from './version-constants.ts';

export const STATE_MANIFEST_FILENAME = 'state.json';

export interface StateManifestWriter {
  runtimeVersion: string;
  protocolVersion?: number;
  adoptedAt?: string;
}

export interface StateManifestRecord {
  stateSchemaVersion: number;
  createdAt: string;
  createdBy: StateManifestWriter;
  lastWriteBy?: StateManifestWriter & { at: string };
}

export type ProjectShape = 'fresh' | 'adopt';

export function detectProjectShape(opts: { lockDir: string; shadowRepoDir: string }): ProjectShape {
  void opts.lockDir;
  if (existsSync(opts.shadowRepoDir)) return 'adopt';
  return 'fresh';
}

function manifestPath(lockDir: string): string {
  return resolve(lockDir, STATE_MANIFEST_FILENAME);
}

function isCompatibleSchema(manifestSchema: number, currentSchema: number): boolean {
  if (manifestSchema === currentSchema) return true;
  if (manifestSchema === 0 && currentSchema === 1) return true;
  return false;
}

export class StateManifestError extends Error {
  readonly kind: 'corrupt' | 'incompatible';
  readonly path: string;
  constructor(args: {
    kind: 'corrupt' | 'incompatible';
    path: string;
    message: string;
  }) {
    super(args.message);
    this.name = 'StateManifestError';
    this.kind = args.kind;
    this.path = args.path;
  }
}

export type ReadStateManifestResult =
  | { status: 'absent' }
  | { status: 'present'; manifest: StateManifestRecord };

function isStateManifestRecord(value: unknown): value is StateManifestRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.stateSchemaVersion !== 'number') return false;
  if (typeof v.createdAt !== 'string') return false;
  if (!v.createdBy || typeof v.createdBy !== 'object') return false;
  const c = v.createdBy as Record<string, unknown>;
  if (typeof c.runtimeVersion !== 'string') return false;
  if (c.protocolVersion !== undefined && typeof c.protocolVersion !== 'number') return false;
  return true;
}

export function readStateManifest(lockDir: string): ReadStateManifestResult {
  const path = manifestPath(lockDir);
  if (!existsSync(path)) return { status: 'absent' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new StateManifestError({
      kind: 'corrupt',
      path,
      message: `Failed to read state manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateManifestError({
      kind: 'corrupt',
      path,
      message: `State manifest at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!isStateManifestRecord(parsed)) {
    throw new StateManifestError({
      kind: 'corrupt',
      path,
      message: `State manifest at ${path} has invalid shape (missing or wrong-typed required fields)`,
    });
  }
  return { status: 'present', manifest: parsed };
}

export function writeStateManifest(lockDir: string, record: StateManifestRecord): void {
  const path = manifestPath(lockDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

interface AssertCompatibleStateManifestOptions {
  lockDir: string;
  shadowRepoDir: string;
  currentStateSchemaVersion?: number;
  currentRuntimeVersion?: string;
  currentProtocolVersion?: number;
  now?: () => Date;
}

export function assertCompatibleStateManifest(
  opts: AssertCompatibleStateManifestOptions,
): StateManifestRecord {
  const log = getLogger('state-manifest');
  const currentStateSchemaVersion = opts.currentStateSchemaVersion ?? STATE_SCHEMA_VERSION;
  const currentRuntimeVersion = opts.currentRuntimeVersion ?? RUNTIME_VERSION;
  const currentProtocolVersion = opts.currentProtocolVersion ?? PROTOCOL_VERSION;
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const path = manifestPath(opts.lockDir);

  const read = readStateManifest(opts.lockDir);

  if (read.status === 'present') {
    const m = read.manifest;
    if (!isCompatibleSchema(m.stateSchemaVersion, currentStateSchemaVersion)) {
      throw new StateManifestError({
        kind: 'incompatible',
        path,
        message:
          `State manifest at ${path} declares stateSchemaVersion=${m.stateSchemaVersion} ` +
          `but this binary supports ${currentStateSchemaVersion}. ` +
          `Refusing to boot — on-the-fly migration is out of scope. ` +
          `(Manifest written by runtime ${m.createdBy.runtimeVersion}, ` +
          `protocol ${m.createdBy.protocolVersion}.)`,
      });
    }
    try {
      const updated: StateManifestRecord = {
        ...m,
        lastWriteBy: {
          runtimeVersion: currentRuntimeVersion,
          protocolVersion: currentProtocolVersion,
          at: nowIso,
        },
      };
      writeStateManifest(opts.lockDir, updated);
      return updated;
    } catch (err) {
      log.warn({ err }, '[state-manifest] failed to update lastWriteBy — proceeding');
      return m;
    }
  }

  const shape = detectProjectShape({
    lockDir: opts.lockDir,
    shadowRepoDir: opts.shadowRepoDir,
  });

  if (shape === 'fresh') {
    const fresh: StateManifestRecord = {
      stateSchemaVersion: currentStateSchemaVersion,
      createdAt: nowIso,
      createdBy: {
        runtimeVersion: currentRuntimeVersion,
        protocolVersion: currentProtocolVersion,
      },
    };
    writeStateManifest(opts.lockDir, fresh);
    log.info(
      { path, stateSchemaVersion: currentStateSchemaVersion },
      '[state-manifest] fresh project — wrote manifest',
    );
    return fresh;
  }

  const adopted: StateManifestRecord = {
    stateSchemaVersion: 0,
    createdAt: nowIso,
    createdBy: {
      runtimeVersion: currentRuntimeVersion,
      protocolVersion: currentProtocolVersion,
      adoptedAt: nowIso,
    },
  };
  writeStateManifest(opts.lockDir, adopted);
  log.warn(
    { path, runtimeVersion: currentRuntimeVersion },
    '[state-manifest] adopting pre-versioned project — wrote schema-0 manifest. ' +
      'Future binaries with STATE_SCHEMA_VERSION>=2 may refuse if they cannot read schema-0 state.',
  );
  return adopted;
}
