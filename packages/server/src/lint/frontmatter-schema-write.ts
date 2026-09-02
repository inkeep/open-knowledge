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
  let parentReal: string;
  try {
    parentReal = realpathSync(dirname(abs));
  } catch (err) {
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
