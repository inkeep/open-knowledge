import { BIG_DOC, MEDIUM_DOC } from '../fixtures/synthetic-doc.ts';

export const DOC_MARKERS: Record<string, string> = {
  README: 'Local-first knowledge base',
  CLAUDE: 'Bun monorepo',
  AGENTS: 'Bun monorepo',
  [BIG_DOC.docName]: BIG_DOC.title,
  [MEDIUM_DOC.docName]: MEDIUM_DOC.title,
};

export function markerFor(docName: string): string | null {
  return DOC_MARKERS[docName] ?? null;
}
