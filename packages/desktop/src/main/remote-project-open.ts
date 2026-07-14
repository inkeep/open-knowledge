import type { SshMachine } from '@inkeep/open-knowledge-core';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { OkRemoteDispatchRequest } from '../shared/ipc-channels.ts';
import type { RemoteProjectInspection } from './remote-project-service.ts';

const CANCEL_BUTTON = 0;
const INITIALIZE_BUTTON = 1;

interface RemoteProjectOpenDecision {
  readonly path: string;
  readonly initialize: boolean;
}

interface RemoteProjectOpenDeps {
  showInitializationDialog(
    options: MessageBoxOptions,
  ): Promise<Pick<MessageBoxReturnValue, 'response'>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse the complete Navigator remote IPC protocol without dropping unknown fields. */
export function parseRemoteDispatchRequest(value: unknown): OkRemoteDispatchRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  switch (request.kind) {
    case 'list-machines':
      return hasExactKeys(request, ['kind']) ? { kind: 'list-machines' } : null;
    case 'save-machine': {
      if (!hasExactKeys(request, ['kind', 'machine']) || !isRecord(request.machine)) return null;
      const machine = request.machine;
      const allowed = new Set(['id', 'name', 'host', 'port']);
      if (
        !Object.hasOwn(machine, 'name') ||
        !Object.hasOwn(machine, 'host') ||
        Object.keys(machine).some((key) => !allowed.has(key)) ||
        typeof machine.name !== 'string' ||
        typeof machine.host !== 'string' ||
        (Object.hasOwn(machine, 'id') && typeof machine.id !== 'string') ||
        (Object.hasOwn(machine, 'port') && typeof machine.port !== 'number')
      ) {
        return null;
      }
      return {
        kind: 'save-machine',
        machine: {
          ...(Object.hasOwn(machine, 'id') ? { id: machine.id as string } : {}),
          name: machine.name,
          host: machine.host,
          ...(Object.hasOwn(machine, 'port') ? { port: machine.port as number } : {}),
        },
      };
    }
    case 'remove-machine':
    case 'test-machine':
      return hasExactKeys(request, ['kind', 'machineId']) && nonEmptyString(request.machineId)
        ? { kind: request.kind, machineId: request.machineId }
        : null;
    case 'list-directories':
    case 'open-project':
      return hasExactKeys(request, ['kind', 'machineId', 'path']) &&
        nonEmptyString(request.machineId) &&
        nonEmptyString(request.path)
        ? { kind: request.kind, machineId: request.machineId, path: request.path }
        : null;
    default:
      return null;
  }
}

/**
 * Keep remote initialization authority in desktop main. The renderer may ask
 * to open a path, but it cannot inspect the project or authorize writes.
 */
export async function resolveRemoteProjectOpen(
  machine: SshMachine,
  inspection: RemoteProjectInspection,
  deps: RemoteProjectOpenDeps,
): Promise<RemoteProjectOpenDecision | null> {
  if (inspection.initialized) {
    return { path: inspection.projectPath, initialize: false };
  }

  const result = await deps.showInitializationDialog({
    type: 'warning',
    title: 'Initialize remote project?',
    message: `Initialize OpenKnowledge on ${machine.name}?`,
    detail: `Remote path: ${inspection.selectedPath}\n\nOpenKnowledge will create these missing files:\n\u2022 .ok/config.yml\n\u2022 .ok/.gitignore\n\u2022 .okignore\n\nExisting .ok/config.yml and .okignore files are never overwritten. An existing .ok/.gitignore may receive missing runtime ignore entries.`,
    buttons: ['Cancel', 'Initialize and open'],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  });

  if (result.response === CANCEL_BUTTON) return null;
  if (result.response === INITIALIZE_BUTTON) {
    return { path: inspection.selectedPath, initialize: true };
  }
  throw new Error('Remote project initialization dialog returned an invalid response.');
}
