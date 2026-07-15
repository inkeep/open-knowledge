/**
 * Native markdownlint config discovery. The project's markdownlint rules are the
 * SOURCE OF TRUTH in its own `.markdownlint.*` files — not in `.ok/config.yml`.
 * Resolution follows markdownlint-cli2: the nearest file on the doc→root walk
 * governs wholesale (no per-rule merge across depths), `extends` is the
 * inheritance mechanism, and a governing file is honored exactly as cli2
 * would — no OK underlay (OK's tuned defaults apply only when no file governs).
 *
 * Read-only and fs-bound, so it lives server/CLI-side; the browser never calls
 * it (the browser receives the already-resolved config).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MarkdownlintRuleSetting } from '@inkeep/open-knowledge-core';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';

/** markdownlint's native config filenames, in precedence order (first found wins). */
const MARKDOWNLINT_CANDIDATE_FILES = [
  '.markdownlint.jsonc',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlint.yml',
  // Executable configs: detected so their presence is never silently ignored,
  // but declined at load time (see loadNativeConfigFile).
  '.markdownlint.cjs',
  '.markdownlint.mjs',
  '.markdownlintrc',
] as const;

/** Default native filename to create when a project has none yet. */
export const DEFAULT_MARKDOWNLINT_FILENAME = '.markdownlint.json';

/**
 * Find the project's existing native markdownlint file (first candidate that
 * exists, by precedence). Returns its name + absolute path, or null when none
 * exists. The write surface uses this to preserve a project's chosen file +
 * format instead of forcing a `.json`.
 */
export function findNativeMarkdownlintFile(dir: string): { name: string; path: string } | null {
  for (const name of MARKDOWNLINT_CANDIDATE_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) return { name, path };
  }
  return null;
}

export interface DiscoveredMarkdownlintConfig {
  /**
   * The resolved native config (a markdownlint `Configuration`, `extends`
   * chain already flattened), or null when the governing file is unusable
   * (malformed / unreadable) — callers then keep OK defaults AND surface
   * `problems`, never silently.
   */
  rules: Record<string, MarkdownlintRuleSetting> | null;
  /** The governing file's path relative to the walk root, for diagnostics. */
  file: string;
  /** Human-readable resolution problems (malformed file, bad `extends`, …). */
  problems: string[];
}

/**
 * Discover the native markdownlint config at `dir` (root-level, no cascade).
 * Returns null when no native file exists.
 */
export function discoverMarkdownlintConfig(dir: string): DiscoveredMarkdownlintConfig | null {
  const found = findNativeMarkdownlintFile(dir);
  if (!found) return null;
  return loadNativeConfigFile(found.path, found.name, dir);
}

/**
 * Cascade discovery, markdownlint-cli2 semantics: the NEAREST directory on
 * the `docDir` → `rootDir` walk that holds a native file governs, wholesale —
 * no per-rule merge across depths (subfolders inherit shared config
 * explicitly via `extends`, the native inheritance mechanism). No search
 * above `rootDir`. Returns null when no file governs `docDir`.
 */
export function resolveNativeMarkdownlintConfig(
  docDir: string,
  rootDir: string,
): DiscoveredMarkdownlintConfig | null {
  const root = resolve(rootDir);
  let dir = resolve(docDir);
  // Clamp escapes (a docDir outside root walks nothing but the root itself).
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

/**
 * The root-level native file's OWN keys, verbatim — `extends` reference
 * included, chain NOT flattened. This is the write surface's read path: a
 * rule edit must merge into what the user actually wrote, never materialize
 * a resolved `extends` base into the file. Malformed/absent → null.
 *
 * A filesystem READ failure (EACCES, EMFILE, transient I/O) throws instead:
 * null is the write surface's license to rebuild the file from scratch, and
 * an unreadable-but-intact config must abort that write, not seed it with an
 * empty merge base (which would silently drop every hand-tuned rule).
 */
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

/** Max `extends` chain depth — cycles are caught separately; this bounds pathology. */
const MAX_EXTENDS_DEPTH = 10;

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Load one native config file and flatten its `extends` chain (child keys win
 * over the extended base, shallow — markdownlint's own merge). Guards:
 * package-name `extends` declined (no node_modules resolution semantics in a
 * KB project or the bundled server); realpath outside `boundaryDir` refused
 * (mirrors the symlink-escape policy); cycles + depth bounded. Every guard
 * records a problem — a config that half-resolves lints with what DID resolve
 * plus loud problems, and a malformed governing file yields `rules: null`.
 */
function loadNativeConfigFile(
  absPath: string,
  displayName: string,
  boundaryDir: string,
): DiscoveredMarkdownlintConfig {
  const problems: string[] = [];
  const visited = new Set<string>();

  const load = (path: string, depth: number): Record<string, MarkdownlintRuleSetting> | null => {
    // Lexical containment first, so an escaping target is refused as an
    // escape even when it doesn't exist (realpath would throw "cannot read").
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
    // Realpath containment second — catches symlinks that point outside.
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
      // Read via the already-resolved realpath so the bytes parsed come from
      // the same inode the containment check validated (a symlink swapped
      // between check and read would otherwise reopen the escape window).
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
    // `$schema` is editor-tooling metadata (officially recommended for
    // IntelliSense); markdownlint ignores it at runtime, and its URL-string
    // value must not reach the rules object (the wire schema's rule-setting
    // union would reject it and 500 the config fetch).
    const {
      extends: extendsRef,
      $schema: _schema,
      ...own
    } = parsed.value as Record<string, MarkdownlintRuleSetting> & {
      extends?: unknown;
      $schema?: unknown;
    };
    // Null is markdownlint's documented "no inheritance" value, same as absent.
    if (extendsRef === undefined || extendsRef === null) return own;
    if (typeof extendsRef !== 'string' || extendsRef === '') {
      problems.push(`invalid extends value in ${relative(boundaryDir, path) || path}`);
      return own;
    }
    // Bare specifiers are npm packages in native markdownlint — declined here.
    if (!extendsRef.startsWith('.') && !isAbsolute(extendsRef)) {
      problems.push(
        `package extends is not supported (${JSON.stringify(extendsRef)} in ${relative(boundaryDir, path) || path}) — use a relative file path`,
      );
      return own;
    }
    const target = resolve(dirname(path), extendsRef);
    const base = load(target, depth + 1);
    // Child keys override the extended base, per markdownlint's shallow merge.
    return base ? { ...base, ...own } : own;
  };

  const rules = load(absPath, 0);
  return { rules, file: displayName, problems };
}

/** First line of an error's message, so problems stay one-line but keep the cause. */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n', 1)[0] ?? '';
}

function parseNativeConfig(raw: string, name: string): { value: unknown } | { error: string } {
  try {
    if (name.endsWith('.yaml') || name.endsWith('.yml')) return { value: parseYaml(raw) };
    // JSON + JSONC + `.markdownlintrc` all go through jsonc-parser: a
    // strict-JSON superset tolerating comments and trailing commas, matching
    // what markdownlint-cli2 accepts (regex-stripped JSONC has bitten this
    // repo before — parser-capability findings in the 2026-06-26 harness
    // config-write-safety work). BOM is stripped up front: jsonc-parser
    // reports it as InvalidSymbol@0 while still parsing fine, so leaving it
    // would misclassify a valid BOM'd config as malformed. jsonc-parser
    // recovers a value even for partially invalid input, so collect errors
    // and treat any as malformed rather than lint with a half-parsed config.
    const errors: ParseError[] = [];
    const value = parseJsonc(raw.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    const first = errors[0];
    if (first) return { error: `${printParseErrorCode(first.error)} at offset ${first.offset}` };
    return { value };
  } catch (err) {
    return { error: errorDetail(err) };
  }
}
