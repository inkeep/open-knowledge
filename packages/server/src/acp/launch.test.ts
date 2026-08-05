/**
 * Kill-semantics tests for `spawnAcpAgent` + `terminateAgentTree` — the
 * process-tree death guarantee behind thread close and server shutdown.
 *
 * The stubborn fixture simulates the npx shape that motivated group-kill: a
 * SIGTERM-ignoring wrapper whose SIGTERM-ignoring child is the "real" agent.
 * Killing only the direct child orphans the grandchild (verified on macOS:
 * SIGKILL to npx reparents its bin to PID 1, still running).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLaunchError,
  isPathQualified,
  mergedEnv,
  overlaySetsPath,
  preflightLaunch,
  type ResolvedLaunch,
  resolveWindowsCommand,
  spawnAcpAgent,
  terminateAgentTree,
  windowsCmdWrap,
  withHostedAgentMarker,
  withLoginShellPath,
} from './launch.ts';

describe('mergedEnv PATH augmentation', () => {
  test('an explicit overlay PATH is used verbatim — augmentation repairs only the inherited base', () => {
    const key = 'PATH' in process.env ? 'PATH' : 'Path';
    const out = mergedEnv({ [key]: '/sentinel/only' });
    // An overlay PATH is a spawn-env contract: it wins verbatim, never appended-to.
    expect(out[key]).toBe('/sentinel/only');
  });

  test('appends without dropping any existing PATH entry', () => {
    const key = 'PATH' in process.env ? 'PATH' : 'Path';
    const after = new Set((mergedEnv()[key] ?? '').split(delimiter));
    for (const dir of (process.env[key] ?? '').split(delimiter).filter(Boolean)) {
      expect(after.has(dir)).toBe(true);
    }
  });

  test('preserves non-PATH process.env entries', () => {
    expect(mergedEnv().HOME).toBe(process.env.HOME);
  });

  test('overlaySetsPath sees PATH under any spelling', () => {
    expect(overlaySetsPath({ Path: '/x' })).toBe(true);
    expect(overlaySetsPath({ PATH: '/x' })).toBe(true);
    expect(overlaySetsPath({ HOME: '/x' })).toBe(false);
    expect(overlaySetsPath(undefined)).toBe(false);
  });
});

describe('withLoginShellPath', () => {
  const key = 'PATH' in process.env ? 'PATH' : 'Path';

  test('appends the login shell PATH to the launch env, key spelling preserved', () => {
    const out = withLoginShellPath(
      { cmd: 'npx', args: [], env: { [key]: '/usr/bin' }, kind: 'npx', pathFromOverlay: false },
      `/nvm/bin${delimiter}/usr/bin`,
    );
    expect(out.env[key]).toBe(`/usr/bin${delimiter}/nvm/bin`);
    expect(out.cmd).toBe('npx');
  });

  test('leaves the rest of the env untouched', () => {
    const out = withLoginShellPath(
      {
        cmd: 'npx',
        args: ['-y', 'pkg'],
        env: { [key]: '/usr/bin', TOKEN: 'keep' },
        kind: 'npx',
        pathFromOverlay: false,
      },
      '/nvm/bin',
    );
    expect(out.env.TOKEN).toBe('keep');
    expect(out.args).toEqual(['-y', 'pkg']);
  });
});

describe('isPathQualified', () => {
  test('a bare name is PATH-searched; a located command is not', () => {
    expect(isPathQualified('npx')).toBe(false);
    expect(isPathQualified('./agent')).toBe(true);
    expect(isPathQualified('/opt/agent/bin/agent')).toBe(true);
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const plainEnv = (overlay: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...overlay };
};

const launchFor = (script: string, overlay?: Record<string, string>): ResolvedLaunch => ({
  cmd: 'node',
  args: [script],
  env: plainEnv(overlay),
  kind: 'custom',
  pathFromOverlay: overlaySetsPath(overlay),
});

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let dirs: string[] = [];
let strayPids: number[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-launch-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone — the desired state.
    }
  }
  strayPids = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('hosted-agent marker', () => {
  test('sets the marker and leaves the rest of the env alone', () => {
    const out = withHostedAgentMarker({ FOO: 'bar' });
    expect(out[OK_HOSTED_AGENT_ENV]).toBe('1');
    expect(out.FOO).toBe('bar');
  });

  test('wins over a launch env that already set the key — hosting is our fact, not the agent config’s', () => {
    expect(withHostedAgentMarker({ [OK_HOSTED_AGENT_ENV]: '0' })[OK_HOSTED_AGENT_ENV]).toBe('1');
  });

  // The marker only earns its keep if it survives into the spawned process —
  // that is the hop `ok mcp` reads it across. Assert on a real spawn rather
  // than on the helper's return value.
  test('a really-spawned agent receives it in its environment', async () => {
    const dir = tmp();
    const script = join(dir, 'echo-marker.js');
    // Write-then-rename: a plain writeFileSync makes the path observable the
    // instant it is created, so a waiter polling on existence can read it back
    // empty before the bytes land. The rename publishes it already complete.
    writeFileSync(
      script,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(process.argv[1] + '.tmp', String(process.env.${OK_HOSTED_AGENT_ENV} ?? 'ABSENT'));`,
        "fs.renameSync(process.argv[1] + '.tmp', process.argv[1] + '.out');",
      ].join('\n'),
    );
    const child = spawnAcpAgent(launchFor(script), dir);
    if (child.pid !== undefined) strayPids.push(child.pid);
    await waitFor(() => existsSync(`${script}.out`), 10_000, 'spawned agent to report its env');
    expect(readFileSync(`${script}.out`, 'utf8')).toBe('1');
  });
});

describe('preflightLaunch', () => {
  const catchErr = (p: Promise<unknown>): Promise<unknown> => p.then(() => null).catch((e) => e);

  test('a path-qualified command that exists resolves', async () => {
    // process.execPath is an absolute, executable path → no PATH search.
    await expect(
      preflightLaunch({
        cmd: process.execPath,
        args: [],
        env: {},
        kind: 'custom',
        pathFromOverlay: false,
      }),
    ).resolves.toBeUndefined();
  });

  test('a missing npx surfaces an actionable Node.js hint', async () => {
    // Empty PATH guarantees `npx` cannot resolve on any platform.
    const err = await catchErr(
      preflightLaunch({
        cmd: 'npx',
        args: ['-y', 'x'],
        env: { PATH: '' },
        kind: 'npx',
        pathFromOverlay: true,
      }),
    );
    expect(err).toBeInstanceOf(AgentLaunchError);
    expect((err as AgentLaunchError).code).toBe('command-not-found');
    expect((err as AgentLaunchError).message).toContain('Node.js');
  });

  test('a missing uvx surfaces an actionable uv hint', async () => {
    const err = await catchErr(
      preflightLaunch({
        cmd: 'uvx',
        args: [],
        env: { PATH: '' },
        kind: 'uvx',
        pathFromOverlay: true,
      }),
    );
    expect(err).toBeInstanceOf(AgentLaunchError);
    expect((err as AgentLaunchError).message).toContain('uv');
  });

  test('a bare command is found via a PATH search', async () => {
    const dir = tmp();
    const name = process.platform === 'win32' ? 'fakeagent.cmd' : 'fakeagent';
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(
      preflightLaunch({
        cmd: 'fakeagent',
        args: [],
        env: { PATH: dir },
        kind: 'custom',
        pathFromOverlay: true,
      }),
    ).resolves.toBeUndefined();
  });

  test('a missing binary distribution reports the offending path', async () => {
    const missing = join(tmp(), 'does-not-exist-agent');
    const err = await catchErr(
      preflightLaunch({
        cmd: missing,
        args: [],
        env: {},
        kind: 'binary',
        pathFromOverlay: false,
      }),
    );
    expect(err).toBeInstanceOf(AgentLaunchError);
    expect((err as AgentLaunchError).code).toBe('command-not-found');
    expect((err as AgentLaunchError).message).toContain(missing);
  });
});

describe('windows cmd wrapping (spawn on Windows)', () => {
  test('resolveWindowsCommand leaves path-qualified commands untouched', () => {
    expect(resolveWindowsCommand('C:\\x\\uvx.exe', 'C:\\x')).toBe('C:\\x\\uvx.exe');
    expect(resolveWindowsCommand('/usr/bin/uvx', undefined)).toBe('/usr/bin/uvx');
  });

  test('resolveWindowsCommand picks the .cmd/.exe, never a bare extensionless file', () => {
    // Mirror the C:\Program Files\nodejs layout: an extensionless `npx` shell
    // script next to `npx.cmd`. PATHEXT resolution must pick npx.cmd.
    const dir = tmp();
    writeFileSync(join(dir, 'npx'), '#!/bin/sh\n'); // git-bash script, not exec'able on Windows
    writeFileSync(join(dir, 'npx.cmd'), '@echo off\n');
    const resolved = resolveWindowsCommand('npx', dir);
    // Never the extensionless script. On Windows it resolves to npx.cmd; on a
    // case-sensitive FS with no PATHEXT it returns the input unchanged.
    expect(resolved).not.toBe(join(dir, 'npx'));
    if (resolved !== 'npx') expect(/\.cmd$/i.test(resolved)).toBe(true);
  });

  test('outer-quotes the whole command so a spaced launcher path survives /s', () => {
    const { cmd, args } = windowsCmdWrap('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'pkg']);
    expect(cmd.toLowerCase()).toContain('cmd');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // The command line is wrapped in an outer pair of quotes (cmd /s strips
    // the first + last quote), with the spaced launcher path quoted inside.
    expect(args[3]).toBe('""C:\\Program Files\\nodejs\\npx.cmd" -y pkg"');
  });

  test('quotes args that would otherwise split or be interpreted by cmd', () => {
    const { args } = windowsCmdWrap('tool', ['a b', 'safe', 'a&b', '']);
    expect(args[3]).toBe('""tool" "a b" safe "a&b" """');
  });
});

describe('terminateAgentTree', () => {
  test('a compliant agent exits on SIGTERM within the grace window', async () => {
    const dir = tmp();
    const script = join(dir, 'compliant.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawnAcpAgent(launchFor(script), dir);
    if (child.pid !== undefined) strayPids.push(child.pid);
    await waitFor(() => child.pid !== undefined, 2_000, 'spawn');

    const dead = await terminateAgentTree(child, { graceMs: 3_000 });
    expect(dead).toBe(true);
    expect(child.pid !== undefined && isAlive(child.pid)).toBe(false);
    // Graceful path: killed by the group SIGTERM, not the escalation.
    expect(child.signalCode).toBe('SIGTERM');
  });

  test('a SIGTERM-ignoring wrapper AND its grandchild both die via group escalation', async () => {
    const dir = tmp();
    const kidPidFile = join(dir, 'kid.pid');
    const script = join(dir, 'stubborn.mjs');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        'const kid = spawn(process.execPath, [',
        "  '-e',",
        '  "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);",',
        "], { stdio: 'ignore' });",
        'writeFileSync(process.env.KID_PID_FILE, String(kid.pid));',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const child = spawnAcpAgent(launchFor(script, { KID_PID_FILE: kidPidFile }), dir);
    if (child.pid !== undefined) strayPids.push(child.pid);
    await waitFor(() => existsSync(kidPidFile), 5_000, 'grandchild pid file');
    const kidPid = Number(readFileSync(kidPidFile, 'utf8'));
    strayPids.push(kidPid);
    expect(Number.isInteger(kidPid) && kidPid > 0).toBe(true);
    expect(isAlive(kidPid)).toBe(true);

    const dead = await terminateAgentTree(child, { graceMs: 250 });
    expect(dead).toBe(true);
    expect(child.pid !== undefined && isAlive(child.pid)).toBe(false);
    // The load-bearing assertion: the grandchild died with the group. A
    // direct-child SIGKILL would leave it running (the npx orphan bug).
    await waitFor(() => !isAlive(kidPid), 2_000, 'grandchild death');
  });
});
