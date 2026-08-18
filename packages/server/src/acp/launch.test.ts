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
  brokenInterpreterHint,
  declinedRepairHint,
  isPathQualified,
  mergedEnv,
  overlaySetsPath,
  preflightLaunch,
  probeInterpreterHealth,
  type ResolvedLaunch,
  resolveWindowsCommand,
  spawnAcpAgent,
  terminateAgentTree,
  undeletableManagedRuntimeHint,
  unrepairableManagedRuntimeHint,
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

  test('drops inherited `npm_config_overrides` while preserving user-set npm env', () => {
    // The bug: pnpm dev exports `npm_config_overrides` with pnpm's flat
    // `parent>child` key shape. A nested `npx exec` re-enters npm,
    // arborist rejects the flat key, and launch dies with
    // `Override without name`. Only that one env var breaks — user-set
    // npm env (`npm_config_userconfig`, nerf-darted auth tokens like
    // `npm_config_//<registry>/:_authToken`) and pnpm broadcasts that
    // merely warn (`registry`, `strict_peer_dependencies`) must reach
    // the spawned agent unchanged.
    const priors = {
      npm_config_overrides: process.env.npm_config_overrides,
      npm_config_userconfig: process.env.npm_config_userconfig,
      'npm_config_//registry.example.com/:_authToken':
        process.env['npm_config_//registry.example.com/:_authToken'],
      npm_config_registry: process.env.npm_config_registry,
      NPM_CONFIG_STRICT_PEER_DEPENDENCIES: process.env.NPM_CONFIG_STRICT_PEER_DEPENDENCIES,
    };
    process.env.npm_config_overrides = '{"@modelcontextprotocol/sdk>zod":"^3.25.7"}';
    process.env.npm_config_userconfig = '/home/user/.npmrc-override';
    process.env['npm_config_//registry.example.com/:_authToken'] = 'secret';
    process.env.npm_config_registry = 'https://registry.example.com/';
    process.env.NPM_CONFIG_STRICT_PEER_DEPENDENCIES = 'true';
    try {
      const out = mergedEnv();
      expect(out.npm_config_overrides).toBeUndefined();
      expect(out.npm_config_userconfig).toBe('/home/user/.npmrc-override');
      expect(out['npm_config_//registry.example.com/:_authToken']).toBe('secret');
      expect(out.npm_config_registry).toBe('https://registry.example.com/');
      expect(out.NPM_CONFIG_STRICT_PEER_DEPENDENCIES).toBe('true');
    } finally {
      for (const [k, v] of Object.entries(priors)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('managed-runtime overlay wins over a pnpm-broadcast `npm_config_cache` base', () => {
    // `rewriteLaunchToManagedRuntime` sets `npm_config_cache` on the
    // returned env to point at the runtime's private cache. In the real
    // failure scenario pnpm's own `npm_config_cache` is already in
    // `process.env` — seed it so the assertion pins that path instead of
    // collapsing into a re-test of the pre-existing overlay-wins merge.
    const prior = process.env.npm_config_cache;
    process.env.npm_config_cache = '/pnpm/broadcast/cache';
    try {
      const out = mergedEnv({ npm_config_cache: '/tmp/managed-node-cache' });
      expect(out.npm_config_cache).toBe('/tmp/managed-node-cache');
    } finally {
      if (prior === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prior;
    }
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

/**
 * The gap preflight structurally cannot see: an interpreter that resolves and
 * is executable, yet dies the moment it runs (a Homebrew `node`
 * whose `icu4c` was upgraded out from under it aborts under dyld).
 */
describe.skipIf(process.platform === 'win32')('probeInterpreterHealth', () => {
  /** A fake `npx` on PATH that behaves however `body` says. */
  const fakeNpx = (body: string): ResolvedLaunch => {
    const dir = tmp();
    writeFileSync(join(dir, 'npx'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return {
      cmd: 'npx',
      args: ['-y', '@fake/agent'],
      env: { PATH: dir },
      kind: 'npx',
      pathFromOverlay: true,
    };
  };

  test('an interpreter that answers --version is healthy', async () => {
    await expect(probeInterpreterHealth(fakeNpx('exit 0'))).resolves.toBeNull();
  });

  test('a non-zero exit reports the code and the first stderr line', async () => {
    const detail = await probeInterpreterHealth(fakeNpx('echo "cannot find module" >&2\nexit 3'));
    expect(detail).toContain('exit code 3');
    expect(detail).toContain('cannot find module');
  });

  // The reported shape: the dyld failure aborts the process, so there is no
  // exit code at all — only a signal and the linker's message on stderr.
  test('a crash reports the signal with the linker message', async () => {
    const detail = await probeInterpreterHealth(
      fakeNpx('echo "dyld[1]: Library not loaded: libicui18n.74.dylib" >&2\nkill -ABRT $$'),
    );
    expect(detail).toContain('SIGABRT');
    expect(detail).toContain('libicui18n.74.dylib');
  });

  test('a failure with a silent stderr still reports the exit code', async () => {
    expect(await probeInterpreterHealth(fakeNpx('exit 9'))).toBe('exit code 9');
  });

  test('an unspawnable command reports the spawn error rather than throwing', async () => {
    const detail = await probeInterpreterHealth({
      cmd: join(tmp(), 'not-a-real-npx'),
      args: [],
      env: {},
      kind: 'npx',
      pathFromOverlay: false,
    });
    expect(detail).not.toBeNull();
  });

  // A slow `--version` is not the crash this guards, and blocking every launch
  // on it would be the worse regression — so a hang reads as healthy-enough.
  test('a hung probe times out as healthy and does not leak the process', async () => {
    const dir = tmp();
    const beat = join(dir, 'heartbeat');
    // A GRANDchild (the fixture shell backgrounds it), so it outlives a kill
    // aimed at the direct child alone and dies only with the process group.
    //
    // It proves it stopped by ceasing to write, rather than by disappearing
    // from a process check: an orphan reparents to init, and where init doesn't
    // reap (a container's PID 1), a dead process lingers as a zombie that
    // `kill(pid, 0)` still reports as alive. Verified on Linux — the group kill
    // does land there; the process-existence check is what lies.
    writeFileSync(
      join(dir, 'npx'),
      `#!/bin/sh\n(while : ; do echo tick >> ${beat}; /bin/sleep 0.05; done) &\nwait\n`,
      { mode: 0o755 },
    );
    const launch: ResolvedLaunch = {
      cmd: 'npx',
      args: [],
      env: { PATH: dir },
      kind: 'npx',
      pathFromOverlay: true,
    };
    expect(await probeInterpreterHealth(launch, 500)).toBeNull();
    // It was running: otherwise this test would pass against a fixture that
    // never started, proving nothing about the kill.
    await waitFor(() => existsSync(beat), 5_000, 'the grandchild to start ticking');

    // The kill is deliberately not awaited — the verdict must not wait on it —
    // so allow a moment for the group signal to land, then require a quiet
    // window with no new ticks.
    const beats = (): number => readFileSync(beat, 'utf8').length;
    let stopped = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const before = beats();
      await new Promise((r) => setTimeout(r, 400));
      if (beats() === before) {
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
  }, 20_000);
});

describe('brokenInterpreterHint', () => {
  test('names Node.js for npx and points at the Homebrew icu4c cause', () => {
    const hint = brokenInterpreterHint(
      { cmd: 'npx', args: [], env: {}, kind: 'npx', pathFromOverlay: false },
      'SIGABRT',
    );
    expect(hint).toContain('Node.js');
    expect(hint).toContain('icu4c');
    // "not found" would send the user after an install they already have.
    expect(hint).not.toContain('was not found');
  });

  test('names uv for uvx, with no Node-specific cause pasted in', () => {
    const hint = brokenInterpreterHint(
      { cmd: 'uvx', args: [], env: {}, kind: 'uvx', pathFromOverlay: false },
      'exit code 1',
    );
    expect(hint).toContain('uv');
    // The Homebrew/icu4c story belongs to Node. Matching on the display name
    // alone missed this: the offending clause spells it `node` in backticks.
    expect(hint).not.toContain('Node.js');
    expect(hint).not.toContain('node');
    expect(hint).not.toContain('icu4c');
  });

  test("a replacement that still won't run blames the machine, not the user", () => {
    const hint = unrepairableManagedRuntimeHint(
      {
        cmd: '/home/u/.ok/runtimes/node/bin/npx',
        args: [],
        env: {},
        kind: 'npx',
        pathFromOverlay: false,
      },
      'SIGABRT',
    );
    expect(hint).toContain('SIGABRT');
    // The remedy is no longer homework: OK already replaced the copy, so what
    // is left to say is what could still be stopping it.
    expect(hint).not.toContain('delete that directory');
    // The user did not install this one, so "reinstall or repair" is advice
    // they cannot act on — and their system Node may be blameless.
    expect(hint).not.toContain('Reinstall or repair');
    expect(hint).not.toContain('icu4c');
  });

  // Symmetry with the sibling hint's two-branch coverage: testing one branch
  // is how the Node-specific advice reached uv users in the first place.
  test('the managed-runtime hints name uv for a uvx runtime', () => {
    const uvx = {
      cmd: '/home/u/.ok/runtimes/uv/uvx',
      args: [],
      env: {},
      kind: 'uvx',
      pathFromOverlay: false,
    } as const;
    for (const hint of [
      unrepairableManagedRuntimeHint(uvx, 'SIGABRT'),
      undeletableManagedRuntimeHint(uvx, 'SIGABRT'),
      declinedRepairHint(uvx),
    ]) {
      expect(hint).toContain('uv');
      expect(hint).not.toContain('Node.js');
    }
  });

  // A quarantine that failed means nothing was re-downloaded. Reusing the
  // fresh-copy wording here would send the user hunting for a machine-level
  // cause when the actual blocker is another agent holding the tree open.
  test('the un-replaceable hint does not claim a fresh copy was tried', () => {
    const hint = undeletableManagedRuntimeHint(
      {
        cmd: '/home/u/.ok/runtimes/node/bin/npx',
        args: [],
        env: {},
        kind: 'npx',
        pathFromOverlay: false,
      },
      'SIGABRT',
    );
    expect(hint).toContain('damaged');
    expect(hint).not.toContain('downloaded a fresh copy');
  });

  // Declining the repair must not reach for the stock decline hint, which says
  // the interpreter isn't installed — OK's copy is installed, just damaged.
  test('the declined-repair hint says damaged, not missing', () => {
    const hint = declinedRepairHint({
      cmd: '/home/u/.ok/runtimes/node/bin/npx',
      args: [],
      env: {},
      kind: 'npx',
      pathFromOverlay: false,
    });
    expect(hint).toContain('damaged');
    expect(hint).not.toContain("isn't installed");
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
