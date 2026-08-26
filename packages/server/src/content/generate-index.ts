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

import { encodeHrefPath, headingContentIdentity } from '@inkeep/open-knowledge-core';

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
 * `MD024` is the third default rule over this namespace, and it compares heading
 * content across levels, so this string is not the generator's alone: it shares a
 * namespace with the free-form `type` values that become section headings. So a
 * document whose `type` reduces to this string joins the title's own key in the
 * section collection of `buildIndexMarkdown` and lists under the title, rather
 * than opening a second heading with the same content. Absent such a document
 * the key never exists, and the title is emitted from this constant.
 *
 * Not localized, and not merely because this is file content rather than UI: the
 * bytes are the fixed point the write guard compares against, so a title that
 * varied by host locale would make every rebuild a write on a differently
 * configured machine — the same failure the locale-independent sort avoids.
 */
const INDEX_TITLE = 'Index';

/**
 * Every heading the generator writes from a fixed string of its own.
 *
 * `type` is free-form, so any of these can also arrive as one, and the two are
 * then indistinguishable by the time they reach a bucket. Naming the set once is
 * what keeps that a membership question: enumerating the constants at each site
 * is how `SUBDIRECTORY_SECTION` got a reservation while `INDEX_TITLE` did not,
 * and adding a fourth string here is the only step a later heading needs.
 *
 * Exported so the suite can assert this set is exactly what the generator emits
 * from inputs that declare no `type` at all, rather than restating the strings
 * and drifting from them.
 */
export const GENERATOR_OWNED_HEADINGS: ReadonlySet<string> = new Set([
  INDEX_TITLE,
  UNTYPED_SECTION,
  SUBDIRECTORY_SECTION,
]);

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

/**
 * Whether `candidate` is the spelling a bucket should render under, given the
 * one it currently holds. `compareSections` cannot decide this alone: it folds
 * case and normalizes BOTH sides to NFC, so two spellings of one grapheme
 * cluster compare equal and the answer would fall through to whichever arrived
 * first. Raw code points break that tie, which is what keeps the rendered
 * heading a function of the bucket's members rather than of traversal order.
 */
function prefersSpelling(candidate: string, current: string): boolean {
  return (compareSections(candidate, current) || compareCodePoints(candidate, current)) < 0;
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
 * The bullet list under one heading. Every bucket renders through here, the
 * title's included, so within-bucket order stays a pure function of the entry
 * set no matter which heading owns it.
 */
function renderBody(links: readonly RenderableLink[], directory: string): string {
  return links
    .slice()
    .sort(compareLinks)
    .map((link) => renderLink(link, directory))
    .join('\n');
}

/**
 * Group into `## <type>` sections (plus a `## Subdirectories` section when child
 * directories are supplied) under the index title, and render.
 *
 * Every section heading this emits is a key of one collection, keyed by
 * `headingContentIdentity` rather than by source text. That mirrors the rule's
 * own reduction rather than sharing it, and it is case SENSITIVE, unlike the
 * case-folding comparators further up this file, which order sections rather
 * than key them. The title joins that collection only when a document's `type`
 * reduces to its identity, which is the whole point. For every other directory
 * no such key exists and the title is emitted from the constant, so the `?? []`
 * read below is the ordinary path rather than a guard.
 *
 * A `Map` cannot hold two entries under one key, so a heading whose content
 * already belongs to the generator merges into that bucket instead of opening a
 * second heading with the same content. `type` is free-form, so any
 * of the generator's own heading strings can arrive as one, and `MD024` compares
 * heading content across levels: a heading kept outside the collection would
 * collide. The title renders at level one and every other bucket at level two,
 * which is what `MD025` and `MD041` require, so the title is selected by key
 * rather than sorted with the rest.
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

  // Each bucket carries the heading it will render under, because the key is an
  // identity several distinct source strings can share. Which spelling wins has
  // to be a pure function of the bucket's members: `entries` arrives in live
  // file-index order, which differs between a cold boot and an incremental
  // rebuild, so picking the first one seen would make the bytes depend on
  // traversal order and the write guard would never settle.
  //
  // `pinned` marks a heading the generator owns. Those keep their own spelling
  // even when a document's `type` reaches the bucket first, which is what stops
  // a colliding `<b></b>Subdirectories` from renaming the section the generator
  // writes its own child-index links under.
  interface Bucket {
    heading: string;
    pinned: boolean;
    links: RenderableLink[];
  }

  const titleKey = headingContentIdentity(INDEX_TITLE);
  const grouped = new Map<string, Bucket>();

  // Whether a heading is pinned is derived here, not supplied by the caller.
  // Every route into this function resolves a string that is either one the
  // generator owns or one a document declared, and membership is the whole
  // question — so a caller cannot state it wrongly, and a route added later
  // cannot forget to. That is what makes the promise on the set's declaration
  // true: a fourth heading needs one line there and nothing at any call site.
  //
  // Pinning matters because the spelling reduction otherwise hands the heading
  // to a colliding `<b></b>` variant, whose U+003C sorts below every letter, and
  // the generator ends up writing its own content under a heading carrying
  // inline HTML. Both live collision routes need it: `Other` beside
  // `<b></b>Other` with no untyped document, and `Subdirectories` beside
  // `<b></b>Subdirectories` with no child indexes.
  const bucketFor = (heading: string): RenderableLink[] => {
    const key = headingContentIdentity(heading);
    const pinned = GENERATOR_OWNED_HEADINGS.has(heading);
    const existing = grouped.get(key);
    if (!existing) {
      const created: Bucket = { heading, pinned, links: [] };
      grouped.set(key, created);
      return created.links;
    }
    if (pinned && !existing.pinned) {
      existing.heading = heading;
      existing.pinned = true;
    } else if (!pinned && !existing.pinned && prefersSpelling(heading, existing.heading)) {
      existing.heading = heading;
    }
    return existing.links;
  };

  for (const entry of entries) {
    bucketFor(sectionOf(entry)).push(entry);
  }

  if (subdirectories.length > 0) {
    // `Subdirectories` is also a valid document type. Sharing its bucket keeps
    // the semantic heading unique when documents and child indexes coexist.
    bucketFor(SUBDIRECTORY_SECTION).push(...subdirectories);
  }

  const blocks = [...grouped]
    .filter(([key]) => key !== titleKey)
    .sort(([, left], [, right]) => compareSections(left.heading, right.heading))
    .map(([, { heading, links }]) => `## ${heading}\n\n${renderBody(links, directory)}`);

  const header = options.isRoot ? `---\nokf_version: "${GENERATED_OKF_VERSION}"\n---\n\n` : '';

  // The title renders alone when nothing shares its bucket and above a bullet
  // list when documents do. Emitting it on both branches is what makes "exactly
  // one top-level heading" unconditional rather than a property that lapses
  // whenever the bundle happens to be empty. An empty bundle also gains no
  // section, since a heading with no links would claim a grouping that
  // describes nothing.
  // DRIFT WARNING: bullets sitting directly under the level-one title depend on
  // `okf/index-shape` opening a section on a heading at ANY level
  // (`packages/core/src/markdown/lint/rules/index-shape.ts`). Tightening that
  // rule so only `##` opens a section would make every index for a folder
  // holding a title-colliding document report a finding against a file its
  // author cannot edit. The two live in different packages and TypeScript
  // cannot see the coupling.
  const titleLinks = grouped.get(titleKey)?.links ?? [];
  const title =
    titleLinks.length === 0
      ? `# ${INDEX_TITLE}`
      : `# ${INDEX_TITLE}\n\n${renderBody(titleLinks, directory)}`;

  return `${header}${[title, ...blocks].join('\n\n')}\n`;
}
