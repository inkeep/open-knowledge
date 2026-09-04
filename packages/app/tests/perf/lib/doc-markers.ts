export const DOC_MARKERS: Record<string, string> = {
  README: 'Local-first knowledge base',
  PROJECT: 'Build an agent-native knowledge platform',
  CLAUDE: 'Bun monorepo',
  AGENTS: 'Bun monorepo',
  STORIES: 'Now phase workstreams',
};

export function markerFor(docName: string): string | null {
  return DOC_MARKERS[docName] ?? null;
}
