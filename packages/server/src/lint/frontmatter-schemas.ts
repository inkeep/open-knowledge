/**
 * Frontmatter schema-file loading. Each `contentRules.frontmatter.schemas`
 * mapping names a JSON Schema file by a path relative to the PROJECT ROOT
 * (the folder containing `.ok/` — not `contentDir`, so the `.ok/schemas/`
 * default keeps working when `content.dir` scopes docs to a subfolder). This
 * loads each file once, validates the declared dialect, and injects the
 * parsed content + a canonical dedup key into the resolved entries the core
 * plugin (and the browser, via the effective config) validates with.
 *
 * Every load failure — escape, missing/unreadable file, malformed JSON,
 * unsupported dialect, ajv-refused schema — records a `problems[]` entry for
 * the config channel and leaves that entry content-less; it never becomes a
 * per-doc diagnostic. Escape guarding mirrors the markdownlint-discovery
 * policy: lexical containment first (an escaping target is refused even when
 * it doesn't exist), realpath containment second (symlinks pointing outside),
 * and the bytes are read via the validated realpath.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CANONICAL_SCHEMA_DIALECT_URIS,
  compileAppliesTo,
  DEFAULT_SCHEMA_DIALECT,
  type FrontmatterSchemaMapping,
  findZeroMatchAppliesToPatterns,
  frontmatterSchemaCompileError,
  isSupportedSchemaDialect,
  type ResolvedFrontmatterSchemaEntry,
  SUPPORTED_SCHEMA_DIALECTS,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { isInside } from './fs-safety.ts';

export interface ResolvedFrontmatterSchemas {
  entries: ResolvedFrontmatterSchemaEntry[];
  problems: string[];
}

/** Upper bound on schema files enumerated for the mapping picker. */
export const SCHEMA_LIST_CAP = 500;

/**
 * Enumerate the project's `.ok/schemas/*.json` files (flat, top-level only) as
 * project-root-relative paths, for the mapping file-picker. A missing or
 * unreadable `.ok/schemas/` is an empty list (not an error). Bounded by
 * `SCHEMA_LIST_CAP` so a pathological directory can't produce an unbounded
 * response; `truncated` signals the list was cut. This is a directory scan for
 * discovery only — unlike `resolveFrontmatterSchemas`, it neither reads nor
 * validates schema content (the picker just needs paths).
 */
export function listProjectSchemaFiles(projectRoot: string): {
  schemas: string[];
  truncated: boolean;
} {
  const dir = join(projectRoot, '.ok', 'schemas');
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    // A missing dir is the ordinary first-run case and stays quiet. Anything
    // else (EACCES under macOS TCC, a permissions change) renders an empty
    // picker that looks identical to first-run, so log it rather than let the
    // operator stare at a list that silently cannot populate.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      getLogger('frontmatter-schemas').warn(
        { err, code, dir },
        'could not enumerate .ok/schemas; the schema picker will show an empty list',
      );
    }
    return { schemas: [], truncated: false };
  }
  const truncated = names.length > SCHEMA_LIST_CAP;
  const schemas = names.slice(0, SCHEMA_LIST_CAP).map((name) => `.ok/schemas/${name}`);
  return { schemas, truncated };
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Config-channel problems for enabled mappings whose authored globs match zero
 * of the project's docs — a typo'd or stale pattern silently scopes the schema
 * to nothing, which no per-doc diagnostic can ever surface. Doc-walk cost is
 * the caller's call: only doc-independent surfaces (the root lint-config
 * response, the audit) pay it, never the per-doc lint path. The problem-string
 * prefixes are part of the compose contract with the Settings frontmatter
 * panel — keep in sync on either-side change.
 */
export function unmatchedAppliesToProblems(
  mappings: readonly FrontmatterSchemaMapping[],
  docPaths: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const mapping of mappings) {
    if (mapping.enabled === false) continue;
    for (const pattern of findZeroMatchAppliesToPatterns(mapping.appliesTo, docPaths)) {
      problems.push(
        `unmatched appliesTo glob ${JSON.stringify(pattern)} — matches no docs in this project (frontmatter mapping for ${mapping.file})`,
      );
    }
  }
  return problems;
}

type LoadOutcome = { schema: Record<string, unknown>; key: string } | { problem: string };

function loadSchemaFile(projectDir: string, file: string): LoadOutcome {
  const abs = resolve(projectDir, file);
  if (!isInside(abs, resolve(projectDir))) {
    return { problem: `frontmatter schema ${file}: resolves outside the project` };
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    return { problem: `frontmatter schema ${file}: cannot read (${errorDetail(err)})` };
  }
  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch (err) {
    return { problem: `frontmatter schema ${file}: cannot read (${errorDetail(err)})` };
  }
  if (!isInside(real, projectReal)) {
    return { problem: `frontmatter schema ${file}: resolves outside the project` };
  }
  let raw: string;
  try {
    // Read via the validated realpath so the parsed bytes come from the same
    // inode the containment check admitted.
    raw = readFileSync(real, 'utf-8');
  } catch (err) {
    return { problem: `frontmatter schema ${file}: cannot read (${errorDetail(err)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { problem: `frontmatter schema ${file}: malformed JSON (${errorDetail(err)})` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { problem: `frontmatter schema ${file}: not a JSON object` };
  }
  const schema = parsed as Record<string, unknown>;
  if (!isSupportedSchemaDialect(schema)) {
    // Name the supported dialects (the overview) and one paste-ready canonical
    // `$schema` URI (a concrete fix), so the author doesn't have to translate a
    // label back into the exact string to write.
    const example = JSON.stringify(CANONICAL_SCHEMA_DIALECT_URIS[DEFAULT_SCHEMA_DIALECT]);
    return {
      problem: `frontmatter schema ${file}: unsupported dialect ${JSON.stringify(schema.$schema)} (supported: ${SUPPORTED_SCHEMA_DIALECTS.join(', ')}; e.g. ${example})`,
    };
  }
  const compileError = frontmatterSchemaCompileError(schema);
  if (compileError !== null) {
    return { problem: `frontmatter schema ${file}: does not compile (${compileError})` };
  }
  return { schema, key: real };
}

/**
 * Load every mapping's schema file (each distinct file read once), returning
 * resolved entries + config-channel problems. Every returned entry carries a
 * `key` — the canonical realpath for loaded files, the authored path for
 * failed ones — which downstream code also uses as the "already resolved"
 * marker (see `resolve-config.ts`).
 */
export function resolveFrontmatterSchemas(
  projectDir: string,
  mappings: readonly FrontmatterSchemaMapping[],
): ResolvedFrontmatterSchemas {
  const problems: string[] = [];
  const outcomeByFile = new Map<string, LoadOutcome>();
  const reportedFiles = new Set<string>();
  const entries: ResolvedFrontmatterSchemaEntry[] = [];

  for (const mapping of mappings) {
    // Disabled mappings still resolve (the schema editor reads their content)
    // but stay silent on the problems channel — a toggled-off broken schema
    // shouldn't nag.
    const silent = mapping.enabled === false;
    const compiled = compileAppliesTo(mapping.appliesTo);
    for (const { pattern, detail } of compiled.invalidPatterns) {
      if (silent) continue;
      problems.push(
        `invalid appliesTo glob ${JSON.stringify(pattern)} — ${detail} (frontmatter mapping for ${mapping.file})`,
      );
    }
    for (const { pattern, reason } of compiled.suspiciousPatterns) {
      if (silent) continue;
      const detail =
        reason === 'trailing-slash'
          ? 'a trailing slash can never match (doc paths have no trailing slash)'
          : reason === 'leading-slash'
            ? 'a leading slash can never match (doc paths are relative)'
            : 'doc paths are extension-less; drop the file extension';
      problems.push(
        `suspicious appliesTo glob ${JSON.stringify(pattern)} — ${detail} (frontmatter mapping for ${mapping.file})`,
      );
    }
    let outcome = outcomeByFile.get(mapping.file);
    if (outcome === undefined) {
      outcome = loadSchemaFile(projectDir, mapping.file);
      outcomeByFile.set(mapping.file, outcome);
    }
    // Reported outside the cache-miss branch: a disabled mapping loads the file
    // first and stays silent, so gating the report on the miss would let a
    // LATER enabled mapping for the same file hit the cache and never report —
    // silently unvalidating docs that are actively governed. `reportedFiles`
    // keeps that from double-reporting when two enabled mappings share a file.
    if ('problem' in outcome && !silent && !reportedFiles.has(mapping.file)) {
      reportedFiles.add(mapping.file);
      problems.push(outcome.problem);
    }
    entries.push(
      'problem' in outcome
        ? { ...mapping, key: mapping.file }
        : { ...mapping, key: outcome.key, schema: outcome.schema },
    );
  }
  return { entries, problems };
}
