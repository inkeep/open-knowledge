import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  addOkPathsToGitExclude,
  detectInstalledEditors,
  getOkArtifactPaths,
  type ProjectAiIntegrationsResult,
  writeProjectAiIntegrations,
} from '@inkeep/open-knowledge';
import {
  ALL_EDITOR_IDS,
  type EditorId,
  type OkFolderState,
  sanitizeFolderName,
} from '@inkeep/open-knowledge-core';
import {
  applySeed,
  coercePackId,
  type EnsureProjectGitResult,
  ensureProjectGit,
  ensureProjectSkillGitignore,
  findEnclosingProjectRoot,
  initContent,
  planSeed,
  tracedMkdirSync,
  writeRootGitignoreForNewRepo,
} from '@inkeep/open-knowledge-server';
import {
  type DiscoverProjectOptions,
  type DiscoverProjectResult,
  discoverProject as defaultDiscoverProject,
} from './folder-admission.ts';

export function folderState(path: string): OkFolderState {
  try {
    if (!existsSync(path)) return 'free';
    const st = statSync(path);
    if (!st.isDirectory()) {
      return 'exists-nonempty';
    }
    const entries = readdirSync(path);
    return entries.length === 0 ? 'exists-empty' : 'exists-nonempty';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        `[create-new-project] folderState swallowed ${code ?? 'unknown'} at ${path}: ${(err as Error).message}`,
      );
    }
    return 'free';
  }
}

export { sanitizeFolderName };

import type { CreateNewProjectFailureReason } from '@inkeep/open-knowledge-core';

export class CreateNewProjectError extends Error {
  readonly reason: CreateNewProjectFailureReason;
  readonly details?: Record<string, unknown>;
  constructor(
    reason: CreateNewProjectFailureReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'CreateNewProjectError';
    this.reason = reason;
    this.details = details;
  }
}

interface CreateNewProjectSuccess {
  readonly target: string;
  readonly projectDir: string;
  readonly defaultContentDir: string;
  readonly gitRootPromoted: boolean;
  readonly aiIntegrations: ProjectAiIntegrationsResult;
  readonly variant: 'create-new-default' | 'create-new-customized';
  readonly sharingOutcome: CreateNewSharingOutcome;
}

function validateEditors(editors: readonly string[]): EditorId[] {
  const known = new Set<string>(ALL_EDITOR_IDS);
  const out: EditorId[] = [];
  for (const id of editors) {
    if (!known.has(id)) {
      throw new CreateNewProjectError(
        'invalid-args',
        `Unknown editor id: ${JSON.stringify(id)}. Valid options: ${ALL_EDITOR_IDS.join(', ')}`,
      );
    }
    out.push(id as EditorId);
  }
  return out;
}

interface CreateNewProjectArgs {
  readonly parent: string;
  readonly name: string;
  readonly editors: readonly string[];
  readonly sharing?: 'shared' | 'local-only';
  readonly packId?: string;
  readonly rootDir?: string;
}

export interface RunCreateNewDeps {
  readonly discoverProject?: (
    pickedPath: string,
    opts: DiscoverProjectOptions,
  ) => Promise<DiscoverProjectResult>;
  readonly detectInstalledEditors?: () => readonly string[];
}

export type CreateNewSharingOutcome =
  | { kind: 'shared' }
  | { kind: 'local-only-applied'; appended: string[]; alreadyPresent: string[] }
  | {
      kind: 'local-only-refused-tracked';
      tracked: string[];
      remediation: string;
    }
  | {
      kind: 'local-only-no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

function applyCreateNewLocalOnly(projectDir: string): CreateNewSharingOutcome {
  const paths = getOkArtifactPaths(projectDir);
  const result = addOkPathsToGitExclude(projectDir, paths);
  if (result.kind === 'refused-tracked') {
    return {
      kind: 'local-only-refused-tracked',
      tracked: [...result.tracked],
      remediation: result.remediation,
    };
  }
  if (result.kind === 'no-exclude') {
    return { kind: 'local-only-no-exclude', reason: result.reason };
  }
  return {
    kind: 'local-only-applied',
    appended: result.appended,
    alreadyPresent: result.alreadyPresent,
  };
}

export async function runCreateNew(
  args: CreateNewProjectArgs,
  deps: RunCreateNewDeps = {},
): Promise<CreateNewProjectSuccess> {
  const discoverProject = deps.discoverProject ?? defaultDiscoverProject;

  if (typeof args.parent !== 'string' || args.parent.length === 0) {
    throw new CreateNewProjectError('invalid-args', 'parent must be a non-empty string');
  }
  if (typeof args.name !== 'string') {
    throw new CreateNewProjectError('invalid-args', 'name must be a string');
  }
  if (!Array.isArray(args.editors)) {
    throw new CreateNewProjectError('invalid-args', 'editors must be an array');
  }

  const editors = validateEditors(args.editors);
  const sanitized = sanitizeFolderName(args.name);
  if (sanitized.length === 0) {
    throw new CreateNewProjectError('invalid-args', 'name is empty after sanitization');
  }

  const parent = resolve(args.parent);
  const target = resolve(parent, sanitized);

  const enclosing = findEnclosingProjectRoot(parent);
  if (enclosing !== null) {
    throw new CreateNewProjectError(
      'nested-project',
      `Cannot create a project inside an existing project: ${enclosing.rootPath}`,
      { rootPath: enclosing.rootPath, distance: enclosing.distance },
    );
  }

  const state = folderState(target);
  if (state === 'exists-nonempty') {
    throw new CreateNewProjectError('target-not-empty', `Target folder is not empty: ${target}`, {
      target,
    });
  }

  try {
    tracedMkdirSync(target, { recursive: true });
  } catch (err) {
    throw new CreateNewProjectError(
      'mkdir-failed',
      `Failed to create directory ${target}: ${(err as Error).message}`,
      { target, cause: (err as Error).message },
    );
  }

  let discovery: DiscoverProjectResult;
  try {
    discovery = await discoverProject(target, { dirSizeProbe: null });
  } catch (err) {
    throw new CreateNewProjectError(
      'discovery-failed',
      `discoverProject failed at ${target}: ${(err as Error).message}`,
      { target, cause: (err as Error).message },
    );
  }

  if (discovery.kind === 'rejected') {
    throw new CreateNewProjectError(
      'discovery-failed',
      `discoverProject rejected ${target}: ${discovery.reason}`,
      { target, reason: discovery.reason },
    );
  }
  if (discovery.kind === 'managed' || discovery.kind === 'managed-requires-confirmation') {
    throw new CreateNewProjectError(
      'nested-project',
      `Cannot create a project inside an existing project: ${discovery.projectDir}`,
      { rootPath: discovery.projectDir, distance: 0 },
    );
  }

  const projectDir = discovery.projectDir;
  const defaultContentDir = discovery.defaultContentDir;
  const gitRootPromoted = discovery.gitRootPromoted;

  let gitResult: EnsureProjectGitResult;
  try {
    gitResult = await ensureProjectGit(projectDir);
  } catch (err) {
    throw new CreateNewProjectError(
      'git-init-failed',
      `git init failed at ${projectDir}: ${(err as Error).message}`,
      { projectDir, cause: (err as Error).message },
    );
  }

  try {
    initContent(projectDir, {
      contentDir: defaultContentDir !== '.' ? defaultContentDir : undefined,
    });
  } catch (err) {
    throw new CreateNewProjectError(
      'init-failed',
      `initContent failed at ${projectDir}: ${(err as Error).message}`,
      { projectDir, cause: (err as Error).message },
    );
  }

  if (gitResult.didInit) {
    try {
      writeRootGitignoreForNewRepo(projectDir);
    } catch (err) {
      console.warn(
        `[create-new-project] skipping .gitignore seed at ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const aiIntegrations = writeProjectAiIntegrations(projectDir, [...editors]);

  try {
    ensureProjectSkillGitignore(projectDir);
  } catch (err) {
    console.warn(
      `[create-new-project] skipping project-skill .gitignore entry at ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const desiredSharing: 'shared' | 'local-only' =
    args.sharing === 'local-only' ? 'local-only' : 'shared';
  const sharingOutcome: CreateNewSharingOutcome =
    desiredSharing === 'local-only' ? applyCreateNewLocalOnly(projectDir) : { kind: 'shared' };

  const seedPackId = coercePackId(args.packId);
  if (seedPackId !== undefined) {
    const namedRoot = gitRootPromoted ? relative(projectDir, target) : '';
    const chosenRoot = args.rootDir ?? '';
    const seedRootDir =
      namedRoot === ''
        ? args.rootDir
        : chosenRoot === ''
          ? namedRoot
          : `${namedRoot}/${chosenRoot}`;
    try {
      const plan = await planSeed({
        projectDir,
        rootDir: seedRootDir,
        packId: seedPackId,
      });
      const seedResult = await applySeed(plan, { projectDir, packId: seedPackId });
      if (seedResult.errors.length > 0) {
        console.warn(
          `[create-new-project] starter-pack seed partial failure at ${projectDir} (pack ${seedPackId}):`,
          seedResult.errors,
        );
      }
    } catch (err) {
      console.warn(
        `[create-new-project] starter-pack seed failed at ${projectDir} (pack ${seedPackId}):`,
        err,
      );
    }
  }

  const detectEditors = deps.detectInstalledEditors ?? (() => detectInstalledEditors(''));
  let proposed: Set<string> | null = null;
  try {
    proposed = new Set(detectEditors());
  } catch (err) {
    console.warn('[create-new-project] editor detection failed; variant is customized:', err);
  }
  const baseline = proposed;
  const variant: CreateNewProjectSuccess['variant'] =
    baseline !== null && editors.length === baseline.size && editors.every((id) => baseline.has(id))
      ? 'create-new-default'
      : 'create-new-customized';

  return {
    target,
    projectDir,
    defaultContentDir,
    gitRootPromoted,
    aiIntegrations,
    variant,
    sharingOutcome,
  };
}

export function resolveDefaultProjectsRoot(
  persistedParent: string | null,
  documentsDir: string,
  existsCheck: (p: string) => boolean = existsSync,
): string {
  if (persistedParent !== null) {
    try {
      if (existsCheck(persistedParent)) return persistedParent;
    } catch (err) {
      console.warn('[create-new-project] persisted lastUsedProjectParent existsCheck failed:', err);
    }
  }
  return resolve(documentsDir, 'OpenKnowledge');
}
