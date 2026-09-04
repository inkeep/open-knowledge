import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { findEnclosingProjectRoot, isProjectRoot } from './fs/find-project-root.ts';

export class SingleFileNotFoundError extends Error {
  constructor(readonly filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = 'SingleFileNotFoundError';
  }
}

export class SingleFileNotAFileError extends Error {
  constructor(readonly filePath: string) {
    super(`Not a file: ${filePath}. \`ok <file>\` opens a single markdown file.`);
    this.name = 'SingleFileNotAFileError';
  }
}

export class SingleFileProjectOverrideError extends Error {
  constructor(
    readonly projectRoot: string,
    reason: string,
  ) {
    super(`Cannot open with --project ${projectRoot}: ${reason}`);
    this.name = 'SingleFileProjectOverrideError';
  }
}

export class SingleFileNotMarkdownError extends Error {
  constructor(readonly filePath: string) {
    super(`OpenKnowledge edits markdown files (.md / .mdx): ${filePath}`);
    this.name = 'SingleFileNotMarkdownError';
  }
}

export type SingleFileOpenPlan =
  | {
      readonly mode: 'project';
      readonly projectRoot: string;
      readonly docName: string;
      readonly canonicalFilePath: string;
    }
  | {
      readonly mode: 'ephemeral';
      readonly canonicalFilePath: string;
      readonly contentDir: string;
      readonly singleDocRelPath: string;
      readonly docName: string;
    };

export interface PrepareSingleFileOpenOptions {
  readonly projectRoot?: string;
}

export function prepareSingleFileOpen(
  filePath: string,
  options: PrepareSingleFileOpenOptions = {},
): SingleFileOpenPlan {
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

  if (options.projectRoot !== undefined) {
    const projectRoot = resolve(options.projectRoot);
    if (!isProjectRoot(projectRoot)) {
      throw new SingleFileProjectOverrideError(
        projectRoot,
        'no .ok/config.yml there, so it is not an OpenKnowledge project root',
      );
    }
    const projectContentDir = resolveProjectContentDir(projectRoot);
    const relPath = relative(projectContentDir, canonicalFilePath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      throw new SingleFileProjectOverrideError(
        projectRoot,
        `${canonicalFilePath} is not inside that project's content directory`,
      );
    }
    return {
      mode: 'project',
      projectRoot,
      docName: stripDocExtension(relPath.split(sep).join('/')),
      canonicalFilePath,
    };
  }

  const hit = findEnclosingProjectRoot(fileDir);
  if (hit) {
    const projectRoot = hit.rootPath;
    const projectContentDir = resolveProjectContentDir(projectRoot);
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

function resolveProjectContentDir(projectRoot: string): string {
  const config = readConfigSafely({
    absPath: resolveConfigPath('project', projectRoot),
    sideline: false,
    warn: () => {},
  });
  const contentRel = config.value.content?.dir ?? '.';
  return resolve(projectRoot, contentRel);
}

export const EPHEMERAL_PROJECT_DIR_PREFIX = 'ok-ephemeral-';

export function seedEphemeralProjectDir(projectDir: string, contentDir: string): string {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(
    resolve(okDir, 'config.yml'),
    `# Ephemeral single-file session (\`ok <file>\`). Throwaway — safe to delete.\ncontent:\n  dir: ${JSON.stringify(contentDir)}\n`,
    'utf-8',
  );
  writeFileSync(resolve(okDir, '.gitignore'), 'local/\n', 'utf-8');
  return projectDir;
}

export function createEphemeralProjectDir(contentDir: string): string {
  return seedEphemeralProjectDir(
    mkdtempSync(resolve(tmpdir(), EPHEMERAL_PROJECT_DIR_PREFIX)),
    contentDir,
  );
}
