import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AutoConsolidationTrigger,
  formatCheckpointBodyLine,
  formatCheckpointSubject,
  formatImportSubject,
  formatOkActor,
  formatParkSubject,
  type OkActorEntry,
  type ParsedCheckpoint,
  parseCheckpoint,
  parseWriterId,
  resolveShadowDir,
  type WriterClassification,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { incrementShadowMigrationLegacyRefsDeleted } from './metrics.ts';
import { acquireLock, releaseLock } from './shadow-lock.ts';
import { withSpan } from './telemetry.ts';

export interface ShadowHandle {
  gitDir: string;
  workTree: string;
}

export interface ShadowRef {
  current: ShadowHandle | undefined;
}

export interface WriterIdentity {
  id: string;
  name: string;
  email: string;
}

const GIT_TIMEOUT_MS = (() => {
  const raw = process.env.OK_GIT_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

export const MAINTENANCE_GIT_TIMEOUT_MS = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_GC_TIMEOUT_MS;
  if (!raw) return 600_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

const SHADOW_GC_AUTO = 512;

export function shadowGit(shadow: ShadowHandle, opts?: { timeoutMs?: number }) {
  return simpleGit({
    baseDir: shadow.workTree,
    timeout: { block: opts?.timeoutMs ?? GIT_TIMEOUT_MS },
  }).env({
    GIT_DIR: shadow.gitDir,
    GIT_WORK_TREE: shadow.workTree,
  });
}

export async function configureShadowGc(shadow: ShadowHandle): Promise<void> {
  const sg = shadowGit(shadow);
  await sg.raw('config', 'gc.auto', String(SHADOW_GC_AUTO));
  await sg.raw('config', 'gc.autoDetach', 'false');
  await sg.raw('config', 'gc.writeCommitGraph', 'true');
  await sg.raw('config', 'commitGraph.changedPaths', 'true');
}

/** One WIP chain on a branch — its writer id, tip, classification, whether the
 *  tip is a park commit (branch-switch state that must never be folded), and the
 *  tip's committer time (for the TTL backstop's age check). */
export interface WipChainInfo {
  writerId: string;
  tipSha: string;
  classification: WriterClassification;
  isPark: boolean;
  committedAtMs: number;
}

export async function enumerateWipChains(
  shadow: ShadowHandle,
  branch: string,
): Promise<WipChainInfo[]> {
  const sg = shadowGit(shadow);
  let lines: string[];
  try {
    lines = (
      await sg.raw(
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)',
        `refs/wip/${branch}/`,
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  const out: WipChainInfo[] = [];
  for (const line of lines) {
    const [refname = '', tipSha = '', committerUnix = '', subject = ''] = line.split('\x00');
    const writerId = refname.split('/').slice(3).join('/');
    if (!writerId) continue;
    const unix = Number.parseInt(committerUnix, 10);
    out.push({
      writerId,
      tipSha,
      classification: parseWriterId(writerId).classification,
      isPark: subject.startsWith('park:'),
      committedAtMs: Number.isFinite(unix) ? unix * 1000 : 0,
    });
  }
  return out;
}

export async function initShadowRepo(projectRoot: string): Promise<ShadowHandle> {
  const shadowDir = resolveShadowDir(projectRoot);

  const legacyDir = resolve(projectRoot, '.git/openknowledge');
  const legacyExists = existsSync(legacyDir);
  const newExists = existsSync(shadowDir);
  if (legacyExists && !newExists) {
    tracedRenameSync(legacyDir, shadowDir);
  } else if (legacyExists && newExists) {
    console.warn('[shadow-repo] unexpected legacy + new shadow both present — no rename performed');
  }

  const alreadyInit = existsSync(resolve(shadowDir, 'HEAD'));
  if (!alreadyInit) {
    tracedMkdirSync(shadowDir, { recursive: true });

    const git = simpleGit({ baseDir: projectRoot, timeout: { block: GIT_TIMEOUT_MS } });
    await git.raw('init', '--bare', shadowDir);

    const sg = simpleGit({ timeout: { block: GIT_TIMEOUT_MS } }).env({ GIT_DIR: shadowDir });
    await sg.raw('config', '--unset', 'core.bare');
    await sg.raw('config', 'core.worktree', projectRoot);
    await sg.raw('config', 'user.name', 'openknowledge');
    await sg.raw('config', 'user.email', 'noreply@openknowledge.local');
  }

  const handle: ShadowHandle = { gitDir: shadowDir, workTree: projectRoot };

  try {
    await configureShadowGc(handle);
  } catch (e) {
    console.warn('[shadow-repo] failed to write gc config (non-fatal):', e);
  }

  await sweepLegacyShadowRefs(handle);

  sweepOrphanedTmpIndexFiles(handle);

  acquireLock(shadowDir, projectRoot);

  return handle;
}

export function destroyShadowRepo(shadow: ShadowHandle): void {
  releaseLock(shadow.gitDir);
}

export async function sweepLegacyShadowRefs(shadow: ShadowHandle): Promise<number> {
  const sg = shadowGit(shadow);
  let allRefs: string[];
  try {
    const raw = await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip');
    allRefs = raw
      .trim()
      .split('\n')
      .filter((r) => r.length > 0);
  } catch {
    return 0;
  }

  const toDelete: string[] = [];
  const breakdown: Record<string, number> = { server: 0, 'human-': 0, upstream: 0 };

  for (const refname of allRefs) {
    const parts = refname.split('/');
    if (parts.length < 4) continue;
    const writerId = parts.slice(3).join('/');

    const classification = parseWriterId(writerId).classification;
    if (classification !== 'unknown') continue;

    if (writerId === 'server') {
      toDelete.push(refname);
      breakdown.server++;
    } else if (writerId.startsWith('human-')) {
      toDelete.push(refname);
      breakdown['human-']++;
    } else if (writerId === 'upstream') {
      toDelete.push(refname);
      breakdown.upstream++;
    }
  }

  if (toDelete.length === 0) return 0;

  for (const ref of toDelete) {
    try {
      await sg.raw('update-ref', '-d', ref);
    } catch (e) {
      console.warn(`[shadow-migration] failed to delete legacy ref ${ref}:`, e);
    }
  }

  const deleted = toDelete.length;
  incrementShadowMigrationLegacyRefsDeleted(deleted);
  console.warn(
    `[shadow-migration] deleted ${deleted} legacy refs: server=${breakdown.server} human-=${breakdown['human-']} upstream=${breakdown.upstream}`,
  );

  return deleted;
}

export interface CommitWipOptions {
  date?: string;
}

export async function commitWip(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  contentRoot: string,
  message: string,
  branch = 'main',
  opts?: CommitWipOptions,
): Promise<string> {
  return withSpan(
    'shadow.commitWip',
    {
      attributes: {
        'shadow.writer': writer.id,
        'shadow.branch': branch,
      },
    },
    async () => commitWipInner(shadow, writer, contentRoot, message, branch, opts?.date),
  );
}

async function commitWipInner(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  contentRoot: string,
  message: string,
  branch = 'main',
  date?: string,
): Promise<string> {
  const tmpIndex = resolve(shadow.gitDir, `index-wip-${writer.id}`);
  const ref = `refs/wip/${branch}/${writer.id}`;
  const sg = shadowGit(shadow);
  const gitPathspec = contentRoot || '.';

  try {
    try {
      const refTree = (await sg.raw('rev-parse', `${ref}^{tree}`)).trim();
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('read-tree', refTree);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unknown revision') || msg.includes('bad revision')) {
      } else {
        console.error(`[shadow-repo] Unexpected error seeding index for ${ref}:`, e);
        throw e;
      }
    }

    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: tmpIndex,
      })
      .raw('add', gitPathspec);
    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    let parentSha: string | null = null;
    try {
      parentSha = (await sg.raw('rev-parse', ref)).trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
        console.error(`[shadow-repo] Unexpected error resolving ${ref}:`, e);
        throw e;
      }
    }

    const args = ['commit-tree', treeSha, '-m', message];
    if (parentSha) args.push('-p', parentSha);

    const commitEnv: Record<string, string> = {
      GIT_DIR: shadow.gitDir,
      GIT_AUTHOR_NAME: writer.name,
      GIT_AUTHOR_EMAIL: writer.email,
      GIT_COMMITTER_NAME: 'openknowledge',
      GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
    };
    if (date) {
      commitEnv.GIT_AUTHOR_DATE = date;
      commitEnv.GIT_COMMITTER_DATE = date;
    }
    const commitSha = (await sg.env(commitEnv).raw(...args)).trim();

    await sg.raw('update-ref', ref, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {}
  }
}

function sweepOrphanedTmpIndexFiles(shadow: ShadowHandle): number {
  let deleted = 0;
  try {
    for (const name of readdirSync(shadow.gitDir)) {
      if (!name.startsWith('index-wip-fanout-')) continue;
      try {
        rmSync(resolve(shadow.gitDir, name));
        deleted++;
      } catch {}
    }
  } catch {}
  return deleted;
}

export async function buildWipTree(shadow: ShadowHandle, contentRoot: string): Promise<string> {
  const tmpIndex = resolve(shadow.gitDir, `index-wip-fanout-${randomUUID()}`);
  const sg = shadowGit(shadow);
  const gitPathspec = contentRoot || '.';

  try {
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: tmpIndex,
      })
      .raw('add', gitPathspec);
    return (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {}
  }
}

export async function commitWipFromTree(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  treeSha: string,
  message: string,
  branch = 'main',
): Promise<string> {
  return withSpan(
    'shadow.commitWipFromTree',
    {
      attributes: {
        'shadow.writer': writer.id,
        'shadow.branch': branch,
        'shadow.tree': treeSha.slice(0, 8),
      },
    },
    async () => commitWipFromTreeInner(shadow, writer, treeSha, message, branch),
  );
}

async function commitWipFromTreeInner(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  treeSha: string,
  message: string,
  branch = 'main',
): Promise<string> {
  const ref = `refs/wip/${branch}/${writer.id}`;
  const sg = shadowGit(shadow);

  let parentSha: string | null = null;
  try {
    parentSha = (await sg.raw('rev-parse', ref)).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
      console.error(`[shadow-repo] Unexpected error resolving ${ref}:`, e);
      throw e;
    }
  }

  const args = ['commit-tree', treeSha, '-m', message];
  if (parentSha) args.push('-p', parentSha);

  const commitSha = (
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_AUTHOR_NAME: writer.name,
        GIT_AUTHOR_EMAIL: writer.email,
        GIT_COMMITTER_NAME: 'openknowledge',
        GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
      })
      .raw(...args)
  ).trim();

  await sg.raw('update-ref', ref, commitSha);
  return commitSha;
}

export const FILE_SYSTEM_WRITER: WriterIdentity = {
  id: 'file-system',
  name: 'File System',
  email: 'file-system@openknowledge.local',
};

export const GIT_UPSTREAM_WRITER: WriterIdentity = {
  id: 'git-upstream',
  name: 'Git (upstream)',
  email: 'git@openknowledge.local',
};

export const SERVICE_WRITER: WriterIdentity = {
  id: 'openknowledge-service',
  name: 'OpenKnowledge (service)',
  email: 'service@openknowledge.local',
};

const UPSTREAM_WRITER: WriterIdentity = GIT_UPSTREAM_WRITER;

export async function commitUpstreamImport(
  shadow: ShadowHandle,
  contentRoot: string,
  oldHead: string | null,
  newHead: string,
  branch = 'main',
): Promise<string> {
  return withSpan(
    'shadow.commitUpstreamImport',
    { attributes: { 'shadow.branch': branch, 'shadow.new_head': newHead.slice(0, 8) } },
    async () => commitUpstreamImportInner(shadow, contentRoot, oldHead, newHead, branch),
  );
}

async function commitUpstreamImportInner(
  shadow: ShadowHandle,
  contentRoot: string,
  oldHead: string | null,
  newHead: string,
  branch = 'main',
): Promise<string> {
  const subject = formatImportSubject(oldHead, newHead);
  const actorEntry: OkActorEntry = {
    v: 1,
    writer_id: UPSTREAM_WRITER.id,
    principal: null,
    agent_session: null,
    agent_type: null,
    client_name: null,
    client_version: null,
    label: null,
    display_name: UPSTREAM_WRITER.name,
    color_seed: UPSTREAM_WRITER.id,
    docs: [],
  };
  const message = `${subject}\n\n${formatOkActor(actorEntry)}`;
  return commitWip(shadow, UPSTREAM_WRITER, contentRoot, message, branch);
}

export interface SafetyCheckpointParams {
  action: string;
  context: Record<string, unknown>;
}

const SAFETY_WRITER: WriterIdentity = SERVICE_WRITER;

export async function safetyCheckpoint(
  shadow: ShadowHandle,
  contentRoot: string,
  params: SafetyCheckpointParams,
  branch = 'main',
): Promise<string> {
  const subject = formatCheckpointSubject(`pre-${params.action}`);
  const actorEntry: OkActorEntry = {
    v: 1,
    writer_id: SAFETY_WRITER.id,
    principal: null,
    agent_session: null,
    agent_type: null,
    client_name: null,
    client_version: null,
    label: null,
    display_name: SAFETY_WRITER.name,
    color_seed: SAFETY_WRITER.id,
    docs: [],
  };
  const message = `${subject}\n\n${formatOkActor(actorEntry)}`;
  return commitWip(shadow, SAFETY_WRITER, contentRoot, message, branch);
}

export type InMemoryCheckpointParams =
  | {
      kind: 'bridge-merge-loss';
      docName: string;
      contents: string;
      label: string;
      branch?: string;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'external-change-rescue';
      docName: string;
      contents: string;
      label: string;
      branch?: string;
      metadata: { incomingDiskSha: string };
    };

export async function saveInMemoryCheckpoint(
  shadow: ShadowHandle,
  contentRoot: string,
  params: InMemoryCheckpointParams,
): Promise<string> {
  const branch = params.branch ?? 'main';
  const sg = shadowGit(shadow);
  const token = randomUUID();
  const tmpIndex = resolve(shadow.gitDir, `index-checkpoint-${token}`);
  const tmpBlobFile = resolve(shadow.gitDir, `tmp-checkpoint-blob-${token}`);

  const treePath = contentRoot
    ? `${contentRoot.replace(/\/$/, '')}/${params.docName}`
    : params.docName;
  const size = Buffer.byteLength(params.contents, 'utf-8');
  const parsed: ParsedCheckpoint =
    params.kind === 'bridge-merge-loss'
      ? {
          kind: 'bridge-merge-loss',
          docName: params.docName,
          size,
          metadata: params.metadata,
        }
      : {
          kind: 'external-change-rescue',
          docName: params.docName,
          size,
          metadata: params.metadata,
        };
  const bodyLine = formatCheckpointBodyLine(parsed);
  const message = `checkpoint: ${params.label}\n\n${bodyLine}`;

  try {
    tracedWriteFileSync(tmpBlobFile, params.contents, 'utf-8');
    const blobSha = (
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('hash-object', '-w', tmpBlobFile)
    ).trim();
    await sg
      .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
      .raw('update-index', '--add', '--cacheinfo', `100644,${blobSha},${treePath}`);
    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    const commitSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'openknowledge',
          GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
        })
        .raw('commit-tree', treeSha, '-m', message)
    ).trim();

    await sg.raw('update-ref', `refs/checkpoints/${branch}/${commitSha}`, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {}
    try {
      rmSync(tmpBlobFile);
    } catch {}
  }
}

export interface TimelineRescueEntry {
  docName: string;
  timestamp: string;
  size: number;
  sha: string;
  label: string;
  incomingDiskSha: string;
}

export async function listRescueCheckpoints(
  shadow: ShadowHandle,
  branch = 'main',
): Promise<TimelineRescueEntry[]> {
  const sg = shadowGit(shadow);
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch {
    return [];
  }
  const shas = refOutput
    .trim()
    .split('\n')
    .filter((s) => s.length === 40);
  if (shas.length === 0) return [];

  let logRaw: string;
  try {
    logRaw = await sg.raw(
      'log',
      '--no-walk',
      '--author-date-order',
      '--format=%H%x00%aI%x00%s%x00%B%x1e',
      ...shas,
    );
  } catch {
    return [];
  }

  const out: TimelineRescueEntry[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', timestamp = '', subject = '', body = ''] = trimmed.split('\x00');
    const parsed = parseCheckpoint(body);
    if (parsed?.kind !== 'external-change-rescue') continue;

    let docName = parsed.docName ?? '';
    let size = parsed.size ?? 0;

    if (!docName) {
      try {
        const tree = (await sg.raw('ls-tree', '-r', '--long', sha)).trim();
        const line = tree.split('\n')[0];
        if (line) {
          const cols = line.split(/\s+/);
          const pathIdx = 4;
          const sizeIdx = 3;
          if (size === 0) size = Number(cols[sizeIdx] ?? '0');
          docName =
            (cols[pathIdx] ?? '')
              .replace(/\.mdx?$/, '')
              .split('/')
              .slice(-1)[0] ?? '';
        }
      } catch {}
    }
    if (!docName) continue;
    out.push({
      docName,
      timestamp,
      size,
      sha,
      label: subject.replace(/^checkpoint:\s*/, ''),
      incomingDiskSha: parsed.metadata.incomingDiskSha,
    });
  }
  return out;
}

export interface CheckpointRetentionPolicy {
  maxBridgeMergeLoss: number;
  maxExternalChangeRescue: number;
  maxAutoConsolidation: number;
  ttlMs: number;
}

export const DEFAULT_CHECKPOINT_RETENTION: CheckpointRetentionPolicy = {
  maxBridgeMergeLoss: 50,
  maxExternalChangeRescue: 50,
  maxAutoConsolidation: 2,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

export interface CheckpointGcResult {
  scanned: number;
  deletedBridgeMergeLoss: number;
  deletedExternalChangeRescue: number;
  deletedAutoConsolidation: number;
  retained: number;
}

export async function gcCheckpointRefs(
  shadow: ShadowHandle,
  branch = 'main',
  policy: CheckpointRetentionPolicy = DEFAULT_CHECKPOINT_RETENTION,
): Promise<CheckpointGcResult> {
  const result: CheckpointGcResult = {
    scanned: 0,
    deletedBridgeMergeLoss: 0,
    deletedExternalChangeRescue: 0,
    deletedAutoConsolidation: 0,
    retained: 0,
  };
  const sg = shadowGit(shadow);
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch {
    return result;
  }
  const refLines = refOutput
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (refLines.length === 0) return result;

  const shaToRef = new Map<string, string>();
  const shas: string[] = [];
  for (const line of refLines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx < 0) continue;
    const sha = line.slice(0, spaceIdx);
    const ref = line.slice(spaceIdx + 1);
    if (sha.length !== 40) continue;
    shaToRef.set(sha, ref);
    shas.push(sha);
  }
  result.scanned = shas.length;
  if (shas.length === 0) return result;

  let logRaw: string;
  try {
    logRaw = await sg.raw(
      'log',
      '--no-walk',
      '--author-date-order',
      '--format=%H%x00%aI%x00%B%x1e',
      ...shas,
    );
  } catch {
    return result;
  }

  type TypedKind = 'bridge-merge-loss' | 'external-change-rescue' | 'auto-consolidation';
  interface Entry {
    sha: string;
    timestamp: number; // ms since epoch
    kind: TypedKind | null;
  }
  const entries: Entry[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', timestamp = '', body = ''] = trimmed.split('\x00');
    if (!sha) continue;
    const parsed = parseCheckpoint(body);
    const kind = parsed?.kind ?? null;
    const ts = Date.parse(timestamp);
    entries.push({ sha, timestamp: Number.isFinite(ts) ? ts : 0, kind });
  }

  const byKind: Record<TypedKind, Entry[]> = {
    'bridge-merge-loss': [],
    'external-change-rescue': [],
    'auto-consolidation': [],
  };
  let retainedUntyped = 0;
  for (const e of entries) {
    if (e.kind === null) {
      retainedUntyped++;
      continue;
    }
    byKind[e.kind].push(e);
  }

  const now = Date.now();
  const deleteRefs: string[] = [];
  const planDeletions = (
    list: Entry[],
    limit: number,
    counter: 'deletedBridgeMergeLoss' | 'deletedExternalChangeRescue' | 'deletedAutoConsolidation',
    applyTtl = true,
  ): void => {
    list.sort((a, b) => b.timestamp - a.timestamp);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry) continue;
      const overCount = i >= limit;
      const overTtl =
        applyTtl && policy.ttlMs > 0 && entry.timestamp > 0 && now - entry.timestamp > policy.ttlMs;
      if (overCount || overTtl) {
        const ref = shaToRef.get(entry.sha);
        if (ref) {
          deleteRefs.push(ref);
          result[counter]++;
        }
      }
    }
  };
  planDeletions(byKind['bridge-merge-loss'], policy.maxBridgeMergeLoss, 'deletedBridgeMergeLoss');
  planDeletions(
    byKind['external-change-rescue'],
    policy.maxExternalChangeRescue,
    'deletedExternalChangeRescue',
  );
  planDeletions(
    byKind['auto-consolidation'],
    policy.maxAutoConsolidation,
    'deletedAutoConsolidation',
    false,
  );

  for (const ref of deleteRefs) {
    try {
      await sg.raw('update-ref', '-d', ref);
    } catch (err) {
      console.warn('[checkpoint-gc] failed to delete', ref, err);
    }
  }

  result.retained = retainedUntyped + (result.scanned - deleteRefs.length - retainedUntyped);
  return result;
}

export interface ParkableDoc {
  docName: string;
  markdown: string;
  diskSnapshot: string;
}

export async function parkBranch(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  documents: ParkableDoc[],
  newBranch?: string,
): Promise<string | null> {
  if (documents.length === 0) return null;
  return withSpan(
    'shadow.parkBranch',
    {
      attributes: {
        'shadow.branch': branch,
        'shadow.new_branch': newBranch ?? '',
        'shadow.doc_count': documents.length,
      },
    },
    async () => parkBranchInner(shadow, branch, writerId, documents, newBranch),
  );
}

async function parkBranchInner(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  documents: ParkableDoc[],
  newBranch?: string,
): Promise<string | null> {
  const sg = shadowGit(shadow);
  const tmpIndex = resolve(shadow.gitDir, `index-park-${branch.replace(/\//g, '-')}`);
  const ref = `refs/wip/${branch}/${writerId}`;

  const tmpBlobFile = resolve(shadow.gitDir, 'tmp-park-blob');
  try {
    for (const doc of documents) {
      tracedWriteFileSync(tmpBlobFile, doc.markdown, 'utf-8');
      const blobSha = (
        await sg
          .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
          .raw('hash-object', '-w', tmpBlobFile)
      ).trim();
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('update-index', '--add', '--cacheinfo', `100644,${blobSha},${doc.docName}`);

      tracedWriteFileSync(tmpBlobFile, doc.diskSnapshot, 'utf-8');
      const baseSha = (
        await sg
          .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
          .raw('hash-object', '-w', tmpBlobFile)
      ).trim();
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('update-index', '--add', '--cacheinfo', `100644,${baseSha},.park-base/${doc.docName}`);
    }

    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    let parentSha: string | null = null;
    try {
      parentSha = (await sg.raw('rev-parse', ref)).trim();
    } catch {}

    const parkActorEntry: OkActorEntry = {
      v: 1,
      writer_id: SERVICE_WRITER.id,
      principal: null,
      agent_session: null,
      agent_type: null,
      client_name: null,
      client_version: null,
      label: null,
      display_name: SERVICE_WRITER.name,
      color_seed: SERVICE_WRITER.id,
      docs: documents.map((d) => d.docName),
    };
    const parkMessage = `${formatParkSubject(branch, newBranch ?? branch)}\n\n${formatOkActor(parkActorEntry)}`;
    const args = ['commit-tree', treeSha, '-m', parkMessage];
    if (parentSha) args.push('-p', parentSha);

    const commitSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'openknowledge',
          GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
        })
        .raw(...args)
    ).trim();

    await sg.raw('update-ref', ref, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {}
    try {
      rmSync(tmpBlobFile);
    } catch {}
  }
}

export async function readParkedState(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  docName: string,
): Promise<{ markdown: string; diskSnapshot: string } | null> {
  const sg = shadowGit(shadow);
  const ref = `refs/wip/${branch}/${writerId}`;

  let refSha: string;
  try {
    refSha = (await sg.raw('rev-parse', ref)).trim();
  } catch {
    return null; // ref doesn't exist — no parked state
  }

  try {
    const msg = (await sg.raw('log', '-1', '--format=%s', refSha)).trim();
    if (!msg.startsWith('park:')) return null;

    const markdown = (await sg.raw('show', `${refSha}:${docName}`)).trim();
    const diskSnapshot = (await sg.raw('show', `${refSha}:.park-base/${docName}`)).trim();
    return { markdown, diskSnapshot };
  } catch (e) {
    console.error(`[shadow] Failed to read parked state for ${docName} from ${ref}:`, e);
    throw e;
  }
}

export interface SaveVersionResult {
  checkpointRef: string;
}

export interface SaveVersionOptions {
  checkpointKind?: { foldedRefs: number; trigger: AutoConsolidationTrigger };
  includeUpstream?: boolean;
  timeoutMs?: number;
  date?: string;
}

export async function saveVersion(
  shadow: ShadowHandle,
  contentRoot: string,
  writers: WriterIdentity[],
  branch = 'main',
  summary?: string,
  options?: SaveVersionOptions,
): Promise<SaveVersionResult> {
  return withSpan(
    'shadow.saveVersion',
    {
      attributes: {
        'shadow.branch': branch,
        'shadow.writer_count': writers.length,
        'shadow.checkpoint_kind': options?.checkpointKind ? 'auto-consolidation' : 'user',
      },
    },
    async () => saveVersionInner(shadow, contentRoot, writers, branch, summary, options),
  );
}

async function saveVersionInner(
  shadow: ShadowHandle,
  contentRoot: string,
  writers: WriterIdentity[],
  branch = 'main',
  summary?: string,
  options?: SaveVersionOptions,
): Promise<SaveVersionResult> {
  const sg = shadowGit(shadow, options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
  const gitPathspec = contentRoot || '.';

  const shadowTmpIndex = resolve(shadow.gitDir, `index-checkpoint-${randomUUID()}`);
  try {
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: shadowTmpIndex,
      })
      .raw('add', gitPathspec);
    const shadowTreeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: shadowTmpIndex }).raw('write-tree')
    ).trim();

    const foldWriters =
      options?.includeUpstream === false ? writers : [...writers, GIT_UPSTREAM_WRITER];
    const shadowParentShas: string[] = [];
    const wipSnapshotShas = new Map<string, string>(); // writerId -> sha at snapshot
    for (const w of foldWriters) {
      try {
        const sha = (await sg.raw('rev-parse', `refs/wip/${branch}/${w.id}`)).trim();
        shadowParentShas.push(sha);
        wipSnapshotShas.set(w.id, sha);
      } catch {}
    }
    const uniqueParents = [...new Set(shadowParentShas)];

    try {
      const priorCheckpoint = (
        await sg.raw(
          'for-each-ref',
          '--sort=-creatordate',
          '--count=1',
          '--format=%(objectname)',
          `refs/checkpoints/${branch}/`,
        )
      ).trim();
      if (priorCheckpoint && !uniqueParents.includes(priorCheckpoint)) {
        uniqueParents.push(priorCheckpoint);
      }
    } catch {}

    const checkpointActorEntry: OkActorEntry = {
      v: 1,
      writer_id: SERVICE_WRITER.id,
      principal: null,
      agent_session: null,
      agent_type: null,
      client_name: null,
      client_version: null,
      label: null,
      display_name: SERVICE_WRITER.name,
      color_seed: SERVICE_WRITER.id,
      docs: [],
    };
    const checkpointSubject = summary?.trim() ? summary.trim() : 'Checkpoint version';
    let checkpointMessage = `${formatCheckpointSubject(checkpointSubject)}\n\n${formatOkActor(checkpointActorEntry)}`;
    if (options?.checkpointKind) {
      checkpointMessage += `\n${formatCheckpointBodyLine({
        kind: 'auto-consolidation',
        docName: null,
        size: null,
        metadata: {
          foldedRefs: options.checkpointKind.foldedRefs,
          trigger: options.checkpointKind.trigger,
        },
      })}`;
    }
    const checkpointArgs = ['commit-tree', shadowTreeSha, '-m', checkpointMessage];
    for (const p of uniqueParents) {
      checkpointArgs.push('-p', p);
    }

    const checkpointEnv: Record<string, string> = {
      GIT_DIR: shadow.gitDir,
      GIT_AUTHOR_NAME: 'openknowledge',
      GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
      GIT_COMMITTER_NAME: 'openknowledge',
      GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
    };
    if (options?.date) {
      checkpointEnv.GIT_AUTHOR_DATE = options.date;
      checkpointEnv.GIT_COMMITTER_DATE = options.date;
    }
    const checkpointSha = (await sg.env(checkpointEnv).raw(...checkpointArgs)).trim();

    const checkpointRef = `refs/checkpoints/${branch}/${checkpointSha}`;
    await sg.raw('update-ref', checkpointRef, checkpointSha);

    await resetFoldedWipRefs(sg, branch, foldWriters, wipSnapshotShas);

    return { checkpointRef };
  } finally {
    try {
      rmSync(shadowTmpIndex);
    } catch {}
  }
}

export async function resetFoldedWipRefs(
  sg: ReturnType<typeof shadowGit>,
  branch: string,
  writers: readonly { id: string }[],
  wipSnapshotShas: ReadonlyMap<string, string>,
): Promise<void> {
  for (const w of writers) {
    const ref = `refs/wip/${branch}/${w.id}`;
    const expected = wipSnapshotShas.get(w.id);
    if (expected === undefined) continue; // had no WIP ref at snapshot — nothing to reset
    try {
      await sg.raw('update-ref', '-d', ref, expected);
    } catch {}
  }
}
