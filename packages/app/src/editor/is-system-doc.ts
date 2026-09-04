import { CONFIG_DOC_NAMES, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';

export function isSystemDoc(docName: string): boolean {
  return docName === SYSTEM_DOC_NAME;
}

const CONFIG_DOC_NAME_SET: ReadonlySet<string> = new Set(CONFIG_DOC_NAMES);

export function isConfigDoc(docName: string): boolean {
  return CONFIG_DOC_NAME_SET.has(docName);
}
