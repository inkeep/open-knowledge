/**
 * Client-side mirror of the server's `cc1-broadcast.ts:isSystemDoc` check.
 * The `__system__` pseudo-doc carries CC1 push signals (derived-view
 * invalidation) on a dedicated Y.Doc — it is not user-editable content and
 * must never be admitted to the editor ProviderPool.
 *
 */

import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';

export function isSystemDoc(docName: string): boolean {
  return docName === SYSTEM_DOC_NAME;
}
