/**
 * `findHubCandidates` — soft-nudge helper that suggests parent hub docs for
 * an orphaned knowledge-base doc. Used by `/api/agent-write-md` to attach a
 * `hints: [{type: 'orphan', ...}]` entry to the response when a new doc has
 * zero backlinks and a hub candidate exists in its folder tree.
 *
 * Algorithm:
 *   - Walk from `dirname(targetPath)` up to the content root.
 *   - At each level, look for: INDEX.md, README.md, REPORT.md, SPEC.md, OR a
 *     file whose basename matches the folder name (e.g. `reports/r1/r1.md`).
 *   - Return up to 3 nearest-first docNames that exist in the file index
 *     (which is already scoped by ContentFilter).
 */

/**
 * Hub basenames recognized at each folder level, case-insensitive.
 * Priority within a folder: INDEX > README > REPORT > SPEC > folder-name-match.
 */
const FIXED_HUB_BASENAMES: readonly string[] = ['INDEX', 'README', 'REPORT', 'SPEC'];

const MAX_CANDIDATES = 3;

/** Result of a candidate lookup — docNames (path without `.md`), nearest-first, up to 3. */
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

  // Pre-build a lowercase docName -> actual docName map once, since the walk
  // may probe multiple folder levels. Scoped to matters of case mismatch on
  // hub names (`README.md` vs `readme.md`); exact matches remain O(1).
  const lowerIndex = buildLowerDocNameIndex(fileIndex);

  let folder = parentFolder(targetDocName);
  while (true) {
    // Fixed hub basenames (INDEX, README, REPORT, SPEC) — case-insensitive.
    for (const base of FIXED_HUB_BASENAMES) {
      push(lookup(fileIndex, lowerIndex, joinDocName(folder, base)));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
    // Folder-name-match: `reports/r1` tries `reports/r1/r1`. Empty folder
    // (content root) has no basename, so skip.
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

/** Exact match first; else case-insensitive match; else null. */
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
    // First-wins — exact-case matches dominate, but the lowercase fallback
    // still resolves when the target casing doesn't exist.
    if (!lower.has(key)) lower.set(key, docName);
  }
  return lower;
}

/** Returns the parent folder of a docName. `'reports/r1/foo'` -> `'reports/r1'`. `'foo'` -> `''`. */
function parentFolder(docName: string): string {
  const idx = docName.lastIndexOf('/');
  return idx < 0 ? '' : docName.slice(0, idx);
}

/** Basename of a folder path. `'reports/r1'` -> `'r1'`. */
function basename(folderPath: string): string {
  const idx = folderPath.lastIndexOf('/');
  return idx < 0 ? folderPath : folderPath.slice(idx + 1);
}

/** Joins a folder and a basename into a docName. Empty folder yields bare basename. */
function joinDocName(folder: string, base: string): string {
  return folder === '' ? base : `${folder}/${base}`;
}
