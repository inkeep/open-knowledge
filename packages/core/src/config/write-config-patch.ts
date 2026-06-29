
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isMap, isSeq, type ParsedNode, parseDocument } from 'yaml';
import { LOCAL_DIR, OK_DIR } from '../constants/ok-dir.ts';
import { atomicWriteFile } from '../util/atomic-yaml-write.ts';
import { FileLockTimeoutError, withFileLock } from '../util/file-lock.ts';
import type { ConfigValidationError, WriteScope } from './errors.ts';
import type { Err, Ok, Result } from './result.ts';
import { type Config, type ConfigPatch, ConfigSchema } from './schema.ts';
import { CONFIG_SCHEMA_MAJOR_PATH } from './schema-version.ts';
import { addConfigSpanEvent, withConfigSpan, withConfigSpanSync } from './telemetry.ts';
import { validatePatchScopes } from './validate-patch-scopes.ts';
import { applyPatchToDocument, toConfigIssue } from './yaml-patch.ts';

const CONFIG_FILENAME = 'config.yml';

export const USER_CONFIG_FILENAME = 'global.yml';

function schemaUrl(scope: WriteScope): string {
  const filename =
    scope === 'user'
      ? 'config.user.schema.json'
      : scope === 'project-local'
        ? 'config.project-local.schema.json'
        : 'config.project.schema.json';
  return `https://unpkg.com/@inkeep/open-knowledge@latest/dist/schemas/${CONFIG_SCHEMA_MAJOR_PATH}/${filename}`;
}

function defaultFirstWriteHeader(scope: WriteScope): string {
  return `# yaml-language-server: $schema=${schemaUrl(scope)}\n`;
}

export interface WriteConfigPatchOptions {
  cwd: string;
  scope: WriteScope;
  patch: ConfigPatch;
  homedirOverride?: string;
  firstWriteHeader?: string | null;
}

export interface WriteConfigPatchSuccess {
  effective: Config;
  appliedPaths: string[];
  path: string;
  created: boolean;
}

export type WriteConfigPatchResult = Result<WriteConfigPatchSuccess, ConfigValidationError>;

export function resolveConfigPath(
  scope: WriteScope,
  cwd: string,
  homedirOverride?: string,
): string {
  if (scope === 'user') {
    const home = homedirOverride ?? homedir();
    return resolve(home, OK_DIR, USER_CONFIG_FILENAME);
  }
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  if (scope === 'project-local') {
    return resolve(absCwd, OK_DIR, LOCAL_DIR, CONFIG_FILENAME);
  }
  return resolve(absCwd, OK_DIR, CONFIG_FILENAME);
}

function err(error: ConfigValidationError): Err<ConfigValidationError> {
  return { ok: false, error };
}

function ok(value: WriteConfigPatchSuccess): Ok<WriteConfigPatchSuccess> {
  return { ok: true, ...value };
}

export async function writeConfigPatch(
  opts: WriteConfigPatchOptions,
): Promise<WriteConfigPatchResult> {
  return withConfigSpan(
    'config.patch',
    { 'config.scope': opts.scope, 'config.transport': 'fs' },
    async (span) => {
      const result = await writeConfigPatchInner(opts);
      span.setAttribute('config.outcome', result.ok ? 'success' : 'rejected');
      if (!result.ok) span.setAttribute('config.error.code', result.error.code);
      return result;
    },
  );
}

async function writeConfigPatchInner(
  opts: WriteConfigPatchOptions,
): Promise<WriteConfigPatchResult> {
  const { cwd, scope, patch, homedirOverride } = opts;
  const absPath = resolveConfigPath(scope, cwd, homedirOverride);

  const scopeViolation = validatePatchScopes(patch, scope);
  if (scopeViolation !== null) {
    return err(scopeViolation);
  }

  try {
    await mkdir(dirname(absPath), { recursive: true });
  } catch (e) {
    return err({
      code: 'WRITE_ERROR',
      detail: `Could not create parent directory for ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  try {
    return await withFileLock(`${absPath}.lock`, () => writeConfigPatchLocked(opts, absPath));
  } catch (e) {
    if (e instanceof FileLockTimeoutError) {
      return err({
        code: 'WRITE_ERROR',
        detail: e.message,
      });
    }
    throw e;
  }
}

async function writeConfigPatchLocked(
  opts: WriteConfigPatchOptions,
  absPath: string,
): Promise<WriteConfigPatchResult> {
  const { patch, scope, firstWriteHeader } = opts;

  let existingContent = '';
  let fileExists = false;
  if (existsSync(absPath)) {
    fileExists = true;
    try {
      existingContent = readFileSync(absPath, 'utf-8');
    } catch (e) {
      return err({
        code: 'WRITE_ERROR',
        detail: `Could not read existing config: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const doc = parseDocument(existingContent);
  if (doc.errors.length > 0) {
    return err({
      code: 'YAML_PARSE',
      detail: doc.errors.map((e) => e.message).join('; '),
    });
  }

  if (doc.contents === null) {
    doc.contents = doc.createNode({}) as ParsedNode;
  } else if (!isMap(doc.contents)) {
    return err({
      code: 'YAML_PARSE',
      detail: `Top-level YAML value must be a mapping (object), got ${isSeq(doc.contents) ? 'sequence' : 'scalar'}`,
    });
  }

  const appliedPaths = applyPatchToDocument(doc, patch);

  const merged = doc.toJSON();
  const parseResult = withConfigSpanSync(
    'config.validate',
    { 'config.scope': scope, 'config.validation.layer': 'L2' },
    (validateSpan) => {
      const r = ConfigSchema.safeParse(merged);
      validateSpan.setAttribute('config.outcome', r.success ? 'success' : 'rejected');
      if (!r.success) {
        for (const issue of r.error.issues) {
          addConfigSpanEvent('config.validation.issue', {
            'issue.path': issue.path.map((p) => String(p)).join('.'),
            'issue.message': issue.message,
          });
        }
      }
      return r;
    },
  );
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(toConfigIssue);
    return err({ code: 'SCHEMA_INVALID', issues });
  }

  let serialized = doc.toString();
  if (!fileExists) {
    const header =
      firstWriteHeader === undefined ? defaultFirstWriteHeader(scope) : (firstWriteHeader ?? '');
    if (header.length > 0) {
      const headerNormalized = header.endsWith('\n') ? header : `${header}\n`;
      serialized = `${headerNormalized}${serialized}`;
    }
  }

  try {
    await mkdir(dirname(absPath), { recursive: true });
  } catch (e) {
    return err({
      code: 'WRITE_ERROR',
      detail: `Could not create parent directory for ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  try {
    await atomicWriteFile(absPath, serialized);
  } catch (e) {
    return err({
      code: 'WRITE_ERROR',
      detail: `Could not write ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return ok({
    effective: parseResult.data,
    appliedPaths,
    path: absPath,
    created: !fileExists,
  });
}
