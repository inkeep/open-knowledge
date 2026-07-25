/**
 * Frontmatter schema-file WRITE surface: merge one field's constraints into a
 * schema file via the core `applyFieldConstraint` (non-destructive — advanced
 * keywords survive verbatim), creating the file with the draft-07 skeleton on
 * first edit. Same safety posture as the markdownlint writer: project-root
 * escape guarding (lexical + realpath), atomic tmp+rename through the traced
 * fs wrappers, and a typed refusal instead of a throw for policy declines.
 *
 * Write/create scope is deliberately broader than delete's. A mapping may
 * point at any project-relative JSON file (`loadSchemaFile` accepts any path),
 * so the editor must be able to write wherever the linter can already read.
 * Delete narrows to `isFrontmatterSchemaAsset` because it is destructive and
 * irreversible, so it fails closed to the naming convention instead.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  applyFieldConstraint,
  emptyFrontmatterSchemaText,
  type FrontmatterFieldConstraint,
  FrontmatterSchemaEditError,
  isFrontmatterSchemaAsset,
  removeSchemaField,
  renameSchemaField,
  type SchemaParentPathSegment,
} from '@inkeep/open-knowledge-core';
import { tracedUnlinkSync } from '../fs-traced.ts';
import { isInside, writeFileAtomic } from './fs-safety.ts';

export type WriteFrontmatterSchemaResult =
  | { action: 'written' | 'created' | 'deleted'; file: string }
  | { action: 'refused'; file: string; reason: string };

function refused(file: string, reason: string): { refusal: WriteFrontmatterSchemaResult } {
  return { refusal: { action: 'refused', file, reason } };
}

/**
 * Resolve `file` to its guarded on-disk write target: lexical containment
 * first (an escaping path is refused even when it doesn't exist), then
 * realpath containment — on the existing file (a symlinked schema is edited
 * in place; an escaping link is refused), or, in `create-missing` mode, on
 * the freshly-made parent directory (often `.ok/schemas/`). In
 * `require-existing` mode a missing file is a refusal and nothing is created
 * — the remove/rename/transform operations have nothing to edit.
 */
function resolveSchemaWriteTarget(
  projectDir: string,
  file: string,
  mode: 'create-missing' | 'require-existing',
):
  | { target: string; exists: boolean; currentText: string }
  | { refusal: WriteFrontmatterSchemaResult } {
  const abs = resolve(projectDir, file);
  if (!isInside(abs, resolve(projectDir))) {
    return refused(file, 'path resolves outside the project');
  }
  if (existsSync(abs)) {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch (err) {
      return refused(file, `cannot read (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!isInside(real, realpathSync(projectDir))) {
      return refused(file, 'path resolves outside the project');
    }
    return { target: real, exists: true, currentText: readFileSync(real, 'utf-8') };
  }
  if (mode === 'require-existing') {
    return refused(file, 'file does not exist');
  }
  mkdirSync(dirname(abs), { recursive: true });
  const parentReal = realpathSync(dirname(abs));
  if (!isInside(parentReal, realpathSync(projectDir))) {
    return refused(file, 'path resolves outside the project');
  }
  return { target: resolve(parentReal, basename(abs)), exists: false, currentText: '' };
}

export function writeFrontmatterSchemaField(
  projectDir: string,
  file: string,
  field: string,
  constraint: FrontmatterFieldConstraint,
  parentPath: readonly SchemaParentPathSegment[] = [],
): WriteFrontmatterSchemaResult {
  const resolved = resolveSchemaWriteTarget(projectDir, file, 'create-missing');
  if ('refusal' in resolved) return resolved.refusal;
  let nextText: string;
  try {
    nextText = applyFieldConstraint(resolved.currentText, field, constraint, parentPath);
  } catch (err) {
    if (err instanceof FrontmatterSchemaEditError) {
      return { action: 'refused', file, reason: err.message };
    }
    throw err;
  }
  if (nextText === resolved.currentText) return { action: 'written', file };
  writeFileAtomic(resolved.target, nextText);
  return { action: resolved.exists ? 'written' : 'created', file };
}

/**
 * Scaffold an empty schema file (the draft-07 skeleton) at `file` if it does
 * not already exist — the create-empty half of the write surface, so the
 * picker's "create new schema" lands a real, valid file before any field is
 * added. Idempotent: an existing file is left untouched (never clobbered).
 */
export function createEmptyFrontmatterSchemaFile(
  projectDir: string,
  file: string,
): WriteFrontmatterSchemaResult {
  const resolved = resolveSchemaWriteTarget(projectDir, file, 'create-missing');
  if ('refusal' in resolved) return resolved.refusal;
  if (resolved.exists) return { action: 'written', file };
  writeFileAtomic(resolved.target, emptyFrontmatterSchemaText());
  return { action: 'created', file };
}

/** Apply a whole-schema transform to an existing schema file, atomically. */
function transformSchemaFile(
  projectDir: string,
  file: string,
  transform: (currentText: string) => string,
): WriteFrontmatterSchemaResult {
  const resolved = resolveSchemaWriteTarget(projectDir, file, 'require-existing');
  if ('refusal' in resolved) return resolved.refusal;
  let nextText: string;
  try {
    nextText = transform(resolved.currentText);
  } catch (err) {
    if (err instanceof FrontmatterSchemaEditError) {
      return { action: 'refused', file, reason: err.message };
    }
    throw err;
  }
  if (nextText !== resolved.currentText) writeFileAtomic(resolved.target, nextText);
  return { action: 'written', file };
}

/** Remove one field (properties entry + required membership) from a schema file. */
export function removeFrontmatterSchemaField(
  projectDir: string,
  file: string,
  field: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): WriteFrontmatterSchemaResult {
  return transformSchemaFile(projectDir, file, (text) =>
    removeSchemaField(text, field, parentPath),
  );
}

/** Rename one field in a schema file, carrying unmodeled keywords + required. */
export function renameFrontmatterSchemaField(
  projectDir: string,
  file: string,
  field: string,
  to: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): WriteFrontmatterSchemaResult {
  return transformSchemaFile(projectDir, file, (text) =>
    renameSchemaField(text, field, to, parentPath),
  );
}

/**
 * Delete a schema file. Deletable scope = the schema-browser's scope
 * (`isFrontmatterSchemaAsset`): the ecosystem `*.schema.json` convention
 * anywhere in the project plus `.ok/schemas/*.json`; anything else is a
 * typed refusal. Unlinks the directory ENTRY (never a symlink's target, so a
 * planted link can't reach outside the project), and is idempotent: an
 * already-absent file reports `deleted` so a retried delete flow can't fail.
 */
export function deleteFrontmatterSchemaFile(
  projectDir: string,
  file: string,
): WriteFrontmatterSchemaResult {
  if (!isFrontmatterSchemaAsset(file)) {
    return {
      action: 'refused',
      file,
      reason: 'only *.schema.json files (or .ok/schemas/*.json) can be deleted',
    };
  }
  const abs = resolve(projectDir, file);
  if (!isInside(abs, resolve(projectDir))) {
    return { action: 'refused', file, reason: 'path resolves outside the project' };
  }
  // The parent (`.ok/schemas/`) could itself be a symlink pointing outside the
  // project — resolve it first so the unlinked entry provably lives inside.
  let parentReal: string;
  try {
    parentReal = realpathSync(dirname(abs));
  } catch (err) {
    // ENOENT/ENOTDIR prove the entry cannot exist (missing parent, or a
    // non-directory component), so reporting it gone is honest. Anything else
    // — EACCES, EPERM, ELOOP, EIO — means we could NOT prove it: the file may
    // well still be there, and returning `deleted` would make the GUI drop the
    // mapping and silently stop validating those docs.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { action: 'deleted', file };
    return {
      action: 'refused',
      file,
      reason: `cannot read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!isInside(parentReal, realpathSync(projectDir))) {
    return { action: 'refused', file, reason: 'path resolves outside the project' };
  }
  try {
    tracedUnlinkSync(resolve(parentReal, basename(abs)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { action: 'deleted', file };
    throw err;
  }
  return { action: 'deleted', file };
}
