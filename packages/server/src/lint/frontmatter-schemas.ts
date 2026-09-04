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

export const SCHEMA_LIST_CAP = 500;

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

export function resolveFrontmatterSchemas(
  projectDir: string,
  mappings: readonly FrontmatterSchemaMapping[],
): ResolvedFrontmatterSchemas {
  const problems: string[] = [];
  const outcomeByFile = new Map<string, LoadOutcome>();
  const reportedFiles = new Set<string>();
  const entries: ResolvedFrontmatterSchemaEntry[] = [];

  for (const mapping of mappings) {
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
