/**
 * Builds the body of a generated OKF `index.md`.
 *
 * The rule, stated once so widening the scope later does not restate it:
 *
 *   An index lists every document at or below its folder that is not already
 *   covered by a nested index, grouped by `type`. It links to a subdirectory
 *   only when that subdirectory has its own index.
 *
 * Each index lists the documents directly in its own directory and links to the
 * immediate child directories that carry their own index. Paths arrive
 * content-root-relative and render relative to the index's directory, so an
 * index in `concepts/` links `./bounded-context.md`, not `./concepts/...`.
 *
 * Grouping by `type` follows the group indexes in the bundles vendored under
 * `../markdown/lint/rules/okf-reference/`, which head each section with the
 * `type` its directory holds. Their ROOT indexes do something different — a
 * single `Subdirectories` section linking to child indexes — which is what a
 * container directory here renders alongside its type sections.
 *
 * Formatting is pure and lives here alone; the write path is
 * `regenerate-index.ts`. Splitting them keeps every shape decision testable
 * without a server, a disk, or a Y.Doc.
 */

import { encodeHrefPath } from '@inkeep/open-knowledge-core';

/** One document as the index renders it. `path` is content-root-relative. */
export interface IndexEntry {
  path: string;
  title: string;
  description?: string | undefined;
  type?: string | undefined;
}

/**
 * One immediate child directory, linking to its own generated index. `path` is
 * the content-root-relative path of that child's index document, so it rebases
 * exactly like a document entry; a bare folder path would read as broken (see
 * `toHref`).
 */
export interface SubdirectoryEntry {
  path: string;
  /** Link label — the child directory's name. */
  title: string;
}

export interface BuildIndexOptions {
  /**
   * Root indexes are the only ones the format permits frontmatter on, and the
   * only place `okf_version` may appear. A non-root index carrying any key at
   * all is a violation (`frontmatter-reserved-index` pins `maxProperties: 0`).
   */
  isRoot: boolean;
  /**
   * Content-root-relative directory this index lives in; '' (the default) is the
   * root. Entry and subdirectory paths render relative to it. Kept distinct from
   * `isRoot` because that flag governs frontmatter while this governs rebasing.
   */
  directory?: string | undefined;
  /**
   * Immediate child directories that have an index of their own. Rendered as a
   * single `## Subdirectories` section; a directory with none omits the section.
   */
  subdirectories?: readonly SubdirectoryEntry[] | undefined;
}

/**
 * The version this generator writes. A quoted `major.minor` string, which is
 * what `frontmatter-root-index` pins via `^[0-9]+\.[0-9]+$` — unquoted, YAML
 * reads `0.2` as a float and a trailing zero would not survive a round trip.
 */
const GENERATED_OKF_VERSION = '0.2';

/** Section for documents whose frontmatter declares no `type`. */
const UNTYPED_SECTION = 'Other';

/**
 * Heading for the section that links to child directories. Named for the
 * relationship rather than a `type`, matching the reference agent's root index.
 */
const SUBDIRECTORY_SECTION = 'Subdirectories';

/**
 * The index's one top-level heading; `type` sections sit under it at level two.
 *
 * Sections cannot themselves be level one. Several of them in one file is
 * `MD025`, and markdownlint's default profile — which OK matches 1:1 and layers
 * nothing onto — has that rule on. Demoting sections without adding a title
 * instead trips `MD041`, which wants the first line to be a top-level heading.
 * One title plus level-two sections satisfies both, and is the shape the
 * hand-written index this generator replaced already used.
 *
 * Not localized, and not merely because this is file content rather than UI: the
 * bytes are the fixed point the write guard compares against, so a title that
 * varied by host locale would make every rebuild a write on a differently
 * configured machine — the same failure the locale-independent sort avoids.
 */
const INDEX_TITLE = 'Index';

/** The shared shape a link line renders from — a document or a subdirectory. */
interface RenderableLink {
  path: string;
  title: string;
  description?: string | undefined;
}

/** `type` as written, trimmed; `Other` when absent or blank. */
function sectionOf(entry: IndexEntry): string {
  const declared = entry.type === undefined ? '' : toSingleLine(entry.type);
  return declared ? declared : UNTYPED_SECTION;
}

/**
 * Descriptions are single-line by construction — a bullet is one line, and a
 * newline mid-entry would end the list item and strand the rest as a paragraph
 * that no longer belongs to any entry.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Fixed code-point order — independent of the host's locale and ICU data. */
function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedSortKey(value: string): string {
  return toSingleLine(value).normalize('NFC').toLowerCase();
}

function compareSections(left: string, right: string): number {
  return (
    compareCodePoints(normalizedSortKey(left), normalizedSortKey(right)) ||
    compareCodePoints(left.normalize('NFC'), right.normalize('NFC'))
  );
}

function compareLinks(left: RenderableLink, right: RenderableLink): number {
  return (
    compareCodePoints(normalizedSortKey(left.title), normalizedSortKey(right.title)) ||
    compareCodePoints(
      left.path.replaceAll('\\', '/').normalize('NFC'),
      right.path.replaceAll('\\', '/').normalize('NFC'),
    )
  );
}

/** Escape the characters that can terminate or alter a Markdown link label. */
function escapeLinkLabel(value: string): string {
  return toSingleLine(value).replace(/[\\[\]]/g, '\\$&');
}

/**
 * Strip the index's own directory prefix so a content-root-relative path renders
 * relative to where the index lives. Entries are always at or below `directory`
 * by construction, so a path that does not start with it is passed through.
 */
function relativeTo(directory: string, path: string): string {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedDir = directory.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedDir === '') return normalizedPath;
  const prefix = `${normalizedDir}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

/**
 * Link form: relative, `./`-prefixed, extension retained. Precedent #56 names
 * relative the recommended default, and the extension keeps the link working in
 * GitHub, Obsidian, and an editor that never loaded OK.
 *
 * Deliberately never a bare folder (`./concepts/`): `ClassifiedLinkTarget` has
 * no folder variant, so a trailing slash resolves to a *document* of that name
 * and a folder link reads as broken to our own link validator. A subdirectory
 * link therefore targets the child index document, not the folder.
 */
function toHref(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  return `./${encodeHrefPath(normalized)}`;
}

function renderLink(link: RenderableLink, directory: string): string {
  const anchor = `* [${escapeLinkLabel(link.title)}](${toHref(relativeTo(directory, link.path))})`;
  const description = link.description === undefined ? '' : toSingleLine(link.description);
  return description ? `${anchor} - ${description}` : anchor;
}

/**
 * Group into `## <type>` sections (plus a `## Subdirectories` section when child
 * directories are supplied) under the index title, and render.
 *
 * Sections sort alphabetically by heading and entries sort by title
 * case-insensitively, both matching the reference generator. Ordering is what
 * makes the output a fixed point: two runs over the same content must produce
 * identical bytes, or the write guard never settles and every rebuild churns the
 * file.
 */
export function buildIndexMarkdown(
  entries: readonly IndexEntry[],
  options: BuildIndexOptions,
): string {
  const directory = options.directory ?? '';
  const subdirectories = options.subdirectories ?? [];

  const grouped = new Map<string, RenderableLink[]>();
  for (const entry of entries) {
    const section = sectionOf(entry);
    const bucket = grouped.get(section);
    if (bucket) bucket.push(entry);
    else grouped.set(section, [entry]);
  }

  if (subdirectories.length > 0) {
    // `Subdirectories` is also a valid document type. Sharing its bucket keeps
    // the semantic heading unique when documents and child indexes coexist.
    const bucket = grouped.get(SUBDIRECTORY_SECTION);
    if (bucket) bucket.push(...subdirectories);
    else grouped.set(SUBDIRECTORY_SECTION, [...subdirectories]);
  }

  const blocks = [...grouped]
    .sort(([left], [right]) => compareSections(left, right))
    .map(([heading, links]) => {
      const body = links
        .slice()
        .sort(compareLinks)
        .map((link) => renderLink(link, directory))
        .join('\n');
      return `## ${heading}\n\n${body}`;
    });

  const header = options.isRoot ? `---\nokf_version: "${GENERATED_OKF_VERSION}"\n---\n\n` : '';

  // An empty bundle keeps the title and gains no section: an empty `## Other`
  // would claim a grouping that describes nothing, while the title alone reads
  // as a bundle with no documents yet. Holding the title in both cases is what
  // makes "exactly one top-level heading" unconditional rather than a property
  // that lapses whenever the bundle happens to be empty.
  return `${header}${[`# ${INDEX_TITLE}`, ...blocks].join('\n\n')}\n`;
}
