/**
 * Client-side mirror of the server's `cc1-broadcast.ts:isSystemDoc` /
 * `isConfigDoc` checks. The `__system__` pseudo-doc carries CC1 push signals
 * (derived-view invalidation) on a dedicated Y.Doc; config docs
 * (`__config__/project`, `__local__/project`, `__user__/config.yml`,
 * `__config__/okignore`) are Y.Text-only settings planes. Neither is
 * user-editable content, and neither may be admitted to a documentName-keyed
 * pool (STOP rule: every documentName-keyed entry point short-circuits on
 * `isSystemDoc(name) || isConfigDoc(name)`).
 */

import { CONFIG_DOC_NAMES, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';

export function isSystemDoc(docName: string): boolean {
  return docName === SYSTEM_DOC_NAME;
}

const CONFIG_DOC_NAME_SET: ReadonlySet<string> = new Set(CONFIG_DOC_NAMES);

export function isConfigDoc(docName: string): boolean {
  return CONFIG_DOC_NAME_SET.has(docName);
}
