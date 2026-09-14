import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import type { Conflict, ConflictIo, ResolveStrategy } from './conflict-authority.ts';
import { ConflictMarkersInContentError } from './conflict-errors.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { splitNulSeparatedPaths } from './git-paths.ts';
import { isWithinDir } from './path-utils.ts';
import { containsUnresolvedConflictBlock } from './reconciliation.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

export function selectReconcileOurs(
  entry: Extract<Conflict, { kind: 'reconcile' }>,
  liveOurs: string | null,
): string {
  return liveOurs !== null && !containsUnresolvedConflictBlock(liveOurs)
    ? liveOurs
    : entry.stages.ours;
}

export function projectAbsPath(projectDir: string, file: string): string {
  const projectRoot = resolve(projectDir);
  const absPath = resolve(projectRoot, file);
  if (!isWithinDir(absPath, projectRoot)) {
    throw new Error(`[conflicts] file path escapes project directory: ${file}`);
  }
  return assertRealpathWithinDir(absPath, projectRoot, {
    allowShareableOkArtifact: isShareableOkArtifact,
  });
}

function requireContent(content: string | undefined): string {
  if (content === undefined) {
    throw new Error(`[conflicts] strategy 'content' requires content parameter`);
  }
  return content;
}

export async function resolveMergeNative(
  entry: Extract<Conflict, { kind: 'merge-native' }>,
  strategy: ResolveStrategy,
  content: string | undefined,
  io: ConflictIo,
  projectDir: string,
): Promise<void> {
  switch (strategy) {
    case 'mine':
      await io.gitRaw(['checkout', '--ours', ...pathspecArgs([entry.file])]);
      await io.gitRaw(['add', ...pathspecArgs([entry.file])]);
      return;

    case 'theirs':
      await io.gitRaw(['checkout', '--theirs', ...pathspecArgs([entry.file])]);
      await io.gitRaw(['add', ...pathspecArgs([entry.file])]);
      return;

    case 'content': {
      const bytes = requireContent(content);
      io.writeProjectFileUntracked(projectAbsPath(projectDir, entry.file), bytes);
      await io.gitRaw(['add', ...pathspecArgs([entry.file])]);
      return;
    }

    case 'delete':
      await io.gitRaw(['rm', ...pathspecArgs([entry.file])]);
      return;

    default: {
      const exhaustive: never = strategy;
      throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
    }
  }
}

export async function resolveWorkingTree(
  entry: Extract<Conflict, { kind: 'working-tree' }>,
  strategy: ResolveStrategy,
  content: string | undefined,
  io: ConflictIo,
  projectDir: string,
): Promise<void> {
  const requestedPath = resolve(projectDir, entry.file);
  const canonicalPath = projectAbsPath(projectDir, entry.file);
  switch (strategy) {
    case 'mine':
      return;

    case 'theirs': {
      const theirsBytes = await io.gitRaw(['cat-file', 'blob', entry.theirsSha]);
      if (containsUnresolvedConflictBlock(theirsBytes)) {
        throw new ConflictMarkersInContentError({ file: entry.file });
      }
      io.writeProjectFileUntracked(canonicalPath, theirsBytes);
      return;
    }

    case 'content': {
      io.writeProjectFileUntracked(canonicalPath, requireContent(content));
      return;
    }

    case 'delete':
      if (existsSync(requestedPath)) io.unlinkProjectFile(requestedPath);
      return;

    default: {
      const exhaustive: never = strategy;
      throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
    }
  }
}

export async function resolveReconcile(
  strategy: ResolveStrategy,
  resolvedBytes: string | undefined,
  docName: string,
  absPath: string,
  io: ConflictIo,
): Promise<void> {
  switch (strategy) {
    case 'mine':
    case 'theirs':
    case 'content': {
      await io.applyResolvedContent(docName, absPath, requireContent(resolvedBytes));
      return;
    }

    case 'delete':
      if (existsSync(absPath)) io.unlinkProjectFile(absPath);
      return;

    default: {
      const exhaustive: never = strategy;
      throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
    }
  }
}

export type CommitMergeResult =
  | { ok: true }
  | { ok: false; unmerged: string[]; cause: unknown }
  | { ok: false; unmerged: null; probeError: unknown; cause: unknown };

export async function commitMergeIfEmpty(io: ConflictIo): Promise<CommitMergeResult> {
  try {
    await io.gitRaw(['commit', '--no-edit']);
    return { ok: true };
  } catch (cause) {
    try {
      const unmerged = splitNulSeparatedPaths(
        await io.gitRaw(['diff', '-z', '--name-only', '--diff-filter=U']),
      );
      return { ok: false, unmerged, cause };
    } catch (probeError) {
      return { ok: false, unmerged: null, probeError, cause };
    }
  }
}
