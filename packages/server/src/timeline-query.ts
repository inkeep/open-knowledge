/**
 * Timeline query — walk the shadow repo DAG and return a merged, paginated
 * list of timeline entries for a given document.
 *
 * Entry types are classified from commit message prefixes:
 *   'checkpoint:' → checkpoint
 *   'import:'     → upstream  (canonical)
 *   'upstream:'   → upstream  (legacy fallback for pre-rename commits)
 *   'park:'       → park      (branch-switch infrastructure; never returned)
 *   else          → wip
 *
 * Park commits store blobs at extension-less docName paths so
 * `restoreBranchWIP` can three-way merge against disk. The per-version fetch
 * (`/api/history/:sha`) reads at `${contentRoot}/${docName}.md` and cannot
 * resolve them — clicking a park row would yield "Diff unavailable". Park
 * is internal state, not user history, so it is excluded unconditionally.
 */

import { existsSync } from 'node:fs';
import type { EntryType, TimelineEntry } from '@inkeep/open-knowledge-core';
import {
  parseCheckpoint,
  parseOkActors,
  readContributors,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { getDocExtension } from './doc-extensions.ts';
import { managedArtifactTimelinePaths } from './managed-artifact-persistence.ts';
import {
  type AncestorShaSetCache,
  batchCheckExistence,
  buildAncestorShaSet,
  buildSeeds,
  createAncestorShaSetCache,
  createSeedsCache,
  expandPredecessors,
  getOrLoadRenameLogIndex,
  logSeededReachable,
  type RenameLogIndex,
  type SeedsCache,
} from './rename-log.ts';
import type { ShadowHandle } from './shadow-repo.ts';
import { shadowGit } from './shadow-repo.ts';
import { getMeter, withSpan } from './telemetry.ts';
import { recordTimelineQuery } from './timeline-telemetry.ts';

/**
 * Depth bound for a history page. Sizing the git-level
 * `-n` to 3×(offset+limit) gives the requested window plus slack to absorb
 * post-walk filtering losses (ok-actor noise, park rows). The hard ceiling
 * caps the worst-case walk regardless of how deep a caller pages — offsets
 * beyond the ceiling return an empty page with `hasMore=true`. The panel
 * requests at most limit 100; the MCP tool documents the window.
 */
const HISTORY_WALK_CEILING = 500;
export function historyWalkCap(offset: number, limit: number): number {
  return Math.min(HISTORY_WALK_CEILING, 3 * (Math.max(0, offset) + Math.max(1, limit)));
}

interface HistoryQuery {
  docName: string;
  branch?: string;
  /** Filter to specific entry types (comma-separated or array). */
  type?: string | string[];
  /** Only include entries from these authors (by name or email). */
  author?: string | string[];
  /** Exclude entries from these authors (by name or email). */
  excludeAuthor?: string | string[];
  /**
   * Include service-authored `auto-consolidation` checkpoints.
   * Default false: these are excluded from responses so daily auto-consolidations
   * never pollute timelines (their WIP ancestry is still walked, so the WIP rows
   * they anchor stay visible — only the checkpoint row is hidden). Opt-in for
   * debugging / a future maintenance UI.
   */
  includeAutoCheckpoints?: boolean;
  limit?: number;
  offset?: number;
}

interface HistoryResult {
  entries: TimelineEntry[];
  total: number;
  hasMore: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * NUL-delimited format for `git log --format`.
 * Fields: sha, authorDate, authorName, authorEmail, subject, rawBody (full message via %B).
 * Records are terminated with ASCII Record Separator \x1e to handle multi-line commit bodies.
 */
const GIT_LOG_FORMAT = '%H%x00%aI%x00%an%x00%ae%x00%s%x00%B%x1e';

const EMPTY: HistoryResult = { entries: [], total: 0, hasMore: false };

/**
 * A commit subject the attribution path emits for a folder `.ok/` artifact
 * event (`template-create: …`, `template-rename: a -> b`,
 * `folder-frontmatter-edit: …`, `folder-create: …`). Legacy CRDT WIP/park
 * snapshots carry raw `wip:`/`park:`/`import:` subjects and are NOT folder
 * activity — `getFolderTimeline` uses this to keep the timeline to genuine,
 * attributed artifact events.
 */
const FOLDER_ARTIFACT_SUBJECT_RE =
  /^(template-(create|edit|rename|move|delete)|folder-frontmatter-(edit|delete)|folder-create): /;
function isFolderArtifactSubject(message: string): boolean {
  return FOLDER_ARTIFACT_SUBJECT_RE.test(message);
}

function classifyType(subject: string): EntryType {
  if (subject.startsWith('checkpoint:')) return 'checkpoint';
  if (subject.startsWith('import:') || subject.startsWith('upstream:')) return 'upstream';
  if (subject.startsWith('park:')) return 'park';
  return 'wip';
}

/**
 * Internal entry shape — adds `rawBody` for downstream filters that need the
 * full ok-actor body lines (e.g., `filterEntriesByOkActorDocs` uses
 * `previous_paths`). Stripped before returning to API consumers.
 */
type ParsedEntry = TimelineEntry & { rawBody: string };

function parseGitLogOutput(raw: string): ParsedEntry[] {
  if (!raw.trim()) return [];
  return raw
    .split('\x1e')
    .map((record) => {
      const trimmed = record.trimStart();
      if (!trimmed) return null;
      const parts = trimmed.split('\x00');
      const [sha = '', timestamp = '', author = '', authorEmail = '', message = '', rawBody = ''] =
        parts;
      const type = classifyType(message);
      return {
        sha: sha.trim(),
        timestamp,
        author,
        authorEmail,
        type,
        message,
        contributors: readContributors(rawBody),
        checkpoint: type === 'checkpoint' ? parseCheckpoint(rawBody) : null,
        rawBody,
      };
    })
    .filter((e): e is ParsedEntry => e !== null && e.sha.length === 40);
}

function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val)
    ? val
    : val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

let _chainDepthHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
function chainDepthHist(): ReturnType<ReturnType<typeof getMeter>['createHistogram']> {
  _chainDepthHist ||= getMeter().createHistogram('rename.predecessor_chain_depth_histogram', {
    description: 'Predecessor chain depth observed per timeline query',
  });
  return _chainDepthHist;
}

let _transientSkipCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function transientSkipCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _transientSkipCounter ||= getMeter().createCounter('rename.transient_skip_total', {
    description: 'Count of empty-commitSha entries encountered (lazy-population transient skip)',
  });
  return _transientSkipCounter;
}

function matchesAuthor(entry: TimelineEntry, authors: string[]): boolean {
  if (authors.length === 0) return true;
  return authors.some(
    (a) =>
      entry.author.toLowerCase().includes(a.toLowerCase()) ||
      entry.authorEmail.toLowerCase().includes(a.toLowerCase()),
  );
}

/**
 * Filter `entries` to keep only those whose tree contains the target document
 * at one of its historical paths, cycle-bounded per predecessor.
 *
 * Builds one `(sha, path)` probe per (entry, chain-step) where the cycle
 * bound is satisfied (current name has no bound; predecessors require
 * `sha ∈ ancestors(seeds(R))`). All probes are sent through one
 * `git cat-file --batch-check` stream. An entry is kept iff any probe for
 * it succeeded.
 */
/**
 * Filter timeline entries to those where at least one writer's
 * `OkActorEntry.docs[]` or `previous_paths[].{from,to}` matches a docName in
 * the chain (cycle-bounded for predecessor steps; unbounded for current).
 *
 * The git-log pathspec filter (`git log -- <path>`) is a coarse pre-filter
 * that catches both real modifications AND topological noise:
 *
 *   - Multi-writer fan-out: each writer's WIP ref is its own chain
 *     (precedent #25). When writer B commits anything, `buildWipTree` builds
 *     the tree from the entire `contentRoot` — so any file added by writer A
 *     since writer B's last commit appears as ADDED in writer B's commit
 *     even though the blob is identical. `git log -- <path>` returns those
 *     commits as "modifications."
 *
 *   - Backlink-rewrite side effects: when doc X is renamed, `applyRenameMap`
 *     rewrites links in every backlink source. Those sources' blobs change.
 *     `git log -- <source-path>` returns the rename commit even though the
 *     source wasn't the rename target.
 *
 * `OkActorEntry.docs[]` carries the docs the writer EXPLICITLY targeted
 * (recordContributor docName + post-rename per-doc recordContributor). It
 * does NOT include incidental backlink-rewrite or topology-only changes.
 * `previous_paths[].{from,to}` carries the rename mapping. The intersection
 * with the chain is the correct "this commit really touched the doc" check.
 *
 * Cycle bound: predecessor steps reuse the same `predecessorAncestors` set
 * computed by `filterEntriesByChain` for checkpoint filtering. Current name
 * (chain[length-1]) is unbounded.
 */
function filterEntriesByOkActorDocs(
  entries: ParsedEntry[],
  chain: Array<{ path: string; renameCommit: string | null }>,
  predecessorAncestors: Array<Set<string> | null>,
): ParsedEntry[] {
  if (entries.length === 0) return entries;
  if (chain.length === 0) return entries;

  return entries.filter((entry) => {
    const actors = parseOkActors(entry.rawBody);
    // Pre-attribution / non-ok-actor commits (extremely old or service-only):
    // keep them — the absence of an ok-actor line is a separate signal that
    // the git-log pathspec already filtered the right shape.
    if (actors.length === 0) return true;

    const touchedNames = new Set<string>();
    for (const actor of actors) {
      for (const d of actor.docs) touchedNames.add(d);
      if (actor.previous_paths) {
        for (const p of actor.previous_paths) {
          touchedNames.add(p.from);
          touchedNames.add(p.to);
        }
      }
    }
    if (touchedNames.size === 0) return true;

    // Match against any chain step that's in cycle bound.
    for (let chainIdx = 0; chainIdx < chain.length; chainIdx++) {
      const step = chain[chainIdx];
      const ancestors = predecessorAncestors[chainIdx];
      if (ancestors !== null && !ancestors.has(entry.sha)) continue;
      if (touchedNames.has(step.path)) return true;
    }
    return false;
  });
}

async function filterEntriesByChain<E extends { sha: string }>(
  shadow: ShadowHandle,
  entries: E[],
  chain: Array<{ path: string; renameCommit: string | null }>,
  branch: string,
  pathFor: (name: string) => string,
  cache: AncestorShaSetCache,
  seedsCache: SeedsCache,
): Promise<E[]> {
  if (entries.length === 0) return entries;
  if (chain.length === 0) return entries;

  // Pre-compute ancestor sets for each predecessor step. Current name has
  // no bound (matches every entry that has the path in its tree).
  const predecessorAncestors: Array<Set<string> | null> = await Promise.all(
    chain.map(async (step) => {
      if (step.renameCommit === null) return null;
      const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
      if (seeds.length === 0) return new Set<string>();
      return buildAncestorShaSet(shadow, seeds, branch, cache);
    }),
  );

  // Build the probe list. For each entry, for each chain step where the
  // entry's SHA satisfies the cycle bound, emit one probe.
  type Probe = { entryIdx: number; sha: string; path: string };
  const probes: Probe[] = [];
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    for (let chainIdx = 0; chainIdx < chain.length; chainIdx++) {
      const step = chain[chainIdx];
      const ancestors = predecessorAncestors[chainIdx];
      if (ancestors !== null && !ancestors.has(entry.sha)) continue;
      probes.push({ entryIdx, sha: entry.sha, path: pathFor(step.path) });
    }
  }

  if (probes.length === 0) return [];
  const results = await batchCheckExistence(
    shadow,
    probes.map((p) => ({ sha: p.sha, path: p.path })),
  );

  const keep = new Set<number>();
  for (let i = 0; i < probes.length; i++) {
    if (results[i]) keep.add(probes[i].entryIdx);
  }
  return entries.filter((_, i) => keep.has(i));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Query the shadow repo DAG and return a merged, paginated timeline.
 *
 * Reads are intentionally NOT protected by the shadow-root writer lock —
 * concurrent reads with writes are safe on git object storage.
 *
 * Returns an empty result (never throws) when shadow repo is missing or corrupt.
 *
 * Optional `renameLogIndex` overrides the module-level singleton — primarily
 * for tests that want a controlled chain without touching disk.
 */
export async function getDocumentHistory(
  shadow: ShadowHandle,
  query: HistoryQuery,
  contentRoot = '.',
  options?: { renameLogIndex?: RenameLogIndex },
): Promise<HistoryResult> {
  // Graceful degradation: if the shadow workTree doesn't exist, return empty
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) {
    return EMPTY;
  }

  // Defense in depth: docName is interpolated into a git pathspec
  // (`<contentRoot>/<docName><ext>`). `..` segments and null bytes can escape
  // the contentRoot after git's pathspec normalization. The HTTP boundary
  // already rejects these via `safeDocPath`; this guard catches any direct
  // library callers that bypass it.
  if (query.docName && (query.docName.includes('..') || query.docName.includes('\0'))) {
    return EMPTY;
  }

  const branch = query.branch ?? 'main';
  const limit = Math.max(1, query.limit ?? 50);
  const offset = Math.max(0, query.offset ?? 0);

  // Git-level depth bound: every ancestry walk below is capped at this
  // many commits so a doc with thousands of matching commits returns a first
  // page in bounded time instead of eating the 30s watchdog.
  const walkCap = historyWalkCap(offset, limit);
  const queryStart = performance.now();
  // Set when any bounded walk returns ≥ walkCap rows — the window is saturated
  // and there are (almost certainly) more commits than this page exposes.
  let windowSaturated = false;
  const finishMetric = (width: number, commits: number, error = false): void =>
    recordTimelineQuery({
      durationMs: performance.now() - queryStart,
      width,
      commits,
      capped: windowSaturated,
      error,
    });

  const typeFilter = toArray(query.type);
  const authorFilter = toArray(query.author);
  const excludeAuthorFilter = toArray(query.excludeAuthor);
  // Hide auto-consolidation checkpoint rows by default.
  const includeAuto = query.includeAutoCheckpoints ?? false;

  // Build file pathspec so git log only returns commits touching this document.
  // Normalize: strip leading './' AND treat bare '.' as empty (git rejects
  // both "./foo" and "./" pathspecs when operating against a bare repo).
  const normalizedRoot = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  const pathFor = (name: string): string =>
    normalizedRoot
      ? `${normalizedRoot}/${name}${getDocExtension(name)}`
      : `${name}${getDocExtension(name)}`;

  // Managed-artifact docs (skills/templates) are versioned under their
  // `.ok/...` artifact key, NOT the synthetic `__skill__/...` doc name — so the
  // git pathspec AND the OkActor post-filter must target that key, else `git
  // log` filters on a path with no commits and a saved version never appears.
  // `managedArtifactTimelinePaths` is the shared translation; global skills
  // are unversioned → no shadow history.
  const managed = query.docName
    ? managedArtifactTimelinePaths(query.docName)
    : ({ managed: false } as const);
  if (managed.managed && !managed.versioned) return EMPTY;
  const managedFilePath = managed.managed && managed.versioned ? managed.filePath : undefined;
  // The recorded artifact key drives the predecessor chain + OkActor matching.
  const effectiveDocName = managed.managed && managed.versioned ? managed.docKey : query.docName;

  const docPath = query.docName
    ? managedFilePath
      ? normalizedRoot
        ? `${normalizedRoot}/${managedFilePath}`
        : managedFilePath
      : pathFor(query.docName)
    : undefined;

  try {
    // Chain walker for predecessor expansion. Length 1 (no rename history) →
    // single-pathspec git log identical to the doc's historical query path.
    // Inside the try block: a corrupt rename-log index or transient git
    // failure during expansion must degrade to EMPTY, not throw uncaught.
    const renameLogIndex = options?.renameLogIndex ?? getOrLoadRenameLogIndex(shadow.gitDir);
    const { chain, skipped } = await withSpan('rename.expandPredecessors', undefined, async () =>
      query.docName
        ? expandPredecessors(effectiveDocName, branch, renameLogIndex)
        : { chain: [], skipped: 0 },
    );
    const hasRenameHistory = chain.length > 1;
    if (query.docName) chainDepthHist().record(chain.length);
    if (skipped > 0) transientSkipCounter().add(skipped);

    // One seedsCache per request — shared across the checkpoint filter and the
    // WIP predecessor walk so each predecessor's `git show` + `for-each-ref`
    // pair runs at most once even when both code paths execute.
    const seedsCache = createSeedsCache();
    // One ancestor-set cache per request — shared across the checkpoint
    // filter (`filterEntriesByChain`) and the post-filter that drops
    // multi-writer/backlink-rewrite noise. Without sharing, every predecessor
    // step re-runs `git rev-list --ancestry-path` for the same seeds.
    const ancestorSetCache = createAncestorShaSetCache();

    const sg = shadowGit(shadow);

    // ── Fast path: checkpoint-only query ───────────────────────────────────
    // Uses for-each-ref to list checkpoint SHAs, then resolves commit details
    // via git log --no-walk (avoids walking ancestry — reads only specified commits).
    if (typeFilter.length === 1 && typeFilter[0] === 'checkpoint') {
      const branchCpShas = (
        await sg.raw(
          'for-each-ref',
          '--sort=-creatordate',
          '--format=%(objectname)',
          `refs/checkpoints/${branch}/`,
        )
      )
        .trim()
        .split('\n')
        .filter((s) => s.length === 40);

      // On feature branches, fall back to main's checkpoints
      let mainCpShas: string[] = [];
      if (branch !== 'main') {
        try {
          mainCpShas = (
            await sg.raw(
              'for-each-ref',
              '--sort=-creatordate',
              '--format=%(objectname)',
              'refs/checkpoints/main/',
            )
          )
            .trim()
            .split('\n')
            .filter((s) => s.length === 40);
        } catch {
          // no main checkpoints
        }
      }

      const allShas = [...branchCpShas, ...mainCpShas];
      if (allShas.length === 0) return EMPTY;

      // Bulk-resolve commit details without walking ancestry.
      // Note: --no-walk ignores pathspecs, so we filter afterwards via cat-file.
      const raw = await sg.raw(
        'log',
        '--no-walk',
        '--author-date-order',
        `--format=${GIT_LOG_FORMAT}`,
        ...allShas,
      );

      let allEntries = parseGitLogOutput(raw).map((e) => ({ ...e, type: 'checkpoint' as const }));

      if (docPath) {
        const cache = createAncestorShaSetCache();
        allEntries = await filterEntriesByChain(
          shadow,
          allEntries,
          chain,
          branch,
          pathFor,
          cache,
          seedsCache,
        );
      }

      // Apply branch-takes-over-main cutoff
      if (branch !== 'main' && branchCpShas.length > 0 && mainCpShas.length > 0) {
        const branchSet = new Set(branchCpShas);
        const branchCps = allEntries.filter((e) => branchSet.has(e.sha));
        const mainCps = allEntries.filter((e) => !branchSet.has(e.sha));
        const earliestBranchCp = branchCps.reduce(
          (min, e) => Math.min(min, new Date(e.timestamp).getTime()),
          Number.POSITIVE_INFINITY,
        );
        allEntries = [
          ...branchCps,
          ...mainCps.filter((e) => new Date(e.timestamp).getTime() < earliestBranchCp),
        ];
      }

      const filtered = allEntries.filter(
        (e) =>
          (includeAuto || e.checkpoint?.kind !== 'auto-consolidation') &&
          matchesAuthor(e, authorFilter) &&
          (excludeAuthorFilter.length === 0 || !matchesAuthor(e, excludeAuthorFilter)),
      );

      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
      const stripped: TimelineEntry[] = page.map(({ rawBody: _rawBody, ...rest }) => rest);
      // Checkpoint-only fast path uses `--no-walk` (bounded by checkpoint count,
      // never `-n`-capped), so the window is never saturated here.
      finishMetric(allShas.length, total);
      return { entries: stripped, total, hasMore: offset + limit < total };
    }

    // ── Full DAG walk ───────────────────────────────────────────────────────

    // Collect refs separately: checkpoints are queried via --no-walk (always
    // included as user-triggered landmarks), WIP/upstream walk the full DAG.
    const checkpointShas: string[] = [];
    const startRefs: string[] = [];
    const isFeatureBranch = branch !== 'main';

    try {
      const cpRefs = (
        await sg.raw('for-each-ref', '--format=%(objectname)', `refs/checkpoints/${branch}/`)
      )
        .trim()
        .split('\n')
        .filter((s) => s.length === 40);
      checkpointShas.push(...cpRefs);
    } catch {
      // no checkpoints
    }

    // On feature branches, also collect main's checkpoints as fallback history.
    // Main's checkpoints older than the branch's first checkpoint are shown;
    // main's checkpoints newer than that are hidden (branch has its own timeline).
    let mainCheckpointShas: string[] = [];
    if (isFeatureBranch) {
      try {
        mainCheckpointShas = (
          await sg.raw('for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/')
        )
          .trim()
          .split('\n')
          .filter((s) => s.length === 40);
      } catch {
        // no main checkpoints
      }
    }

    try {
      const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', `refs/wip/${branch}/`))
        .trim()
        .split('\n')
        .filter(Boolean);
      startRefs.push(...wipRefs);
    } catch {
      // no WIP refs
    }

    // On feature branches with no branch-specific refs, also walk main's WIP
    // so pre-divergence auto-saves are visible.
    if (isFeatureBranch && startRefs.length === 0) {
      try {
        const mainWipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/main/'))
          .trim()
          .split('\n')
          .filter(Boolean);
        startRefs.push(...mainWipRefs);
      } catch {
        // no main WIP refs
      }
    }

    if (startRefs.length === 0 && checkpointShas.length === 0 && mainCheckpointShas.length === 0) {
      return EMPTY;
    }

    // 1) Resolve checkpoint entries.
    //    Branch checkpoints are always included. Main checkpoints are included
    //    only up to the branch's first checkpoint (branch takes over its own history).
    const allCpShas = [...checkpointShas, ...mainCheckpointShas];
    let checkpointEntries: ParsedEntry[] = [];
    if (allCpShas.length > 0) {
      const cpRaw = await sg.raw(
        'log',
        '--no-walk',
        '--author-date-order',
        `--format=${GIT_LOG_FORMAT}`,
        ...allCpShas,
      );
      let allCpEntries = parseGitLogOutput(cpRaw).map((e) => ({
        ...e,
        type: 'checkpoint' as const,
      }));

      // --no-walk ignores pathspecs, so filter checkpoints to only those
      // whose tree actually contains the target document at one of its
      // historical paths (cycle-bounded per predecessor).
      if (docPath) {
        allCpEntries = await filterEntriesByChain(
          shadow,
          allCpEntries,
          chain,
          branch,
          pathFor,
          ancestorSetCache,
          seedsCache,
        );
      }

      if (isFeatureBranch && checkpointShas.length > 0 && mainCheckpointShas.length > 0) {
        // Find the earliest branch checkpoint timestamp — main's checkpoints
        // older than this are pre-divergence history (show them).
        // Main's checkpoints at or newer than this are post-divergence (hide them).
        const branchCpShaSet = new Set(checkpointShas);
        const branchCps = allCpEntries.filter((e) => branchCpShaSet.has(e.sha));
        const mainCps = allCpEntries.filter((e) => !branchCpShaSet.has(e.sha));

        const earliestBranchCp = branchCps.reduce((min, e) => {
          const t = new Date(e.timestamp).getTime();
          return t < min ? t : min;
        }, Number.POSITIVE_INFINITY);

        // Keep all branch checkpoints + main checkpoints older than the branch's first
        checkpointEntries = [
          ...branchCps,
          ...mainCps.filter((e) => new Date(e.timestamp).getTime() < earliestBranchCp),
        ];
      } else {
        // No branch checkpoints exist, or we're on main — show all
        checkpointEntries = allCpEntries;
      }
    }

    // 2) WIP + upstream: walk ancestry from all refs (including checkpoints
    //    so their WIP ancestry is reachable).
    const allStartRefs = [...startRefs];
    for (const sha of allCpShas) allStartRefs.push(sha);

    let wipEntries: ParsedEntry[] = [];
    if (allStartRefs.length > 0) {
      // Current name walk — depth-bounded at the git level (`-n walkCap`); the
      // single-pathspec `git log` is identical when no rename history exists.
      const currentRaw = await sg.raw(
        'log',
        '--full-history',
        '--author-date-order',
        `--format=${GIT_LOG_FORMAT}`,
        '-n',
        String(walkCap),
        ...allStartRefs,
        ...(docPath ? ['--', docPath] : []),
      );
      wipEntries = parseGitLogOutput(currentRaw);
      if (wipEntries.length >= walkCap) windowSaturated = true;

      // Predecessor walks — one `git log <seeds(R)> -- <historicalDocPath>` per
      // predecessor entry (chain-bounded). Empty seed set short-circuits. Each
      // step is wrapped independently so a transient failure on one predecessor
      // (e.g., git pressure, broken seed) does not drop history from the
      // remaining predecessors that may resolve cleanly.
      if (hasRenameHistory) {
        // Skip the trailing element (current docName, already walked above).
        for (let i = 0; i < chain.length - 1; i++) {
          const step = chain[i];
          if (step.renameCommit === null) continue;
          try {
            const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
            if (seeds.length === 0) continue;
            const predecessorPath = pathFor(step.path);
            // Seeds may be a long list on long-lived projects (every checkpoint
            // older than the rename commit). Routing through `logSeededReachable`
            // pipes them via stdin when they'd exceed argv limits.
            const predRaw = await logSeededReachable(
              shadow,
              [
                '--full-history',
                '--author-date-order',
                `--format=${GIT_LOG_FORMAT}`,
                '-n',
                String(walkCap),
              ],
              seeds,
              predecessorPath,
            );
            const predEntries = parseGitLogOutput(predRaw);
            if (predEntries.length >= walkCap) windowSaturated = true;
            wipEntries = [...wipEntries, ...predEntries];
          } catch (e) {
            console.warn(
              `[timeline] predecessor walk failed for step ${i} (${step.path}); skipping:`,
              e,
            );
          }
        }
      }
    }

    // Merge checkpoint + WIP entries
    const allEntries = [...checkpointEntries, ...wipEntries];

    // Deduplicate by SHA (multiple refs may reach same commits)
    const seen = new Set<string>();
    const unique: ParsedEntry[] = [];
    for (const e of allEntries) {
      if (!seen.has(e.sha)) {
        seen.add(e.sha);
        unique.push(e);
      }
    }

    // Apply the OkActorEntry-based post-filter whenever we have a docName
    // (chain.length > 0). The git-log pathspec pre-filter catches both real
    // modifications AND multi-writer-fan-out noise: each writer's WIP commit
    // is built from `buildWipTree` over the entire contentRoot, so any file
    // another writer added since this writer's previous commit appears as
    // ADDED in this writer's tree (precedent #25). The OkActor `docs[]` /
    // `previous_paths[]` declaration is the source of truth for what the
    // writer actually intended to touch.
    //
    // Byte-identity with pre-attribution output is preserved structurally:
    // preserved structurally: legacy commits without an `ok-actor:` line hit
    // the `actors.length === 0` early-return inside `filterEntriesByOkActorDocs`
    // and pass through unchanged. Checkpoint / upstream-import / safety-
    // checkpoint commits declare `docs: []` and hit the `touchedNames.size
    // === 0` early-return for the same reason.
    let postFiltered = unique;
    if (unique.length > 0 && chain.length > 0) {
      const filterAncestors: Array<Set<string> | null> = await Promise.all(
        chain.map(async (step) => {
          if (step.renameCommit === null) return null;
          const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
          if (seeds.length === 0) return new Set<string>();
          // Reuse the request-scoped cache populated by the checkpoint filter
          // — same seed sets resolve to the same ancestor sets here.
          return buildAncestorShaSet(shadow, seeds, branch, ancestorSetCache);
        }),
      );
      postFiltered = filterEntriesByOkActorDocs(unique, chain, filterAncestors);
    }

    // Sort by timestamp descending (newest first). Git log outputs are pre-sorted
    // within each ref walk, but merging checkpoint + WIP results may interleave.
    postFiltered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply filters
    let filtered: ParsedEntry[] = postFiltered;

    // Park commits are branch-switch infrastructure (extension-less docName
    // tree paths), not user history — never expose them through the timeline.
    filtered = filtered.filter((e) => e.type !== 'park');

    // Hide auto-consolidation checkpoint rows by default. The walk already
    // traversed their WIP ancestry (so the WIP rows they anchor stay visible);
    // only the synthetic checkpoint row is dropped, and it is dropped BEFORE
    // pagination so a hidden row never costs a visible page slot.
    if (!includeAuto) {
      filtered = filtered.filter((e) => e.checkpoint?.kind !== 'auto-consolidation');
    }

    if (typeFilter.length > 0) {
      filtered = filtered.filter((e) => typeFilter.includes(e.type));
    }

    if (authorFilter.length > 0) {
      filtered = filtered.filter((e) => matchesAuthor(e, authorFilter));
    }

    if (excludeAuthorFilter.length > 0) {
      filtered = filtered.filter((e) => !matchesAuthor(e, excludeAuthorFilter));
    }

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    // Strip the internal `rawBody` before returning to API consumers.
    const stripped: TimelineEntry[] = page.map(({ rawBody: _rawBody, ...rest }) => rest);
    finishMetric(allStartRefs.length, unique.length);
    // `hasMore` is true when there are more pages within the gathered set OR the
    // git-level depth bound was hit AND this page still has rows. The saturation
    // term is gated on a non-empty page so an offset past the gathered set returns
    // an empty page with `hasMore: false` — the bounded walk is deterministic, so
    // paging further can never surface new rows, and an ungated saturation term
    // would spin an auto-paginating consumer forever on an aged window.
    return {
      entries: stripped,
      total,
      hasMore: (windowSaturated && page.length > 0) || offset + limit < total,
    };
  } catch (e) {
    console.warn('[timeline] getDocumentHistory failed, returning empty result:', e);
    // Record the failure with its real elapsed duration AND error=true so a
    // timeout storm is distinguishable in the metric
    // from a burst of legitimately-empty docs — both otherwise land in
    // width/commits bucket 0. `finishMetric` already times from `queryStart`.
    finishMetric(0, 0, true);
    return EMPTY;
  }
}

/**
 * Folder timeline — attributed activity over a folder's `.ok/`
 * artifacts (templates + frontmatter), written by the attribution path.
 * Unlike `getDocumentHistory`, no rename-chain / checkpoint-filter machinery:
 * `.ok/` artifacts have no doc-style rename history, and the commit-message
 * subjects carry the action (`template-create`, `folder-frontmatter-edit`, …).
 * Walks the per-writer WIP refs (+ checkpoint refs) for `<branch>`, filtered to
 * the folder's `.ok/` subtree, deduped by SHA, newest-first. Reuses the shared
 * git-log format + parser + contributor reader. Never throws — degrades to
 * empty on a missing/corrupt shadow repo.
 */
export async function getFolderTimeline(
  shadow: ShadowHandle,
  folderRel: string,
  contentRoot = '.',
  options?: { branch?: string; limit?: number; offset?: number },
): Promise<HistoryResult> {
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) return EMPTY;
  // Defense in depth: folderRel is interpolated into a git pathspec.
  if (folderRel.includes('..') || folderRel.includes('\0')) return EMPTY;

  const branch = options?.branch ?? 'main';
  const limit = Math.max(1, options?.limit ?? 50);
  const offset = Math.max(0, options?.offset ?? 0);

  const normalizedRoot = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  const base = folderRel.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const okPath = [normalizedRoot, base, '.ok'].filter(Boolean).join('/');

  const sg = shadowGit(shadow);
  try {
    const startRefs: string[] = [];
    for (const refNs of [`refs/wip/${branch}/`, `refs/checkpoints/${branch}/`]) {
      try {
        const refs = (await sg.raw('for-each-ref', '--format=%(refname)', refNs))
          .trim()
          .split('\n')
          .filter(Boolean);
        startRefs.push(...refs);
      } catch {
        // ref namespace absent — fine.
      }
    }
    if (startRefs.length === 0) return EMPTY;

    // Depth-bound the folder walk too: `.ok/`-heavy folders on
    // aged repos would otherwise walk full ancestry like the doc timeline did.
    const walkCap = historyWalkCap(offset, limit);
    // `git log <refs> -- <okPath>` returns every commit touching the folder's
    // `.ok/` subtree across all writer refs, deduped by git. Belt-and-suspenders
    // SHA dedupe below guards against any ref-overlap edge.
    const raw = await sg.raw(
      'log',
      '--full-history',
      '--author-date-order',
      `--format=${GIT_LOG_FORMAT}`,
      '-n',
      String(walkCap),
      ...startRefs,
      '--',
      okPath,
    );
    const parsedFolderEntries = parseGitLogOutput(raw);
    const windowSaturated = parsedFolderEntries.length >= walkCap;
    // Two precise filters — the `git log -- <okPath>` pathspec is only a coarse
    // pre-filter (the shadow repo rebuilds the per-writer tree each commit, so
    // `.ok/` blobs show as "changed" in commits that didn't touch them, and
    // park / unrelated doc writes leak in):
    //   1. SUBJECT must be a typed artifact action the attribution path emits
    //      (`template-*`, `folder-frontmatter-*`, `folder-create`). This is what
    //      makes an entry a real, attributed folder event — legacy CRDT
    //      WIP/park snapshots (raw `wip:`/`park:` subjects) are NOT folder
    //      activity and are dropped, so the card never shows unclassifiable
    //      pre-feature noise.
    //   2. The recorded contributor docs must include an artifact under THIS
    //      folder's `.ok/` — scopes the event to this folder (a typed commit for
    //      another folder won't match), mirroring the doc timeline's
    //      `OkActorEntry.docs[]` signal.
    const okDocPrefix = base ? `${base}/.ok/` : '.ok/';
    const seen = new Set<string>();
    const entries: TimelineEntry[] = [];
    for (const parsed of parsedFolderEntries) {
      if (seen.has(parsed.sha)) continue;
      if (!isFolderArtifactSubject(parsed.message)) continue;
      const touchesFolderArtifact = parsed.contributors.some((c) =>
        c.docs.some((doc) => doc.startsWith(okDocPrefix)),
      );
      if (!touchesFolderArtifact) continue;
      seen.add(parsed.sha);
      const { rawBody: _rawBody, ...entry } = parsed;
      entries.push(entry);
    }
    const total = entries.length;
    const page = entries.slice(offset, offset + limit);
    // Saturation term gated on a non-empty page (see getDocumentHistory): a
    // `.ok/`-heavy folder can saturate the raw walk while the two precise filters
    // drop most rows, so an ungated saturation term would keep `hasMore: true` on
    // every empty page past `total` and spin a load-more consumer forever.
    return {
      entries: page,
      total,
      hasMore: (windowSaturated && page.length > 0) || offset + limit < total,
    };
  } catch (e) {
    console.warn('[timeline] getFolderTimeline failed, returning empty result:', e);
    return EMPTY;
  }
}
