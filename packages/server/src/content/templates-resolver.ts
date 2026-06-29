
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseTemplateFile } from '@inkeep/open-knowledge-core';

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

/** Returned by `resolveProjectTemplates`. `truncated` is `true` when the
 *  walker bailed at `PROJECT_TEMPLATE_SCAN_CAP` and may have missed templates
 *  deeper in BFS order — callers should surface this so users know the list
 *  is incomplete. */
export interface ProjectTemplatesResult {
  templates: TemplateEntry[];
  truncated: boolean;
}

export function resolveProjectTemplates(projectDir: string): ProjectTemplatesResult {
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
      console.warn(
        `[ok-templates] project scan hit the ${PROJECT_TEMPLATE_SCAN_CAP}-directory cap at ${projectDir}; deeper templates were not enumerated. Queue depth at break: ${queue.length}.`,
      );
      break;
    }

    const seen = ensureSeen(folderRel);
    collectFromFolder(projectDir, folderRel, 'local', seen, out);

    const absDir = folderRel ? join(projectDir, folderRel) : projectDir;
    let entries: string[];
    try {
      entries = readdirSync(absDir).sort();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(absDir)) {
        templateMetaWarnedPaths.add(absDir);
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ok-templates] failed to read directory ${absDir} during project scan — skipped. Reason: ${reason}`,
        );
      }
      continue;
    }
    for (const name of entries) {
      if (PROJECT_TEMPLATE_DIR_SKIP.has(name)) continue;
      if (name.startsWith('.')) continue;
      const childAbs = join(absDir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(childAbs);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      const childRel = folderRel ? posix.join(folderRel, name) : name;
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

  if (!existsSync(templatesDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(templatesDir);
  } catch {
    return;
  }

  for (const entryName of entries) {
    if (!entryName.endsWith('.md')) continue;
    const name = entryName.slice(0, -3); // strip `.md`
    if (seen.has(name)) continue;

    const absPath = join(templatesDir, entryName);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(absPath);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;

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
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT' && !templateMetaWarnedPaths.has(absPath)) {
      templateMetaWarnedPaths.add(absPath);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ok-templates] failed to read template at ${absPath} — metadata skipped. Reason: ${reason}`,
      );
    }
    return {};
  }
  const { identity } = parseTemplateFile(content);
  if (typeof identity.title !== 'string' && !templateMetaWarnedPaths.has(absPath)) {
    templateMetaWarnedPaths.add(absPath);
    console.warn(
      `[ok-templates] template at ${absPath} has no title — YAML may be malformed or the title is missing.`,
    );
  }
  const result: TemplateMeta = {};
  if (typeof identity.title === 'string') result.title = identity.title;
  if (typeof identity.description === 'string') result.description = identity.description;
  return result;
}
