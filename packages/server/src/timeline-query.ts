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

const HISTORY_WALK_CEILING = 500;
export function historyWalkCap(offset: number, limit: number): number {
  return Math.min(HISTORY_WALK_CEILING, 3 * (Math.max(0, offset) + Math.max(1, limit)));
}

interface HistoryQuery {
  docName: string;
  branch?: string;
  type?: string | string[];
  author?: string | string[];
  excludeAuthor?: string | string[];
  includeAutoCheckpoints?: boolean;
  limit?: number;
  offset?: number;
}

interface HistoryResult {
  entries: TimelineEntry[];
  total: number;
  hasMore: boolean;
}

const GIT_LOG_FORMAT = '%H%x00%aI%x00%an%x00%ae%x00%s%x00%B%x1e';

const EMPTY: HistoryResult = { entries: [], total: 0, hasMore: false };

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

function filterEntriesByOkActorDocs(
  entries: ParsedEntry[],
  chain: Array<{ path: string; renameCommit: string | null }>,
  predecessorAncestors: Array<Set<string> | null>,
): ParsedEntry[] {
  if (entries.length === 0) return entries;
  if (chain.length === 0) return entries;

  return entries.filter((entry) => {
    const actors = parseOkActors(entry.rawBody);
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

  const predecessorAncestors: Array<Set<string> | null> = await Promise.all(
    chain.map(async (step) => {
      if (step.renameCommit === null) return null;
      const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
      if (seeds.length === 0) return new Set<string>();
      return buildAncestorShaSet(shadow, seeds, branch, cache);
    }),
  );

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

export async function getDocumentHistory(
  shadow: ShadowHandle,
  query: HistoryQuery,
  contentRoot = '.',
  options?: { renameLogIndex?: RenameLogIndex },
): Promise<HistoryResult> {
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) {
    return EMPTY;
  }

  if (query.docName && (query.docName.includes('..') || query.docName.includes('\0'))) {
    return EMPTY;
  }

  const branch = query.branch ?? 'main';
  const limit = Math.max(1, query.limit ?? 50);
  const offset = Math.max(0, query.offset ?? 0);

  const walkCap = historyWalkCap(offset, limit);
  const queryStart = performance.now();
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
  const includeAuto = query.includeAutoCheckpoints ?? false;

  const normalizedRoot = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  const pathFor = (name: string): string =>
    normalizedRoot
      ? `${normalizedRoot}/${name}${getDocExtension(name)}`
      : `${name}${getDocExtension(name)}`;

  const managed = query.docName
    ? managedArtifactTimelinePaths(query.docName)
    : ({ managed: false } as const);
  if (managed.managed && !managed.versioned) return EMPTY;
  const managedFilePath = managed.managed && managed.versioned ? managed.filePath : undefined;
  const effectiveDocName = managed.managed && managed.versioned ? managed.docKey : query.docName;

  const docPath = query.docName
    ? managedFilePath
      ? normalizedRoot
        ? `${normalizedRoot}/${managedFilePath}`
        : managedFilePath
      : pathFor(query.docName)
    : undefined;

  try {
    const renameLogIndex = options?.renameLogIndex ?? getOrLoadRenameLogIndex(shadow.gitDir);
    const { chain, skipped } = await withSpan('rename.expandPredecessors', undefined, async () =>
      query.docName
        ? expandPredecessors(effectiveDocName, branch, renameLogIndex)
        : { chain: [], skipped: 0 },
    );
    const hasRenameHistory = chain.length > 1;
    if (query.docName) chainDepthHist().record(chain.length);
    if (skipped > 0) transientSkipCounter().add(skipped);

    const seedsCache = createSeedsCache();
    const ancestorSetCache = createAncestorShaSetCache();

    const sg = shadowGit(shadow);

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
        } catch {}
      }

      const allShas = [...branchCpShas, ...mainCpShas];
      if (allShas.length === 0) return EMPTY;

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
      finishMetric(allShas.length, total);
      return { entries: stripped, total, hasMore: offset + limit < total };
    }

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
    } catch {}

    let mainCheckpointShas: string[] = [];
    if (isFeatureBranch) {
      try {
        mainCheckpointShas = (
          await sg.raw('for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/')
        )
          .trim()
          .split('\n')
          .filter((s) => s.length === 40);
      } catch {}
    }

    try {
      const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', `refs/wip/${branch}/`))
        .trim()
        .split('\n')
        .filter(Boolean);
      startRefs.push(...wipRefs);
    } catch {}

    if (isFeatureBranch && startRefs.length === 0) {
      try {
        const mainWipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/main/'))
          .trim()
          .split('\n')
          .filter(Boolean);
        startRefs.push(...mainWipRefs);
      } catch {}
    }

    if (startRefs.length === 0 && checkpointShas.length === 0 && mainCheckpointShas.length === 0) {
      return EMPTY;
    }

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
        const branchCpShaSet = new Set(checkpointShas);
        const branchCps = allCpEntries.filter((e) => branchCpShaSet.has(e.sha));
        const mainCps = allCpEntries.filter((e) => !branchCpShaSet.has(e.sha));

        const earliestBranchCp = branchCps.reduce((min, e) => {
          const t = new Date(e.timestamp).getTime();
          return t < min ? t : min;
        }, Number.POSITIVE_INFINITY);

        checkpointEntries = [
          ...branchCps,
          ...mainCps.filter((e) => new Date(e.timestamp).getTime() < earliestBranchCp),
        ];
      } else {
        checkpointEntries = allCpEntries;
      }
    }

    const allStartRefs = [...startRefs];
    for (const sha of allCpShas) allStartRefs.push(sha);

    let wipEntries: ParsedEntry[] = [];
    if (allStartRefs.length > 0) {
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

      if (hasRenameHistory) {
        for (let i = 0; i < chain.length - 1; i++) {
          const step = chain[i];
          if (step.renameCommit === null) continue;
          try {
            const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
            if (seeds.length === 0) continue;
            const predecessorPath = pathFor(step.path);
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

    const allEntries = [...checkpointEntries, ...wipEntries];

    const seen = new Set<string>();
    const unique: ParsedEntry[] = [];
    for (const e of allEntries) {
      if (!seen.has(e.sha)) {
        seen.add(e.sha);
        unique.push(e);
      }
    }

    let postFiltered = unique;
    if (unique.length > 0 && chain.length > 0) {
      const filterAncestors: Array<Set<string> | null> = await Promise.all(
        chain.map(async (step) => {
          if (step.renameCommit === null) return null;
          const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
          if (seeds.length === 0) return new Set<string>();
          return buildAncestorShaSet(shadow, seeds, branch, ancestorSetCache);
        }),
      );
      postFiltered = filterEntriesByOkActorDocs(unique, chain, filterAncestors);
    }

    postFiltered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    let filtered: ParsedEntry[] = postFiltered;

    filtered = filtered.filter((e) => e.type !== 'park');

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
    const stripped: TimelineEntry[] = page.map(({ rawBody: _rawBody, ...rest }) => rest);
    finishMetric(allStartRefs.length, unique.length);
    return {
      entries: stripped,
      total,
      hasMore: (windowSaturated && page.length > 0) || offset + limit < total,
    };
  } catch (e) {
    console.warn('[timeline] getDocumentHistory failed, returning empty result:', e);
    finishMetric(0, 0, true);
    return EMPTY;
  }
}

export async function getFolderTimeline(
  shadow: ShadowHandle,
  folderRel: string,
  contentRoot = '.',
  options?: { branch?: string; limit?: number; offset?: number },
): Promise<HistoryResult> {
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) return EMPTY;
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
      } catch {}
    }
    if (startRefs.length === 0) return EMPTY;

    const walkCap = historyWalkCap(offset, limit);
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
