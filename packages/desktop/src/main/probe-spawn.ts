import { spawn } from 'node:child_process';
import {
  composeOkChildEnv,
  hasNoResolvableOkHome,
  hasOkManagedBinDirsOnPath,
  type OkManagedBinDirsOptions,
  okChildEnvOptionsFromProcess,
  okChildPathEntries,
  okManagedBinDirs,
} from '../shared/ok-child-env.ts';
import {
  commandWithManagedPath,
  type ShellCommandFamily,
  shellCommandFamily,
} from '../shared/terminal-shell.ts';
import type { ProbeChild, ProbeTimers } from './claude-readiness.ts';
import { getLogger } from './desktop-logger.ts';

export type ProbeReassert = 'applied' | 'skipped-shape' | 'skipped-win32';

export interface ProbeSpawnArgv {
  readonly args: readonly string[];
  readonly reassert: ProbeReassert;
  readonly family: ShellCommandFamily | undefined;
}

export type ProbeEnvVerdict =
  | 'not-applicable'
  | 'not-applicable-no-home'
  | 'inherited'
  | 'injected';

const VERDICT_MESSAGES: Record<ProbeEnvVerdict, string> = {
  'not-applicable': 'no OK-managed bin dir applies to CLI-presence probe children',
  'not-applicable-no-home':
    'home directory unresolvable, so CLI-presence probe children get no OK-managed bin dir',
  inherited: 'CLI-presence probe children inherit the OK-managed bin dir from the app PATH',
  injected: 'CLI-presence probe children get the OK-managed bin dir added to the app PATH',
};

const VERDICT_LOG_LEVELS: Record<ProbeEnvVerdict, 'warn' | 'info'> = {
  'not-applicable': 'info',
  'not-applicable-no-home': 'warn',
  inherited: 'info',
  injected: 'info',
};

const REASSERT_WARNINGS: Record<ProbeReassert, string | null> = {
  applied: null,
  'skipped-shape':
    'POSIX probe argv does not end in -c <command>, so the OK-managed bin dir was not reasserted after shell startup files ran',
  'skipped-win32': null,
};

export function probeEnvVerdict(
  parentEnv: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
): ProbeEnvVerdict {
  if (okManagedBinDirs(options).length === 0) {
    return hasNoResolvableOkHome(options) ? 'not-applicable-no-home' : 'not-applicable';
  }
  return hasOkManagedBinDirsOnPath(parentEnv, options) ? 'inherited' : 'injected';
}

let probeEnvCompositionLogged = false;

function logProbeEnvComposition(
  parentEnv: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
  argv: ProbeSpawnArgv | undefined,
): void {
  if (probeEnvCompositionLogged) return;
  probeEnvCompositionLogged = true;
  const verdict = probeEnvVerdict(parentEnv, options);
  const record = {
    platform: options.platform,
    verdict,
    okManagedBinDirs: okManagedBinDirs(options),
    parentPathEntryCount: okChildPathEntries(parentEnv, options).length,
    reassert: argv?.reassert,
    shellCommandFamily: argv?.family,
  };
  const log = getLogger('probe-spawn');
  log[VERDICT_LOG_LEVELS[verdict]](record, VERDICT_MESSAGES[verdict]);
}

export function okProbeSpawnEnv(
  options: OkManagedBinDirsOptions = okChildEnvOptionsFromProcess(),
  argv?: ProbeSpawnArgv,
): Record<string, string> {
  logProbeEnvComposition(process.env, options, argv);
  return composeOkChildEnv(process.env, options);
}

export function probeSpawnArgs(
  shell: string,
  spawnArgs: readonly string[],
  options: OkManagedBinDirsOptions,
): ProbeSpawnArgv {
  if (options.platform === 'win32') {
    return { args: spawnArgs, reassert: 'skipped-win32', family: undefined };
  }
  const family = shellCommandFamily(shell);
  const command = spawnArgs.at(-2) === '-c' ? spawnArgs.at(-1) : undefined;
  if (command === undefined) return { args: spawnArgs, reassert: 'skipped-shape', family };
  return {
    args: [
      ...spawnArgs.slice(0, -1),
      commandWithManagedPath(shell, command, okManagedBinDirs(options)),
    ],
    reassert: 'applied',
    family,
  };
}

export function realProbeSpawn(file: string, spawnArgs: readonly string[]): ProbeChild {
  const options = okChildEnvOptionsFromProcess();
  const argv = probeSpawnArgs(file, spawnArgs, options);
  const reassertWarning = REASSERT_WARNINGS[argv.reassert];
  if (reassertWarning !== null) {
    getLogger('probe-spawn').warn(
      {
        event: 'probe-reassert-skipped',
        platform: options.platform,
        shellCommandFamily: argv.family,
        reassert: argv.reassert,
      },
      reassertWarning,
    );
  }
  const child = spawn(file, [...argv.args], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    env: okProbeSpawnEnv(options, argv),
  });
  return {
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
    },
    onError: (cb) => {
      child.on('error', (err) => cb(err));
    },
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}

export const realProbeTimers: ProbeTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};
