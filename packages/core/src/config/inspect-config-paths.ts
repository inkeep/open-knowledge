
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { resolveConfigPath } from './write-config-patch.ts';

export interface ConfigPathPresence {
  user: boolean;
  project: boolean;
}

export interface InspectConfigPathsOptions {
  cwd: string;
  homedirOverride?: string;
}

export function inspectConfigPaths(
  paths: ReadonlyArray<readonly (string | number)[]>,
  opts: InspectConfigPathsOptions,
): Map<string, ConfigPathPresence> {
  const userJson = readJsonForScope('user', opts);
  const projectJson = readJsonForScope('project', opts);
  const result = new Map<string, ConfigPathPresence>();
  for (const path of paths) {
    const key = path.join('.');
    result.set(key, {
      user: hasPathInJson(userJson, path),
      project: hasPathInJson(projectJson, path),
    });
  }
  return result;
}

function readJsonForScope(scope: 'user' | 'project', opts: InspectConfigPathsOptions): unknown {
  const absPath = resolveConfigPath(scope, opts.cwd, opts.homedirOverride);
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        `[inspectConfigPaths] could not read ${scope} config at ${absPath}: ${(e as Error).message ?? e}`,
      );
    }
    return null;
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    console.warn(
      `[inspectConfigPaths] ${scope} config at ${absPath} has YAML parse errors; treating as absent for scope inference`,
    );
    return null;
  }
  return doc.toJSON();
}

function hasPathInJson(obj: unknown, path: readonly (string | number)[]): boolean {
  if (path.length === 0) return obj !== null && obj !== undefined;
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return false;
    if (Array.isArray(cur) && typeof seg === 'number') {
      cur = cur[seg];
      continue;
    }
    if (typeof cur === 'object') {
      const key = String(seg);
      if (!(key in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[key];
      continue;
    }
    return false;
  }
  return cur !== undefined;
}
