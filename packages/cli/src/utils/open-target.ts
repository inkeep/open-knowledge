/**
 * Hand an HTTP(S) URL or custom-scheme deep link to the platform's registered
 * handler, and report whether the launcher process started successfully.
 */
import type { spawn as NativeSpawn } from 'node:child_process';
import {
  type SpawnDetachedScrubbedOutcome,
  spawnDetachedScrubbedAndWait,
} from './detached-spawn.ts';

export interface OpenTargetOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof NativeSpawn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface OpenInvocation {
  command: string;
  args: readonly string[];
}

function resolveOpenInvocation(target: string, platform: NodeJS.Platform): OpenInvocation {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [target] };
  if (platform === 'win32') {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      return { command: 'explorer.exe', args: [target] };
    }
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', target],
    };
  }
  return { command: 'xdg-open', args: [target] };
}

export function openTarget(
  target: string,
  options: OpenTargetOptions = {},
): Promise<SpawnDetachedScrubbedOutcome> {
  const invocation = resolveOpenInvocation(target, options.platform ?? process.platform);
  return spawnDetachedScrubbedAndWait(invocation.command, invocation.args, {
    spawn: options.spawn,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}

export function openTargetFailureMessage(
  reason: Exclude<SpawnDetachedScrubbedOutcome, { ok: true }>['reason'],
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const launcher = resolveOpenInvocation(target, platform).command;
  switch (reason) {
    case 'not-installed':
      return `${launcher} is not installed or cannot be executed`;
    case 'timeout':
      return `${launcher} did not start in time`;
    case 'spawn-error':
      return `${launcher} could not be started`;
  }
}
