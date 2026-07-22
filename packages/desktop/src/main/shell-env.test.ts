import { describe, expect, it } from 'vitest';
import { applyHarvestedAuthSock, harvestShellAuthSock, type ShellEnvLogger } from './shell-env.ts';

const MARK = '<<OK-AUTH-SOCK>>';

function collectingLogger(): {
  logger: ShellEnvLogger;
  events: string[];
  payloads: Array<Record<string, unknown> & { event: string }>;
} {
  const events: string[] = [];
  const payloads: Array<Record<string, unknown> & { event: string }> = [];
  return {
    logger: {
      event: (payload) => {
        events.push(payload.event);
        payloads.push(payload);
      },
    },
    events,
    payloads,
  };
}

function fakeSpawn(result: {
  code: number | null;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { stderr: '', ...result };
  };
  return { spawn, calls };
}

describe('harvestShellAuthSock', () => {
  it('returns the sock wrapped in markers', async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: `${MARK}/tmp/agent.sock${MARK}` });
    const sock = await harvestShellAuthSock({
      env: { SHELL: '/bin/zsh' },
      platform: 'darwin',
      spawn,
    });
    expect(sock).toBe('/tmp/agent.sock');
  });

  it('extracts the sock despite rc-file noise around the markers', async () => {
    const { spawn } = fakeSpawn({
      code: 0,
      stdout: `Welcome!\nnvm loaded\n${MARK}/tmp/agent.sock${MARK}\ntrailing noise`,
    });
    const sock = await harvestShellAuthSock({
      env: { SHELL: '/bin/zsh' },
      platform: 'darwin',
      spawn,
    });
    expect(sock).toBe('/tmp/agent.sock');
  });

  it('returns null when the login shell has no SSH_AUTH_SOCK', async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: `${MARK}${MARK}` });
    expect(
      await harvestShellAuthSock({ env: { SHELL: '/bin/zsh' }, platform: 'darwin', spawn }),
    ).toBeNull();
  });

  it('returns null and logs on non-zero exit, carrying bounded stderr', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawn = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { code: 1, stdout: '', stderr: `zsh: bad substitution${'x'.repeat(400)}` };
    };
    const { logger, events, payloads } = collectingLogger();
    expect(
      await harvestShellAuthSock({
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
        spawn,
        logger,
      }),
    ).toBeNull();
    expect(events).toContain('shell-authsock-harvest-failed');
    const failure = payloads.find((p) => p.event === 'shell-authsock-harvest-failed');
    expect(failure?.stderr).toMatch(/^zsh: bad substitution/);
    expect((failure?.stderr as string).length).toBeLessThanOrEqual(300);
  });

  it('returns null and logs on timeout', async () => {
    const { spawn } = fakeSpawn({ code: null, stdout: '', timedOut: true });
    const { logger, events } = collectingLogger();
    expect(
      await harvestShellAuthSock({
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
        spawn,
        logger,
      }),
    ).toBeNull();
    expect(events).toContain('shell-authsock-harvest-failed');
  });

  it('returns null and logs bounded stdout when the markers are missing', async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: `rc noise only, no marker${'y'.repeat(400)}` });
    const { logger, events, payloads } = collectingLogger();
    expect(
      await harvestShellAuthSock({
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
        spawn,
        logger,
      }),
    ).toBeNull();
    expect(events).toContain('shell-authsock-harvest-failed');
    const failure = payloads.find((p) => p.event === 'shell-authsock-harvest-failed');
    expect(failure?.reason).toBe('marker-missing');
    expect(failure?.stdout).toMatch(/^rc noise only/);
    expect((failure?.stdout as string).length).toBeLessThanOrEqual(300);
  });

  it('returns null and logs when spawn throws', async () => {
    const { logger, events } = collectingLogger();
    expect(
      await harvestShellAuthSock({
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
        spawn: async () => {
          throw new Error('ENOENT');
        },
        logger,
      }),
    ).toBeNull();
    expect(events).toContain('shell-authsock-harvest-failed');
  });

  it('skips win32 without spawning', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: `${MARK}/tmp/x${MARK}` });
    expect(await harvestShellAuthSock({ env: {}, platform: 'win32', spawn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('spawns $SHELL as an interactive login shell', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: `${MARK}/tmp/x${MARK}` });
    await harvestShellAuthSock({
      env: { SHELL: '/opt/homebrew/bin/fish' },
      platform: 'darwin',
      spawn,
    });
    expect(calls[0]?.command).toBe('/opt/homebrew/bin/fish');
    expect(calls[0]?.args[0]).toBe('-ilc');
  });

  it('falls back to zsh on darwin and bash on linux when SHELL is unset', async () => {
    const darwin = fakeSpawn({ code: 0, stdout: `${MARK}/tmp/x${MARK}` });
    await harvestShellAuthSock({ env: {}, platform: 'darwin', spawn: darwin.spawn });
    expect(darwin.calls[0]?.command).toBe('/bin/zsh');

    const linux = fakeSpawn({ code: 0, stdout: `${MARK}/tmp/x${MARK}` });
    await harvestShellAuthSock({ env: {}, platform: 'linux', spawn: linux.spawn });
    expect(linux.calls[0]?.command).toBe('/bin/bash');
  });
});

describe('applyHarvestedAuthSock', () => {
  it('patches env when the harvested sock differs, logging previous and new values', () => {
    const env: Record<string, string | undefined> = { SSH_AUTH_SOCK: '/launchd/Listeners' };
    const { logger, events, payloads } = collectingLogger();
    expect(applyHarvestedAuthSock(env, '/tmp/agent.sock', logger)).toBe(true);
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(events).toContain('shell-authsock-harvested');
    const harvested = payloads.find((p) => p.event === 'shell-authsock-harvested');
    expect(harvested?.from).toBe('/launchd/Listeners');
    expect(harvested?.to).toBe('/tmp/agent.sock');
  });

  it('logs from: null when no prior sock existed', () => {
    const env: Record<string, string | undefined> = {};
    const { logger, payloads } = collectingLogger();
    expect(applyHarvestedAuthSock(env, '/tmp/agent.sock', logger)).toBe(true);
    const harvested = payloads.find((p) => p.event === 'shell-authsock-harvested');
    expect(harvested?.from).toBeNull();
    expect(harvested?.to).toBe('/tmp/agent.sock');
  });

  it('sets env when no sock was present at all', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyHarvestedAuthSock(env, '/tmp/agent.sock', collectingLogger().logger)).toBe(true);
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  it('no-ops when the harvested sock matches the current value', () => {
    const env: Record<string, string | undefined> = { SSH_AUTH_SOCK: '/tmp/agent.sock' };
    expect(applyHarvestedAuthSock(env, '/tmp/agent.sock', collectingLogger().logger)).toBe(false);
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  it('never downgrades: null harvest leaves the existing value untouched', () => {
    const env: Record<string, string | undefined> = { SSH_AUTH_SOCK: '/launchd/Listeners' };
    expect(applyHarvestedAuthSock(env, null, collectingLogger().logger)).toBe(false);
    expect(env.SSH_AUTH_SOCK).toBe('/launchd/Listeners');
  });

  it('never downgrades: empty-string harvest leaves the existing value untouched', () => {
    const env: Record<string, string | undefined> = { SSH_AUTH_SOCK: '/launchd/Listeners' };
    expect(applyHarvestedAuthSock(env, '', collectingLogger().logger)).toBe(false);
    expect(env.SSH_AUTH_SOCK).toBe('/launchd/Listeners');
  });
});
