import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { initContent } from '@inkeep/open-knowledge-server';

import { PACKAGE_VERSION } from './constants.ts';

export type RemoteCompanionErrorCode =
  | 'project-uninitialized'
  | 'project-initialize-failed'
  | 'config-invalid'
  | 'content-dir-outside-project'
  | 'startup-failed';

export class RemoteCompanionError extends Error {
  constructor(
    readonly code: RemoteCompanionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RemoteCompanionError';
  }
}

export interface RemoteProjectInspection {
  readonly v: 1;
  readonly selectedPath: string;
  readonly projectPath: string;
  readonly initialized: boolean;
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function isRemoteProjectRoot(path: string): boolean {
  const okDirectory = resolve(path, '.ok');
  try {
    const stat = lstatSync(okDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RemoteCompanionError('config-invalid', 'Project configuration is invalid.');
    }
  } catch (cause) {
    if (cause instanceof RemoteCompanionError) throw cause;
    if (isNotFound(cause)) return false;
    throw new RemoteCompanionError('config-invalid', 'Project configuration cannot be read.', {
      cause,
    });
  }

  try {
    const stat = lstatSync(resolve(okDirectory, 'config.yml'));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RemoteCompanionError('config-invalid', 'Project configuration is invalid.');
    }
    return true;
  } catch (cause) {
    if (cause instanceof RemoteCompanionError) throw cause;
    if (isNotFound(cause)) return false;
    throw new RemoteCompanionError('config-invalid', 'Project configuration cannot be read.', {
      cause,
    });
  }
}

function findRemoteProjectRoot(selectedPath: string, homePath: string): string | null {
  let current = selectedPath;
  while (true) {
    const atHome = current === homePath;
    if (isRemoteProjectRoot(current)) return realpathSync.native(current);
    // ~/.ok also owns per-user support such as remote companions. A missing
    // project config there is not a marker, and lookup must never escape into
    // another home-level namespace.
    if (atHome) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve the selected folder and its nearest existing OpenKnowledge project. */
export function inspectRemoteProject(
  cwd: string,
  homeDirectory: string = homedir(),
): RemoteProjectInspection {
  const selectedPath = realpathSync.native(cwd);
  const projectPath = findRemoteProjectRoot(selectedPath, realpathSync.native(homeDirectory));
  if (projectPath === null) {
    return { v: 1, selectedPath, projectPath: selectedPath, initialized: false };
  }
  return {
    v: 1,
    selectedPath,
    projectPath,
    initialized: true,
  };
}

/**
 * Resolve an existing project, or initialize exactly the selected folder when
 * the caller has explicitly confirmed that write.
 */
export function prepareRemoteProject(cwd: string, expectedSelectedPath?: string): string {
  const inspection = inspectRemoteProject(cwd);
  const initialize = expectedSelectedPath !== undefined;
  if (initialize && inspection.selectedPath !== expectedSelectedPath) {
    throw new RemoteCompanionError(
      'project-initialize-failed',
      'The selected folder changed after confirmation.',
    );
  }
  if (inspection.initialized) return inspection.projectPath;
  if (!initialize) {
    throw new RemoteCompanionError(
      'project-uninitialized',
      'The selected folder is not an OpenKnowledge project.',
    );
  }

  try {
    initContent(inspection.selectedPath, { packageVersion: PACKAGE_VERSION });
  } catch (cause) {
    throw new RemoteCompanionError(
      'project-initialize-failed',
      'The selected folder could not be initialized.',
      { cause },
    );
  }
  if (!isRemoteProjectRoot(inspection.selectedPath)) {
    throw new RemoteCompanionError(
      'project-initialize-failed',
      'Initialization did not create a valid OpenKnowledge project.',
    );
  }
  return inspection.selectedPath;
}

/**
 * Prove that the configured content root stays inside the project before the
 * normal boot path starts filesystem watchers. Remote projects require an
 * existing directory so no recursive mkdir can follow an ancestor swapped to
 * a symlink between validation and boot.
 */
export function validateRemoteContentDirectory(
  projectRoot: string,
  configuredContentDir: string,
): string {
  const canonicalProjectRoot = realpathSync.native(projectRoot);
  const resolvedContentDir = resolve(canonicalProjectRoot, configuredContentDir);
  if (!isWithin(canonicalProjectRoot, resolvedContentDir)) {
    throw new RemoteCompanionError(
      'content-dir-outside-project',
      'The configured content directory is outside the project.',
    );
  }

  let canonicalContentDir: string;
  try {
    canonicalContentDir = realpathSync.native(resolvedContentDir);
    if (!lstatSync(canonicalContentDir).isDirectory()) {
      throw new Error('Content path is not a directory.');
    }
  } catch (cause) {
    throw new RemoteCompanionError(
      'content-dir-outside-project',
      'The configured content directory must be an existing directory.',
      { cause },
    );
  }
  if (!isWithin(canonicalProjectRoot, canonicalContentDir)) {
    throw new RemoteCompanionError(
      'content-dir-outside-project',
      'The configured content directory resolves outside the project.',
    );
  }
  return canonicalContentDir;
}
