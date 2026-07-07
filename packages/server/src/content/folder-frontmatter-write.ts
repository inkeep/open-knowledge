/**
 * Filesystem writer for a single folder's `<folder>/.ok/frontmatter.yml`.
 *
 * Open-shape (any key, any supported value type), exactly like a doc's
 * frontmatter — it describes the folder itself and does NOT cascade into
 * child docs (templates own new-doc starting values). Merge-patch via the
 * shared `mergePatch` primitive, so folder and doc frontmatter behave
 * identically: a key present REPLACES; `null` / `''` / `[]` DROPS; clearing
 * every key removes the file and auto-cleans an empty `.ok/`.
 *
 * A folder is addressed by its own content-root-relative path. There is no
 * glob/match layer — one call writes exactly one folder.
 *
 * Writes are atomic (tmp + rename). When the merged frontmatter is empty
 * (every key cleared, or an empty patch), the file is removed and `.ok/` is
 * auto-cleaned (`templates/` may still be there; that case keeps `.ok/`).
 */

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
  /**
   * Absolute anchor directory the folder path resolves against. Both the MCP
   * `write` / `edit` folder targets and the `/api/folder-config` route pass the
   * resolved content directory, so folder frontmatter lands beside the folder
   * regardless of `content.dir`. For the universal `content.dir = '.'` case it
   * coincides with the project root.
   */
  anchorDir: string;
  /** Anchor-relative folder path. `''` targets the anchor directory itself. */
  folderRel: string;
  /**
   * Merge-patch — open-shape, like a doc's frontmatter. A key present
   * REPLACES the existing value; `null` / `''` / `[]` DROPS the key. An empty
   * patch (`{}`) deletes the file.
   */
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
  // File exists — re-throw on read AND parse failure so the caller surfaces it
  // as WRITE_ERROR. Returning `{}` on a parse error would silently truncate a
  // hand-edited file to just the patch fields during the merge.
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
    } catch {
      // Race or permission; leave it.
    }
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
