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
 * Both layers strip removed keys and continue: a key the engine no longer
 * reads is deleted from the parsed value and reported on
 * `LoadConfigResult.diagnostics`, never blocking startup. Genuine corruption
 * still fails the way it did before: the user-global file is sidelined to
 * `<path>.invalid-<ISO-timestamp>` and replaced with schema defaults (via
 * `readConfigSafely`) so OK can still boot, and a schema-invalid project file
 * throws loud — a project error is user-fixable in place and failing fast
 * helps the user notice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ConfigDiagnostic,
  type ConfigIssue,
  type ConfigValidationError,
  detectRemovedKeys,
  humanFormat,
  locateIssue,
  stripRemovedKeys,
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
  /**
   * Structured diagnostics for the config that was loaded, across both layers.
   * Removed keys are stripped and reported here rather than blocking the load;
   * a sidelined user-global file surfaces its degradation diagnostic too. Empty
   * for a clean config.
   */
  diagnostics: ConfigDiagnostic[];
  /**
   * Files this load renamed out of the way to boot on defaults. Surfaced so a
   * caller can tell the user their file moved — a load that quarantines a file
   * without saying so reads as a silent data loss.
   */
  sidelined: Array<{ from: string; to: string }>;
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
  /**
   * Why the file yielded no value, when the cause was corruption rather than
   * absence. Returned rather than only logged so `LoadConfigResult.diagnostics`
   * can carry it: degrading to defaults silently is what let `ok config
   * validate` answer "✓ valid" for a file it could not parse.
   */
  diagnostic?: ConfigDiagnostic;
}

/**
 * Load a YAML file via parseDocument (source-position-preserving). Returns
 * the parsed JS value plus the Document AST + raw source so callers can
 * locate Zod issues back to file:line:col.
 *
 * On a read or YAML syntax error, logs a warning and returns `value: null`
 * (existing graceful-degradation semantic — broken project YAML doesn't block
 * boot; the user fixes the file and reloads) plus a `diagnostic` describing
 * the cause so the failure is reportable, not just survivable.
 */
function loadYamlFile(filePath: string): LoadedYamlFile {
  if (!existsSync(filePath)) {
    return { value: null, path: filePath, source: null, doc: null };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[config] Failed to read ${filePath}: ${detail}`);
    return {
      value: null,
      path: filePath,
      source: null,
      doc: null,
      diagnostic: { code: 'UNREADABLE', detail: `${filePath}: ${detail}` },
    };
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    const detail = doc.errors.map((e) => e.message).join('; ');
    console.warn(`[config] Failed to parse ${filePath}: ${detail}`);
    return {
      value: null,
      path: filePath,
      source: raw,
      doc: null,
      // The diagnostic variants are value-free by construction, so the file has
      // to be named in `detail` — otherwise a merged report cannot say which
      // layer failed to parse.
      diagnostic: { code: 'YAML_PARSE', detail: `${filePath}: ${detail}` },
    };
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
  const diagnostics: ConfigDiagnostic[] = [];
  const sidelined: Array<{ from: string; to: string }> = [];

  // Layer 1: user-global config — go through readConfigSafely so removed keys
  // are stripped-and-reported and a genuinely broken file is sidelined; either
  // way we boot instead of hanging the user.
  const userConfigPath = resolveConfigPath('user', workingDir);
  const userResult = readConfigSafely({ absPath: userConfigPath });
  diagnostics.push(...userResult.diagnostics);
  if (!userResult.valid && userResult.sidelinedTo !== undefined) {
    sidelined.push({ from: userConfigPath, to: userResult.sidelinedTo });
  }
  let merged: Record<string, unknown> = {};
  if (userResult.valid && userResult.source !== undefined) {
    // Re-emit through the JSON projection so deepMerge stays uniform.
    merged = deepMerge(merged, userResult.value as unknown as Record<string, unknown>);
    sources.push(userConfigPath);
  } else if (!userResult.valid) {
    // readConfigSafely already logged + sidelined; we treat this as "user
    // contributed nothing" and proceed with defaults at this layer.
  }

  // Layer 2: project config. Strip removed keys and continue — a dead key must
  // not brick startup — but a schema violation still throws loud, because a
  // project schema error is user-fixable in place.
  const projectConfigPath = resolve(workingDir, OK_DIR, CONFIG_FILENAME);
  const projectFile = loadYamlFile(projectConfigPath);
  // A project file that could not be read or parsed degrades to defaults, same
  // as before — but it now says so. Without this the whole merged config falls
  // back to defaults, which always validate, so every reporting surface built
  // on `diagnostics` would call a broken file clean.
  if (projectFile.diagnostic !== undefined) {
    diagnostics.push(projectFile.diagnostic);
  }
  if (projectFile.value !== null) {
    const removedKeyDiagnostics = detectRemovedKeys({
      value: projectFile.value,
      file: projectFile.path,
      source: projectFile.source,
      doc: projectFile.doc,
    });
    diagnostics.push(...removedKeyDiagnostics);
    const cleaned =
      removedKeyDiagnostics.length > 0 ? stripRemovedKeys(projectFile.value) : projectFile.value;
    merged = deepMerge(merged, cleaned);
    sources.push(projectConfigPath);
  }

  // Validate the merged result with Zod. Removed keys were already stripped, so
  // a failure here is a genuine schema violation — throw source-located.
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = annotateIssuesWithSource(result.error.issues, projectFile);
    const error: ConfigValidationError = { code: 'SCHEMA_INVALID', issues };
    throw new Error(humanFormat(error));
  }

  return { config: result.data, sources, diagnostics, sidelined };
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
