import { resolveLockDir } from '@inkeep/open-knowledge-server';
import { runClean } from './clean-execution.ts';
import {
  type V1CleanDocument,
  type V1Project,
  type V1Result,
  v1Result,
} from './supervision-json-v1.ts';

export function cleanV1Failure(
  code: 'project-unavailable' | 'operation-failed',
  detail: string,
  project: V1Project = { root: null, resolution: 'unavailable' },
): V1CleanDocument {
  return {
    schemaVersion: 1,
    command: 'clean',
    result: v1Result('clean', code, detail) as V1Result<'clean'>,
    project,
    targets: [],
  };
}

export function buildCleanV1(project: V1Project): V1CleanDocument {
  if (project.root === null) throw new Error('Project root is unavailable');
  const outcome = runClean({
    lockDir: resolveLockDir(project.root),
    log: () => {},
    error: () => {},
  });
  const { code, detail, lockPath } = outcome.decision;
  return {
    schemaVersion: 1,
    command: 'clean',
    result: v1Result('clean', code, detail) as V1Result<'clean'>,
    project,
    targets: [{ lockPath, code, detail }],
  };
}
