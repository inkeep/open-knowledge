/**
 * Shared skill install-state at `~/.ok/skill-state.yml`.
 *
 * Single user-global YAML file describing the install-state of each
 * actively-gated skill target.
 *
 * Targets:
 *   - `claude-cowork` — written by `buildAndOpenSkill` (server HTTP path) and
 *     `handleBuildAndOpen` (desktop Electron bridge). Read by the renderer's
 *     install gate before triggering a fresh `.skill` rebuild.
 *   - `cli-hosts`     — written by `installUserSkill` after a successful
 *     `npx skills add --agent '*' -g` subprocess. Replaces the legacy
 *     `~/.ok/skill-installed-version` file (migrated on first encounter).
 *
 * `recordedAt` is in-band: the YAML's own mtime is no longer authoritative.
 * `recordedAt` updates on every successful `writeTargetVersion` call,
 * including reinstalls of the same version (preserves the pre-promotion
 * mtime-update semantic).
 *
 * Concurrency:
 *   - Writes are atomic via tmp + rename (`atomicWriteFile` from core util).
 *   - Read-modify-write through `writeTargetVersion` is serialized within
 *     a single Node process by JS event-loop semantics; cross-process
 *     concurrent installs converge via atomic rename — last writer wins.
 *   - Read paths are fail-soft: ENOENT, parse error, or schema violation
 *     return null without throwing (renderer-ladder fall-through contract).
 *
 * Schema lives at `packages/core/src/skill-state/schema.ts`.
 */

import { readFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  emptySkillState,
  SKILL_STATE_REL,
  SKILL_STATE_TARGETS,
  SKILL_STATE_VERSION_RE,
  type SkillState,
  SkillStateSchema,
  type SkillStateSurface,
  type SkillStateTarget,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile, withFileLock } from '@inkeep/open-knowledge-core/server';
import { type ParsedNode, parseDocument } from 'yaml';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';

const readFileAsync = promisify(readFile);

// Re-exports for downstream callers (HTTP handlers, MCP tools, CLI):
// keep importing from this module rather than core for a stable surface.
export {
  resolveBundleEnabled,
  SKILL_STATE_TARGETS,
  type SkillStateSurface,
  type SkillStateTarget,
} from '@inkeep/open-knowledge-core';

/** Path to the skill-state YAML file under `$home`. */
export function skillStateYamlPath(home: string): string {
  return join(home, ...SKILL_STATE_REL);
}

/**
 * Serialize a read-modify-write against `skill-state.yml`. Every writer
 * (`writeBundleDecision`, `writeTargetVersion`) full-file RMWs the same file,
 * and at desktop launch a fire-and-forget reclaim grandfather-write can race
 * the dialog's consent decision on the same path. The advisory lock turns
 * "last writer wins" into "writers serialize", so a grandfather write can't
 * clobber a freshly-recorded decline. Fail-soft: on lock-acquire timeout,
 * fall through and write anyway (degrading to the prior last-writer-wins
 * behavior) rather than dropping the write.
 */
async function withSkillStateWriteLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const path = skillStateYamlPath(home);
  // The lockfile lives beside skill-state.yml; create `~/.ok/` first (the
  // writer would otherwise be the one to mkdir it, but that runs inside the
  // lock, so the lockfile's openSync would ENOENT on a fresh home).
  await tracedMkdir(dirname(path), { recursive: true });
  try {
    return await withFileLock(`${path}.lock`, fn);
  } catch (err) {
    if ((err as { code?: string }).code === 'LOCK_TIMEOUT') return fn();
    throw err;
  }
}

/**
 * Minimal logger duck-type. Compatible with `PinoLogger` (`warn(data, msg)`)
 * and ad-hoc shims.
 */
export interface SkillStateLogger {
  warn: (data: unknown, message: string) => void;
  info?: (data: unknown, message: string) => void;
}

/**
 * Console-backed logger used as the default when callers don't pass one.
 * Emits structured payloads via `console.warn(message, data)` so the
 * `event` field stays observable in stdout/journald regardless of whether
 * a Pino logger is wired.
 */
const DEFAULT_LOGGER: SkillStateLogger = {
  warn: (data, message) => console.warn(message, data),
};

/**
 * Adapter that routes core's atomic write through the server's traced
 * fs primitives so disk writes show up as `fs.*` spans.
 */
/**
 * Read and validate `~/.ok/skill-state.yml`. Returns:
 *   - `null` on ENOENT, YAML parse error, or schema violation (fail-soft).
 *   - The validated SkillState on success.
 *
 * Other fs errors (EACCES, EIO, …) propagate so the caller decides whether
 * to fail-soft (renderer-bound gate) or fail-hard. Callers that want
 * strict behavior on parse / schema issues use `SkillStateSchema.safeParse`
 * directly on raw YAML they control.
 */
export async function readSkillStateFile(
  home: string,
  logger: SkillStateLogger = DEFAULT_LOGGER,
): Promise<SkillState | null> {
  const path = skillStateYamlPath(home);
  let content: string;
  try {
    content = await readFileAsync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    logger.warn(
      {
        event: 'skill-state.yaml-parse-error',
        path,
        errors: doc.errors.map((e) => e.message),
      },
      'skill-state.yml parse failed; treating as fresh install',
    );
    return null;
  }

  const parsed = SkillStateSchema.safeParse(doc.toJSON());
  if (!parsed.success) {
    const schemaIssue = parsed.error.issues.find(
      (issue) => issue.path.length === 1 && issue.path[0] === 'schema',
    );
    if (schemaIssue) {
      logger.warn(
        {
          event: 'skill-state.invalid-schema-version',
          path,
          issue: schemaIssue.message,
        },
        'skill-state.yml has unknown schema version; treating as fresh install',
      );
    } else {
      logger.warn(
        {
          event: 'skill-state.schema-violation',
          path,
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        'skill-state.yml failed schema validation; treating as fresh install',
      );
    }
    return null;
  }

  return parsed.data;
}

/**
 * Write a validated SkillState atomically. Validates via `SkillStateSchema`
 * before write — refuses to persist a malformed document. Caller is
 * responsible for assembling the `SkillState` object correctly; this is
 * not an "apply patch" surface. Most callers use `writeTargetVersion`
 * which handles read-modify-write.
 */
async function writeSkillStateFile(home: string, state: SkillState): Promise<void> {
  const parsed = SkillStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `Refusing to write invalid skill-state: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const path = skillStateYamlPath(home);
  await tracedMkdir(dirname(path), { recursive: true });

  // Build YAML from the validated object. Cast matches the pattern in
  // `write-config-patch.ts` — yaml@2's createNode returns a non-Parsed
  // Node but the Document accepts it after assignment.
  const doc = parseDocument('');
  doc.contents = doc.createNode(parsed.data) as ParsedNode;
  const serialized = doc.toString();

  await atomicWriteFile(path, serialized, { fs: tracedAtomicFs });
}

/**
 * Read the recorded version for a target.
 *
 * Returns `null` on:
 *   - file absent (ENOENT)
 *   - YAML parse error
 *   - schema violation (including unknown schema version)
 *   - target absent in `targets`
 */
export async function readTargetVersion(
  home: string,
  target: SkillStateTarget,
  logger?: SkillStateLogger,
): Promise<string | null> {
  const state = await readSkillStateFile(home, logger);
  if (state === null) return null;
  const entry = state.targets[target];
  return entry?.version ?? null;
}

/**
 * Read the recorded `recordedAt` for a target.
 *
 * Source of truth is the in-band `recordedAt` field; the YAML file's mtime
 * is no longer authoritative. Returns `null` on the same conditions as
 * `readTargetVersion`.
 */
export async function readTargetRecordedAt(
  home: string,
  target: SkillStateTarget,
  logger?: SkillStateLogger,
): Promise<string | null> {
  const state = await readSkillStateFile(home, logger);
  if (state === null) return null;
  const entry = state.targets[target];
  return entry?.recordedAt ?? null;
}

/**
 * Write the recorded version for a target. Atomic via tmp + rename.
 *
 * `surface` is optional install-source attribution. When omitted, the
 * existing entry's `surface` (if any) is preserved; passing a value
 * overwrites it. `recordedAt` is updated to "now" on every successful
 * call, including reinstalls of the same version.
 *
 * Errors propagate (existing `installUserSkill` contract: write failure
 * flips the subprocess result to `'failed'`). The renderer-bound gate
 * treats write failure as "guard didn't persist; install will run again
 * on next click".
 */
export async function writeTargetVersion(
  home: string,
  target: SkillStateTarget,
  version: string,
  surface?: SkillStateSurface,
  logger?: SkillStateLogger,
): Promise<void> {
  if (!SKILL_STATE_VERSION_RE.test(version)) {
    throw new Error(`Refusing to write invalid version string: ${version}`);
  }

  await withSkillStateWriteLock(home, async () => {
    // Read existing or start fresh. A fresh document is generated when the
    // file is absent or unreadable — same fail-soft contract as readers.
    const existing = (await readSkillStateFile(home, logger)) ?? emptySkillState();
    const recordedAt = new Date().toISOString();

    // Preserve existing surface when caller doesn't pass one.
    const previousEntry = existing.targets[target];
    const nextSurface = surface !== undefined ? surface : (previousEntry?.surface ?? undefined);

    const entry =
      nextSurface !== undefined
        ? { version, recordedAt, surface: nextSurface }
        : { version, recordedAt };

    const next: SkillState = {
      ...existing,
      targets: {
        ...existing.targets,
        [target]: entry,
      },
    };

    await writeSkillStateFile(home, next);
  });
}

// ─── Per-bundle opt-in decisions ───────────────────────────────────────────
//
// The two user-global bundles (`open-knowledge-discovery`,
// `open-knowledge-write-skill`) are opt-out-able via the first-launch consent
// dialog and `ok init --skills`. The decision lives under the top-level
// `bundles` map keyed by install NAME, separate from the version-keyed
// `targets`. Every install actor (desktop reclaim, CLI sweep, `ok init`,
// dialog confirm) reads `resolveBundleEnabled` (re-exported from core above)
// so a declined bundle is never re-installed.

/**
 * Read the recorded opt-in decision for a bundle (by install name). Returns
 * `null` when the file is absent, unreadable, or carries no entry for this
 * bundle — the caller applies `resolveBundleEnabled` grandfathering.
 */
export async function readBundleDecision(
  home: string,
  bundleName: string,
  logger?: SkillStateLogger,
): Promise<boolean | null> {
  const state = await readSkillStateFile(home, logger).catch(() => null);
  const entry = state?.bundles?.[bundleName];
  return typeof entry?.enabled === 'boolean' ? entry.enabled : null;
}

/**
 * Record an opt-in decision for a bundle. Atomic RMW that preserves `targets`
 * and any other bundles' decisions; stamps `decidedAt` to now.
 */
export async function writeBundleDecision(
  home: string,
  bundleName: string,
  enabled: boolean,
  logger?: SkillStateLogger,
): Promise<void> {
  await withSkillStateWriteLock(home, async () => {
    const existing = (await readSkillStateFile(home, logger)) ?? emptySkillState();
    const next: SkillState = {
      ...existing,
      bundles: {
        ...existing.bundles,
        [bundleName]: { enabled, decidedAt: new Date().toISOString() },
      },
    };
    await writeSkillStateFile(home, next);
  });
}

/**
 * Canonical skill version: the `version` field of
 * `@inkeep/open-knowledge-server`'s `package.json`. Exposed to the renderer
 * via `GET /api/skill/install-state` so callers don't have to worry about
 * which version namespace to compare against.
 */
export async function readServerPackageVersion(): Promise<string> {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const raw = await readFileAsync(fileURLToPath(pkgUrl), 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('@inkeep/open-knowledge-server/package.json missing version field');
  }
  return parsed.version;
}

/** Public snapshot returned by `GET /api/skill/install-state`. */
export interface SkillInstallStateSnapshot {
  currentVersion: string;
  targets: Record<SkillStateTarget, { version: string; recordedAt: string } | null>;
}

/**
 * Build the full GET-endpoint snapshot. If `readServerPackageVersion`
 * throws (corrupt or missing package.json) the caller is expected to
 * surface a 500 — we don't fall back here because a missing version is
 * genuine breakage, not a per-target absence.
 */
export async function readSkillInstallStateSnapshot(
  home: string,
  logger?: SkillStateLogger,
): Promise<SkillInstallStateSnapshot> {
  const [currentVersion, targets] = await Promise.all([
    readServerPackageVersion(),
    readAllTargets(home, logger),
  ]);
  return { currentVersion, targets };
}

/**
 * Read the per-target snapshot. Each target resolves independently — a
 * missing or unreadable target shows as `null` for that target alone; the
 * snapshot still resolves.
 *
 * Errors during file read are NOT propagated here — this function follows
 * the renderer-bound contract "missing target → null." Callers needing
 * strict semantics use `readTargetVersion` directly.
 */
export async function readAllTargets(
  home: string,
  logger: SkillStateLogger = DEFAULT_LOGGER,
): Promise<Record<SkillStateTarget, { version: string; recordedAt: string } | null>> {
  let state: SkillState | null = null;
  try {
    state = await readSkillStateFile(home, logger);
  } catch (err) {
    // Non-ENOENT errors (EACCES, EIO, …) collapse to `null` for the
    // GET-endpoint contract, but we surface them as a warning so
    // permission/IO issues on `~/.ok/skill-state.yml` don't go invisible.
    logger.warn(
      {
        event: 'skill-state.read-error',
        path: skillStateYamlPath(home),
        error: String(err),
      },
      'non-ENOENT error reading skill-state.yml; treating as absent',
    );
    state = null;
  }

  const entries = SKILL_STATE_TARGETS.map((target) => {
    const entry = state?.targets[target];
    if (!entry) return [target, null] as const;
    return [target, { version: entry.version, recordedAt: entry.recordedAt }] as const;
  });

  return Object.fromEntries(entries) as Record<
    SkillStateTarget,
    { version: string; recordedAt: string } | null
  >;
}
