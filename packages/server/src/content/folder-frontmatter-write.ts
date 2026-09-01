import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type FrontmatterRecord, mergePatch } from './frontmatter-merge.ts';

export interface FolderFrontmatterPatchInput {
  anchorDir: string;
  folderRel: string;
  patch: FrontmatterRecord;
}

export type FolderFrontmatterPatchResult =
  | { ok: true; path: string; action: 'written' | 'deleted' | 'noop' }
  | {
      ok: false;
      error: {
        code: 'BAD_CONTENT_DIR' | 'PATH_ESCAPE' | 'WRITE_ERROR';
        message: string;
      };
    };

export function applyFolderFrontmatterPatch(
  input: FolderFrontmatterPatchInput,
): FolderFrontmatterPatchResult {
  if (!isAbsolute(input.anchorDir)) {
    return { ok: false, error: { code: 'BAD_CONTENT_DIR', message: 'anchorDir must be absolute' } };
  }
  const contentAbs = resolve(input.anchorDir);
  const folderRel = input.folderRel.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (folderRel.split('/').some((seg) => seg === '..')) {
    return {
      ok: false,
      error: {
        code: 'PATH_ESCAPE',
        message: `Folder path escapes the content directory: ${input.folderRel}`,
      },
    };
  }
  const targetAbs = folderRel === '' ? contentAbs : resolve(contentAbs, folderRel);
  if (targetAbs !== contentAbs && !targetAbs.startsWith(contentAbs + sep)) {
    return {
      ok: false,
      error: {
        code: 'PATH_ESCAPE',
        message: `Resolved folder escapes the content directory: ${targetAbs}`,
      },
    };
  }

  const okDir = join(targetAbs, '.ok');
  const fmPath = join(okDir, 'frontmatter.yml');

  try {
    const existing = readExistingFrontmatter(fmPath);
    const isEmptyPatch = Object.keys(input.patch).length === 0;
    const merged = isEmptyPatch ? {} : mergePatch(existing, input.patch);

    if (Object.keys(merged).length === 0) {
      if (existsSync(fmPath)) {
        unlinkSync(fmPath);
        autoCleanOkDir(okDir);
        return { ok: true, path: relPathOf(contentAbs, fmPath), action: 'deleted' };
      }
      return { ok: true, path: relPathOf(contentAbs, fmPath), action: 'noop' };
    }

    mkdirSync(okDir, { recursive: true });
    const yaml = stringifyYaml(merged);
    const tmpPath = `${fmPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, yaml, 'utf-8');
    renameSync(tmpPath, fmPath);
    return { ok: true, path: relPathOf(contentAbs, fmPath), action: 'written' };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write folder frontmatter for "${folderRel || '.'}": ${(err as Error).message}`,
      },
    };
  }
}

function readExistingFrontmatter(absPath: string): FrontmatterRecord {
  if (!existsSync(absPath)) return {};
  const content = readFileSync(absPath, 'utf-8');
  const parsed: unknown = parseYaml(content);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return { ...(parsed as FrontmatterRecord) };
}

function autoCleanOkDir(okAbsDir: string): void {
  if (!existsSync(okAbsDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(okAbsDir);
  } catch {
    return;
  }
  if (entries.length === 0) {
    try {
      rmdirSync(okAbsDir);
    } catch {}
  }
}

function relPathOf(rootAbs: string, abs: string): string {
  if (abs.startsWith(rootAbs + sep)) {
    return abs
      .slice(rootAbs.length + 1)
      .split(sep)
      .join('/');
  }
  return abs;
}
