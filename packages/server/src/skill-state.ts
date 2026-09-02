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
import { getLogger } from './logger.ts';

const readFileAsync = promisify(readFile);

export {
  resolveBundleEnabled,
  SKILL_STATE_TARGETS,
  type SkillStateSurface,
  type SkillStateTarget,
} from '@inkeep/open-knowledge-core';

export function skillStateYamlPath(home: string): string {
  return join(home, ...SKILL_STATE_REL);
}

async function withSkillStateWriteLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const path = skillStateYamlPath(home);
  await tracedMkdir(dirname(path), { recursive: true });
  try {
    return await withFileLock(`${path}.lock`, fn);
  } catch (err) {
    if ((err as { code?: string }).code === 'LOCK_TIMEOUT') return fn();
    throw err;
  }
}

export interface SkillStateLogger {
  warn: (data: unknown, message: string) => void;
  info?: (data: unknown, message: string) => void;
}

const DEFAULT_LOGGER: SkillStateLogger = {
  warn: (data, message) => getLogger('skills').warn(data, message),
};

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

  const doc = parseDocument('');
  doc.contents = doc.createNode(parsed.data) as ParsedNode;
  const serialized = doc.toString();

  await atomicWriteFile(path, serialized, { fs: tracedAtomicFs });
}

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
    const existing = (await readSkillStateFile(home, logger)) ?? emptySkillState();
    const recordedAt = new Date().toISOString();

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

export async function readBundleDecision(
  home: string,
  bundleName: string,
  logger?: SkillStateLogger,
): Promise<boolean | null> {
  const state = await readSkillStateFile(home, logger);
  const entry = state?.bundles?.[bundleName];
  return typeof entry?.enabled === 'boolean' ? entry.enabled : null;
}

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

export async function readInstallReported(
  home: string,
  logger?: SkillStateLogger,
): Promise<Set<string>> {
  const state = await readSkillStateFile(home, logger).catch(() => null);
  return new Set(state?.installsReported ?? []);
}

export async function writeInstallReported(
  home: string,
  keys: readonly string[],
  logger?: SkillStateLogger,
): Promise<void> {
  if (keys.length === 0) return;
  await withSkillStateWriteLock(home, async () => {
    const existing = (await readSkillStateFile(home, logger)) ?? emptySkillState();
    const merged = new Set([...(existing.installsReported ?? []), ...keys]);
    await writeSkillStateFile(home, { ...existing, installsReported: [...merged].sort() });
  });
}

export async function clearInstallReported(
  home: string,
  keys: readonly string[],
  logger?: SkillStateLogger,
): Promise<void> {
  if (keys.length === 0) return;
  await withSkillStateWriteLock(home, async () => {
    const existing = await readSkillStateFile(home, logger);
    if (!existing?.installsReported?.length) return;
    const drop = new Set(keys);
    const kept = existing.installsReported.filter((k) => !drop.has(k));
    if (kept.length === existing.installsReported.length) return;
    await writeSkillStateFile(home, { ...existing, installsReported: kept });
  });
}

export async function readServerPackageVersion(): Promise<string> {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const raw = await readFileAsync(fileURLToPath(pkgUrl), 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('@inkeep/open-knowledge-server/package.json missing version field');
  }
  return parsed.version;
}

export interface SkillInstallStateSnapshot {
  currentVersion: string;
  targets: Record<SkillStateTarget, { version: string; recordedAt: string } | null>;
}

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

export async function readAllTargets(
  home: string,
  logger: SkillStateLogger = DEFAULT_LOGGER,
): Promise<Record<SkillStateTarget, { version: string; recordedAt: string } | null>> {
  let state: SkillState | null = null;
  try {
    state = await readSkillStateFile(home, logger);
  } catch (err) {
    logger.warn(
      {
        event: 'skill-state.read-error',
        path: skillStateYamlPath(home),
        err,
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
