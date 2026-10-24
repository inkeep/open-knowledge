import { resolveLockDir } from '@inkeep/open-knowledge-server';
import { buildCleanV1, cleanV1Failure } from './clean-v1.ts';
import { buildPsV1, PsV1DiscoveryError, psV1Failure } from './ps-v1.ts';
import { buildStatusV1, statusV1Failure } from './status-v1.ts';
import { buildStopV1, stopV1Failure } from './stop-v1.ts';
import type {
  SupervisionFormatStrategy,
  SupervisionRequest,
  SupervisionResult,
} from './supervision-format-registry.ts';
import { type V1Document, type V1StopTarget, v1ExitCode } from './supervision-json-v1.ts';
import { requiresProjectConfigForV1 } from './supervision-scope.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopSelector(target: string | undefined): V1StopTarget {
  const kind: V1StopTarget['kind'] =
    target === undefined
      ? 'project'
      : target === 'all'
        ? 'all'
        : /^\d+$/.test(target)
          ? 'number'
          : 'path';
  return { kind, value: target ?? null, projectRoot: null };
}

async function documentFor(request: SupervisionRequest): Promise<V1Document> {
  const { context } = request;
  switch (request.command) {
    case 'status':
      if (context.failure !== null) {
        return statusV1Failure('project-unavailable', context.failure);
      }
      try {
        const root = context.project.root;
        if (root === null) throw new Error('Project root is unavailable');
        return await buildStatusV1({ project: context.project, lockDir: resolveLockDir(root) });
      } catch (error) {
        return statusV1Failure('operation-failed', errorMessage(error));
      }
    case 'ps':
      if (context.failure !== null) return psV1Failure('operation-failed', context.failure);
      try {
        return await buildPsV1();
      } catch (error) {
        return psV1Failure(
          error instanceof PsV1DiscoveryError ? 'discovery-failed' : 'operation-failed',
          errorMessage(error),
        );
      }
    case 'stop': {
      const selector = stopSelector(request.target);
      if (context.failure !== null) {
        return stopV1Failure(selector, request.force, 'project-unavailable', context.failure);
      }
      try {
        return await buildStopV1({
          target: request.target,
          force: request.force,
          projectRoot: context.project.root,
        });
      } catch (error) {
        return stopV1Failure(selector, request.force, 'operation-failed', errorMessage(error));
      }
    }
    case 'clean':
      if (context.failure !== null) {
        return cleanV1Failure('project-unavailable', context.failure);
      }
      try {
        return buildCleanV1(context.project);
      } catch (error) {
        return cleanV1Failure('operation-failed', errorMessage(error), context.project);
      }
  }
}

export const jsonV1Strategy: SupervisionFormatStrategy = {
  format: 'json-v1',
  requiresProjectConfig: requiresProjectConfigForV1,
  async execute(request): Promise<SupervisionResult> {
    const document = await documentFor(request);
    return { document, exitCode: v1ExitCode(document.result.kind) };
  },
};
