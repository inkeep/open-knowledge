import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getLocalDir } from './config/paths.ts';
import { ConflictMarkersInContentError, NoConflictTrackedError } from './conflict-errors.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import { getLogger } from './logger.ts';
import { isWithinDir } from './path-utils.ts';
import { containsUnresolvedConflictBlock } from './reconciliation.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

const log = getLogger('conflict-storage');

export interface ConflictEntry {
  file: string;
  detectedAt: string;
  oursSha?: string;
  theirsSha?: string;
  baseSha?: string;
  variant?: 'working-tree';
}

export type ResolveStrategy = 'mine' | 'theirs' | 'content' | 'delete';

interface ConflictsJson {
  version: 1;
  branch: string;
  conflicts: ConflictEntry[];
}

export class ConflictStore {
  private readonly storePath: string;
  private readonly projectDir: string;
  private branch: string;
  private conflicts: ConflictEntry[] = [];

  constructor(projectDir: string, branch = 'main') {
    this.storePath = join(getLocalDir(projectDir), 'conflicts.json');
    this.projectDir = projectDir;
    this.branch = branch;
    this.load();
  }

  load(): void {
    if (!existsSync(this.storePath)) {
      this.conflicts = [];
      return;
    }
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<ConflictsJson>;
      if (data.version !== 1) {
        log.warn({ path: this.storePath }, '[conflicts] unknown schema version — resetting');
        this.conflicts = [];
        return;
      }
      this.branch = data.branch ?? this.branch;
      this.conflicts = data.conflicts ?? [];
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to load conflicts.json — starting empty');
      this.conflicts = [];
    }
  }

  save(): boolean {
    try {
      const dir = dirname(this.storePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: ConflictsJson = {
        version: 1,
        branch: this.branch,
        conflicts: this.conflicts,
      };
      writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to save conflicts.json');
      return false;
    }
  }

  addConflict(entry: ConflictEntry): boolean {
    if (entry.variant === 'working-tree' && !entry.theirsSha) {
      throw new Error(
        `[conflicts] working-tree conflict for ${entry.file} has no pinned theirs blob`,
      );
    }
    const existing = this.conflicts.findIndex((c) => c.file === entry.file);
    if (existing !== -1) {
      this.conflicts[existing] = entry;
    } else {
      this.conflicts.push(entry);
    }
    return this.save();
  }

  removeConflict(file: string): boolean {
    this.conflicts = this.conflicts.filter((c) => c.file !== file);
    return this.save();
  }

  clear(): void {
    this.conflicts = [];
    if (!this.save()) {
      log.error(
        { branch: this.branch },
        '[conflicts] cleared conflicts in memory but conflicts.json persist failed — the ledger will resurrect them on restart',
      );
    }
  }

  count(): number {
    return this.conflicts.length;
  }

  list(): ConflictEntry[] {
    return [...this.conflicts];
  }

  hasConflicts(): boolean {
    return this.conflicts.length > 0;
  }

  setBranch(branch: string): void {
    this.branch = branch;
  }

  async resolveConflict(file: string, strategy: ResolveStrategy, content?: string): Promise<void> {
    const entry = this.conflicts.find((c) => c.file === file);
    if (!entry) {
      throw new NoConflictTrackedError({ file });
    }

    if (
      strategy === 'content' &&
      content !== undefined &&
      containsUnresolvedConflictBlock(content)
    ) {
      throw new ConflictMarkersInContentError({ file });
    }

    if (strategy === 'content' && content === undefined) {
      throw new Error(`[conflicts] strategy 'content' requires content parameter`);
    }

    if (entry.variant === 'working-tree') {
      await this.resolveWorkingTreeConflict(entry, strategy, content);
      return;
    }

    const { createGitInstance } = await import('./git-handle.ts');
    const handle = createGitInstance(this.projectDir, { credentialConfig: [] });

    switch (strategy) {
      case 'mine':
        await handle.git.raw(['checkout', '--ours', '--', file]);
        await handle.git.raw(['add', '--', file]);
        break;

      case 'theirs':
        await handle.git.raw(['checkout', '--theirs', '--', file]);
        await handle.git.raw(['add', '--', file]);
        break;

      case 'content': {
        if (content === undefined) {
          throw new Error(`[conflicts] strategy 'content' requires content parameter`);
        }
        const projectRoot = resolve(this.projectDir);
        const absPath = resolve(projectRoot, file);
        if (!isWithinDir(absPath, projectRoot)) {
          throw new Error(`[conflicts] file path escapes project directory: ${file}`);
        }
        assertRealpathWithinDir(absPath, projectRoot, {
          allowShareableOkArtifact: isShareableOkArtifact,
        });
        tracedWriteFileSync(absPath, content, 'utf-8');
        await handle.git.raw(['add', '--', file]);
        break;
      }

      case 'delete': {
        await handle.git.raw(['rm', '--', file]);
        break;
      }

      default: {
        const exhaustive: never = strategy;
        throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
      }
    }

    const priorDetectedAt = new Map<string, string>(
      this.list().map((entry) => [entry.file, entry.detectedAt] as const),
    );

    if (!this.removeConflict(file)) {
      log.error(
        { file },
        '[conflicts] resolve dropped the conflict in memory but conflicts.json persist failed — the ledger will resurrect this conflict on restart',
      );
    }

    if (!this.hasConflicts()) {
      try {
        await handle.git.raw(['commit', '--no-edit']);
        log.info({ file }, '[conflicts] all conflicts resolved — merge commit created');
      } catch (e) {
        const fallbackDetectedAt = new Date().toISOString();
        let reAdded = false;
        try {
          const unmerged = await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']);
          for (const f of unmerged) {
            this.addConflict({
              file: f,
              detectedAt: priorDetectedAt.get(f) ?? fallbackDetectedAt,
            });
          }
          reAdded = unmerged.length > 0;
        } catch (scanErr) {
          log.warn(
            { err: scanErr },
            '[conflicts] commit failed and re-scan of unmerged files failed — falling back to single-file re-add',
          );
        }
        if (!reAdded) {
          this.addConflict({ file, detectedAt: priorDetectedAt.get(file) ?? fallbackDetectedAt });
        }
        log.warn(
          { err: e },
          '[conflicts] failed to commit merge after all conflicts resolved — unmerged files re-added',
        );
        const causeText = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Merge commit failed after resolving ${file}; ${reAdded ? 'unmerged files re-added' : 'original file re-added'} — ${causeText}`,
          { cause: e },
        );
      }
    }
  }

  private async resolveWorkingTreeConflict(
    entry: ConflictEntry,
    strategy: ResolveStrategy,
    content: string | undefined,
  ): Promise<void> {
    const projectRoot = resolve(this.projectDir);
    const absPath = resolve(projectRoot, entry.file);
    if (!isWithinDir(absPath, projectRoot)) {
      throw new Error(`[conflicts] file path escapes project directory: ${entry.file}`);
    }
    assertRealpathWithinDir(absPath, projectRoot, {
      allowShareableOkArtifact: isShareableOkArtifact,
    });

    const restoreOnFailure = { ...entry };
    if (!this.removeConflict(entry.file)) {
      log.error(
        { file: entry.file },
        '[conflicts] resolve dropped the conflict in memory but conflicts.json persist failed — the ledger will resurrect this conflict on restart',
      );
    }

    try {
      await this.applyWorkingTreeStrategy(absPath, projectRoot, entry, strategy, content);
    } catch (err) {
      if (!this.addConflict(restoreOnFailure)) {
        log.error(
          { file: entry.file, err },
          '[conflicts] resolve rolled back in memory but conflicts.json persist failed — the ledger will lose this conflict on restart',
        );
      }
      throw err;
    }
  }

  private async applyWorkingTreeStrategy(
    absPath: string,
    projectRoot: string,
    entry: ConflictEntry,
    strategy: ResolveStrategy,
    content: string | undefined,
  ): Promise<void> {
    switch (strategy) {
      case 'mine':
        break;

      case 'theirs': {
        if (!entry.theirsSha) {
          throw new Error(
            `[conflicts] working-tree conflict for ${entry.file} has no pinned theirs blob`,
          );
        }
        const { createGitInstance } = await import('./git-handle.ts');
        const handle = createGitInstance(this.projectDir, { credentialConfig: [] });
        const theirsBytes = await handle.git.raw(['cat-file', 'blob', entry.theirsSha]);
        assertRealpathWithinDir(absPath, projectRoot, {
          allowShareableOkArtifact: isShareableOkArtifact,
        });
        tracedWriteFileSync(absPath, theirsBytes, 'utf-8');
        break;
      }

      case 'content': {
        if (content === undefined) {
          throw new Error(`[conflicts] strategy 'content' requires content parameter`);
        }
        tracedWriteFileSync(absPath, content, 'utf-8');
        break;
      }

      case 'delete':
        if (existsSync(absPath)) tracedUnlinkSync(absPath);
        break;

      default: {
        const exhaustive: never = strategy;
        throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
      }
    }
  }
}
