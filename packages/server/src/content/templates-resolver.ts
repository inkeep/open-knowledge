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
 * `resolveTemplatesAvailable` uses synchronous I/O; matches the pattern in
 * `nested-folder-rules.ts`. Its walk is bounded by the target folder's path
 * depth, so it stays cheap regardless of project size.
 *
 * `resolveProjectTemplates` walks the WHOLE project and is async for that
 * reason — see its doc comment.
 */

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
 * Containment contract: a `.ok/templates` that is itself a symlink is skipped
 * wholesale (`lstat` gate — the per-entry anchors constrain entries, not the
 * directory they were enumerated from), and every entry returned resolves (via
 * realpath) to a file inside the real `.ok/templates/` directory it was
 * enumerated from AND inside `projectDir` — the conjunction, not either alone.
 * `collectFromFolder` drops any `.ok/templates/*.md` that fails either anchor:
 * the first catches a link that stays inside the project but points at
 * `.ok/local/` or `.git/`; the second is defense-in-depth against the dir
 * relocating between the `lstat` gate and enumeration. A menu entry is
 * therefore always safe for a consumer to read.
 * Shared by `resolveProjectTemplates`, so both surfaces inherit the guarantee.
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
 *
 * Async because this walks the entire project: on a large repo the walk
 * reaches the cap, and doing that synchronously stalls the same event loop
 * that services CRDT sync — which readers feel as keystroke lag. Awaiting
 * per directory lets sync messages interleave.
 *
 * Every call re-walks, deliberately. Templates reach disk through two
 * unrelated substrates (the filesystem writers in `templates-write.ts` and
 * the CRDT content persistence path behind `PUT /api/template` — a template is
 * a content doc, so the managed-artifact store no-ops its name) as well as
 * plain external edits, so any memo here has to be invalidated from
 * each of them — a completeness obligation that is easy to violate silently,
 * and whose failure mode is a template the user just created not appearing.
 * The async walk is what removes the latency harm; caching on top bought
 * little and risked that.
 */
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
      // `withFileTypes` carries the entry kind in the readdir result, so the
      // common case needs no per-entry stat at all.
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      // Non-ENOENT failures (EPERM, EACCES, ENOTDIR, symlink loop) indicate
      // a real problem worth a once-per-path log so an operator can trace
      // "my templates aren't showing up" complaints. ENOENT is benign —
      // a folder existed when we queued it but was removed before we
      // walked into it (file watcher race). Mirrors the `readTemplateMeta`
      // pattern below, sharing its `templateMetaWarnedPaths` dedupe set.
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
    // readdir order is filesystem-dependent (ext4 htree hash order vs APFS),
    // so an unsorted BFS makes which folders fall inside
    // PROJECT_TEMPLATE_SCAN_CAP nondeterministic — a folder that survives the
    // cap on one run can be dropped on the next. Sort so the dequeue order,
    // and thus the cap truncation boundary, is stable across runs/platforms.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (PROJECT_TEMPLATE_DIR_SKIP.has(entry.name)) continue;
      // Dot-prefixed dirs (other than `.ok`, already skipped) are user-
      // hidden — `.archive/`, `.private/`, etc. — and follow the same
      // visibility rule the sidebar's filterVisibleEntries uses.
      if (entry.name.startsWith('.')) continue;
      let isDirectory = entry.isDirectory();
      // A Dirent reports the LINK's own type, so a symlink pointing at a
      // directory reads as not-a-directory. Resolve just those with a
      // following stat — symlinked folders stay walkable and non-links
      // still skip the syscall.
      if (!isDirectory && entry.isSymbolicLink()) {
        const linkPath = join(absDir, entry.name);
        try {
          isDirectory = (await stat(linkPath)).isDirectory();
        } catch (err) {
          // A dangling link (ENOENT) is ordinary and stays silent. Anything
          // else — EACCES, ELOOP, EPERM — drops a whole subtree out of the
          // list, so it earns the same once-per-path warn the readdir failure
          // above does, sharing its dedupe set.
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

  // Refuse a `.ok/templates` that is not a REAL directory. `existsSync` /
  // `readdirSync` follow a directory symlink, and the per-entry anchors below
  // constrain each ENTRY, not the directory it was enumerated from — a
  // templates dir symlinked elsewhere IN-project would pass both anchors
  // (anchor 1 realpaths to the link target; anchor 2 because the target is
  // inside the project) and surface foreign `.md` files as menu items. `lstat`
  // does not follow the link, so a symlinked templates dir is skipped wholesale.
  // Deliberately blanket: an in-project `-> ../../shared-templates` link is
  // refused too — the safer default until shared templates are a first-class
  // shape. Both refusals below warn once per path (the sibling drop paths'
  // pattern) so a vanished menu is traceable; only the benign ENOENT
  // ("no templates here", the overwhelmingly common case) stays silent.
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

    // Containment is enforced HERE so every consumer of the templates menu —
    // create-page, the MCP write tool, `/api/templates`, the `exec` ls
    // enrichment — inherits it from one point. `statSync` above follows
    // symlinks, so a `<folder>/.ok/templates/<name>.md` symlink would otherwise
    // let that consumer inline arbitrary file bytes into a new doc, or surface a
    // foreign file's frontmatter as template metadata. TWO anchors, and both are
    // load-bearing — they are complementary, not alternatives:
    // - `templatesDir`: the entry must not leave the dir it was enumerated from.
    //   A link that realpaths elsewhere INSIDE the project (e.g.
    //   `-> ../local/last-spawn-error.log` or `-> ../../.git/config`) is still an
    //   exfiltration channel into the synced content tree; `.ok/local/` and
    //   `.git/` are deliberately out of content scope.
    // - `projectDir`: `assertNoSymlinkEscape` realpaths its ANCHOR, so if
    //   `templatesDir` were itself a symlink out of the project, the first
    //   anchor would become the link target and admit everything under it. The
    //   `lstat` gate above refuses a symlinked templates dir before enumeration;
    //   this anchor is the defense-in-depth backstop for a dir replaced by a
    //   link between that gate and this check.
    // Drop an escaping entry from the menu (a consumer can then never select it)
    // rather than throwing: the resolver's contract is to return a menu, and such
    // an entry simply is not a valid menu item. A raw realpath errno means the
    // file exists but cannot be canonicalized — it cannot be read either, so it
    // is dropped the same way.
    try {
      assertNoSymlinkEscape(absPath, templatesDir);
      assertNoSymlinkEscape(absPath, projectDir);
    } catch (err) {
      if (err instanceof SymlinkEscapeError) {
        if (!templateMetaWarnedPaths.has(absPath)) {
          templateMetaWarnedPaths.add(absPath);
          // `reason` distinguishes the two escape conditions (resolves
          // outside / symlink cycle) — one log line per path, so the condition
          // must ride along. A missing anchor dir throws the non-containment
          // `ContentRootUnavailableError` and routes to the canonicalize-
          // failure warn below instead.
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
