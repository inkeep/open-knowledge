import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
} from '@inkeep/open-knowledge-core/search/workspace-search';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { filterAssetsByAccept } from '../utils/filter-assets-by-accept';
import { type Suggestion, type SuggestionFieldProps, SuggestionInput } from './SuggestionInput.tsx';

const MAX_ITEMS = 8;

const EMPTY_ASSET_SET: ReadonlySet<string> = new Set();

interface SrcAutocompleteProps extends SuggestionFieldProps {
  accept: readonly string[];
}

interface AssetItem {
  path: string;
  basename: string;
}

interface AutocompleteCorpus {
  fingerprint: string;
  byPath: ReadonlyMap<string, AssetItem>;
  corpus: WorkspaceSearchCorpus;
  itemsInOrder: readonly AssetItem[];
}

let cachedCorpus: AutocompleteCorpus | null = null;

function makeAssetItem(path: string): AssetItem {
  const basename = path.split('/').pop() ?? path;
  return { path, basename };
}

function getCachedCorpus(items: readonly AssetItem[]): AutocompleteCorpus {
  const fingerprint = items.map((item) => item.path).join('');
  if (cachedCorpus?.fingerprint === fingerprint) return cachedCorpus;
  cachedCorpus = {
    fingerprint,
    byPath: new Map(items.map((item) => [item.path, item])),
    itemsInOrder: items,
    corpus: createWorkspaceSearchCorpus(
      items.map((item) =>
        createWorkspaceSearchDocument({
          kind: 'page',
          path: item.path,
          title: item.basename,
        }),
      ),
    ),
  };
  return cachedCorpus;
}

function normalizeQueryForSearch(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  return trimmed;
}

function selectSuggestions(corpus: AutocompleteCorpus, rawQuery: string): readonly AssetItem[] {
  const query = normalizeQueryForSearch(rawQuery);
  if (!query) return corpus.itemsInOrder.slice(0, MAX_ITEMS);
  return searchWorkspaceCorpus(corpus.corpus, query, {
    intent: 'autocomplete',
    limit: MAX_ITEMS,
  })
    .map((result) => corpus.byPath.get(result.document.path))
    .filter((item): item is AssetItem => Boolean(item));
}

export function SrcAutocomplete({ value, accept, ...inputProps }: SrcAutocompleteProps): ReactNode {
  const { t } = useLingui();
  const pageList = useOptionalPageList();
  const assetPaths: ReadonlySet<string> = pageList?.assetPaths ?? EMPTY_ASSET_SET;

  const matchingPaths = filterAssetsByAccept(assetPaths, accept);
  const assetItems: readonly AssetItem[] = matchingPaths.map(makeAssetItem);
  const corpus = getCachedCorpus(assetItems);
  const suggestions: readonly Suggestion[] = selectSuggestions(corpus, value).map((item) => ({
    value: `/${item.path}`,
    label: item.basename,
    detail: item.basename !== item.path ? item.path : undefined,
  }));

  return (
    <SuggestionInput
      {...inputProps}
      value={value}
      suggestions={suggestions}
      listLabel={t`Asset suggestions`}
    />
  );
}
