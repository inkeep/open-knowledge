import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ConfigDiagnostic,
  type ConfigIssue,
  type ConfigValidationError,
  detectCommittedProjectLocalKeys,
  detectRemovedKeys,
  humanFormat,
  type IgnoredCommittedKey,
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
  diagnostics: ConfigDiagnostic[];
  sidelined: Array<{ from: string; to: string }>;
  ignoredCommittedKeys: IgnoredCommittedKey[];
}

const DEFAULT_CONFIG_CACHE_MS = 1000;

interface LoadedYamlFile {
  value: Record<string, unknown> | null;
  path: string;
  source: string | null;
  doc: Document | null;
  diagnostic?: ConfigDiagnostic;
}

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
      diagnostic: { code: 'YAML_PARSE', detail: `${filePath}: ${detail}` },
    };
  }
  const parsed = doc.toJSON();
  if (isObject(parsed)) {
    return { value: parsed, path: filePath, source: raw, doc };
  }
  return { value: null, path: filePath, source: raw, doc };
}

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
  const ignoredCommittedKeys: IgnoredCommittedKey[] = [];

  const userConfigPath = resolveConfigPath('user', workingDir);
  const userResult = readConfigSafely({ absPath: userConfigPath });
  diagnostics.push(...userResult.diagnostics);
  if (!userResult.valid && userResult.sidelinedTo !== undefined) {
    sidelined.push({ from: userConfigPath, to: userResult.sidelinedTo });
  }
  if (userResult.valid && userResult.source !== undefined) {
    sources.push(userConfigPath);
  }

  const loadRawLayer = (filePath: string, isCommittedLayer = false): Record<string, unknown> => {
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
    const value = removedKeyDiagnostics.length > 0 ? stripRemovedKeys(file.value) : file.value;
    if (isCommittedLayer) {
      ignoredCommittedKeys.push(
        ...detectCommittedProjectLocalKeys({
          value,
          file: file.path,
          source: file.source,
          doc: file.doc,
        }),
      );
    }
    return value;
  };

  const projectPath = resolve(workingDir, OK_DIR, CONFIG_FILENAME);
  const projectRaw = loadRawLayer(projectPath, true);
  const localRaw = loadRawLayer(resolveConfigPath('project-local', workingDir));

  const merged = mergeLayered(userResult.value as Record<string, unknown>, projectRaw, localRaw);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const projectFile = loadYamlFile(projectPath);
    const issues = annotateIssuesWithSource(result.error.issues, projectFile);
    const error: ConfigValidationError = { code: 'SCHEMA_INVALID', issues };
    throw new Error(humanFormat(error));
  }
  return { config: result.data, sources, diagnostics, sidelined, ignoredCommittedKeys };
}

interface CreateProjectConfigResolverOptions {
  startupCwd: string;
  startupConfig: Config;
  cacheMs?: number;
  loadConfigFn?: (cwd?: string) => LoadConfigResult;
}

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
