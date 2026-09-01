import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MarkdownlintRuleSetting } from '@inkeep/open-knowledge-core';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { isInside } from './fs-safety.ts';

const MARKDOWNLINT_CANDIDATE_FILES = [
  '.markdownlint.jsonc',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlint.yml',
  '.markdownlint.cjs',
  '.markdownlint.mjs',
  '.markdownlintrc',
] as const;

export const DEFAULT_MARKDOWNLINT_FILENAME = '.markdownlint.json';

export function findNativeMarkdownlintFile(dir: string): { name: string; path: string } | null {
  for (const name of MARKDOWNLINT_CANDIDATE_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) return { name, path };
  }
  return null;
}

export interface DiscoveredMarkdownlintConfig {
  rules: Record<string, MarkdownlintRuleSetting> | null;
  file: string;
  problems: string[];
}

export function discoverMarkdownlintConfig(dir: string): DiscoveredMarkdownlintConfig | null {
  const found = findNativeMarkdownlintFile(dir);
  if (!found) return null;
  return loadNativeConfigFile(found.path, found.name, dir);
}

export function resolveNativeMarkdownlintConfig(
  docDir: string,
  rootDir: string,
): DiscoveredMarkdownlintConfig | null {
  const root = resolve(rootDir);
  let dir = resolve(docDir);
  if (!isInside(dir, root)) dir = root;
  while (true) {
    const found = findNativeMarkdownlintFile(dir);
    if (found) {
      const loaded = loadNativeConfigFile(
        found.path,
        relative(root, found.path) || found.name,
        root,
      );
      return loaded;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readOwnNativeRules(
  dir: string,
): { rules: Record<string, unknown>; name: string; path: string; raw: string } | null {
  const found = findNativeMarkdownlintFile(dir);
  if (!found) return null;
  if (/\.(cjs|mjs|js)$/.test(found.path)) return null;
  const raw = readFileSync(found.path, 'utf-8');
  const parsed = parseNativeConfig(raw, found.name);
  if ('error' in parsed) return null;
  const { value } = parsed;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { rules: value as Record<string, unknown>, name: found.name, path: found.path, raw };
}

const MAX_EXTENDS_DEPTH = 10;

function loadNativeConfigFile(
  absPath: string,
  displayName: string,
  boundaryDir: string,
): DiscoveredMarkdownlintConfig {
  const problems: string[] = [];
  const visited = new Set<string>();

  const load = (path: string, depth: number): Record<string, MarkdownlintRuleSetting> | null => {
    if (!isInside(resolve(path), resolve(boundaryDir))) {
      problems.push(
        `refusing extends target outside the project: ${relative(boundaryDir, path) || path}`,
      );
      return null;
    }
    let real: string;
    try {
      real = realpathSync(path);
    } catch (err) {
      problems.push(`cannot read ${relative(boundaryDir, path) || path}: ${errorDetail(err)}`);
      return null;
    }
    if (!isInside(real, realpathSync(boundaryDir))) {
      problems.push(
        `refusing extends target outside the project: ${relative(boundaryDir, path) || path}`,
      );
      return null;
    }
    if (visited.has(real)) {
      problems.push(`extends cycle at ${relative(boundaryDir, path) || path}`);
      return null;
    }
    visited.add(real);
    if (depth > MAX_EXTENDS_DEPTH) {
      problems.push(`extends chain deeper than ${MAX_EXTENDS_DEPTH} levels`);
      return null;
    }
    if (/\.(cjs|mjs|js)$/.test(path)) {
      problems.push(
        `executable markdownlint config detected but not executed: ${relative(boundaryDir, path) || path} — use a JSON/JSONC/YAML config`,
      );
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(real, 'utf-8');
    } catch (err) {
      problems.push(`cannot read ${relative(boundaryDir, path) || path}: ${errorDetail(err)}`);
      return null;
    }
    const parsed = parseNativeConfig(raw, path);
    if ('error' in parsed) {
      problems.push(
        `malformed markdownlint config: ${relative(boundaryDir, path) || path} (${parsed.error})`,
      );
      return null;
    }
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      problems.push(
        `malformed markdownlint config: ${relative(boundaryDir, path) || path} (not an object)`,
      );
      return null;
    }
    const {
      extends: extendsRef,
      $schema: _schema,
      ...own
    } = parsed.value as Record<string, MarkdownlintRuleSetting> & {
      extends?: unknown;
      $schema?: unknown;
    };
    if (extendsRef === undefined || extendsRef === null) return own;
    if (typeof extendsRef !== 'string' || extendsRef === '') {
      problems.push(`invalid extends value in ${relative(boundaryDir, path) || path}`);
      return own;
    }
    if (!extendsRef.startsWith('.') && !isAbsolute(extendsRef)) {
      problems.push(
        `package extends is not supported (${JSON.stringify(extendsRef)} in ${relative(boundaryDir, path) || path}) — use a relative file path`,
      );
      return own;
    }
    const target = resolve(dirname(path), extendsRef);
    const base = load(target, depth + 1);
    return base ? { ...base, ...own } : own;
  };

  const rules = load(absPath, 0);
  return { rules, file: displayName, problems };
}

function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n', 1)[0] ?? '';
}

function parseNativeConfig(raw: string, name: string): { value: unknown } | { error: string } {
  try {
    if (name.endsWith('.yaml') || name.endsWith('.yml')) return { value: parseYaml(raw) };
    const errors: ParseError[] = [];
    const value = parseJsonc(raw.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    const first = errors[0];
    if (first) return { error: `${printParseErrorCode(first.error)} at offset ${first.offset}` };
    return { value };
  } catch (err) {
    return { error: errorDetail(err) };
  }
}
