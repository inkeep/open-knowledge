/**
 * Folder frontmatter reader.
 *
 * Reads a single folder's own `<folder>/.ok/frontmatter.yml` and returns its
 * metadata — open-shape, like a doc's (`title` / `description` / `tags` are
 * conventional keys, plus any other). It is SELF-ONLY: a folder describes
 * only itself. There is no
 * root → leaf cascade — values do not flow downhill into child docs or
 * descendant folders. New-doc starting properties come from templates
 * (`<folder>/.ok/templates/`), not from a read-time value overlay.
 *
 * Synchronous — read-on-demand per `enrichPath` / `enrichDirectory` call.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Folder frontmatter — open shape. Any YAML-representable key is
 * permitted. `title`, `description`, and `tags` are declared explicitly
 * because the UI calls them out, but they're conventional well-known keys,
 * not enforced ones.
 */
export type FolderFrontmatter = {
  title?: string;
  description?: string;
  tags?: string[];
} & Record<string, unknown>;

/**
 * Read a folder's own frontmatter from
 * `<folder>/.ok/frontmatter.yml`. Returns `{}` when the file is absent,
 * empty, or malformed. SELF-ONLY — no ancestor walk, no cascade.
 *
 * @param projectDir    - Absolute project root.
 * @param folderRelPath - Project-root-relative folder path. Empty string,
 *                        `.`, or `/` mean the project root's own `.ok/`.
 */
export function readFolderFrontmatter(
  projectDir: string,
  folderRelPath: string,
): FolderFrontmatter {
  const yamlPath = nestedOkPath(projectDir, folderRelPath, 'frontmatter.yml');
  if (!existsSync(yamlPath)) return {};
  const parsed = readFrontmatterYaml(yamlPath);
  return parsed != null ? coerceWellKnown(parsed) : {};
}

/**
 * Lift well-known keys (`title`, `description`, `tags`) onto the typed
 * surface so readers (search, exec, sidebar) get structurally-typed access
 * without `as` casts. Other keys remain in the `Record<string, unknown>` bag.
 */
function coerceWellKnown(raw: Record<string, unknown>): FolderFrontmatter {
  const out: FolderFrontmatter = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  // Type-narrow well-known keys.
  if (typeof raw.title === 'string') out.title = raw.title;
  else delete out.title;
  if (typeof raw.description === 'string') out.description = raw.description;
  else delete out.description;
  if (Array.isArray(raw.tags)) {
    out.tags = (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string');
  } else {
    delete out.tags;
  }
  return out;
}

/**
 * Per-process dedup of malformed-YAML warnings. Without this, a single broken
 * `<folder>/.ok/frontmatter.yml` would emit one warning per `enrichPath()` call
 * (every `cat` / `ls` / `find` enrichment) — log spam that drowns out the signal.
 */
const warnedPaths = new Set<string>();

function readFrontmatterYaml(absYamlPath: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(absYamlPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    // Malformed YAML in a folder-level config file is treated as absent on
    // the read path — read enrichment must not throw and break list/cat/grep.
    // The write path (`folder-frontmatter-write.ts`) refuses to overwrite it.
    // Surface a one-shot bracket-prefix warning so operators editing
    // `.ok/frontmatter.yml` by hand can find their typo without grepping for
    // "where did my title go".
    if (!warnedPaths.has(absYamlPath)) {
      warnedPaths.add(absYamlPath);
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- ad-hoc operator-facing diagnostic
      console.warn(
        `[ok-folder-frontmatter] malformed YAML at ${absYamlPath} — folder metadata skipped. Fix the file or delete it. Reason: ${reason}`,
      );
    }
    return null;
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // Clear any previous parse-warning state on success so a future
  // breakage emits a fresh warning rather than being silenced.
  warnedPaths.delete(absYamlPath);
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the absolute path of a member inside a folder's `.ok/` directory.
 * Shared with templates_available walk + `write`/`edit` folder write target.
 * Empty `folderRelPath` yields the project root's `.ok/`.
 */
export function nestedOkPath(projectDir: string, folderRelPath: string, member: string): string {
  const normalized = folderRelPath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '' || normalized === '.'
    ? join(projectDir, '.ok', member)
    : join(projectDir, normalized, '.ok', member);
}

/**
 * Compute the parent folder for a file's relative path. `"meetings/foo.md"`
 * → `"meetings"`; `"foo.md"` → `""` (project root). Used by the file-side
 * caller to derive the folder context.
 */
export function parentFolderOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}
