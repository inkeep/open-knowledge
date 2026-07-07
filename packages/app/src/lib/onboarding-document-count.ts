/**
 * Shared content-entry count for the onboarding card. Both the visibility
 * predicate (is the project fresh — count 0?) and the file-completion signal
 * (did the first file land — count >= 1?) key off the same `/api/documents`
 * read, so the fetch + counting rule lives in one place.
 */

import { type DocumentListSuccess, DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { filterVisibleEntries } from '@/components/file-tree-utils';

/**
 * Count user-visible content entries (documents + folders). Most starter packs
 * scaffold only folders, so counting documents alone would read a freshly
 * seeded project as still empty. `filterVisibleEntries` is the shared
 * hidden-file filter, so dotfiles and agent configs do not inflate the count.
 */
export function countVisibleEntries(documents: DocumentListSuccess['documents']): number {
  return filterVisibleEntries(documents).filter(
    (entry) => entry.kind === 'document' || entry.kind === 'folder',
  ).length;
}

/**
 * Fetch the project's content-entry count. Throws on a failed request or a
 * response that does not match the schema; callers route those throws into a
 * fail-safe (suppress the card / leave the step incomplete) rather than guessing.
 */
export async function fetchDocumentEntryCount(): Promise<number> {
  const response = await fetch('/api/documents');
  if (!response.ok) throw new Error(`documents request failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  const parsed = DocumentListSuccessSchema.safeParse(body);
  if (!parsed.success)
    throw new Error('documents response did not match schema', { cause: parsed.error });
  return countVisibleEntries(parsed.data.documents);
}
