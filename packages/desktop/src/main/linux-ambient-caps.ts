import { errorCodeOf } from './linux-shm-posture.ts';

export const AMBIENT_CAPS_CLEARED_ENV = 'OK_AMBIENT_CAPS_CLEARED';
const SETPRIV_PATHS = ['/usr/bin/setpriv', '/bin/setpriv'] as const;

type AmbientCapsDecision =
  | 'not-linux'
  | 'root'
  | 'none'
  | 'status-unreadable'
  | 'reexec'
  | 'setpriv-missing'
  | 'setpriv-not-executable'
  | 'reexec-failed'
  | 'cleared'
  | 'still-present';

const AMBIENT_CAPS_LOG_LEVELS = {
  'not-linux': null,
  root: null,
  none: null,
  reexec: null,
  'status-unreadable': 'warn',
  'setpriv-missing': 'warn',
  'setpriv-not-executable': 'warn',
  'reexec-failed': 'warn',
  cleared: 'info',
  'still-present': 'warn',
} satisfies Record<AmbientCapsDecision, 'info' | 'warn' | null>;

export interface AmbientCapsDeps {
  platform: NodeJS.Platform;
  uid: number;
  env: NodeJS.ProcessEnv;
  readProcStatus: () => string;
  exists: (path: string) => boolean;
  isExecutable: (path: string) => boolean;
  execPath: string;
  argv: readonly string[];
}

interface AmbientCapsExec {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AmbientCapsPosture {
  decision: AmbientCapsDecision;
  event: 'desktop.linux-ambient-caps-posture';
  ambientCaps: string | null;
  clearedFrom: string | null;
  errorCode: string | null;
  exec: AmbientCapsExec | null;
}

export type AmbientCapsFacts = Omit<AmbientCapsPosture, 'exec'>;

export function parseAmbientCaps(procStatus: string): bigint | null {
  const match = /^CapAmb:\s*([0-9a-f]+)$/m.exec(procStatus);
  return match ? BigInt(`0x${match[1]}`) : null;
}

export function planAmbientCapsReexec(deps: AmbientCapsDeps): AmbientCapsPosture {
  const posture: AmbientCapsPosture = {
    decision: 'not-linux',
    event: 'desktop.linux-ambient-caps-posture',
    ambientCaps: null,
    clearedFrom: deps.env[AMBIENT_CAPS_CLEARED_ENV] ?? null,
    errorCode: null,
    exec: null,
  };
  if (deps.platform !== 'linux') return posture;
  if (deps.uid === 0) {
    posture.decision = 'root';
    return posture;
  }

  let ambient: bigint | null;
  try {
    ambient = parseAmbientCaps(deps.readProcStatus());
  } catch (error) {
    posture.decision = 'status-unreadable';
    posture.errorCode = errorCodeOf(error);
    return posture;
  }
  if (ambient === null) {
    posture.decision = 'status-unreadable';
    return posture;
  }
  posture.ambientCaps = ambient.toString(16);

  if (posture.clearedFrom !== null) {
    posture.decision = ambient === 0n ? 'cleared' : 'still-present';
    return posture;
  }
  if (ambient === 0n) {
    posture.decision = 'none';
    return posture;
  }

  const setpriv = SETPRIV_PATHS.find((path) => deps.isExecutable(path));
  if (setpriv === undefined) {
    posture.decision = SETPRIV_PATHS.some((path) => deps.exists(path))
      ? 'setpriv-not-executable'
      : 'setpriv-missing';
    return posture;
  }
  posture.decision = 'reexec';
  posture.exec = {
    file: setpriv,
    args: [setpriv, '--inh-caps=-all', '--ambient-caps=-all', deps.execPath, ...deps.argv.slice(1)],
    env: { ...deps.env, [AMBIENT_CAPS_CLEARED_ENV]: posture.ambientCaps },
  };
  return posture;
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => void;

let bootFacts: AmbientCapsFacts | null = null;

export function clearAmbientCapsBeforeBoot(
  deps: AmbientCapsDeps & { execve: Execve | undefined },
): AmbientCapsPosture {
  const posture = planAmbientCapsReexec(deps);
  delete deps.env[AMBIENT_CAPS_CLEARED_ENV];
  attemptReexec(posture, deps.execve);
  bootFacts = factsOf(posture);
  return posture;
}

function attemptReexec(posture: AmbientCapsPosture, execve: Execve | undefined): void {
  if (posture.exec === null) return;
  if (execve === undefined) {
    posture.decision = 'reexec-failed';
    posture.errorCode = 'EXECVE_UNAVAILABLE';
    return;
  }
  try {
    execve(posture.exec.file, posture.exec.args, posture.exec.env);
  } catch (error) {
    posture.decision = 'reexec-failed';
    posture.errorCode = errorCodeOf(error);
  }
}

export function getBootAmbientCapsFacts(): AmbientCapsFacts | null {
  return bootFacts;
}

function factsOf(posture: AmbientCapsPosture): AmbientCapsFacts {
  const { exec: _exec, ...facts } = posture;
  return facts;
}

export function logAmbientCapsPosture(
  facts: AmbientCapsFacts,
  log: (level: 'info' | 'warn', facts: AmbientCapsFacts) => void,
): void {
  const level = AMBIENT_CAPS_LOG_LEVELS[facts.decision];
  if (level === null) return;
  log(level, facts);
}
