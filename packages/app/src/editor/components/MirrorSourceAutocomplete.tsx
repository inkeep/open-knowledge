import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useMirrorSourceNames } from './mirror-source-names.ts';
import { type Suggestion, type SuggestionFieldProps, SuggestionInput } from './SuggestionInput.tsx';

const MAX_SUGGESTIONS = 8;

interface MirrorSourceAutocompleteProps extends SuggestionFieldProps {
  docName: string;
}

export function MirrorSourceAutocomplete({
  docName,
  value,
  ...fieldProps
}: MirrorSourceAutocompleteProps): ReactNode {
  const { t } = useLingui();
  const sourceNames = useMirrorSourceNames(docName);
  const entries = sourceNames.kind === 'ready' ? sourceNames.entries : [];
  const query = value.trim().toLowerCase();
  const suggestions: readonly Suggestion[] = entries
    .filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) || entry.preview.toLowerCase().includes(query),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => ({
      value: entry.name,
      label: entry.name,
      detail: entry.preview === '' ? undefined : entry.preview,
    }));

  let emptyMessage: string | undefined;
  if (sourceNames.kind === 'ready' && entries.length === 0) {
    emptyMessage = t`No Mirror Source blocks in ${docName}`;
  } else if (sourceNames.kind === 'ready' && suggestions.length === 0) {
    emptyMessage = t`No Mirror Source block in ${docName} matches the text in this field. Clear it to see them all.`;
  }

  return (
    <SuggestionInput
      {...fieldProps}
      value={value}
      suggestions={suggestions}
      listLabel={t`Mirror source names`}
      emptyMessage={emptyMessage}
    />
  );
}
