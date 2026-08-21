
import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import type AjvCore from 'ajv/dist/core.js';
import addFormats from 'ajv-formats';
import { isMap, isScalar, parseDocument } from 'yaml';
import {
  FRONTMATTER_RE,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '../../extensions/frontmatter.ts';
import { compileAppliesTo } from './applies-to.ts';
import type {
  FrontmatterScope,
  LintDiagnostic,
  LintPluginId,
  ResolvedFrontmatterSchemaEntry,
} from './types.ts';

export interface LoadedFrontmatterSchema {
  file: string;
  schema: Record<string, unknown>;
  ruleId?: string;
}

export interface ValidateFrontmatterOptions {
  source?: LintPluginId;
}

export function selectApplicableFrontmatterSchemas(
  entries: readonly ResolvedFrontmatterSchemaEntry[],
  docName: string | undefined,
): LoadedFrontmatterSchema[] {
  const seen = new Set<string>();
  const selected: LoadedFrontmatterSchema[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    if (!entry.schema) continue;
    if (!compileAppliesTo(entry.appliesTo).matches(docName)) continue;
    const key = entry.key ?? entry.file;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ file: entry.file, schema: entry.schema });
  }
  return selected;
}

export type FrontmatterSchemaDialect = 'draft-06' | 'draft-07' | '2019-09' | '2020-12';

export const CANONICAL_SCHEMA_DIALECT_URIS: Record<FrontmatterSchemaDialect, string> = {
  'draft-06': 'http://json-schema.org/draft-06/schema#',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
};

export const SUPPORTED_SCHEMA_DIALECTS = Object.keys(
  CANONICAL_SCHEMA_DIALECT_URIS,
) as readonly FrontmatterSchemaDialect[];

export const DEFAULT_SCHEMA_DIALECT: FrontmatterSchemaDialect = 'draft-07';

const DIALECT_BY_NORMALIZED_URI = new Map<string, FrontmatterSchemaDialect>(
  SUPPORTED_SCHEMA_DIALECTS.map((dialect) => [
    normalizeDialectUri(CANONICAL_SCHEMA_DIALECT_URIS[dialect]),
    dialect,
  ]),
);

function normalizeDialectUri(uri: string): string {
  return uri.replace(/^https?:\/\//, '').replace(/#$/, '');
}

export function resolveFrontmatterSchemaDialect(
  schema: Record<string, unknown>,
): FrontmatterSchemaDialect | null {
  const declared = schema.$schema;
  if (declared === undefined) return DEFAULT_SCHEMA_DIALECT;
  if (typeof declared !== 'string') return null;
  return DIALECT_BY_NORMALIZED_URI.get(normalizeDialectUri(declared)) ?? null;
}

export function isSupportedSchemaDialect(schema: Record<string, unknown>): boolean {
  return resolveFrontmatterSchemaDialect(schema) !== null;
}

const ajvByDialect = new Map<FrontmatterSchemaDialect, AjvCore>();

function assertNeverDialect(dialect: never): never {
  throw new Error(`Unhandled FrontmatterSchemaDialect: ${JSON.stringify(dialect as unknown)}`);
}

function getAjv(dialect: FrontmatterSchemaDialect): AjvCore {
  const existing = ajvByDialect.get(dialect);
  if (existing) return existing;
  const options = { allErrors: true, strict: false };
  let created: AjvCore;
  switch (dialect) {
    case '2020-12':
      created = new Ajv2020(options);
      break;
    case '2019-09':
      created = new Ajv2019(options);
      break;
    case 'draft-06':
    case 'draft-07':
      created = new Ajv(options);
      break;
    default:
      return assertNeverDialect(dialect);
  }
  (addFormats as (ajv: AjvCore) => void)(created);
  ajvByDialect.set(dialect, created);
  return created;
}

function schemaBodyForAjv(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _declared, ...body } = schema;
  return body;
}

function compileOnDialect(
  dialect: FrontmatterSchemaDialect,
  schema: Record<string, unknown>,
): ValidateFunction {
  const ajv = getAjv(dialect);
  const declaredId = schema.$id;
  if (typeof declaredId === 'string' && declaredId !== '') ajv.removeSchema(declaredId);
  return ajv.compile(schemaBodyForAjv(schema));
}

const compiledByContent = new Map<string, ValidateFunction | null>();
const COMPILED_CACHE_CAP = 256;

function compileSchema(schema: Record<string, unknown>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  const cached = compiledByContent.get(key);
  if (cached !== undefined) return cached;
  let compiled: ValidateFunction | null = null;
  const dialect = resolveFrontmatterSchemaDialect(schema);
  if (dialect !== null) {
    try {
      compiled = compileOnDialect(dialect, schema);
    } catch {
      compiled = null;
    }
  }
  if (compiledByContent.size >= COMPILED_CACHE_CAP) compiledByContent.clear();
  compiledByContent.set(key, compiled);
  return compiled;
}

export function frontmatterSchemaCompileError(schema: Record<string, unknown>): string | null {
  if (compileSchema(schema)) return null;
  const dialect = resolveFrontmatterSchemaDialect(schema);
  if (dialect === null) return `unsupported dialect ${JSON.stringify(schema.$schema)}`;
  try {
    compileOnDialect(dialect, schema);
    return 'schema was refused';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function parseFrontmatterData(text: string): {
  data: Record<string, unknown>;
  keyLines: Map<string, number>;
} {
  const keyLines = new Map<string, number>();
  if (!FRONTMATTER_RE.test(text)) return { data: {}, keyLines };
  const { frontmatter } = stripFrontmatter(text);
  const yamlBody = unwrapFrontmatterFences(frontmatter);
  if (yamlBody.trim() === '') return { data: {}, keyLines };

  const doc = parseDocument(yamlBody, { uniqueKeys: false });
  if (doc.errors.length > 0) return { data: {}, keyLines };
  const data: unknown = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data: {}, keyLines };
  }

  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== 'string' || !key.range) continue;
      let line = 0;
      const cap = Math.min(key.range[0], yamlBody.length);
      for (let i = 0; i < cap; i++) {
        if (yamlBody.charCodeAt(i) === 10) line++;
      }
      if (!keyLines.has(key.value)) keyLines.set(key.value, line + 1);
    }
  }
  return { data: data as Record<string, unknown>, keyLines };
}

function describeActual(value: unknown): string {
  if (value === undefined) return '';
  let rendered: string;
  if (typeof value === 'string') rendered = `"${value}"`;
  else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  if (rendered.length > 60) rendered = `${rendered.slice(0, 57)}…`;
  return ` (got ${rendered})`;
}

function topLevelKey(instancePath: string): string | null {
  if (!instancePath.startsWith('/')) return null;
  const segment = instancePath.slice(1).split('/')[0] ?? '';
  if (segment === '') return null;
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerToDotPath(instancePath: string): string {
  return instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

export function validateFrontmatterSource(
  text: string,
  schemas: readonly LoadedFrontmatterSchema[],
  options?: ValidateFrontmatterOptions,
): LintDiagnostic[] {
  if (schemas.length === 0) return [];
  const source = options?.source ?? 'frontmatter';
  const { data, keyLines } = parseFrontmatterData(text);
  const lines = text.split('\n');
  const lineSpan = (line: number): LintDiagnostic['range'] => ({
    start: { line, character: 0 },
    end: { line, character: lines[line]?.length ?? 0 },
  });

  const diagnostics: LintDiagnostic[] = [];
  for (const { schema, ruleId } of schemas) {
    const validate = compileSchema(schema);
    if (!validate) continue;
    if (validate(data)) continue;
    for (const error of validate.errors ?? []) {
      const keyword = error.keyword;
      if (keyword === 'if') continue;
      let line = 0;
      let message: string;
      let frontmatterScope: FrontmatterScope = 'invalid';
      let frontmatterProperty: string | undefined;
      if (keyword === 'maxProperties' && error.instancePath === '') {
        message = 'This document must not have frontmatter';
      } else if (keyword === 'required' && error.instancePath === '') {
        const missing = String(
          (error.params as { missingProperty?: unknown }).missingProperty ?? '',
        );
        message = `Frontmatter property "${missing}" is required`;
        frontmatterScope = 'missing';
        if (missing !== '') frontmatterProperty = missing;
      } else if (error.instancePath === '') {
        message = `Frontmatter ${error.message ?? `violates "${keyword}"`}`;
      } else {
        const anchorKey = topLevelKey(error.instancePath);
        if (anchorKey !== null) {
          line = keyLines.get(anchorKey) ?? 0;
        }
        const path = pointerToDotPath(error.instancePath);
        if (keyword === 'enum') {
          const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
          const actual = anchorKey !== null && path === anchorKey ? data[anchorKey] : undefined;
          message = `Frontmatter property "${path}" must be one of: ${allowed.map(String).join(', ')}${describeActual(actual)}`;
        } else {
          message = `Frontmatter property "${path}" ${error.message ?? `violates "${keyword}"`}`;
        }
      }
      diagnostics.push({
        range: lineSpan(line),
        severity: 'warning',
        source,
        code: ruleId ?? keyword,
        message,
        frontmatterScope,
        ...(frontmatterProperty === undefined ? {} : { frontmatterProperty }),
      });
    }
  }
  return diagnostics;
}
