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
  /**
   * Verified desktop install path from `detectBundlePath()` — the macOS
   * `.app` bundle; an executable path off darwin, where this option is
   * unused. When present and `target` is an `openknowledge://` deep link,
   * darwin dispatch names this exact bundle (`open -a <path> <url>`) instead
   * of resolving the scheme through Launch Services. See darwin's branch in
   * `resolveOpenInvocation` below for why.
   */
  desktopBundlePath?: string;
}

interface OpenInvocation {
  command: string;
  args: readonly string[];
}

function resolveOpenInvocation(
  target: string,
  platform: NodeJS.Platform,
  desktopBundlePath?: string,
): OpenInvocation {
  if (platform === 'darwin') {
    // Plain scheme resolution is vulnerable to a stale Launch Services
    // binding (see desktop's `url-scheme.ts` for the mechanism). When the
    // caller already holds a verified bundle path — an FS probe of the
    // executable inside it, not a Launch Services lookup — name it directly
    // with `-a` instead: this repo already relies on `open -a <bundle>
    // <target>` to cold-launch the app with a target and have it delivered
    // (packages/desktop/tests/smoke/cold-single-file-launch.e2e.ts's
    // `launchViaLaunchServices`, called with an `openknowledge://share?…`
    // target). This is distinct from bundle-ID (`-b`) resolution, a different
    // Launch Services index this dispatch has no reason to trust more than
    // plain scheme resolution — desktop-dispatch.ts's bare `-b` launch (no
    // target argument) is a separate, unaffected case.
    if (desktopBundlePath && target.startsWith('openknowledge://')) {
      return { command: '/usr/bin/open', args: ['-a', desktopBundlePath, target] };
    }
    return { command: '/usr/bin/open', args: [target] };
  }
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
  const invocation = resolveOpenInvocation(
    target,
    options.platform ?? process.platform,
    options.desktopBundlePath,
  );
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
