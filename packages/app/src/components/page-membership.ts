import { isManagedArtifactDocName } from '@inkeep/open-knowledge-core/constants/cc1';

export function isKnownPageDocName(pages: ReadonlySet<string>, docName: string): boolean {
  return pages.has(docName) || isManagedArtifactDocName(docName);
}
