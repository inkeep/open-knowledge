/**
 * Hierarchical YAML config loader.
 *
 * Priority (lowest → highest):
 *   Zod defaults → ~/.ok/global.yml → ./.ok/config.yml
 *
 * ENV and CLI flag overrides are applied in cli.ts after loading.
 *
 * Deep merge: project leaf values override user leaf values.
 * Arrays are replaced, not concatenated.
 *
 * Errors are emitted with source positions via yaml@2's `parseDocument` —
 * `file:line:col` plus a code-snippet with caret marker.
 *
 * The user-global file (`~/.ok/global.yml`) is distinct from project
 * `.ok/config.yml` so the ancestor-walk that detects an OK project can't
 * treat the user's home directory as a project root.
 *
 * The user-global file is read via `readConfigSafely` — invalid files are
 * sidelined to `<path>.invalid-<ISO-timestamp>` and replaced with schema
 * defaults so OK can still boot. The project file errors loud (throws) —
 * project errors are user-fixable in-place and failing fast helps the user
 * notice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ConfigIssue,
  type ConfigValidationError,
  detectRemovedKeys,
  humanFormat,
  locateIssue,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
import { type Document, parseDocument } from 'yaml';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { isObject } from '../utils/is-object.ts';
import { normalizeCwd } from '../utils/normalize-cwd.ts';

export interface LoadConfigResult {
  config: Config;
  sources: string[];
}

/** Short TTL for per-cwd config resolution in long-lived MCP sessions. */
const DEFAULT_CONFIG_CACHE_MS = 1000;

/**
 * Deep merge two objects. Leaf values in `override` replace `base`.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (isObject(overrideVal) && isObject(baseVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

interface LoadedYamlFile {
  /** Parsed JS object (or null if the file is empty / comments-only / missing). */
  value: Record<string, unknown> | null;
  /** Absolute path read. */
  path: string;
  /** Raw file source — needed for source-position rendering on validation failure. */
  source: string | null;
  /** yaml@2 Document AST — needed for `getIn(path)` → byte range translation. */
  doc: Document | null;
}

/**
 * Load a YAML file via parseDocument (source-position-preserving). Returns
 * the parsed JS value plus the Document AST + raw source so callers can
 * locate Zod issues back to file:line:col.
 *
 * On YAML syntax errors, logs a warning and returns `value: null` (existing
 * graceful-degradation semantic — broken project YAML doesn't block boot;
 * the user fixes the file and reloads).
 */
function loadYamlFile(filePath: string): LoadedYamlFile {
  if (!existsSync(filePath)) {
    return { value: null, path: filePath, source: null, doc: null };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(
      `[config] Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
    return { value: null, path: filePath, source: null, doc: null };
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    console.warn(
      `[config] Failed to parse ${filePath}: ${doc.errors.map((e) => e.message).join('; ')}`,
    );
    return { value: null, path: filePath, source: raw, doc: null };
  }
  const parsed = doc.toJSON();
  if (isObject(parsed)) {
    return { value: parsed, path: filePath, source: raw, doc };
  }
  // Comments-only or scalar root — treat as empty.
  return { value: null, path: filePath, source: raw, doc };
}

/**
 * Map Zod issues to source-located `ConfigIssue`s using the project
 * Document AST when the path resolves there. User-global paths don't get
 * source-located here (the user-global file went through readConfigSafely
 * upstream and any user-global issues already triggered sideline + defaults
 * before this merged validation runs).
 */
function annotateIssuesWithSource(
  zodIssues: ReadonlyArray<{ path: PropertyKey[]; message: string; code: string }>,
  projectFile: LoadedYamlFile,
): ConfigIssue[] {
  return zodIssues.map((issue) => {
    const path = issue.path.map((seg) =>
      typeof seg === 'symbol' ? String(seg) : (seg as string | number),
    );
    const base: ConfigIssue = {
      path,
      message: issue.message,
      issueCode: issue.code,
    };
    if (projectFile.doc !== null && projectFile.source !== null) {
      const located = locateIssue({
        file: projectFile.path,
        source: projectFile.source,
        doc: projectFile.doc,
        path,
      });
      if (located !== undefined) {
        return { ...base, source: located };
      }
    }
    return base;
  });
}

export function loadConfig(cwd?: string): LoadConfigResult {
  const workingDir = cwd ?? process.cwd();
  const sources: string[] = [];

  // Layer 1: user-global config — go through readConfigSafely so a broken
  // file is sidelined and we boot on defaults instead of hanging the user.
  const userConfigPath = resolveConfigPath('user', workingDir);
  const userResult = readConfigSafely({ absPath: userConfigPath });
  let merged: Record<string, unknown> = {};
  if (userResult.valid && userResult.source !== undefined) {
    // Re-emit through the JSON projection so deepMerge stays uniform.
    merged = deepMerge(merged, userResult.value as unknown as Record<string, unknown>);
    sources.push(userConfigPath);
  } else if (!userResult.valid) {
    // readConfigSafely already logged + sidelined; we treat this as "user
    // contributed nothing" and proceed with defaults at this layer.
  }

  // Layer 2: project config — fail loud on schema-fail so the user notices.
  const projectConfigPath = resolve(workingDir, OK_DIR, CONFIG_FILENAME);
  const projectFile = loadYamlFile(projectConfigPath);
  if (projectFile.value !== null) {
    // Removed keys are a single-tier hard error in the project config (the
    // user-fixable, fail-fast path). All keys in one pass — no two-trip cycle.
    const removedKeyErrors = detectRemovedKeys({
      value: projectFile.value,
      file: projectFile.path,
      source: projectFile.source,
      doc: projectFile.doc,
    });
    if (removedKeyErrors.length > 0) {
      throw new Error(removedKeyErrors.map(humanFormat).join('\n\n'));
    }
    merged = deepMerge(merged, projectFile.value);
    sources.push(projectConfigPath);
  }

  // Validate the merged result with Zod.
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = annotateIssuesWithSource(result.error.issues, projectFile);
    const error: ConfigValidationError = { code: 'SCHEMA_INVALID', issues };
    throw new Error(humanFormat(error));
  }

  return { config: result.data, sources };
}

interface CreateProjectConfigResolverOptions {
  startupCwd: string;
  startupConfig: Config;
  cacheMs?: number;
  loadConfigFn?: (cwd?: string) => LoadConfigResult;
}

/**
 * Create a lazy per-cwd config resolver for long-lived MCP sessions. Each cwd
 * re-loads its own `.ok/config.yml` (plus user config). No env-var bridges
 * remain — runtime overrides like `HOST`/`PORT` are resolved at command call
 * sites, not via the loaded config.
 */
export function createProjectConfigResolver(
  opts: CreateProjectConfigResolverOptions,
): (cwd?: string) => Promise<Config> {
  const cacheMs = opts.cacheMs ?? DEFAULT_CONFIG_CACHE_MS;
  const load = opts.loadConfigFn ?? loadConfig;
  const cache = new Map<string, { config: Config; expiresAt: number }>();
  const pendingResolutions = new Map<string, Promise<Config>>();
  const normalizedStartupCwdPromise = normalizeCwd(opts.startupCwd);

  return async (cwd?: string): Promise<Config> => {
    const effectiveCwd = await normalizeCwd(cwd ?? opts.startupCwd);
    const now = Date.now();
    const cached = cache.get(effectiveCwd);
    if (cached && cached.expiresAt > now) return cached.config;

    const pending = pendingResolutions.get(effectiveCwd);
    if (pending) return await pending;

    const resolution = (async (): Promise<Config> => {
      if (effectiveCwd === (await normalizedStartupCwdPromise)) {
        cache.set(effectiveCwd, {
          config: opts.startupConfig,
          expiresAt: Date.now() + cacheMs,
        });
        return opts.startupConfig;
      }

      const resolved = load(effectiveCwd).config;
      cache.set(effectiveCwd, { config: resolved, expiresAt: Date.now() + cacheMs });
      return resolved;
    })();

    pendingResolutions.set(effectiveCwd, resolution);
    try {
      return await resolution;
    } finally {
      pendingResolutions.delete(effectiveCwd);
    }
  };
}
