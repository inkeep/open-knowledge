import { resolveStoredPath } from '@inkeep/open-knowledge-core';

export function folderNamesContain(names: Iterable<string>, folderPath: string): boolean {
  const set = names instanceof Set ? names : new Set(names);
  return resolveStoredPath(set, folderPath) !== null;
}
