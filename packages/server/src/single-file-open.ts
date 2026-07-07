/**
 * Shared bootstrap for the no-project single-file open (`ok <file>`).
 *
 * Consumed by BOTH the CLI (`packages/cli`) and the desktop main process
 * (`packages/desktop`) so the two delivery surfaces compute the same plan and
 * can't diverge. The load-bearing rule: **realpath the file
 * BEFORE project detection** — detection keys on the inode, while the editor's
 * write-back forces `contentDir = realpath-parent` (the `symlink-escape` gate).
 * Routing detection on a non-canonical path would mis-route a symlink into a
 * real project to ephemeral mode and clobber the project's file on the same
 * inode.
 *
 *   - Project mode: the file's realpath sits under an ancestor `.ok/config.yml`
 *     → open that project focused on the file's ext-less doc path.
 *   - Ephemeral mode: a standalone file → an ephemeral single-file session
 *     (temp projectDir, real-parent contentDir, single-file content scope).
 */

import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { findEnclosingProjectRoot } from './fs/find-project-root.ts';

/** The file passed to `ok <file>` does not exist on disk. */
export class SingleFileNotFoundError extends Error {
  constructor(readonly filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = 'SingleFileNotFoundError';
  }
}

/** The path passed to `ok <file>` resolves to a directory, not a file. */
export class SingleFileNotAFileError extends Error {
  constructor(readonly filePath: string) {
    super(`Not a file: ${filePath}. \`ok <file>\` opens a single markdown file.`);
    this.name = 'SingleFileNotAFileError';
  }
}

/** The file passed to `ok <file>` is not a supported markdown file (.md/.mdx). */
export class SingleFileNotMarkdownError extends Error {
  constructor(readonly filePath: string) {
    super(`OpenKnowledge edits markdown files (.md / .mdx): ${filePath}`);
    this.name = 'SingleFileNotMarkdownError';
  }
}

export type SingleFileOpenPlan =
  | {
      readonly mode: 'project';
      /** Absolute path of the enclosing project root (where `.ok/config.yml` lives). */
      readonly projectRoot: string;
      /** Ext-less doc path relative to the project's resolved content dir (forward slashes). */
      readonly docName: string;
      /** `realpath(filePath)` — the canonical inode path. */
      readonly canonicalFilePath: string;
    }
  | {
      readonly mode: 'ephemeral';
      /** `realpath(filePath)` — also the ephemeral-session dedup key. */
      readonly canonicalFilePath: string;
      /** The file's real parent directory — the ephemeral session's contentDir. */
      readonly contentDir: string;
      /** Basename of the file — the single-file content scope key. */
      readonly singleDocRelPath: string;
      /** Ext-less doc name (`notes.md` → `notes`) — the `#/<doc>` route target. */
      readonly docName: string;
    };

/**
 * Resolve `filePath` to a single-file open plan. Throws a typed error for a
 * missing path, a directory, or a non-markdown file (callers render a clean CLI
 * message). REALPATHS the file first, then runs project detection on the
 * canonical parent dir.
 */
export function prepareSingleFileOpen(filePath: string): SingleFileOpenPlan {
  // Validate the markdown extension on the user-supplied path before touching
  // the filesystem — a clear, fast rejection for `ok notes.txt`.
  if (!isSupportedDocFile(filePath)) {
    throw new SingleFileNotMarkdownError(filePath);
  }

  let canonicalFilePath: string;
  try {
    canonicalFilePath = realpathSync(resolve(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SingleFileNotFoundError(filePath);
    }
    throw err;
  }

  if (!statSync(canonicalFilePath).isFile()) {
    throw new SingleFileNotAFileError(filePath);
  }

  const fileDir = dirname(canonicalFilePath);
  const hit = findEnclosingProjectRoot(fileDir);
  if (hit) {
    const projectRoot = hit.rootPath;
    const projectContentDir = resolveProjectContentDir(projectRoot);
    // doc path relative to the project's content dir, ext-less, forward slashes.
    const relPath = relative(projectContentDir, canonicalFilePath).split(sep).join('/');
    return {
      mode: 'project',
      projectRoot,
      docName: stripDocExtension(relPath),
      canonicalFilePath,
    };
  }

  const singleDocRelPath = basename(canonicalFilePath);
  return {
    mode: 'ephemeral',
    canonicalFilePath,
    contentDir: fileDir,
    singleDocRelPath,
    docName: stripDocExtension(singleDocRelPath),
  };
}

/**
 * Resolve a project's content directory by reading its `.ok/config.yml`. Falls
 * back to the project root (content.dir defaults to `.`) on any read/parse
 * failure — `readConfigSafely` never throws.
 */
function resolveProjectContentDir(projectRoot: string): string {
  const config = readConfigSafely({
    absPath: resolveConfigPath('project', projectRoot),
    sideline: false,
    warn: () => {},
  });
  const contentRel = config.value.content?.dir ?? '.';
  return resolve(projectRoot, contentRel);
}

/**
 * Create the throwaway `projectDir` for an ephemeral single-file session: an
 * `os.tmpdir()` `mkdtemp` carrying a synthesized minimal `.ok/config.yml`
 * (so the boot config gate passes) plus a `.ok/.gitignore` (so the
 * boot hygiene warning stays quiet). The `.ok/local/` runtime state (lock,
 * shadow, caches) lands here, never in the user's directory. The owner of
 * the session lifecycle (the CLI browser path, or the desktop window) removes
 * this directory on teardown.
 *
 * `contentDir` is written into `content.dir` for honesty, but the ephemeral
 * boot passes `contentDir` explicitly — config resolution does not drive it.
 */
export function createEphemeralProjectDir(contentDir: string): string {
  const projectDir = mkdtempSync(resolve(tmpdir(), 'ok-ephemeral-'));
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  // Minimal valid YAML config — empty would also parse to schema defaults, but
  // recording content.dir keeps the throwaway project self-describing.
  writeFileSync(
    resolve(okDir, 'config.yml'),
    `# Ephemeral single-file session (\`ok <file>\`). Throwaway — safe to delete.\ncontent:\n  dir: ${JSON.stringify(contentDir)}\n`,
    'utf-8',
  );
  // Keeps the per-boot "`.ok/.gitignore` missing" hygiene warning quiet; the
  // dir is in os.tmpdir with no git, so the contents are informational only.
  writeFileSync(resolve(okDir, '.gitignore'), 'local/\n', 'utf-8');
  return projectDir;
}
