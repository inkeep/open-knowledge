import { encodeHrefPath, isMutatingParserReservation } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

export interface IndexEntry {
  path: string;
  title: string;
  description?: string | undefined;
  type?: string | undefined;
}

export interface SubdirectoryEntry {
  directory: string;
  title: string;
}

export interface BuildIndexOptions {
  isRoot: boolean;
  directory?: string | undefined;
  subdirectories?: readonly SubdirectoryEntry[] | undefined;
  warningScope: GeneratedIndexWarningScope | false;
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
  title: LiteralMarkdownText;
  description?: LiteralMarkdownText | undefined;
}

interface LiteralMarkdownText {
  visible: string;
  identity: string;
  source: string;
}

interface LiteralMetadataSource {
  path: string;
  field: 'title' | 'description' | 'type' | 'folder-label';
}

type LiteralMarkdownTextOrigin =
  | {
      kind: 'attributed';
      source: LiteralMetadataSource;
      warningScope: GeneratedIndexWarningScope | false;
    }
  | { kind: 'generator-owned' };

const SUBSTITUTION_WARNING_MESSAGES = {
  control: 'generated index metadata contained a Cc control; replaced it with U+FFFD',
  'parser-reservation':
    'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
} as const;

type SubstitutionWarningKind = keyof typeof SUBSTITUTION_WARNING_MESSAGES;

function metadataSourceKey(source: LiteralMetadataSource): string {
  return `${source.path}\0${source.field}`;
}

export class GeneratedIndexWarningScope {
  readonly contentDir: string;
  readonly #warnedEpisodes = new Map<string, string>();

  constructor(contentDir: string) {
    this.contentDir = contentDir;
  }

  update(kind: SubstitutionWarningKind, source: LiteralMetadataSource, substituted: boolean): void {
    const sourceKey = metadataSourceKey(source);
    const episodeKey = `${kind}\0${sourceKey}`;
    if (!substituted) {
      this.#warnedEpisodes.delete(episodeKey);
      return;
    }
    if (this.#warnedEpisodes.has(episodeKey)) return;
    this.#warnedEpisodes.set(episodeKey, sourceKey);
    getLogger('generated-index').warn(
      { contentDir: this.contentDir, ...source, kind },
      SUBSTITUTION_WARNING_MESSAGES[kind],
    );
  }

  retain(activeSources: ReadonlySet<string>): void {
    for (const [episodeKey, sourceKey] of this.#warnedEpisodes) {
      if (!activeSources.has(sourceKey)) this.#warnedEpisodes.delete(episodeKey);
    }
  }
}

export function createGeneratedIndexWarningScope(contentDir: string): GeneratedIndexWarningScope {
  return new GeneratedIndexWarningScope(contentDir);
}

export function retainGeneratedIndexSubstitutionWarningSources(
  warningScope: GeneratedIndexWarningScope | false,
  entries: readonly IndexEntry[],
  subdirectories: readonly SubdirectoryEntry[],
): void {
  if (!warningScope) return;
  const activeSources = new Set<string>();
  for (const entry of entries) {
    activeSources.add(metadataSourceKey({ path: entry.path, field: 'title' }));
    activeSources.add(metadataSourceKey({ path: entry.path, field: 'type' }));
    if (entry.description !== undefined) {
      activeSources.add(metadataSourceKey({ path: entry.path, field: 'description' }));
    }
  }
  for (const subdirectory of subdirectories) {
    activeSources.add(metadataSourceKey({ path: subdirectory.directory, field: 'folder-label' }));
  }
  warningScope.retain(activeSources);
}

function literalMarkdownText(
  value: string,
  origin: LiteralMarkdownTextOrigin,
): LiteralMarkdownText {
  let controlSubstituted = false;
  let parserReservationSubstituted = false;
  const visible = Array.from(toSingleLine(value), (character) => {
    if (/\p{Cc}/u.test(character)) {
      controlSubstituted = true;
      return '\uFFFD';
    }
    if (isMutatingParserReservation(character)) {
      parserReservationSubstituted = true;
      return '\uFFFD';
    }
    return character;
  }).join('');
  if (origin.kind === 'attributed' && origin.warningScope) {
    origin.warningScope.update('control', origin.source, controlSubstituted);
    origin.warningScope.update('parser-reservation', origin.source, parserReservationSubstituted);
  }
  return {
    visible,
    identity: visible.normalize('NFC'),
    source: visible.replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, '\\$&'),
  };
}

function sectionOf(
  entry: IndexEntry,
  warningScope: GeneratedIndexWarningScope | false,
): LiteralMarkdownText {
  const declared = literalMarkdownText(entry.type ?? '', {
    kind: 'attributed',
    source: { path: entry.path, field: 'type' },
    warningScope,
  });
  return declared.visible
    ? declared
    : literalMarkdownText(UNTYPED_SECTION, { kind: 'generator-owned' });
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
    compareCodePoints(
      normalizedSortKey(left.title.visible),
      normalizedSortKey(right.title.visible),
    ) ||
    compareCodePoints(
      left.path.replaceAll('\\', '/').normalize('NFC'),
      right.path.replaceAll('\\', '/').normalize('NFC'),
    )
  );
}

function renderableLink(
  entry: IndexEntry | SubdirectoryEntry,
  warningScope: GeneratedIndexWarningScope | false,
): RenderableLink {
  const titleSource: LiteralMetadataSource =
    'directory' in entry
      ? { path: entry.directory, field: 'folder-label' }
      : { path: entry.path, field: 'title' };
  return {
    path: 'directory' in entry ? `${entry.directory}/index.md` : entry.path,
    title: literalMarkdownText(entry.title, {
      kind: 'attributed',
      source: titleSource,
      warningScope,
    }),
    description:
      'description' in entry && entry.description !== undefined
        ? literalMarkdownText(entry.description, {
            kind: 'attributed',
            source: { path: entry.path, field: 'description' },
            warningScope,
          })
        : undefined,
  };
}

function relativeTo(directory: string, path: string): string {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedDir = directory.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedDir === '') return normalizedPath;
  const prefix = `${normalizedDir}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

/**
 * Precedent #56 names relative the recommended default, and the extension keeps the link working in
 * GitHub, Obsidian, and an editor that never loaded OK.
 */
function toHref(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  return `./${encodeHrefPath(normalized)}`;
}

function renderLink(link: RenderableLink, directory: string): string {
  const anchor = `* [${link.title.source}](${toHref(relativeTo(directory, link.path))})`;
  return link.description?.source ? `${anchor} - ${link.description.source}` : anchor;
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
  const warningScope = options.warningScope;

  interface Bucket {
    heading: LiteralMarkdownText;
    pinned: boolean;
    links: RenderableLink[];
  }

  const titleKey = literalMarkdownText(INDEX_TITLE, { kind: 'generator-owned' }).identity;
  const grouped = new Map<string, Bucket>();

  const bucketFor = (heading: LiteralMarkdownText): RenderableLink[] => {
    const key = heading.identity;
    const pinned = GENERATOR_OWNED_HEADINGS.has(heading.visible);
    const existing = grouped.get(key);
    if (!existing) {
      const created: Bucket = { heading, pinned, links: [] };
      grouped.set(key, created);
      return created.links;
    }
    if (pinned && !existing.pinned) {
      existing.heading = heading;
      existing.pinned = true;
    } else if (
      !pinned &&
      !existing.pinned &&
      prefersSpelling(heading.visible, existing.heading.visible)
    ) {
      existing.heading = heading;
    }
    return existing.links;
  };

  for (const entry of entries) {
    bucketFor(sectionOf(entry, warningScope)).push(renderableLink(entry, warningScope));
  }

  if (subdirectories.length > 0) {
    bucketFor(literalMarkdownText(SUBDIRECTORY_SECTION, { kind: 'generator-owned' })).push(
      ...subdirectories.map((entry) => renderableLink(entry, warningScope)),
    );
  }

  const blocks = [...grouped]
    .filter(([key]) => key !== titleKey)
    .sort(([, left], [, right]) => compareSections(left.heading.visible, right.heading.visible))
    .map(([, { heading, links }]) => `## ${heading.source}\n\n${renderBody(links, directory)}`);

  const header = options.isRoot ? `---\nokf_version: "${GENERATED_OKF_VERSION}"\n---\n\n` : '';

  const titleLinks = grouped.get(titleKey)?.links ?? [];
  const title =
    titleLinks.length === 0
      ? `# ${INDEX_TITLE}`
      : `# ${INDEX_TITLE}\n\n${renderBody(titleLinks, directory)}`;

  return `${header}${[title, ...blocks].join('\n\n')}\n`;
}
