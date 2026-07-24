export type LinkPathSuggestionKind = 'page' | 'folder' | 'asset';

export interface LinkPathSuggestion {
  kind: LinkPathSuggestionKind;
  path: string;
}

interface BuildLinkPathSuggestionsOptions {
  value: string;
  pages: ReadonlySet<string>;
  folderPaths?: ReadonlySet<string>;
  assetPaths?: ReadonlySet<string>;
  includeAssets?: boolean;
  limit?: number;
}

interface ScoredSuggestion {
  suggestion: LinkPathSuggestion;
  score: number;
}

const DEFAULT_LIMIT = 8;

function normalizeInputPath(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.mdx?$/i, '')
    .replace(/\/+$/g, '');
}

export function isSlashPathSuggestionValue(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

function firstSegmentIsDot(path: string): boolean {
  return path.split('/')[0]?.startsWith('.') ?? false;
}

function scorePath(path: string, query: string): number | null {
  if (!query) return 0;
  const lowerPath = path.toLowerCase();
  const lowerName = basename(path).toLowerCase();
  if (lowerPath === query) return 0;
  if (lowerName === query) return 1;
  if (lowerPath.startsWith(query)) return 2;
  if (lowerName.startsWith(query)) return 3;
  if (lowerName.includes(query)) return 4;
  if (lowerPath.includes(query)) return 5;
  return null;
}

function kindRank(kind: LinkPathSuggestionKind): number {
  switch (kind) {
    case 'page':
      return 0;
    case 'folder':
      return 1;
    case 'asset':
      return 2;
  }
}

function collectSuggestions(options: BuildLinkPathSuggestionsOptions): LinkPathSuggestion[] {
  const suggestions: LinkPathSuggestion[] = [];
  const seen = new Set<string>();

  function push(kind: LinkPathSuggestionKind, rawPath: string) {
    const path = normalizeInputPath(rawPath);
    if (!path) return;
    const key = `${kind}:${path.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ kind, path });
  }

  for (const page of options.pages) push('page', page);
  for (const folder of options.folderPaths ?? []) push('folder', folder);
  if (options.includeAssets) {
    for (const asset of options.assetPaths ?? []) push('asset', asset);
  }

  return suggestions;
}

export function buildLinkPathSuggestions(
  options: BuildLinkPathSuggestionsOptions,
): LinkPathSuggestion[] {
  // Any input is a query, not just a leading-slash path — typing a bare name
  // matches by basename like the command palette does. Whether to suggest at
  // all (path vs external URL vs anchor) is the caller's decision, not this
  // pure matcher's. An empty query browses (every candidate scores 0).
  const query = normalizeInputPath(options.value).toLowerCase();
  // Dot-demotion is a browse-ordering concern only. On a real query, relevance
  // (score) leads; applying it to scored ties could push an exact-matched
  // dotfile past the result cap behind equally-scored siblings.
  const browsing = query === '';

  const scored: ScoredSuggestion[] = [];
  for (const suggestion of collectSuggestions(options)) {
    const score = scorePath(suggestion.path, query);
    if (score === null) continue;
    scored.push({ suggestion, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const kindCompare = kindRank(a.suggestion.kind) - kindRank(b.suggestion.kind);
    if (kindCompare !== 0) return kindCompare;
    if (browsing) {
      // Rank real content paths ahead of dot-directory files (.github,
      // .changeset) — otherwise the browse list's alphabetical fallback fills
      // the cap with dotfiles before any content page appears.
      const dotCompare =
        (firstSegmentIsDot(a.suggestion.path) ? 1 : 0) -
        (firstSegmentIsDot(b.suggestion.path) ? 1 : 0);
      if (dotCompare !== 0) return dotCompare;
    }
    return a.suggestion.path.localeCompare(b.suggestion.path);
  });

  return scored.slice(0, options.limit ?? DEFAULT_LIMIT).map((entry) => entry.suggestion);
}
