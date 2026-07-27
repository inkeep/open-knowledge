
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { isMap, isScalar, parseDocument } from 'yaml';
import {
  FRONTMATTER_RE,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '../../extensions/frontmatter.ts';
import { compileAppliesTo } from './applies-to.ts';
import type { LintDiagnostic, ResolvedFrontmatterSchemaEntry } from './types.ts';

export interface LoadedFrontmatterSchema {
  file: string;
  schema: Record<string, unknown>;
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

export const DRAFT07_SCHEMA_URIS = [
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
] as const;

export function isSupportedSchemaDialect(schema: Record<string, unknown>): boolean {
  const declared = schema.$schema;
  if (declared === undefined) return true;
  return (
    typeof declared === 'string' && (DRAFT07_SCHEMA_URIS as readonly string[]).includes(declared)
  );
}

let ajvInstance: Ajv | null = null;

function getAjv(): Ajv {
  if (!ajvInstance) {
    ajvInstance = new Ajv({ allErrors: true, strict: false });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

const compiledByContent = new Map<string, ValidateFunction | null>();
const COMPILED_CACHE_CAP = 256;

function compileSchema(schema: Record<string, unknown>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  const cached = compiledByContent.get(key);
  if (cached !== undefined) return cached;
  let compiled: ValidateFunction | null = null;
  if (isSupportedSchemaDialect(schema)) {
    const { $schema: _dialect, ...body } = schema;
    try {
      compiled = getAjv().compile(body);
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
  const { $schema: _dialect, ...body } = schema;
  try {
    getAjv().compile(body);
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
): LintDiagnostic[] {
  if (schemas.length === 0) return [];
  const { data, keyLines } = parseFrontmatterData(text);
  const lines = text.split('\n');
  const lineSpan = (line: number): LintDiagnostic['range'] => ({
    start: { line, character: 0 },
    end: { line, character: lines[line]?.length ?? 0 },
  });

  const diagnostics: LintDiagnostic[] = [];
  for (const { schema } of schemas) {
    const validate = compileSchema(schema);
    if (!validate) continue;
    if (validate(data)) continue;
    for (const error of validate.errors ?? []) {
      const keyword = error.keyword;
      let line = 0;
      let message: string;
      if (keyword === 'required' && error.instancePath === '') {
        const missing = String(
          (error.params as { missingProperty?: unknown }).missingProperty ?? '',
        );
        message = `Frontmatter property "${missing}" is required`;
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
        source: 'frontmatter',
        code: keyword,
        message,
      });
    }
  }
  return diagnostics;
}
