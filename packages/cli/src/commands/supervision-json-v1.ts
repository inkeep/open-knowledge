export const V1_CODES = {
  status: ['observed', 'project-unavailable', 'operation-failed'],
  ps: ['inventoried', 'discovery-failed', 'operation-failed'],
  stop: [
    'signalled',
    'already-stopped',
    'target-not-found',
    'clients-connected',
    'ownership-unverified',
    'signal-failed',
    'partially-signalled',
    'ambiguous-target',
    'project-unavailable',
    'operation-failed',
  ],
  clean: [
    'stale-removed',
    'nothing-to-clean',
    'live-retained',
    'ownership-unverified',
    'read-failed',
    'remove-failed',
    'partially-cleaned',
    'project-unavailable',
    'operation-failed',
  ],
} as const;

export type V1Command = keyof typeof V1_CODES;
export type V1CodeFor<C extends V1Command> = (typeof V1_CODES)[C][number];
export type V1Code = V1CodeFor<V1Command>;
export type V1ResultKind = 'success' | 'no-op' | 'refused' | 'partial' | 'error';

export const V1_RESULT_KIND_BY_CODE = {
  observed: 'success',
  'project-unavailable': 'error',
  'operation-failed': 'error',
  inventoried: 'success',
  'discovery-failed': 'error',
  signalled: 'success',
  'already-stopped': 'no-op',
  'target-not-found': 'no-op',
  'clients-connected': 'refused',
  'ownership-unverified': 'refused',
  'signal-failed': 'error',
  'partially-signalled': 'partial',
  'ambiguous-target': 'refused',
  'stale-removed': 'success',
  'nothing-to-clean': 'no-op',
  'live-retained': 'no-op',
  'read-failed': 'error',
  'remove-failed': 'error',
  'partially-cleaned': 'partial',
} as const satisfies Record<V1Code, V1ResultKind>;

export type V1Result<C extends V1Command> = {
  [Code in V1CodeFor<C>]: {
    kind: (typeof V1_RESULT_KIND_BY_CODE)[Code];
    code: Code;
    detail: string | null;
  };
}[V1CodeFor<C>];

export function v1Result<C extends V1Command, Code extends V1CodeFor<C>>(
  _command: C,
  code: Code,
  detail: string | null = null,
): { kind: (typeof V1_RESULT_KIND_BY_CODE)[Code]; code: Code; detail: string | null } {
  return { kind: V1_RESULT_KIND_BY_CODE[code], code, detail };
}

export function v1ExitCode(kind: V1ResultKind): 0 | 1 {
  return kind === 'success' || kind === 'no-op' ? 0 : 1;
}

export interface V1Envelope<C extends V1Command> {
  schemaVersion: 1;
  command: C;
  result: V1Result<C>;
}

export interface V1Project {
  root: string | null;
  resolution: 'enclosing-project' | 'cwd' | 'unavailable';
}

export type V1LockState =
  | 'missing'
  | 'corrupt'
  | 'read-error'
  | 'unverified-owner'
  | 'foreign-host'
  | 'dead-pid'
  | 'alive'
  | 'unknown';

export interface V1Process {
  pid: number;
  startedAt: string | null;
  port: number | null;
  hostname: string | null;
  draining: boolean | null;
}

export interface V1LockObservation {
  lock: { path: string | null; state: V1LockState };
  process: V1Process | null;
  alive: boolean | null;
  runtimeVersion: string | null;
  protocolVersion: number | null;
  capabilities: string[] | null;
  launchKind: 'interactive' | 'mcp-spawned' | null;
}

export type V1ReadinessStatus =
  | 'ready'
  | 'pending'
  | 'failed'
  | 'draining'
  | 'unreachable'
  | 'not-running'
  | 'unknown';

export interface V1Readiness {
  status: V1ReadinessStatus;
  checkedAt: string | null;
  degraded: string[];
}

export interface V1Runtime {
  source: 'server';
  revision: number;
  effectiveSince: string;
  port: number;
  bind: string[];
  idleShutdown: string;
  externalUrl: string | null;
}

export interface V1StatusDocument extends V1Envelope<'status'> {
  project: V1Project;
  server: V1LockObservation & {
    identity: { serverInstanceId: string } | null;
    readiness: V1Readiness;
    runtime: V1Runtime | null;
  };
}

export interface V1PsDocument extends V1Envelope<'ps'> {
  servers: Array<V1LockObservation & { projectRoot: string | null }>;
}

export interface V1StopTarget {
  kind: 'project' | 'path' | 'number' | 'all';
  value: string | null;
  projectRoot: string | null;
}

export interface V1StopTargetRecord {
  lockPath: string | null;
  projectRoot: string | null;
  serverInstanceId: string | null;
  pid: number | null;
  port: number | null;
  code: V1CodeFor<'stop'>;
  detail: string | null;
}

export interface V1StopDocument extends V1Envelope<'stop'> {
  target: V1StopTarget;
  force: boolean;
  targets: V1StopTargetRecord[];
}

export interface V1CleanTargetRecord {
  lockPath: string | null;
  code: V1CodeFor<'clean'>;
  detail: string | null;
}

export interface V1CleanDocument extends V1Envelope<'clean'> {
  project: V1Project;
  targets: V1CleanTargetRecord[];
}

export type V1Document = V1StatusDocument | V1PsDocument | V1StopDocument | V1CleanDocument;
