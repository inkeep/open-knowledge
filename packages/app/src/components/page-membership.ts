import { isManagedArtifactDocName } from '@inkeep/open-knowledge-core';

export function isKnownPageDocName(pages: ReadonlySet<string>, docName: string): boolean {
  return pages.has(docName) || isManagedArtifactDocName(docName);
}
