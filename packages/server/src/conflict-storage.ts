
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getLocalDir } from './config/paths.ts';
import { getLogger } from './logger.ts';
import { isWithinDir } from './path-utils.ts';

const log = getLogger('conflict-storage');


export interface ConflictEntry {
  file: string;
  detectedAt: string;
  oursSha?: string;
  theirsSha?: string;
  baseSha?: string;
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

  save(): void {
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
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to save conflicts.json');
    }
  }

  addConflict(entry: ConflictEntry): void {
    const existing = this.conflicts.findIndex((c) => c.file === entry.file);
    if (existing !== -1) {
      this.conflicts[existing] = entry; // update if already tracked
    } else {
      this.conflicts.push(entry);
    }
    this.save();
  }

  removeConflict(file: string): void {
    this.conflicts = this.conflicts.filter((c) => c.file !== file);
    this.save();
  }

  clear(): void {
    this.conflicts = [];
    this.save();
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


  async resolveConflict(
    file: string,
    strategy: ResolveStrategy,
    content?: string,
    credentialArgs: string[] = [],
  ): Promise<void> {
    const entry = this.conflicts.find((c) => c.file === file);
    if (!entry) {
      throw new Error(`[conflicts] no conflict tracked for file: ${file}`);
    }

    if (strategy === 'content' && content === undefined) {
      throw new Error(`[conflicts] strategy 'content' requires content parameter`);
    }

    const { createGitInstance } = await import('./git-handle.ts');
    const handle = createGitInstance(this.projectDir, { credentialArgs });

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
        writeFileSync(absPath, content, 'utf-8');
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

    this.removeConflict(file);

    if (!this.hasConflicts()) {
      try {
        await handle.git.raw(['commit', '--no-edit']);
        log.info({ file }, '[conflicts] all conflicts resolved — merge commit created');
      } catch (e) {
        const detectedAt = new Date().toISOString();
        let reAdded = false;
        try {
          const raw = await handle.git.raw(['diff', '--name-only', '--diff-filter=U']);
          const unmerged = raw
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          for (const f of unmerged) {
            this.addConflict({ file: f, detectedAt });
          }
          reAdded = unmerged.length > 0;
        } catch (scanErr) {
          log.warn(
            { err: scanErr },
            '[conflicts] commit failed and re-scan of unmerged files failed — falling back to single-file re-add',
          );
        }
        if (!reAdded) {
          this.addConflict({ file, detectedAt });
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
}
