import { SUPPORTED_DOC_EXTENSIONS } from './doc-extensions.ts';

export function docStem(docName: string): string {
  const base = docName.slice(docName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  const ext = base.slice(dot).toLowerCase();
  return (SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext) ? base.slice(0, dot) : base;
}

export const RESERVED_LOG_STEM = 'log';

export function isReservedLogDoc(docName: string): boolean {
  return docStem(docName) === RESERVED_LOG_STEM;
}
