import { type Dirent, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseTemplateFile } from '@inkeep/open-knowledge-core';
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import { assertNoSymlinkEscape } from '../fs-safety.ts';
import { errnoCode } from '../http/handler-utils.ts';
import { getLogger } from '../logger.ts';

type TemplateScope = 'local' | 'inherited';

export interface TemplateEntry {
  name: string;
  title?: string;
  description?: string;
  path: string;
  source_folder: string;
  scope: TemplateScope;
}

interface ResolveTemplatesOptions {
  depth?: number;
}

export function resolveTemplatesAvailable(
  projectDir: string,
  folderRelPath: string,
  _options: ResolveTemplatesOptions = {},
): TemplateEntry[] {
  const normalized = normalizeFolderPath(folderRelPath);
  const segments = normalized === '' ? [] : normalized.split('/');

  const seen = new Set<string>();
  const out: TemplateEntry[] = [];

  collectFromFolder(projectDir, normalized, 'local', seen, out);

  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorPath = segments.slice(0, i).join('/');
    collectFromFolder(projectDir, ancestorPath, 'inherited', seen, out);
  }
  if (segments.length > 0) {
    collectFromFolder(projectDir, '', 'inherited', seen, out);
  }

  return out;
}

export interface ProjectTemplatesResult {
  templates: TemplateEntry[];
  truncated: boolean;
}

export async function resolveProjectTemplates(projectDir: string): Promise<ProjectTemplatesResult> {
  const out: TemplateEntry[] = [];
  const seenPerFolder = new Map<string, Set<string>>();

  const ensureSeen = (folder: string): Set<string> => {
    let set = seenPerFolder.get(folder);
    if (!set) {
      set = new Set();
      seenPerFolder.set(folder, set);
    }
    return set;
  };

  let visited = 0;
  let truncated = false;
  const queue: string[] = [''];
  while (queue.length > 0) {
    const folderRel = queue.shift() ?? '';
    if (visited++ >= PROJECT_TEMPLATE_SCAN_CAP) {
      truncated = true;
      getLogger('templates').warn(
        { projectDir, cap: PROJECT_TEMPLATE_SCAN_CAP, queueDepth: queue.length },
        `project scan hit the ${PROJECT_TEMPLATE_SCAN_CAP}-directory cap at ${projectDir}; deeper templates were not enumerated. Queue depth at break: ${queue.length}.`,
      );
      break;
    }

    const seen = ensureSeen(folderRel);
    collectFromFolder(projectDir, folderRel, 'local', seen, out);

    const absDir = folderRel ? join(projectDir, folderRel) : projectDir;
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(absDir)) {
        templateMetaWarnedPaths.add(absDir);
        const reason = err instanceof Error ? err.message : String(err);
        getLogger('templates').warn(
          { dir: absDir, reason },
          `failed to read directory ${absDir} during project scan — skipped. Reason: ${reason}`,
        );
      }
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (PROJECT_TEMPLATE_DIR_SKIP.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        const linkPath = join(absDir, entry.name);
        try {
          isDirectory = (await stat(linkPath)).isDirectory();
        } catch (err) {
          const code = errnoCode(err);
          if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(linkPath)) {
            templateMetaWarnedPaths.add(linkPath);
            const reason = err instanceof Error ? err.message : String(err);
            getLogger('templates').warn(
              { link: linkPath, reason },
              `failed to resolve symlink ${linkPath} during project scan — skipped. Reason: ${reason}`,
            );
          }
          continue;
        }
      }
      if (!isDirectory) continue;
      const childRel = folderRel ? posix.join(folderRel, entry.name) : entry.name;
      queue.push(childRel);
    }
  }
  return { templates: out, truncated };
}

const PROJECT_TEMPLATE_SCAN_CAP = 2000;

const PROJECT_TEMPLATE_DIR_SKIP: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build']);

function collectFromFolder(
  projectDir: string,
  folderRelPath: string,
  scope: TemplateScope,
  seen: Set<string>,
  out: TemplateEntry[],
): void {
  const templatesDir = folderRelPath
    ? join(projectDir, folderRelPath, '.ok', 'templates')
    : join(projectDir, '.ok', 'templates');

  let dirStat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(templatesDir);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT' && !templateMetaWarnedPaths.has(templatesDir)) {
      templateMetaWarnedPaths.add(templatesDir);
      const reason = err instanceof Error ? err.message : String(err);
      getLogger('templates').warn(
        { dir: templatesDir, reason },
        `cannot stat templates directory ${templatesDir} — its templates are not enumerated. Reason: ${reason}`,
      );
    }
    return;
  }
  if (!dirStat.isDirectory()) {
    if (!templateMetaWarnedPaths.has(templatesDir)) {
      templateMetaWarnedPaths.add(templatesDir);
      getLogger('templates').warn(
        { dir: templatesDir },
        `${templatesDir} is not a real directory (symlink or file) — its templates are not enumerated`,
      );
    }
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(templatesDir);
  } catch {
    return;
  }

  for (const entryName of entries) {
    if (!entryName.endsWith('.md')) continue;
    const name = entryName.slice(0, -3);
    if (seen.has(name)) continue;

    const absPath = join(templatesDir, entryName);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(absPath);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;

    try {
      assertNoSymlinkEscape(absPath, templatesDir);
      assertNoSymlinkEscape(absPath, projectDir);
    } catch (err) {
      if (err instanceof SymlinkEscapeError) {
        if (!templateMetaWarnedPaths.has(absPath)) {
          templateMetaWarnedPaths.add(absPath);
          getLogger('templates').warn(
            { template: absPath, reason: err.message },
            `template ${absPath} escapes its containment boundary — excluded from the menu. Reason: ${err.message}`,
          );
        }
        continue;
      }
      const code = errnoCode(err);
      if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(absPath)) {
        templateMetaWarnedPaths.add(absPath);
        const reason = err instanceof Error ? err.message : String(err);
        getLogger('templates').warn(
          { template: absPath, reason },
          `failed to canonicalize template ${absPath} — excluded from the menu. Reason: ${reason}`,
        );
      }
      continue;
    }

    const meta = readTemplateMeta(absPath);
    const relPath = folderRelPath
      ? posix.join(folderRelPath, '.ok', 'templates', entryName)
      : posix.join('.ok', 'templates', entryName);

    const tplEntry: TemplateEntry = {
      name,
      path: relPath,
      source_folder: folderRelPath,
      scope,
    };
    if (meta.title !== undefined) tplEntry.title = meta.title;
    if (meta.description !== undefined) tplEntry.description = meta.description;

    seen.add(name);
    out.push(tplEntry);
  }
}

function normalizeFolderPath(folderRelPath: string): string {
  return folderRelPath
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
}

interface TemplateMeta {
  title?: string;
  description?: string;
}

const templateMetaWarnedPaths = new Set<string>();

function readTemplateMeta(absPath: string): TemplateMeta {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(absPath)) {
      templateMetaWarnedPaths.add(absPath);
      const reason = err instanceof Error ? err.message : String(err);
      getLogger('templates').warn(
        { path: absPath, reason },
        `failed to read template at ${absPath} — metadata skipped. Reason: ${reason}`,
      );
    }
    return {};
  }
  const { identity } = parseTemplateFile(content);
  if (typeof identity.title !== 'string' && !templateMetaWarnedPaths.has(absPath)) {
    templateMetaWarnedPaths.add(absPath);
    getLogger('templates').warn(
      { path: absPath },
      `template at ${absPath} has no title — YAML may be malformed or the title is missing.`,
    );
  }
  const result: TemplateMeta = {};
  if (typeof identity.title === 'string') result.title = identity.title;
  if (typeof identity.description === 'string') result.description = identity.description;
  return result;
}
