/**
 * Templates aggregation resolver.
 *
 * For a target folder, gathers the templates "menu" the agent can pick
 * from when creating a new doc by walking leaf → root over the folder's
 * ancestry, collecting every `<level>/.ok/templates/*.md`. The target
 * folder's own templates are scope: "local"; ancestors' are scope:
 * "inherited". Closest wins on filename collision.
 *
 * Descendant templates do NOT surface in the parent's array — they appear
 * only inside `subfolders[].templates_available` at their own `"local"`
 * scope when `exec` lists a directory recursively. The recursive
 * subfolders enrichment is the responsibility of the `exec` ls
 * enrichment, not this resolver.
 *
 * Each entry's title + description come from the template file's own
 * frontmatter. `title` is required at template-write time; a stored
 * template always has one. `description` is optional.
 *
 * Synchronous I/O; matches the pattern in `nested-folder-rules.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseTemplateFile } from '@inkeep/open-knowledge-core';

type TemplateScope = 'local' | 'inherited';

export interface TemplateEntry {
  /** Filename without `.md` extension. Stable identifier for write. */
  name: string;
  /** From template frontmatter; required at write time. */
  title?: string;
  /** From template frontmatter; absent if not declared. */
  description?: string;
  /** Project-root-relative path to the template file with `/` separators. */
  path: string;
  /**
   * Project-root-relative folder owning the `.ok/templates/` directory
   * (`""` for project root).
   */
  source_folder: string;
  /**
   * - `local` — template lives in the target folder's own `.ok/templates/`.
   * - `inherited` — template lives in an ancestor folder's `.ok/templates/`.
   */
  scope: TemplateScope;
}

interface ResolveTemplatesOptions {
  /**
   * Reserved for forward-compat. Currently ignored — the resolver always
   * walks leaf → root over the target folder's ancestry. List-time
   * descent into subfolders is handled by the `exec` ls enrichment
   * directly, NOT here. Pass `1` (the default).
   */
  depth?: number;
}

/**
 * Resolve the templates menu for a target folder.
 *
 * @param projectDir    - Absolute project root.
 * @param folderRelPath - Project-root-relative folder path. Empty / `.`
 *                        means the project root.
 */
export function resolveTemplatesAvailable(
  projectDir: string,
  folderRelPath: string,
  _options: ResolveTemplatesOptions = {},
): TemplateEntry[] {
  const normalized = normalizeFolderPath(folderRelPath);
  const segments = normalized === '' ? [] : normalized.split('/');

  // Track template names already claimed by a closer scope. The walk order
  // (target folder → ancestors) guarantees first-seen wins, mirroring
  // "closest wins on collision".
  const seen = new Set<string>();
  const out: TemplateEntry[] = [];

  // 1. Target folder itself → scope: local
  collectFromFolder(projectDir, normalized, 'local', seen, out);

  // 2. Walk ancestors leaf → root → scope: inherited
  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorPath = segments.slice(0, i).join('/');
    collectFromFolder(projectDir, ancestorPath, 'inherited', seen, out);
  }
  // Project root itself is also an ancestor when target is non-root.
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

/**
 * Project-wide flat enumeration of templates — every `.ok/templates/*.md`
 * file under `projectDir`, regardless of scope or inheritance. Used by the
 * editor's empty-state surface to list every template the user can create
 * from. Each entry's `source_folder` is where the template file lives.
 *
 * Scope is always `'local'` here. Bounded by `PROJECT_TEMPLATE_SCAN_CAP`
 * directories visited; `truncated: true` in the result signals the cap hit.
 */
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
      // readdirSync order is filesystem-dependent (ext4 htree hash order vs
      // APFS), so an unsorted BFS makes which folders fall inside
      // PROJECT_TEMPLATE_SCAN_CAP nondeterministic — a folder that survives the
      // cap on one run can be dropped on the next. Sort so the dequeue order,
      // and thus the cap truncation boundary, is stable across runs/platforms.
      entries = readdirSync(absDir).sort();
    } catch (err) {
      // Non-ENOENT failures (EPERM, EACCES, ENOTDIR, symlink loop) indicate
      // a real problem worth a once-per-path log so an operator can trace
      // "my templates aren't showing up" complaints. ENOENT is benign —
      // a folder existed when we queued it but was removed before we
      // walked into it (file watcher race). Mirrors the `readTemplateMeta`
      // pattern below, sharing its `templateMetaWarnedPaths` dedupe set.
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
      // Dot-prefixed dirs (other than `.ok`, already skipped) are user-
      // hidden — `.archive/`, `.private/`, etc. — and follow the same
      // visibility rule the sidebar's filterVisibleEntries uses.
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

/** Cap on directory walks during project-wide template enumeration. */
const PROJECT_TEMPLATE_SCAN_CAP = 2000;

/**
 * Non-dot directories the walker skips. Dot-prefixed dirs (`.git`, `.ok`,
 * `.changeset`, `.claude`, `.agents`, user-authored `.archive/`, etc.)
 * are already filtered by the dot-prefix rule in the walker; this set is
 * just the visible-but-irrelevant ones.
 *
 * **Drift note:** intentionally a subset of `DIR_SKIP` in
 * `enrichment.ts` — we only enumerate the non-dot entries here because
 * the dot-prefix rule above covers the rest. If a new non-dot skip entry
 * is added to either side (e.g. `target/`, `out/`), mirror it to the
 * other to keep the two walkers aligned.
 */
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
  // `title`/`description` live under the `template:` identity key in the
  // single-block format (legacy two-block templates resolve identically via
  // the shared parser). `parseTemplateFile` is total — malformed YAML yields
  // an empty identity rather than throwing.
  const { identity } = parseTemplateFile(content);
  // The core parser is silent by design, but a title-less template signals a
  // problem worth a once-per-path server log: the write path enforces
  // `TEMPLATE_TITLE_REQUIRED`, so a missing title means hand-edited YAML is
  // malformed (e.g. an unquoted colon) or the title was deleted. Restores the
  // operator-facing diagnostic the previous YAML-parse path emitted.
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
