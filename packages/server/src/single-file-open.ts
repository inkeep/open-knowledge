
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { findEnclosingProjectRoot } from './fs/find-project-root.ts';

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

export function prepareSingleFileOpen(filePath: string): SingleFileOpenPlan {
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

export function createEphemeralProjectDir(contentDir: string): string {
  const projectDir = mkdtempSync(resolve(tmpdir(), 'ok-ephemeral-'));
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
