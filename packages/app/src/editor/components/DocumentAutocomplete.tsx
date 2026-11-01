import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { filterPages, type PageItem } from '../extensions/wiki-link-suggestion.ts';
import { type Suggestion, type SuggestionFieldProps, SuggestionInput } from './SuggestionInput.tsx';

export function DocumentAutocomplete({ value, ...fieldProps }: SuggestionFieldProps): ReactNode {
  const { t } = useLingui();
  const pageList = useOptionalPageList();
  const pages: PageItem[] = [...(pageList?.pages ?? [])].map((docName) => ({
    kind: 'page',
    docName,
    title: pageList?.pageTitles.get(docName) ?? docName.split('/').pop() ?? docName,
  }));
  const suggestions: readonly Suggestion[] = filterPages(pages, value.trim()).map((page) => ({
    value: page.docName,
    label: page.title,
    detail: page.title !== page.docName ? page.docName : undefined,
  }));

  return (
    <SuggestionInput
      {...fieldProps}
      value={value}
      suggestions={suggestions}
      listLabel={t`Document suggestions`}
    />
  );
}
