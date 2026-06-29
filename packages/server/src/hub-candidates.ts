
const FIXED_HUB_BASENAMES: readonly string[] = ['INDEX', 'README', 'REPORT', 'SPEC'];

const MAX_CANDIDATES = 3;

export function findHubCandidates(
  targetDocName: string,
  fileIndex: ReadonlyMap<string, unknown>,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (docName: string | null): void => {
    if (!docName || seen.has(docName)) return;
    if (docName === targetDocName) return;
    seen.add(docName);
    candidates.push(docName);
  };

  const lowerIndex = buildLowerDocNameIndex(fileIndex);

  let folder = parentFolder(targetDocName);
  while (true) {
    for (const base of FIXED_HUB_BASENAMES) {
      push(lookup(fileIndex, lowerIndex, joinDocName(folder, base)));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
    const folderBase = folder === '' ? null : basename(folder);
    if (folderBase) {
      push(lookup(fileIndex, lowerIndex, joinDocName(folder, folderBase)));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
    if (folder === '') break;
    folder = parentFolder(folder);
  }

  return candidates;
}

function lookup(
  fileIndex: ReadonlyMap<string, unknown>,
  lowerIndex: ReadonlyMap<string, string>,
  candidate: string,
): string | null {
  if (fileIndex.has(candidate)) return candidate;
  return lowerIndex.get(candidate.toLowerCase()) ?? null;
}

function buildLowerDocNameIndex(fileIndex: ReadonlyMap<string, unknown>): Map<string, string> {
  const lower = new Map<string, string>();
  for (const docName of fileIndex.keys()) {
    const key = docName.toLowerCase();
    if (!lower.has(key)) lower.set(key, docName);
  }
  return lower;
}

function parentFolder(docName: string): string {
  const idx = docName.lastIndexOf('/');
  return idx < 0 ? '' : docName.slice(0, idx);
}

function basename(folderPath: string): string {
  const idx = folderPath.lastIndexOf('/');
  return idx < 0 ? folderPath : folderPath.slice(idx + 1);
}

function joinDocName(folder: string, base: string): string {
  return folder === '' ? base : `${folder}/${base}`;
}
