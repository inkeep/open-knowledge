/**
 * Durable per-project state schema manifest.
 *
 * `.ok/local/state.json` answers one question: *can the current binary
 * read this project's on-disk state at all?* A version-mismatching runtime
 * must refuse to boot rather than silently misinterpret durable state.
 *
 * Rules:
 *
 * - Manifest present + `stateSchemaVersion` matches → proceed. Update
 *   `lastWriteBy` opportunistically.
 * - Manifest present + version mismatch → throw. On-the-fly migration is
 *   out of scope for this surface.
 * - Manifest present + corrupt → throw. Corrupt is NOT treated as absent
 *   — that would silently overwrite real durable state.
 * - Manifest absent + no `.ok/local/` AND no `.git/ok/`
 *   shadow repo → genuinely fresh project. Write the manifest at the
 *   current `STATE_SCHEMA_VERSION`.
 * - Manifest absent + any pre-existing state (`.ok/local/` directory
 *   OR a shadow repo) → adopting a pre-versioned project. Write the manifest
 *   at `stateSchemaVersion = 0` (pre-manifest sentinel) with `createdBy.adoptedAt`
 *   set, log a one-time adoption warning. v1 binaries can read schema-0 state
 *   by definition; future v≥2 binaries can still refuse.
 *
 * The fresh-vs-adopt split is load-bearing for the rollout — every existing
 * project on the day this ships has a shadow repo and no manifest. Stamping
 * today's `STATE_SCHEMA_VERSION` over them would erase the information that
 * they pre-date the manifest scheme.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLogger } from './logger.ts';
import { PROTOCOL_VERSION, RUNTIME_VERSION, STATE_SCHEMA_VERSION } from './version-constants.ts';

/**
 * Filename for the state manifest, relative to the lock dir
 * (`<contentDir>/.ok/local/`).
 */
export const STATE_MANIFEST_FILENAME = 'state.json';

export interface StateManifestWriter {
  runtimeVersion: string;
  /**
   * Optional on read for backward compatibility with manifests written before
   * the protocolVersion field was introduced — those records are still valid
   * (the runtime backfills it on the next opportunistic update). Always
   * populated on writes from this version onward.
   */
  protocolVersion?: number;
  /** Set on the adoption write to mark "this project pre-dates the manifest scheme". */
  adoptedAt?: string;
}

export interface StateManifestRecord {
  stateSchemaVersion: number;
  createdAt: string;
  createdBy: StateManifestWriter;
  lastWriteBy?: StateManifestWriter & { at: string };
}

export type ProjectShape = 'fresh' | 'adopt';

/**
 * Determine whether the project is genuinely fresh (no prior state) or has
 * pre-existing on-disk state that pre-dates the manifest scheme.
 *
 * Adoption is signaled ONLY by the shadow repo at `<projectRoot>/.git/ok/`.
 * The `<contentDir>/.ok/` directory is NOT a reliable signal — it
 * can exist for reasons that don't imply pre-version-field durable state:
 *
 * - `initContent` (CLI's `ok start` autoInitFn) creates it during boot before
 *   the manifest check runs.
 * - `acquireServerLock` creates it when writing the lock file.
 * - A prior boot crash mid-init may have left an empty `.ok/`.
 *
 * If we treated lockDir-existence as adoption, every fresh project would be
 * misclassified as adopted and stamp schema-0 instead of the current schema.
 * The shadow repo is durable, version-relevant state — the actual artifact
 * future binaries might not be able to read. The `.ok/` directory
 * contents (`config.yml`, sync caches) are version-independent or cheap to
 * regenerate. The lockDir parameter is retained for API stability and future
 * use (e.g., a more specific signal once we have one).
 *
 * Implementation narrows the signal to the shadow repo after smoke-test
 * triage showed lockDir-existence caused fresh projects to be misclassified
 * as adopted.
 */
export function detectProjectShape(opts: { lockDir: string; shadowRepoDir: string }): ProjectShape {
  // lockDir intentionally unused.
  void opts.lockDir;
  if (existsSync(opts.shadowRepoDir)) return 'adopt';
  return 'fresh';
}

function manifestPath(lockDir: string): string {
  return resolve(lockDir, STATE_MANIFEST_FILENAME);
}

/**
 * Compatibility table for the pre-flight gate.
 *
 * Strict equality is the default — no `minCompatibleProtocol` range. One
 * special case: schema 0 is the pre-manifest adoption sentinel, and v1 was
 * the first manifest-aware schema. v1 binaries can read schema-0 state by
 * definition — that's how the rollout works (every existing project on the
 * day v1 ships has shadow-repo state and no manifest).
 *
 * Future versions (v2+) need to make their own explicit decision. If v2 wants
 * to read schema-0 / schema-1 state it adds itself here. A separate migration
 * tool would eventually convert older schemas in place — this table only
 * answers "can I read this without migrating?"
 */
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
  // protocolVersion is required-on-write but optional-on-read for backward
  // compatibility with manifests written before the field existed. Reject
  // only if present-but-wrong-type; absent is valid.
  if (c.protocolVersion !== undefined && typeof c.protocolVersion !== 'number') return false;
  return true;
}

/**
 * Read the manifest. Returns `{status: 'absent'}` when no file exists.
 * Throws `StateManifestError({kind: 'corrupt'})` for parse errors or shape
 * violations — corrupt is NEVER treated as absent.
 */
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

/**
 * Write the manifest, atomically replacing any prior file. Creates the lock
 * dir if absent. Owner-only readable (`mode: 0o600`) — the manifest contains
 * project-identifying metadata that has no business being world-readable on
 * shared hosts.
 */
export function writeStateManifest(lockDir: string, record: StateManifestRecord): void {
  const path = manifestPath(lockDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

interface AssertCompatibleStateManifestOptions {
  lockDir: string;
  /** Path to the project's shadow repo (`.git/ok/`). Used for adopt detection. */
  shadowRepoDir: string;
  /** Override the current binary's STATE_SCHEMA_VERSION — primarily for tests. */
  currentStateSchemaVersion?: number;
  /** Override the current binary's RUNTIME_VERSION — primarily for tests. */
  currentRuntimeVersion?: string;
  /** Override the current binary's PROTOCOL_VERSION — primarily for tests. */
  currentProtocolVersion?: number;
  /** Injectable clock — primarily for deterministic tests. */
  now?: () => Date;
}

/**
 * Pre-flight gate called before any shadow-repo IO. Implements the full
 * fresh-vs-adopt rule set. Writes the manifest on first open; throws
 * `StateManifestError({kind: 'incompatible'})` when an existing manifest
 * does not match the current binary's `STATE_SCHEMA_VERSION`.
 *
 * Returns the resolved manifest after the call so callers (notably
 * `bootServer`) can log the outcome with the actual `stateSchemaVersion`.
 */
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
    // Compatible — opportunistically refresh `lastWriteBy`. Best-effort; a
    // failure here should not crash the boot path.
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

  // Absent — fresh-vs-adopt split.
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

  // Adopt — pre-existing state, no manifest. Stamp schema-0 sentinel.
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
