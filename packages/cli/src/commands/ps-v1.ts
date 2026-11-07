import type { LockState } from './lock-state.ts';
import {
  collectPsObservations,
  type PsObservation,
  PsObservationDiscoveryError,
} from './ps-observation.ts';
import { type V1PsDocument, v1Result } from './supervision-json-v1.ts';
import { projectV1LockState } from './supervision-lock-v1.ts';

export class PsV1DiscoveryError extends Error {}

export async function buildPsV1(
  deps: { discover?: () => Promise<string[]>; inspect?: (lockDir: string) => LockState } = {},
): Promise<V1PsDocument> {
  let observations: PsObservation[];
  try {
    observations = await collectPsObservations(deps);
  } catch (error) {
    if (error instanceof PsObservationDiscoveryError) throw new PsV1DiscoveryError(error.message);
    throw error;
  }
  const servers = observations.map(({ projectRoot, state }) => ({
    projectRoot,
    ...projectV1LockState(state),
  }));
  return { schemaVersion: 1, command: 'ps', result: v1Result('ps', 'inventoried'), servers };
}

export function psV1Failure(
  code: 'discovery-failed' | 'operation-failed',
  detail: string,
): V1PsDocument {
  return { schemaVersion: 1, command: 'ps', result: v1Result('ps', code, detail), servers: [] };
}
