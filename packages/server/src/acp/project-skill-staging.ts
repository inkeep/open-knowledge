import { readdirSync, readFileSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copyDirSync } from '../copy-dir.ts';
import type { PinoLogger } from '../logger.ts';
import { stagedInstall } from './staged-install.ts';

const PROJECT_SKILL_STAGE_PARENT = 'agent-skill';
const PROJECT_SKILL_STAGE_NAME = 'open-knowledge';
export const PROJECT_SKILL_ENTRY = 'SKILL.md';

const MISSING_OR_WRONG_KIND = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

export function projectSkillStageDir(localDir: string): string {
  return join(localDir, PROJECT_SKILL_STAGE_PARENT, PROJECT_SKILL_STAGE_NAME);
}

function fileBytesEqual(src: string, dest: string): boolean {
  let destBytes: Buffer;
  try {
    destBytes = readFileSync(dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_OR_WRONG_KIND.has(code)) return false;
    throw err;
  }
  return readFileSync(src).equals(destBytes);
}

export function stagedBundleMatches(sourceDir: string, stagedDir: string): boolean {
  const sourceEntries = readdirSync(sourceDir);
  let stagedEntries: Set<string>;
  try {
    stagedEntries = new Set(readdirSync(stagedDir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_OR_WRONG_KIND.has(code)) return false;
    throw err;
  }
  if (sourceEntries.length !== stagedEntries.size) return false;
  for (const entry of sourceEntries) {
    if (!stagedEntries.has(entry)) return false;
    const src = join(sourceDir, entry);
    const dest = join(stagedDir, entry);
    if (statSync(src).isDirectory()) {
      let destIsDir: boolean;
      try {
        destIsDir = statSync(dest).isDirectory();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_OR_WRONG_KIND.has(code)) return false;
        throw err;
      }
      if (!destIsDir || !stagedBundleMatches(src, dest)) return false;
    } else if (!fileBytesEqual(src, dest)) {
      return false;
    }
  }
  return true;
}

export class ProjectSkillSymlinkError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`refusing to stage the project skill through a symlink at ${path}`);
    this.name = 'ProjectSkillSymlinkError';
    this.path = path;
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) throw new ProjectSkillSymlinkError(path);
}

export interface StageProjectSkillOptions {
  localDir: string;
  sourceDir: string;
  log: PinoLogger;
  logContext?: Record<string, unknown>;
}

export async function stageProjectSkill(opts: StageProjectSkillOptions): Promise<string> {
  const stageDir = projectSkillStageDir(opts.localDir);
  const parentDir = dirname(stageDir);
  const guardDestination = async (): Promise<void> => {
    await assertNotSymlink(parentDir);
    await assertNotSymlink(stageDir);
  };
  return stagedInstall<string>({
    versionDir: stageDir,
    stagingLabel: PROJECT_SKILL_STAGE_NAME,
    findInstalled: async () => {
      await guardDestination();
      return stagedBundleMatches(opts.sourceDir, stageDir) ? stageDir : null;
    },
    prepare: async (stagingDir) => {
      copyDirSync(opts.sourceDir, stagingDir);
      return stagingDir;
    },
    log: opts.log,
    logPrefix: '[acp-threads]',
    logContext: opts.logContext ?? {},
    installedMessage: 'project skill staged',
    missingAfterCommitMessage: 'project skill missing after the staging commit',
  });
}
