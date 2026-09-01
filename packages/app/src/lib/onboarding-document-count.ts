import { type DocumentListSuccess, DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { filterVisibleEntries } from '@/components/file-tree-utils';

export function countVisibleEntries(documents: DocumentListSuccess['documents']): number {
  return filterVisibleEntries(documents).filter(
    (entry) => entry.kind === 'document' || entry.kind === 'folder',
  ).length;
}

export async function fetchDocumentEntryCount(): Promise<number> {
  const response = await fetch('/api/documents');
  if (!response.ok) throw new Error(`documents request failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  const parsed = DocumentListSuccessSchema.safeParse(body);
  if (!parsed.success)
    throw new Error('documents response did not match schema', { cause: parsed.error });
  return countVisibleEntries(parsed.data.documents);
}
