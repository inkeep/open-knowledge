/**
 * Decides whether the generated root `index.md` needs rewriting, and what its
 * bytes should be.
 *
 * Deliberately decides but does not write. The write is two different
 * operations depending on whether the document is open in an editor (a CRDT
 * paired write) or not (a disk write plus its index/durability ceremony), and
 * both live where their helpers do. Keeping the decision separate means the
 * part with all the rules is testable with a plain object instead of a booted
 * server.
 *
 * The returned `changed: false` is load-bearing, not an optimization. Writing
 * the index calls the same file-index and broadcast paths that trigger
 * regeneration, so a generator that always writes re-triggers itself. Comparing
 * bytes first turns that into a fixed point: an unchanged index performs no
 * write, mutates no index, and signals nothing.
 */

import { extractPageDescription, extractPageTitle, extractPageType } from '../page-identity.ts';
import { buildIndexMarkdown, type IndexEntry, type SubdirectoryEntry } from './generate-index.ts';

/** The bundle-root index, as a docName (extension-less, like every docName). */
export const ROOT_INDEX_DOC_NAME = 'index';

/**
 * Reserved stems are navigation and history for the bundle, not entries in it.
 * Excluding `index` also breaks the most direct self-trigger: an index that
 * listed itself would change its own inputs by existing.
 */
const RESERVED_STEMS: ReadonlySet<string> = new Set(['index', 'log']);

/**
 * The metadata the index needs from a document.
 *
 * Two callers supply it from different places, which is why this is an
 * interface rather than a read of the file index: the runtime generator passes
 * the watcher's cached entries, and `seed/apply.ts` passes the entries a pack
 * is about to scaffold, before any server exists. Keeping the source abstract
 * is what lets one builder serve both.
 */
export interface IndexSourceDoc {
  title?: string | undefined;
  description?: string | undefined;
  type?: string | undefined;
}

/** Cached fields captured before a watcher update mutates the file index. */
export interface PreviousIndexedFields {
  title?: string | undefined;
  description?: string | undefined;
  type?: string | undefined;
}

export interface DirectoryIndexDeps {
  /** Every markdown doc the content filter admits, keyed by docName. */
  docs: Iterable<readonly [string, IndexSourceDoc]>;
  /** `.md` or `.mdx` for a docName — links carry the real extension. */
  docExtension: (docName: string) => string;
  /**
   * Current bytes of the index in `directory` ('' for root, otherwise
   * content-root-relative), or `null` when it does not exist yet. Reading disk
   * or a resident document is the caller's job; the decision layer stays
   * server-free, so each directory's bytes arrive through this accessor rather
   * than one shared string.
   */
  currentMarkdownFor: (directory: string) => string | null;
}

export interface DirectoryIndexDecision {
  /** Content-root-relative directory this index lives in; '' for the root. */
  directory: string;
  /** False when the existing bytes already match — do nothing at all. */
  changed: boolean;
  /** The bytes the index should hold, whether or not they differ. */
  markdown: string;
}

/**
 * Infrastructure lives in dot-directories — `.ok/templates`, an installed pack
 * skill under `.claude/skills`. Those are markdown, and a consumer walking the
 * tree does see them, but they are not the bundle's knowledge and listing them
 * in a navigation index buries the content that is.
 */
function isInfrastructurePath(docName: string): boolean {
  return docName.split('/').some((segment) => segment.startsWith('.'));
}

function basenameOf(docName: string): string {
  return docName.split('/').pop() ?? docName;
}

/**
 * The immediate parent of a slash-separated path — a docName or a directory;
 * '' for anything at the root. Exported because the scheduler resolves a
 * document event to the directory whose index owns it.
 */
export function directoryOf(docName: string): string {
  const slash = docName.lastIndexOf('/');
  return slash === -1 ? '' : docName.slice(0, slash);
}

/**
 * A directory and every ancestor above it, ending at the root ''.
 *
 * The parent chain an event must invalidate when a directory's set of children
 * changes: each ancestor index carries links downward, so a created or deleted
 * subdirectory can move any index between the change and the root. An ancestor
 * with no index of its own produces no decision and is absorbed by the byte
 * comparison, so passing the whole chain is safe rather than exact.
 */
export function directoryChainToRoot(directory: string): string[] {
  const chain: string[] = [];
  let current = directory;
  while (current !== '') {
    chain.push(current);
    current = directoryOf(current);
  }
  chain.push('');
  return chain;
}

/**
 * Whether a docName names a generated index — the reserved `index` basename at
 * any depth (`index` at the root, `<dir>/index` below it).
 *
 * The self-trigger guard turns on this. A generated index is itself a file, and
 * writing a resident one reaches disk through the persistence flush, whose
 * completion hook re-enters the scheduler with the index's own docName; an index
 * that accepted that write would schedule its own rebuild forever. Matching only
 * the root name lets every generated child slip through. `log` — the other
 * reserved stem — is deliberately not matched: a `log` write moves no index
 * entry, so its rebuild is absorbed by the byte comparison rather than refused.
 */
export function isGeneratedIndexDocName(docName: string): boolean {
  return basenameOf(docName) === ROOT_INDEX_DOC_NAME;
}

/**
 * A document the index counts: neither a reserved stem nor infrastructure. The
 * entry list and the directory set filter on this one predicate, so "a directory
 * earns an index on the same terms a document earns an entry" is a code fact
 * rather than two rules kept in step by hand.
 */
function isAdmittedEntry(docName: string): boolean {
  return !RESERVED_STEMS.has(basenameOf(docName)) && !isInfrastructurePath(docName);
}

/**
 * Shape one admitted document as the index renders it. Shared by the root-only
 * collector and the per-directory planner so both emit byte-identical entries —
 * the title fallback and the extension-carrying path stay one code fact rather
 * than two that can drift.
 */
function toIndexEntry(
  docName: string,
  meta: IndexSourceDoc,
  docExtension: (docName: string) => string,
): IndexEntry {
  return {
    path: `${docName}${docExtension(docName)}`,
    // The file index resolves title through the full ladder (frontmatter, then
    // first heading) and falls back to the docName, so an absent title here
    // means an entry built without enrichment rather than an untitled document.
    // The docName is the same floor `/api/pages` uses.
    title: meta.title ?? basenameOf(docName),
    description: meta.description,
    type: meta.type,
  };
}

/**
 * The set of directories that should carry a generated index: the root always,
 * plus every ancestor directory of an admitted document.
 *
 * Root is unconditional — it is the bundle's entry point and exists even for a
 * bundle with no documents yet. A non-root directory earns an index only by
 * holding an admitted document somewhere at or below it, so a directory whose
 * only content is reserved files or infrastructure never appears.
 *
 * Derived from document keys alone — each key walked to its ancestors — so it
 * reads no directory and touches no disk. Deriving from the keys rather than the
 * watcher's folder index is what keeps empty directories out: the folder index
 * registers a directory whether or not any markdown lives in it, while the keys
 * are exactly the admitted-document set the entries come from.
 */
export function collectIndexDirectories(docNames: Iterable<string>): Set<string> {
  const directories = new Set<string>(['']);

  for (const docName of docNames) {
    if (!isAdmittedEntry(docName)) continue;

    const segments = docName.split('/');
    segments.pop();
    let directory = '';
    for (const segment of segments) {
      directory = directory === '' ? segment : `${directory}/${segment}`;
      directories.add(directory);
    }
  }

  return directories;
}

/** Path depth for deepest-first ordering; the root ('') is 0. */
function depthOf(directory: string): number {
  return directory === '' ? 0 : directory.split('/').length;
}

/**
 * Plan a rebuild decision for every directory that should carry an index.
 *
 * One decision per directory in the set, each built only from the documents
 * directly in that directory plus links to the immediate child directories, and
 * each compared against its own current bytes. That per-directory comparison is
 * what lets every index reach its own fixed point independently: an unchanged
 * directory reports `changed: false` and its consumer writes nothing.
 *
 * A child is listed by set membership, not by probing whether its index is
 * already on disk. Every directory in the set gets a decision in this same plan,
 * so the whole tree is internally consistent at once and a cold boot converges
 * without a second corrective pass. Decisions come back deepest-first so a
 * consumer writing them in order lands each child before the parent that links
 * it, never leaving a parent index pointing at an index not yet written.
 */
export function planDirectoryIndexRegenerations(
  deps: DirectoryIndexDeps,
): DirectoryIndexDecision[] {
  // Consumed twice below — once for the directory set, once to bucket entries —
  // so materialize it; a single-use iterator would be spent after the first pass.
  const docs = [...deps.docs];
  const directories = collectIndexDirectories(docs.map(([docName]) => docName));

  const entriesByDirectory = new Map<string, IndexEntry[]>();
  for (const [docName, meta] of docs) {
    if (!isAdmittedEntry(docName)) continue;
    const directory = directoryOf(docName);
    const bucket = entriesByDirectory.get(directory);
    if (bucket) bucket.push(toIndexEntry(docName, meta, deps.docExtension));
    else entriesByDirectory.set(directory, [toIndexEntry(docName, meta, deps.docExtension)]);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const directory of directories) {
    if (directory === '') continue; // the root is nobody's child
    const parent = directoryOf(directory);
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(directory);
    else childrenByParent.set(parent, [directory]);
  }

  const decisions = [...directories].map((directory): DirectoryIndexDecision => {
    const entries = entriesByDirectory.get(directory) ?? [];
    // A subdirectory links to the child's generated index document. That index
    // is always written `.md` (never `.mdx`), so the target is fixed rather than
    // resolved through `docExtension`, which is for admitted documents.
    const subdirectories: SubdirectoryEntry[] = (childrenByParent.get(directory) ?? []).map(
      (child) => ({ path: `${child}/${ROOT_INDEX_DOC_NAME}.md`, title: basenameOf(child) }),
    );
    const markdown = buildIndexMarkdown(entries, {
      isRoot: directory === '',
      directory,
      subdirectories,
    });
    return { directory, changed: deps.currentMarkdownFor(directory) !== markdown, markdown };
  });

  // Deepest-first, with a code-point tie-break so the order is a pure function
  // of the directory set rather than of document iteration order.
  return decisions.sort(
    (left, right) =>
      depthOf(right.directory) - depthOf(left.directory) ||
      (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0),
  );
}

/**
 * Whether a write changed anything the index would show.
 *
 * The index renders exactly three fields, so every other edit — a paragraph, a
 * heading below the first, an unrelated frontmatter key — must not schedule a
 * rebuild. Editing prose is the common case by a wide margin, and treating it
 * as a trigger would rewrite the index on nearly every keystroke burst.
 *
 * A first write has no previous bytes; the title moves from nothing to
 * something, so a new document schedules a rebuild without a special case.
 */
export function indexedFieldsChanged(
  previousMarkdown: string | null | undefined,
  nextMarkdown: string,
  docName: string,
): boolean {
  const previous = previousMarkdown ?? '';
  return (
    extractPageTitle(previous, docName) !== extractPageTitle(nextMarkdown, docName) ||
    extractPageDescription(previous) !== extractPageDescription(nextMarkdown) ||
    extractPageType(previous) !== extractPageType(nextMarkdown)
  );
}

/**
 * Semantic invalidation for external watcher updates, whose old full bytes are
 * no longer available after classification but whose cached rendered fields
 * were captured before the file-index mutation.
 */
export function indexedMetadataChanged(
  previous: PreviousIndexedFields | undefined,
  nextMarkdown: string,
  docName: string,
): boolean {
  if (previous === undefined) return true;
  return (
    previous.title !== extractPageTitle(nextMarkdown, docName) ||
    previous.description !== extractPageDescription(nextMarkdown) ||
    previous.type !== extractPageType(nextMarkdown)
  );
}
