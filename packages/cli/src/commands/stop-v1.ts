import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isProcessAlive, lockBaseUrl, resolveLockDir } from '@inkeep/open-knowledge-server';
import { getInvocationCwd } from '../project-anchor.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { inspectLock, type LockState } from './lock-state.ts';
import { runStop } from './stop.ts';
import {
  type V1Result,
  type V1StopDocument,
  type V1StopTarget,
  type V1StopTargetRecord,
  v1Result,
} from './supervision-json-v1.ts';
import { projectV1LockState } from './supervision-lock-v1.ts';

type StopCode = V1StopTargetRecord['code'];
type Candidate = {
  lockDir: string;
  state: LockState;
  projectRoot: string | null;
  identity: string | null;
};
type ConfirmIdentity = (candidate: Candidate) => Promise<string | null>;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function projectRootForLockDir(lockDir: string): string | null {
  const local = resolve(lockDir);
  const okDir = dirname(local);
  if (basename(local) !== 'local' || basename(okDir) !== '.ok') return null;
  return canonical(dirname(okDir));
}

function stoppable(
  state: LockState,
): state is Extract<LockState, { status: 'alive' | 'foreign-host' }> {
  return (
    state.status === 'alive' || (state.status === 'foreign-host' && isProcessAlive(state.lock.pid))
  );
}

async function confirmIdentity(candidate: Candidate): Promise<string | null> {
  if (!stoppable(candidate.state) || candidate.projectRoot === null) return null;
  const baseUrl = lockBaseUrl(candidate.state.lock);
  if (baseUrl === null) return null;
  try {
    const response = await fetch(`${baseUrl}/api/server-inspection`, {
      signal: AbortSignal.timeout(2_000),
      redirect: 'manual',
    });
    if (response.status !== 200) return null;
    const data: unknown = await response.json();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const inspection = data as Record<string, unknown>;
    if (
      inspection.pid !== candidate.state.lock.pid ||
      typeof inspection.projectRoot !== 'string' ||
      !isAbsolute(inspection.projectRoot) ||
      canonical(inspection.projectRoot) !== candidate.projectRoot ||
      typeof inspection.serverInstanceId !== 'string' ||
      inspection.serverInstanceId.trim().length === 0 ||
      !('runtime' in inspection)
    )
      return null;
    return inspection.serverInstanceId;
  } catch {
    return null;
  }
}

function candidate(lockDir: string, state: LockState): Candidate {
  return {
    lockDir: resolve(lockDir),
    state,
    projectRoot: projectRootForLockDir(lockDir),
    identity: null,
  };
}

function record(item: Candidate, code: StopCode, detail: string | null): V1StopTargetRecord {
  const process = projectV1LockState(item.state).process;
  return {
    lockPath: resolve(item.state.lockPath),
    projectRoot: item.projectRoot,
    serverInstanceId: item.identity,
    pid: process?.pid ?? null,
    port: process?.port ?? null,
    code,
    detail,
  };
}

function document(
  target: V1StopTarget,
  force: boolean,
  targets: V1StopTargetRecord[],
  code: StopCode,
  detail: string | null = null,
): V1StopDocument {
  return {
    schemaVersion: 1,
    command: 'stop',
    result: v1Result('stop', code, detail) as V1Result<'stop'>,
    target,
    force,
    targets,
  };
}

export function stopV1Failure(
  target: V1StopTarget,
  force: boolean,
  code: 'project-unavailable' | 'operation-failed',
  detail: string,
): V1StopDocument {
  return document({ ...target, projectRoot: null }, force, [], code, detail);
}

export interface StopV1Deps {
  target: string | undefined;
  force: boolean;
  projectRoot: string | null;
  discover?: () => Promise<string[]>;
  inspect?: (lockDir: string) => LockState;
  confirm?: ConfirmIdentity;
  stop?: typeof runStop;
}

export async function buildStopV1(deps: StopV1Deps): Promise<V1StopDocument> {
  const kind =
    deps.target === undefined
      ? 'project'
      : deps.target === 'all'
        ? 'all'
        : /^\d+$/.test(deps.target)
          ? 'number'
          : 'path';
  const target: V1StopTarget = { kind, value: deps.target ?? null, projectRoot: null };
  const discover = deps.discover ?? discoverLockDirs;
  const inspect = deps.inspect ?? ((dir: string) => inspectLock(dir, 'server'));
  const stop = deps.stop ?? runStop;
  let candidates: Candidate[];
  if (kind === 'project' || kind === 'path') {
    const root =
      kind === 'project' ? deps.projectRoot : resolve(getInvocationCwd(), deps.target ?? '');
    if (root === null)
      return stopV1Failure(
        target,
        deps.force,
        'project-unavailable',
        'Project root is unavailable.',
      );
    target.projectRoot = canonical(root);
    const dir = resolveLockDir(target.projectRoot);
    candidates = [candidate(dir, inspect(dir))];
  } else {
    const paths = new Map<string, string>();
    for (const dir of await discover()) {
      const normalized = resolve(dir);
      const lockPath = resolve(normalized, 'server.lock');
      if (!paths.has(lockPath)) paths.set(lockPath, normalized);
    }
    candidates = [...paths]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, dir]) => candidate(dir, inspect(dir)));
    if (kind === 'number') {
      const number = Number.parseInt(deps.target ?? '', 10);
      candidates = candidates.filter(
        (item) =>
          stoppable(item.state) &&
          (item.state.lock.pid === number || item.state.lock.port === number),
      );
      const verify = deps.confirm ?? confirmIdentity;
      for (const item of candidates) item.identity = await verify(item);
      const seen = new Set<string>();
      candidates = candidates.filter((item) => {
        if (item.identity === null || !stoppable(item.state) || item.projectRoot === null)
          return true;
        const key = JSON.stringify([item.identity, item.state.lock.pid, item.projectRoot]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (candidates.length > 1) {
        return document(
          target,
          deps.force,
          candidates.map((item) =>
            record(item, 'ambiguous-target', 'Retry with an explicit project directory.'),
          ),
          'ambiguous-target',
          'Multiple servers match this number.',
        );
      }
    }
  }
  if (candidates.length === 0)
    return document(
      target,
      deps.force,
      [],
      kind === 'number' ? 'target-not-found' : 'already-stopped',
    );
  const targets: V1StopTargetRecord[] = [];
  for (const item of candidates) {
    if (kind === 'all' && !stoppable(item.state)) {
      const code =
        item.state.status === 'unverified-owner' || item.state.status === 'read-error'
          ? 'ownership-unverified'
          : 'already-stopped';
      targets.push(record(item, code, null));
      continue;
    }
    const outcome = await stop({
      lockDir: item.lockDir,
      force: deps.force,
      inspect: () => item.state,
      log: () => {},
      error: () => {},
    });
    targets.push(record(item, outcome.decision.code, outcome.decision.detail));
  }
  const codes = targets.map((item) => item.code);
  const code =
    codes.length === 1
      ? (codes[0] ?? 'already-stopped')
      : codes.includes('signalled') &&
          codes.some((item) => item !== 'signalled' && item !== 'already-stopped')
        ? 'partially-signalled'
        : codes.includes('signal-failed')
          ? 'signal-failed'
          : codes.includes('clients-connected')
            ? 'clients-connected'
            : codes.includes('ownership-unverified')
              ? 'ownership-unverified'
              : codes.includes('signalled')
                ? 'signalled'
                : 'already-stopped';
  return document(target, deps.force, targets, code);
}
