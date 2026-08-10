/**
 * Hierarchical YAML config loader.
 *
 * Priority (lowest → highest):
 *   Zod defaults → ~/.ok/global.yml → ./.ok/config.yml → ./.ok/local/config.yml
 *
 * ENV and CLI flag overrides are applied in cli.ts after loading.
 *
 * The three file layers combine through the scope-aware `mergeLayered` (each
 * layer schema-parsed on its own first): a leaf's registered scope decides
 * which layer may set it, so a committed project-file value for a
 * project-local leaf — the load-bearing case is `server.allowExternal: true`
 * arriving via clone — can never win over the local layer's parsed default.
 * A scope-blind deep merge here previously let any layer set any leaf.
 * Arrays are replaced, not concatenated.
 *
 * Errors are emitted with source positions via yaml@2's `parseDocument` —
 * `file:line:col` plus a code-snippet with caret marker.
 *
 * The user-global file (`~/.ok/global.yml`) is distinct from project
 * `.ok/config.yml` so the ancestor-walk that detects an OK project can't
 * treat the user's home directory as a project root.
 *
 * Every layer strips removed keys and continues: a key the engine no longer
 * reads is deleted from the parsed value and reported on
 * `LoadConfigResult.diagnostics`, never blocking startup. Genuine corruption
 * still fails the way it did before: the user-global file is sidelined to
 * `<path>.invalid-<ISO-timestamp>` and replaced with schema defaults (via
 * `readConfigSafely`) so OK can still boot, and a schema-invalid project or
 * project-local file throws loud — both are user-fixable in place and
 * failing fast helps the user notice.
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
  mergeLayered,
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
  // way we boot instead of hanging the user. Its return value is already a
  // schema-parsed Config (defaults applied) — the per-layer shape
  // mergeLayered's scope rules operate on.
  const userConfigPath = resolveConfigPath('user', workingDir);
  const userResult = readConfigSafely({ absPath: userConfigPath });
  diagnostics.push(...userResult.diagnostics);
  if (!userResult.valid && userResult.sidelinedTo !== undefined) {
    sidelined.push({ from: userConfigPath, to: userResult.sidelinedTo });
  }
  if (userResult.valid && userResult.source !== undefined) {
    sources.push(userConfigPath);
  }

  // Layers 2 + 3: project (committed) and project-local (gitignored,
  // per-machine). Read RAW — removed keys stripped and reported, but NOT
  // schema-parsed. Leaving an unset leaf `undefined` (rather than filling its
  // schema default per layer) is load-bearing two ways:
  //   1. an empty/missing project file no longer clobbers an explicit
  //      user-global value with a filled default (the precedence bug);
  //   2. `mergeLayered`'s project-local scope rule skips the committed project
  //      layer, so a committed `server.allowExternal` (or any project-local
  //      key) resolves to its schema default — never the cloned value.
  // A file that could not be read/parsed degrades to `{}` but says so via
  // `diagnostics`.
  const loadRawLayer = (filePath: string): Record<string, unknown> => {
    const file = loadYamlFile(filePath);
    if (file.diagnostic !== undefined) {
      diagnostics.push(file.diagnostic);
    }
    if (file.value === null) return {};
    const removedKeyDiagnostics = detectRemovedKeys({
      value: file.value,
      file: file.path,
      source: file.source,
      doc: file.doc,
    });
    diagnostics.push(...removedKeyDiagnostics);
    sources.push(filePath);
    return removedKeyDiagnostics.length > 0 ? stripRemovedKeys(file.value) : file.value;
  };

  const projectPath = resolve(workingDir, OK_DIR, CONFIG_FILENAME);
  const projectRaw = loadRawLayer(projectPath);
  const localRaw = loadRawLayer(resolveConfigPath('project-local', workingDir));

  // Scope-aware merge over the raw layers, then ONE parse fills defaults for
  // genuinely-unset leaves. DELIBERATE TRADE (do not "fix" back to per-layer
  // parsing — that reintroduces the precedence + project-local-leak bugs): a
  // schema violation now surfaces at this merged parse, so a bad value in the
  // project or project-local file reports at the merged level rather than
  // `file:line`. Source location is best-effort attributed to the project
  // file when the offending path resolves there.
  const merged = mergeLayered(userResult.value as Record<string, unknown>, projectRaw, localRaw);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const projectFile = loadYamlFile(projectPath);
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
