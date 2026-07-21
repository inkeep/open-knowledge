/**
 * In-memory tag index. Stores `tag → Set<docName>` keyed on the **expanded**
 * hierarchical form, so a doc carrying `#proj/team` is registered under both
 * `'proj'` and `'proj/team'`. Rollup queries are then plain O(1) lookups
 * against the same map — no per-query scan.
 *
 * Source channels per doc:
 *   - inline `#tag` text in the markdown body (regex `TAG_VALUE_RE` mirrors
 *     `core/markdown/tag-promotion.ts`'s inline pattern modulo the boundary
 *     wrapper — server-side we already have the body string isolated, so
 *     the boundary group is collapsed into a leading `(^|\\s)`).
 *   - frontmatter `tags:` list, validated via core's
 *     `extractFrontmatterTags` so the inline + YAML surfaces share one
 *     regex and one drop-on-invalid policy.
 *
 * Persistence mirrors the backlink cache: a JSON snapshot of each doc's
 * literal authored tags plus per-file mtime+size, at
 * `<projectDir>/.ok/local/cache/tags.json`. Warm boots load the snapshot and
 * `reconcileWithDisk()` re-parses only files whose mtime or size changed;
 * cold boots (or a corrupt snapshot) fall back to the full `init()` scan.
 * Only the literal tag sets are persisted — hierarchy expansion is
 * re-derived on load, so the snapshot can never disagree with the
 * expansion rules.
 *
 * Similar surface to BacklinkIndex. Same `updateDocumentFromMarkdown` /
 * `deleteDocument` method names. Branch-agnostic single-state
 * simplification (tag rollup is not branch-aware today), so the snapshot is
 * a single file rather than per-branch: a branch switch rewrites changed
 * files' mtimes, which the same reconcile pass picks up.
 */

import { type Dirent, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createTagInTextRegex,
  expandTagToHierarchy,
  extractFrontmatterTags,
  stripFrontmatter,
  tagsMatchingPrefix,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { tracedMkdir, tracedWriteFile } from './fs-traced.ts';
import { instrumentIndexRebuild } from './index-telemetry.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';

const log = getLogger('tag-index');

/**
 * Inline-tag pattern for server-side body scanning. Sourced from
 * `core/markdown/tag-promotion.ts` via `createTagInTextRegex` so client-
 * promoter and server-indexer share one pattern at a single source of
 * truth — drift between the two would cause the indexer to count tags
 * the editor doesn't render, or miss ones it does. Each call returns a
 * fresh `RegExp` (stateful `lastIndex` is per-instance; the per-line
 * scan below resets it explicitly).
 */
const TAG_VALUE_RE = createTagInTextRegex();

export interface TagSummaryEntry {
  name: string;
  count: number;
  isLeaf: boolean;
}

export interface TagIndexOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  /**
   * Project root (where `.ok/` lives). Enables the on-disk snapshot at
   * `<projectDir>/.ok/local/cache/tags.json`. When omitted (in-memory-only
   * usage, most unit tests), `saveToDisk` is a no-op and `loadFromDisk`
   * reports a cache miss so callers fall back to the full scan.
   */
  projectDir?: string;
}

/** Per-file freshness witness captured at rebuild/reconcile time. */
interface FileMeta {
  mtimeMs: number;
  size: number;
}

interface SerializedTagIndexSnapshot {
  version: 1;
  /** docName → sorted literal authored tags (hierarchy re-expanded on load). */
  docs: Record<string, string[]>;
  /** docName → mtime+size at the last rebuild/reconcile; the boot short-circuit witness. */
  files: Record<string, FileMeta>;
}

const SNAPSHOT_VERSION = 1;

/**
 * Structural validation of a parsed snapshot. Anything off-shape (wrong
 * version, non-string tags, non-numeric file meta) reports corrupt so the
 * caller falls back to a full rebuild — a partial restore from a bad
 * snapshot would surface stale or garbage tags to the user.
 */
function isValidSnapshot(data: unknown): data is SerializedTagIndexSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const snapshot = data as Record<string, unknown>;
  if (snapshot.version !== SNAPSHOT_VERSION) return false;
  const { docs, files } = snapshot;
  if (typeof docs !== 'object' || docs === null || Array.isArray(docs)) return false;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return false;
  for (const tags of Object.values(docs)) {
    if (!Array.isArray(tags)) return false;
    if (!tags.every((tag) => typeof tag === 'string' && tag.length > 0)) return false;
  }
  for (const meta of Object.values(files)) {
    if (typeof meta !== 'object' || meta === null) return false;
    const { mtimeMs, size } = meta as Record<string, unknown>;
    if (typeof mtimeMs !== 'number' || typeof size !== 'number') return false;
  }
  return true;
}

interface TagIndexState {
  /** Expanded-prefix tag → set of docs that fall under that prefix (or carry it exactly). */
  byTag: Map<string, Set<string>>;
  /** docName → set of expanded-prefix tags that doc registered. Lets removal walk in O(tag-count). */
  byDoc: Map<string, Set<string>>;
  /**
   * docName → set of literal authored tags (no hierarchy expansion). Stored
   * separately so the API can answer "which of this doc's authored tags
   * match the queried prefix" — a question that's load-bearing for the
   * dialog UX but distinct from "is this doc registered under prefix X"
   * (which `byTag` answers via the expanded keys). Without this map the
   * rollup is invisible to the user: a doc with `#frontend/component`
   * registers under both `frontend` and `frontend/component` for query
   * purposes, but the user wants to see *which* nested variant brought it
   * into the result list, not the rollup parent.
   */
  byDocLiteral: Map<string, Set<string>>;
}

function createEmptyState(): TagIndexState {
  return {
    byTag: new Map(),
    byDoc: new Map(),
    byDocLiteral: new Map(),
  };
}

interface TagDocMatch {
  docName: string;
  /**
   * The doc's authored tags that fall under the queried prefix. Sorted
   * lexicographically. Equal to `[query]` when the doc has the exact tag,
   * `[query/x, query/y]` when the doc only has nested children, or the
   * union when it has both.
   */
  matchingTags: string[];
}

/**
 * Strip single-backtick inline code spans from a line. A `#tag` inside
 * inline code (e.g. `` `#config` ``) parses to an mdast `code` node, not a
 * `text` node, so the client-side promoter at `core/markdown/tag-promotion.ts`
 * never sees it. The server-side scanner walks raw lines and would otherwise
 * see and index it — diverging from the rendered surface. Mirror the
 * client-side gate by removing what the parser would treat as inline code
 * before running the tag regex.
 *
 * Per CommonMark §6.1 backslashes are NOT escape characters inside a code
 * span — only the backtick run is meaningful. Match a non-greedy run of
 * non-backtick chars between the delimiters. Multi-backtick spans
 * (`` `` `code` `` ``) aren't handled here because the in-the-wild rate is
 * negligible and the failure mode is a false negative (tag visible in
 * editor but missing from the index), which is the safer direction.
 */
function stripInlineCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

/**
 * Extract every inline tag value from a markdown body string. Doesn't dedupe
 * or expand — the index applies hierarchy + dedup. Code-fence boundary
 * detection isn't needed here because the inline promoter operates on text
 * nodes after parse, but to keep parity with the rendered surface we strip
 * fenced code regions and inline code spans before scanning. A `#word`
 * inside either form shouldn't index as a tag.
 */
function extractInlineTagsFromBody(body: string): string[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}([`~]{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else {
        // CommonMark: a closing fence is the marker char repeated at least
        // as many times as the opener, optionally surrounded by whitespace,
        // with NO info string. Building the closer regex from `fenceMarker`
        // (which only captured the run of marker chars, not any info string
        // the opener carried) keeps the gate honest.
        const closer = new RegExp(
          `^\\s{0,3}${fenceMarker[0] === '`' ? '`' : '~'}{${fenceMarker.length},}\\s*$`,
        );
        if (closer.test(line)) {
          inFence = false;
          fenceMarker = '';
        }
      }
      continue;
    }
    if (inFence) continue;
    const scannable = stripInlineCodeSpans(line);
    TAG_VALUE_RE.lastIndex = 0;
    for (;;) {
      const match = TAG_VALUE_RE.exec(scannable);
      if (match === null) break;
      const value = match[2];
      if (value) out.push(value);
    }
  }
  return out;
}

export class TagIndex {
  private readonly contentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly projectDir?: string;
  private state: TagIndexState = createEmptyState();
  /**
   * Per-doc freshness witnesses from the last full scan or reconcile.
   * Persisted in the snapshot; runtime incremental updates deliberately do
   * NOT refresh entries here, so the next boot's reconcile re-parses any
   * file whose bytes moved under a stale witness (same contract as
   * BacklinkIndex's mtime map).
   */
  private fileMeta = new Map<string, FileMeta>();
  private initChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: TagIndexOptions) {
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
    this.projectDir = options.projectDir;
  }

  private snapshotPath(): string | null {
    if (!this.projectDir) return null;
    return resolve(getLocalDir(this.projectDir), 'cache', 'tags.json');
  }

  /**
   * Serialize a task onto the internal chain shared with `init()`. Every
   * operation that reads or replaces whole-index state (full scan,
   * reconcile, snapshot load/save) runs here so a snapshot save can never
   * observe a half-populated rebuild and two scans can never interleave
   * their per-doc updates. Failures clear the chain link (same shape as
   * `init()`'s original chaining) so one failed task doesn't poison the
   * next.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.initChain.then(fn);
    this.initChain = run.then(
      () => undefined,
      (err) => {
        log.warn({ err }, 'queued tag-index task failed (chain cleared for next task)');
      },
    );
    return run;
  }

  /**
   * Stop all future queued work (scans, reconciles, snapshot saves become
   * no-ops) and resolve once in-flight chain tasks have drained. Server
   * destroy calls this so a fire-and-forget snapshot save can never land
   * inside `.ok/` after teardown starts — test rigs `rm -rf` the state dir
   * right after destroy, and a late write turns that into ENOTEMPTY.
   */
  close(): Promise<void> {
    this.closed = true;
    return this.initChain;
  }

  /**
   * Replace this doc's tag set. Removes its prior contribution from the
   * forward map first so renames or deletes never leave stale entries.
   * Synthetic doc names short-circuit silently — same gate `BacklinkIndex`
   * uses (`__system__` + `__config__/*` are never indexed).
   */
  updateDocumentFromMarkdown(docName: string, markdown: string): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    try {
      const { frontmatter, body } = stripFrontmatter(markdown);
      const yamlBody = frontmatter ? unwrapFrontmatterFences(frontmatter) : '';
      const fmTags = extractFrontmatterTags(yamlBody);
      const inlineTags = extractInlineTagsFromBody(body);

      // Collapse to a Set first — duplicates within a single doc shouldn't
      // inflate the count.
      const authoredTags = new Set<string>([...fmTags, ...inlineTags]);

      // Compute the expanded-prefix set this doc should appear under.
      const expanded = new Set<string>();
      for (const tag of authoredTags) {
        for (const prefix of expandTagToHierarchy(tag)) {
          expanded.add(prefix);
        }
      }

      this.applyDocSnapshot(docName, authoredTags, expanded);
    } catch (err) {
      log.warn({ docName, err }, `Failed to scan ${docName} for tag extraction`);
      this.deleteDocument(docName);
    }
  }

  /**
   * Remove a doc from the index. Idempotent — calling twice is a no-op.
   * Cleans empty `byTag` entries so `getAllTags()` doesn't surface dead
   * keys.
   */
  deleteDocument(docName: string): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    const prior = this.state.byDoc.get(docName);
    if (!prior) return;
    for (const tag of prior) {
      const docs = this.state.byTag.get(tag);
      if (!docs) continue;
      docs.delete(docName);
      if (docs.size === 0) this.state.byTag.delete(tag);
    }
    this.state.byDoc.delete(docName);
    this.state.byDocLiteral.delete(docName);
  }

  /**
   * Atomic rename — drops the old doc's entries and registers the new
   * doc with the rename's post-content tags. Sister to
   * `BacklinkIndex.renameDocument`'s shape (minus `branch` since
   * `TagIndex` is branch-agnostic). Callers don't have to inline
   * `deleteDocument` + `updateDocumentFromMarkdown` at every rename
   * site — the helper keeps the divergence from BacklinkIndex's API
   * surface from compounding as more rename surfaces appear.
   */
  renameDocument(oldDocName: string, newDocName: string, markdown: string): void {
    this.deleteDocument(oldDocName);
    this.updateDocumentFromMarkdown(newDocName, markdown);
  }

  /**
   * Look up docs registered under a tag (including via hierarchy rollup,
   * because the index stores expanded prefixes). Returns docs sorted
   * lexicographically; empty array when the tag is unknown.
   */
  getDocsForTag(tag: string): string[] {
    const docs = this.state.byTag.get(tag);
    if (!docs) return [];
    return [...docs].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Same membership query as `getDocsForTag` but enriched with each doc's
   * authored tags that actually fall under the queried prefix. Lets the
   * dialog show "this doc is in the list because it has #foo/bar" instead
   * of just listing the doc and leaving the rollup invisible. Returns docs
   * sorted lexicographically; per-doc `matchingTags` is also sorted.
   */
  getDocsForTagWithMatches(tag: string): TagDocMatch[] {
    const docs = this.state.byTag.get(tag);
    if (!docs) return [];
    const result: TagDocMatch[] = [];
    for (const docName of docs) {
      const literal = this.state.byDocLiteral.get(docName);
      if (!literal) continue;
      const matching = tagsMatchingPrefix(literal, tag);
      result.push({
        docName,
        matchingTags: [...matching].sort((a, b) => a.localeCompare(b)),
      });
    }
    return result.sort((a, b) => a.docName.localeCompare(b.docName));
  }

  /**
   * Enumerate every indexed tag with its doc count and whether it is a leaf
   * (no other indexed tag starts with `name + '/'`). Sorted by name. Useful
   * for tag-cloud / tag-tree UIs that need both shape and density per node.
   */
  getAllTags(): TagSummaryEntry[] {
    const entries = [...this.state.byTag.entries()];
    const allNames = entries.map(([name]) => name);
    const childPrefixSet = new Set<string>();
    for (const name of allNames) {
      const slashIdx = name.indexOf('/');
      // For each non-leaf, the parent prefix already shows up in the map
      // (the index stores every expanded prefix). The leaf check is just:
      // does any *other* indexed name start with `name + '/'`. To answer
      // O(1) instead of O(n) per-tag, precompute the set of names that
      // have at least one slash — those names imply non-leaf parents.
      if (slashIdx > 0) childPrefixSet.add(name.slice(0, slashIdx));
      // Also imply every intermediate level — `a/b/c` means `a` and `a/b` are non-leaf.
      let cursor = slashIdx;
      while (cursor > 0) {
        childPrefixSet.add(name.slice(0, cursor));
        cursor = name.indexOf('/', cursor + 1);
      }
    }
    return entries
      .map(([name, docs]) => ({
        name,
        count: docs.size,
        isLeaf: !childPrefixSet.has(name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Full cold-start scan. Walks `contentDir` (respecting `contentFilter`),
   * indexes every supported markdown file, and collects the freshness
   * witnesses a later `saveToDisk` persists. Mirrors
   * `BacklinkIndex.rebuildFromDisk` — same recursion shape, same exclusion
   * gates.
   *
   * Reads files via the absolute path discovered during the walk rather than
   * `getDocExtension(docName)` so the indexer doesn't have to mutate the
   * shared `docExtensionByName` map (file-watcher remains the authoritative
   * registrar for that map; touching it from a derived index would couple
   * test order across surfaces).
   */
  init(): Promise<void> {
    return this.enqueue(() => instrumentIndexRebuild('tag', 'full', () => this.initOnce()));
  }

  private async initOnce(): Promise<void> {
    if (this.closed) return;
    this.state = createEmptyState();
    this.fileMeta = new Map();
    if (!existsSync(this.contentDir)) return;
    const entries = await this.listDocsWithPaths();
    // Bounded read batches keep the event loop responsive on large content
    // dirs (same shape as BacklinkIndex.rebuildFromDisk).
    const BATCH_SIZE = 50;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ docName, filePath }) => {
          try {
            const [fileStat, markdown] = await Promise.all([
              stat(filePath),
              readFile(filePath, 'utf-8'),
            ]);
            return { docName, markdown, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
          } catch (err) {
            log.warn({ docName, err }, `Failed to read ${docName} during init`);
            return null;
          }
        }),
      );
      for (const result of results) {
        if (!result) continue;
        try {
          this.updateDocumentFromMarkdown(result.docName, result.markdown);
          this.fileMeta.set(result.docName, { mtimeMs: result.mtimeMs, size: result.size });
        } catch (err) {
          log.warn(
            { docName: result.docName, err },
            `Failed to index ${result.docName} during init`,
          );
        }
      }
    }
  }

  /**
   * Restore the persisted snapshot into memory. Returns `false` on cache
   * miss, disabled persistence (no `projectDir`), or ANY corruption —
   * callers must treat `false` as "run the full `init()` scan". A `true`
   * return means the in-memory state now reflects the snapshot; follow with
   * `reconcileWithDisk()` to fold in offline changes.
   */
  loadFromDisk(): Promise<boolean> {
    return this.enqueue(() => this.loadOnce());
  }

  private async loadOnce(): Promise<boolean> {
    if (this.closed) return false;
    const filePath = this.snapshotPath();
    if (!filePath || !existsSync(filePath)) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    } catch (err) {
      log.warn({ err }, 'Failed to load tag snapshot; falling back to full rebuild');
      return false;
    }
    if (!isValidSnapshot(parsed)) {
      log.warn({}, 'Tag snapshot failed validation; falling back to full rebuild');
      return false;
    }
    this.state = createEmptyState();
    this.fileMeta = new Map(Object.entries(parsed.files));
    for (const [docName, tags] of Object.entries(parsed.docs)) {
      // Same synthetic-doc gate as the live update path — a hand-edited or
      // poisoned snapshot must not smuggle system docs into the index.
      if (isLinkIndexExcludedDoc(docName)) continue;
      const authoredTags = new Set(tags);
      const expanded = new Set<string>();
      for (const tag of authoredTags) {
        for (const prefix of expandTagToHierarchy(tag)) {
          expanded.add(prefix);
        }
      }
      this.applyDocSnapshot(docName, authoredTags, expanded);
    }
    return true;
  }

  /**
   * Persist the current literal tag sets + freshness witnesses. No-op when
   * persistence is disabled. Enqueued on the internal chain so a save never
   * captures a half-populated rebuild.
   */
  saveToDisk(): Promise<void> {
    return this.enqueue(() => this.saveOnce());
  }

  private async saveOnce(): Promise<void> {
    if (this.closed) return;
    const filePath = this.snapshotPath();
    if (!filePath) return;
    const snapshot: SerializedTagIndexSnapshot = {
      version: SNAPSHOT_VERSION,
      docs: Object.fromEntries(
        [...this.state.byDocLiteral.entries()].map(([docName, tags]) => [
          docName,
          [...tags].sort((a, b) => a.localeCompare(b)),
        ]),
      ),
      files: Object.fromEntries(this.fileMeta),
    };
    await tracedMkdir(dirname(filePath), { recursive: true });
    await tracedWriteFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /**
   * Incremental startup / branch-switch reconcile. Walks the content dir,
   * short-circuits files whose mtime AND size match the stored witness, and
   * re-parses only changed or new files (bounded 50-file read batches).
   * Docs whose file vanished are dropped. Requires `loadFromDisk()` (or a
   * prior `init()`) to have populated the witnesses — with none stored,
   * every file classifies as new and the pass degrades gracefully to a full
   * scan that also prunes stale in-memory entries.
   */
  reconcileWithDisk(): Promise<{ added: number; updated: number; deleted: number }> {
    return this.enqueue(() =>
      instrumentIndexRebuild(
        'tag',
        'reconcile',
        () => this.reconcileOnce(),
        (diff) => ({
          'index.added': diff.added,
          'index.updated': diff.updated,
          'index.deleted': diff.deleted,
        }),
      ),
    );
  }

  private async reconcileOnce(): Promise<{ added: number; updated: number; deleted: number }> {
    if (this.closed || !existsSync(this.contentDir)) return { added: 0, updated: 0, deleted: 0 };
    const docs = await this.listDocsWithPaths();
    const currentDocSet = new Set(docs.map((d) => d.docName));
    const newMeta = new Map<string, FileMeta>();
    let added = 0;
    let updated = 0;

    // Phase 1: stat all files concurrently to find changed/new ones.
    const toProcess: Array<{ docName: string; filePath: string; meta: FileMeta; isNew: boolean }> =
      [];
    const statResults = await Promise.allSettled(
      docs.map(async ({ docName, filePath }) => {
        const fileStat = await stat(filePath);
        return { docName, filePath, meta: { mtimeMs: fileStat.mtimeMs, size: fileStat.size } };
      }),
    );
    for (const result of statResults) {
      if (result.status === 'rejected') continue; // inaccessible; skip
      const { docName, filePath, meta } = result.value;
      const stored = this.fileMeta.get(docName);
      if (stored !== undefined && stored.mtimeMs === meta.mtimeMs && stored.size === meta.size) {
        newMeta.set(docName, meta);
        continue;
      }
      toProcess.push({ docName, filePath, meta, isNew: stored === undefined });
    }

    // Phase 2: read + parse changed/new files in bounded batches.
    const BATCH_SIZE = 50;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, meta, isNew, filePath }) => ({
          docName,
          meta,
          isNew,
          markdown: await readFile(filePath, 'utf-8'),
        })),
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to reconcile file');
          continue;
        }
        const { docName, meta, isNew, markdown } = result.value;
        this.updateDocumentFromMarkdown(docName, markdown);
        newMeta.set(docName, meta);
        if (isNew) added++;
        else updated++;
      }
    }

    // Phase 3: drop docs whose file is gone. Union of stored witnesses and
    // live doc keys covers docs indexed at runtime (live-derived updates)
    // that never got a witness entry.
    let deleted = 0;
    const allKnownDocs = new Set([...this.fileMeta.keys(), ...this.state.byDoc.keys()]);
    for (const docName of allKnownDocs) {
      if (!currentDocSet.has(docName)) {
        this.deleteDocument(docName);
        deleted++;
      }
    }

    this.fileMeta = newMeta;
    return { added, updated, deleted };
  }

  private applyDocSnapshot(
    docName: string,
    authoredTags: Set<string>,
    expanded: Set<string>,
  ): void {
    const prior = this.state.byDoc.get(docName) ?? new Set<string>();

    // Remove tags this doc no longer carries.
    for (const tag of prior) {
      if (expanded.has(tag)) continue;
      const docs = this.state.byTag.get(tag);
      if (!docs) continue;
      docs.delete(docName);
      if (docs.size === 0) this.state.byTag.delete(tag);
    }

    // Add tags this doc gained.
    for (const tag of expanded) {
      let docs = this.state.byTag.get(tag);
      if (!docs) {
        docs = new Set();
        this.state.byTag.set(tag, docs);
      }
      docs.add(docName);
    }

    if (expanded.size === 0) {
      this.state.byDoc.delete(docName);
      this.state.byDocLiteral.delete(docName);
    } else {
      this.state.byDoc.set(docName, expanded);
      this.state.byDocLiteral.set(docName, authoredTags);
    }
  }

  private async listDocsWithPaths(): Promise<Array<{ docName: string; filePath: string }>> {
    const out: Array<{ docName: string; filePath: string }> = [];
    await this.walkContentDir(this.contentDir, out);
    // Dedupe by docName when both `foo.md` and `foo.mdx` exist on disk —
    // sort by extension so `.mdx` wins (matching `doc-extensions.ts`'s
    // precedence order: mdx ranks above md).
    out.sort((a, b) => {
      if (a.docName !== b.docName) return a.docName.localeCompare(b.docName);
      // `.mdx` before `.md` — longer extension wins for the same stem.
      return b.filePath.localeCompare(a.filePath);
    });
    const seen = new Set<string>();
    return out.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });
  }

  private async walkContentDir(
    dir: string,
    out: Array<{ docName: string; filePath: string }>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir, err }, `Failed to read directory ${dir}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter && relDir && this.contentFilter.isDirExcluded(relDir)) continue;
        await this.walkContentDir(fullPath, out);
        continue;
      }
      if (!entry.isFile() || !isSupportedDocFile(entry.name)) continue;
      const relPath = toPosix(relative(this.contentDir, fullPath));
      if (this.contentFilter?.isExcluded(relPath)) continue;
      out.push({ docName: stripDocExtension(relPath), filePath: fullPath });
    }
  }
}
