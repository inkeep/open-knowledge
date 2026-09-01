import { encodeHrefPath, headingContentIdentity } from '@inkeep/open-knowledge-core';

export interface IndexEntry {
  path: string;
  title: string;
  description?: string | undefined;
  type?: string | undefined;
}

export interface SubdirectoryEntry {
  path: string;
  title: string;
}

export interface BuildIndexOptions {
  isRoot: boolean;
  directory?: string | undefined;
  subdirectories?: readonly SubdirectoryEntry[] | undefined;
}

const GENERATED_OKF_VERSION = '0.2';

const UNTYPED_SECTION = 'Other';

const SUBDIRECTORY_SECTION = 'Subdirectories';

const INDEX_TITLE = 'Index';

export const GENERATOR_OWNED_HEADINGS: ReadonlySet<string> = new Set([
  INDEX_TITLE,
  UNTYPED_SECTION,
  SUBDIRECTORY_SECTION,
]);

interface RenderableLink {
  path: string;
  title: string;
  description?: string | undefined;
}

function sectionOf(entry: IndexEntry): string {
  const declared = entry.type === undefined ? '' : toSingleLine(entry.type);
  return declared ? declared : UNTYPED_SECTION;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

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

function escapeLinkLabel(value: string): string {
  return toSingleLine(value).replace(/[\\[\]]/g, '\\$&');
}

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

function renderBody(links: readonly RenderableLink[], directory: string): string {
  return links
    .slice()
    .sort(compareLinks)
    .map((link) => renderLink(link, directory))
    .join('\n');
}

export function buildIndexMarkdown(
  entries: readonly IndexEntry[],
  options: BuildIndexOptions,
): string {
  const directory = options.directory ?? '';
  const subdirectories = options.subdirectories ?? [];

  interface Bucket {
    heading: string;
    pinned: boolean;
    links: RenderableLink[];
  }

  const titleKey = headingContentIdentity(INDEX_TITLE);
  const grouped = new Map<string, Bucket>();

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
    bucketFor(SUBDIRECTORY_SECTION).push(...subdirectories);
  }

  const blocks = [...grouped]
    .filter(([key]) => key !== titleKey)
    .sort(([, left], [, right]) => compareSections(left.heading, right.heading))
    .map(([, { heading, links }]) => `## ${heading}\n\n${renderBody(links, directory)}`);

  const header = options.isRoot ? `---\nokf_version: "${GENERATED_OKF_VERSION}"\n---\n\n` : '';

  const titleLinks = grouped.get(titleKey)?.links ?? [];
  const title =
    titleLinks.length === 0
      ? `# ${INDEX_TITLE}`
      : `# ${INDEX_TITLE}\n\n${renderBody(titleLinks, directory)}`;

  return `${header}${[title, ...blocks].join('\n\n')}\n`;
}
