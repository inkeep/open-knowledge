
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';

export function isSystemDoc(docName: string): boolean {
  return docName === SYSTEM_DOC_NAME;
}
