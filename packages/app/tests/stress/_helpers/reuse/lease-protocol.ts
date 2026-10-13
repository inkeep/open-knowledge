export const REUSE_SOCKET_ENV = 'OK_TEST_E2E_REUSE_SOCKET';
export const REUSE_RUN_ENV = 'OK_TEST_E2E_REUSE_RUN';

export const SERVER_MODES = ['dev'] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

export type WorkerServerEnv = Readonly<Record<string, string>>;

export interface SlotCompatibility {
  readonly config: string;
  readonly workerServerEnv: WorkerServerEnv;
  readonly serverMode: ServerMode;
}

export interface LeaseRequest extends SlotCompatibility {
  readonly worktree: string;
  readonly run: string;
  readonly slot: number;
}

export const REFUSAL_REASONS = [
  'supervisor-closed',
  'run-aborted',
  'busy',
  'incompatible',
  'launch-failed',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type LeaseOutcome =
  | {
      readonly kind: 'granted';
      readonly token: string;
      readonly slot: number;
      readonly baseURL: string;
      readonly port: number;
      readonly contentDir: string;
      readonly launched: boolean;
      readonly relaunchedBecause: string | null;
    }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly detail: string };

export type LeaseVerdict =
  | { readonly held: true }
  | { readonly held: false; readonly reason: string };

export interface SlotStatus {
  readonly slot: number;
  readonly baseURL: string | null;
  readonly config: string | null;
  readonly leasedBy: string | null;
}

export type ClientMessage =
  | { readonly id: number; readonly op: 'acquire'; readonly request: LeaseRequest }
  | { readonly id: number; readonly op: 'verify'; readonly token: string }
  | {
      readonly id: number;
      readonly op: 'release';
      readonly token: string;
      readonly discard: boolean;
    }
  | { readonly id: number; readonly op: 'status' }
  | { readonly id: number; readonly op: 'shutdown' };

export type ServerMessage =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not a JSON object`);
  }
  return value as Fields;
}

function stringField(fields: Fields, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${what}.${key} is not a non-empty string`);
  }
  return value;
}

function integerField(fields: Fields, key: string, what: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${what}.${key} is not a non-negative integer`);
  }
  return value;
}

function workerServerEnvField(fields: Fields, what: string): WorkerServerEnv {
  const env = fieldsOf(fields.workerServerEnv, `${what}.workerServerEnv`);
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new TypeError(`${what}.workerServerEnv.${key} is not a string`);
    }
  }
  return env as WorkerServerEnv;
}

function isServerMode(value: unknown): value is ServerMode {
  return (SERVER_MODES as readonly unknown[]).includes(value);
}

export function parseLeaseRequest(value: unknown): LeaseRequest {
  const what = 'lease request';
  const fields = fieldsOf(value, what);
  if (!isServerMode(fields.serverMode)) {
    throw new TypeError(`${what}.serverMode is not one of ${SERVER_MODES.join(', ')}`);
  }
  return {
    worktree: stringField(fields, 'worktree', what),
    config: stringField(fields, 'config', what),
    run: stringField(fields, 'run', what),
    slot: integerField(fields, 'slot', what),
    workerServerEnv: workerServerEnvField(fields, what),
    serverMode: fields.serverMode,
  };
}

export function parseClientMessage(line: string): ClientMessage {
  const fields = fieldsOf(JSON.parse(line), 'supervisor request');
  const id = integerField(fields, 'id', 'supervisor request');
  switch (fields.op) {
    case 'acquire':
      return { id, op: 'acquire', request: parseLeaseRequest(fields.request) };
    case 'verify':
      return { id, op: 'verify', token: stringField(fields, 'token', 'verify request') };
    case 'release':
      if (typeof fields.discard !== 'boolean') {
        throw new TypeError('release request.discard is not a boolean');
      }
      return {
        id,
        op: 'release',
        token: stringField(fields, 'token', 'release request'),
        discard: fields.discard,
      };
    case 'status':
      return { id, op: 'status' };
    case 'shutdown':
      return { id, op: 'shutdown' };
    default:
      throw new TypeError(`supervisor request.op ${JSON.stringify(fields.op)} is not supported`);
  }
}

export function parseServerMessage(line: string): ServerMessage {
  const fields = fieldsOf(JSON.parse(line), 'supervisor response');
  const id = integerField(fields, 'id', 'supervisor response');
  if (fields.ok === true) return { id, ok: true, result: fields.result };
  if (fields.ok === false) {
    return { id, ok: false, error: stringField(fields, 'error', 'supervisor response') };
  }
  throw new TypeError('supervisor response.ok is not a boolean');
}

function isRefusalReason(value: unknown): value is RefusalReason {
  return (REFUSAL_REASONS as readonly unknown[]).includes(value);
}

export function parseLeaseOutcome(value: unknown): LeaseOutcome {
  const what = 'lease outcome';
  const fields = fieldsOf(value, what);
  if (fields.kind === 'refused') {
    if (!isRefusalReason(fields.reason)) {
      throw new TypeError(`${what}.reason ${JSON.stringify(fields.reason)} is not supported`);
    }
    return { kind: 'refused', reason: fields.reason, detail: stringField(fields, 'detail', what) };
  }
  if (fields.kind !== 'granted') throw new TypeError(`${what}.kind is not granted or refused`);
  if (typeof fields.launched !== 'boolean') {
    throw new TypeError(`${what}.launched is not a boolean`);
  }
  const relaunchedBecause = fields.relaunchedBecause;
  if (relaunchedBecause !== null && typeof relaunchedBecause !== 'string') {
    throw new TypeError(`${what}.relaunchedBecause is not a string or null`);
  }
  return {
    kind: 'granted',
    token: stringField(fields, 'token', what),
    slot: integerField(fields, 'slot', what),
    baseURL: stringField(fields, 'baseURL', what),
    port: integerField(fields, 'port', what),
    contentDir: stringField(fields, 'contentDir', what),
    launched: fields.launched,
    relaunchedBecause,
  };
}

export function parseLeaseVerdict(value: unknown): LeaseVerdict {
  const fields = fieldsOf(value, 'lease verdict');
  if (fields.held === true) return { held: true };
  if (fields.held === false) {
    return { held: false, reason: stringField(fields, 'reason', 'lease verdict') };
  }
  throw new TypeError('lease verdict.held is not a boolean');
}

function changedEnvKeys(recorded: WorkerServerEnv, requested: WorkerServerEnv): string[] {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(requested)]);
  return [...keys].filter((key) => recorded[key] !== requested[key]).sort();
}

export function workerServerEnvChange(
  recorded: SlotCompatibility,
  requested: SlotCompatibility,
): string | undefined {
  const changedEnv = changedEnvKeys(recorded.workerServerEnv, requested.workerServerEnv);
  return changedEnv.length === 0
    ? undefined
    : `its workerServerEnv differs in ${changedEnv.join(', ')}`;
}

export function compatibilityMismatch(
  recorded: SlotCompatibility,
  requested: SlotCompatibility,
): string | undefined {
  const differences: string[] = [];
  if (recorded.config !== requested.config) {
    differences.push(`invocation config ${requested.config} is not ${recorded.config}`);
  }
  if (recorded.serverMode !== requested.serverMode) {
    differences.push(`server mode ${requested.serverMode} is not ${recorded.serverMode}`);
  }
  return differences.length === 0 ? undefined : differences.join('; ');
}
