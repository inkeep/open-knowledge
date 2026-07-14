import { describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { PROTOCOL_VERSION, type SshMachine } from '@inkeep/open-knowledge-core';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';
import {
  assertSafeTunnelSshConfig,
  buildIsCommandAvailableCommand,
  buildListDirectoriesCommand,
  buildPosixLoginShellCommand,
  buildRemoteCompanionInstallCommand,
  buildRemoteCompanionProbeCommand,
  buildRemoteInspectCommand,
  buildRemoteMachineTestCommand,
  buildRemoteServeCommand,
  buildRemoteTerminalConsentCommand,
  buildRemoteTunnelSentinelCommand,
  buildSshCommandArgs,
  buildSshEffectiveConfigArgs,
  buildSshTerminalArgs,
  buildSshTunnelArgs,
  encodeRemoteDirectoryRequest,
  fingerprintTunnelSshConfig,
  parseRemoteCompanionStatus,
  parseRemoteErrorLine,
  parseRemoteInspection,
  parseRemoteMachineTest,
  parseRemoteReadyLine,
  parseRemoteTerminalConsent,
  quotePosix,
  REMOTE_COMMAND_MARKER,
  REMOTE_COMPANION_INSTALL_NODE_SCRIPT,
  REMOTE_COMPANION_MARKER,
  REMOTE_COMPANION_PROBE_NODE_SCRIPT,
  REMOTE_DIRECTORIES_MARKER,
  REMOTE_ERROR_MARKER,
  REMOTE_INSPECT_MARKER,
  REMOTE_LIST_DIRECTORIES_NODE_SCRIPT,
  REMOTE_READY_MARKER,
  REMOTE_TERMINAL_CONSENT_MARKER,
  REMOTE_TEST_MARKER,
  REMOTE_TUNNEL_READY_MARKER,
  type RemoteChildProcess,
  RemoteProjectError,
  RemoteProjectService,
  type RemoteProjectServiceDeps,
  type RemoteSpawn,
  type RemoteSpawnOptions,
  readBoundedResponseText,
  validateRemoteExecutableName,
  validateRemoteProjectPath,
  validateSshMachine,
} from '../../src/main/remote-project-service.ts';

const TEST_COMPANION_DIGEST = 'a'.repeat(64);
const TEST_NONCE = 'A'.repeat(43);

const MACHINE: SshMachine = {
  id: 'build-box',
  name: 'Build box',
  host: 'developer@build-box',
  port: 2222,
};

function readyMarker(overrides: Record<string, unknown> = {}): string {
  return `${REMOTE_READY_MARKER}${JSON.stringify({
    v: 1,
    nonce: TEST_NONCE,
    port: 43123,
    projectPath: '/srv/wiki',
    platform: 'linux',
    pathSeparator: '/',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['http', 'ws'],
    owned: true,
    ...overrides,
  })}`;
}

function emitTunnelReady(child: FakeChild): void {
  queueMicrotask(() =>
    child.writeStdout(
      `${REMOTE_TUNNEL_READY_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, ready: true })}\n`,
    ),
  );
}

function testMarker(status: string, nonce = TEST_NONCE): string {
  return `${REMOTE_TEST_MARKER}${JSON.stringify({ v: 1, nonce, status })}`;
}

function companionMarker(status: string, nonce = TEST_NONCE): string {
  return `${REMOTE_COMPANION_MARKER}${JSON.stringify({ v: 1, nonce, status })}`;
}

function commandMarker(available: boolean, nonce = TEST_NONCE): string {
  return `${REMOTE_COMMAND_MARKER}${JSON.stringify({ v: 1, nonce, available })}`;
}

function directoryMarker(payload: Record<string, unknown>, nonce = TEST_NONCE): string {
  return `${REMOTE_DIRECTORIES_MARKER}${JSON.stringify({ v: 1, nonce, ...payload })}`;
}

class FakeChild extends EventEmitter {
  readonly lifecycle: string[] = [];
  readonly stdinPayloads: Uint8Array[] = [];
  onStdinEnd: (() => void) | undefined;
  readonly stdin = {
    end: mock((data?: Uint8Array) => {
      if (data !== undefined) this.stdinPayloads.push(data);
      this.lifecycle.push('stdin:end');
      this.onStdinEnd?.();
    }),
  };
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = mock((_signal?: NodeJS.Signals) => {
    this.lifecycle.push('kill');
    return true;
  });

  writeStdout(value: string | Uint8Array): void {
    this.stdout.write(value);
  }

  writeStderr(value: string | Uint8Array): void {
    this.stderr.write(value);
  }

  close(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  asRemoteChild(): RemoteChildProcess {
    return this as unknown as RemoteChildProcess;
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: RemoteSpawnOptions;
  readonly child: FakeChild;
}

function recordingSpawn(onSpawn: (call: SpawnCall, index: number) => void): {
  readonly spawn: RemoteSpawn;
  readonly calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: RemoteSpawn = (file, args, options) => {
    const child = new FakeChild();
    const call = { file, args: [...args], options, child };
    calls.push(call);
    onSpawn(call, calls.length - 1);
    return child.asRemoteChild();
  };
  return { spawn, calls };
}

function recordingProjectSpawn(onSpawn: (call: SpawnCall, index: number) => void): {
  readonly spawn: RemoteSpawn;
  readonly calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: RemoteSpawn = (file, args, options) => {
    const child = new FakeChild();
    const call = { file, args: [...args], options, child };
    if (args.at(-1)?.includes(REMOTE_TEST_MARKER)) {
      queueMicrotask(() => {
        child.writeStdout(`${testMarker('ok')}\n`);
        child.close(0);
      });
    } else {
      calls.push(call);
      onSpawn(call, calls.length - 1);
    }
    return child.asRemoteChild();
  };
  return { spawn, calls };
}

function serviceDeps(spawn: RemoteSpawn, overrides: RemoteProjectServiceDeps = {}) {
  return {
    spawn,
    sshPath: '/test/system-ssh',
    allocateLocalPort: async () => 45123,
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ collabUrl: 'ws://localhost:43123/collab', port: 43123 }),
    }),
    sleep: async () => {},
    createNonce: () => TEST_NONCE,
    inspectTunnelConfig: async () => 'test-connection-fingerprint',
    ensureRemoteCompanion: async () => TEST_COMPANION_DIGEST,
    ...overrides,
  } satisfies RemoteProjectServiceDeps;
}

describe('SSH machine and path validation', () => {
  test('accepts and copies the non-secret machine allowlist', () => {
    expect(validateSshMachine(MACHINE)).toEqual(MACHINE);
    expect(validateSshMachine({ id: 'x', name: 'X', host: 'ssh-config-alias' })).toEqual({
      id: 'x',
      name: 'X',
      host: 'ssh-config-alias',
    });
  });

  test('rejects unsafe destinations, invalid ports, and secret-shaped extra fields', () => {
    for (const host of [
      '',
      '-proxy',
      'host name',
      'host\nname',
      ' host',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-injection fixture
      'x;touch${IFS}/tmp/pwn',
      'wild*card',
      '[::1]',
    ]) {
      expect(() => validateSshMachine({ ...MACHINE, host })).toThrow(RemoteProjectError);
    }
    for (const port of [0, 65_536, 22.5, '22']) {
      expect(() => validateSshMachine({ ...MACHINE, port })).toThrow(RemoteProjectError);
    }
    expect(() => validateSshMachine({ ...MACHINE, password: 'secret' })).toThrow(
      'unsupported fields',
    );
  });

  test('accepts only absolute and home-relative POSIX project paths', () => {
    expect(validateRemoteProjectPath('/srv/a project')).toBe('/srv/a project');
    expect(validateRemoteProjectPath('~/a project')).toBe('~/a project');
    expect(validateRemoteProjectPath('~')).toBe('~');
    for (const path of ['', '.', 'relative/project', '../project', '/bad\npath']) {
      expect(() => validateRemoteProjectPath(path)).toThrow(RemoteProjectError);
    }
  });
});

describe('safe command construction', () => {
  test('quotes POSIX shell data without exposing quote or semicolon injection', () => {
    expect(quotePosix("a'b;c")).toBe(`'a'"'"'b;c'`);
    const path = "/srv/a'; touch /tmp/pwn; #";
    const command = buildRemoteServeCommand(path, TEST_COMPANION_DIGEST, {
      initialize: false,
      nonce: TEST_NONCE,
    });
    expect(command).toContain(`exec "\${SHELL:-/bin/sh}" -lic`);
    expect(command).toContain('--nonce');
    expect(command).toBe(
      buildPosixLoginShellCommand(
        `cd ${quotePosix(path)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings "$HOME/.ok/remote/servers/${TEST_COMPANION_DIGEST}/remote-companion.mjs" --nonce '${TEST_NONCE}' serve`,
      ),
    );
    expect(command).not.toContain('cd /srv/a');
    const expectedPath = Buffer.from(path).toString('base64url');
    expect(
      buildRemoteServeCommand(path, TEST_COMPANION_DIGEST, {
        initialize: true,
        nonce: TEST_NONCE,
      }),
    ).toBe(
      buildPosixLoginShellCommand(
        `cd ${quotePosix(path)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings "$HOME/.ok/remote/servers/${TEST_COMPANION_DIGEST}/remote-companion.mjs" --nonce '${TEST_NONCE}' serve --initialize --expected-path ${quotePosix(expectedPath)}`,
      ),
    );
    expect(() =>
      buildRemoteServeCommand('~/wiki', TEST_COMPANION_DIGEST, {
        initialize: true,
        nonce: TEST_NONCE,
      }),
    ).toThrow('canonical absolute folder path');
    const inspectCommand = buildRemoteInspectCommand(path, TEST_COMPANION_DIGEST, TEST_NONCE);
    expect(inspectCommand).toContain('remote-companion.mjs');
    expect(inspectCommand).toContain('inspect');
  });

  test('uses a constant Node script with a base64url JSON directory payload', () => {
    const path = "/srv/O'Reilly docs";
    const payload = encodeRemoteDirectoryRequest(path, TEST_NONCE);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      nonce: TEST_NONCE,
      path,
    });
    const command = buildListDirectoriesCommand(path, TEST_NONCE);
    expect(command).toContain('node -e');
    expect(command).toContain(payload);
    expect(command).not.toContain(path);
    expect(REMOTE_LIST_DIRECTORIES_NODE_SCRIPT).toContain(REMOTE_DIRECTORIES_MARKER);
    expect(REMOTE_LIST_DIRECTORIES_NODE_SCRIPT).toContain('fs.opendir');
    expect(REMOTE_LIST_DIRECTORIES_NODE_SCRIPT).toContain("error: 'too-many'");
  });

  test('builds hardened command and loopback tunnel argv without weakening known hosts', () => {
    const commandArgs = buildSshCommandArgs(MACHINE, 'fixed-command');
    expect(commandArgs).toContain('BatchMode=yes');
    expect(commandArgs).toContain('ClearAllForwardings=yes');
    expect(commandArgs).toContain('ServerAliveInterval=15');
    expect(commandArgs).toContain('RemoteCommand=none');
    expect(commandArgs).toContain('SessionType=default');
    expect(commandArgs).toContain('ForwardAgent=no');
    expect(commandArgs).toContain('ControlPath=none');
    expect(commandArgs).toContain('ForkAfterAuthentication=no');
    expect(commandArgs).toContain('developer@build-box');
    expect(commandArgs).toContain('fixed-command');
    expect(commandArgs.join(' ')).not.toContain('StrictHostKeyChecking');
    expect(commandArgs.join(' ')).not.toContain('UserKnownHostsFile');

    const tunnelArgs = buildSshTunnelArgs(MACHINE, 45123, 43123, TEST_NONCE);
    expect(tunnelArgs).toContain('ExitOnForwardFailure=yes');
    expect(tunnelArgs).not.toContain('-N');
    expect(tunnelArgs).toContain('127.0.0.1:45123:127.0.0.1:43123');
    expect(tunnelArgs.at(-1)).toBe(buildRemoteTunnelSentinelCommand(TEST_NONCE));
    // The tunnel must override an inherited `yes` so Desktop's explicit -L is
    // retained. The effective-config probe uses this exact posture too.
    expect(tunnelArgs).not.toContain('ClearAllForwardings=yes');
    expect(tunnelArgs).toContain('ClearAllForwardings=no');

    const configArgs = buildSshEffectiveConfigArgs(MACHINE);
    expect(configArgs).toContain('-G');
    expect(configArgs).toContain('ControlPath=none');
    expect(configArgs).toContain('ClearAllForwardings=no');
    expect(configArgs.at(-1)).toBe(MACHINE.host);
  });

  test('rejects effective Host configs with unrelated forwards and fingerprints routing identity', () => {
    const safe = [
      'host build-box',
      'hostname 10.0.0.12',
      'user developer',
      'port 2222',
      'proxyjump bastion',
      'canonicalizehostname false',
    ].join('\n');
    expect(() => assertSafeTunnelSshConfig(safe)).not.toThrow();
    expect(fingerprintTunnelSshConfig(safe)).toHaveLength(64);
    expect(fingerprintTunnelSshConfig(safe)).not.toBe(
      fingerprintTunnelSshConfig(safe.replace('10.0.0.12', '10.0.0.13')),
    );

    for (const line of [
      'localforward 127.0.0.1:8000 127.0.0.1:8000',
      'remoteforward 127.0.0.1:9000 127.0.0.1:9000',
      'dynamicforward 127.0.0.1:1080',
    ]) {
      expect(() => assertSafeTunnelSshConfig(`${safe}\n${line}`)).toThrow('Add a clean Host alias');
    }
  });

  test('remote terminal safely runs launchCommand, then returns to an interactive shell', () => {
    const path = "/srv/project'; safe";
    const launchCommand = `claude --append-system-prompt 'team docs'`;
    const args = buildSshTerminalArgs(MACHINE, path, launchCommand);
    expect(args).toContain('-tt');
    expect(args).toContain('ClearAllForwardings=yes');
    expect(args.at(-1)).toBe(
      buildPosixLoginShellCommand(
        `cd ${quotePosix(path)} && ${launchCommand}; exec "\${SHELL:-/bin/sh}" -l -i`,
      ),
    );
  });

  test('remote terminal with no launch command opens a login-interactive shell', () => {
    const args = buildSshTerminalArgs(MACHINE, '/srv/project');
    expect(args.at(-1)).toBe(
      buildPosixLoginShellCommand(
        `cd ${quotePosix('/srv/project')} && exec "\${SHELL:-/bin/sh}" -l -i`,
      ),
    );
  });

  test('machine and command probes are fixed, marker-based login-shell commands', () => {
    const machineProbe = buildRemoteMachineTestCommand(TEST_NONCE);
    expect(machineProbe).toContain('uname -s');
    expect(machineProbe).toContain('platform-unsupported');
    expect(machineProbe).toContain('node_major=');
    expect(machineProbe).toContain('git --version');
    expect(machineProbe).not.toContain('command -v ok');
    expect(machineProbe).toContain('node-too-old');
    expect(machineProbe).toContain('git-too-old');

    expect(buildIsCommandAvailableCommand('claude', TEST_NONCE)).toContain('command -v');
    expect(buildIsCommandAvailableCommand('claude', TEST_NONCE)).toContain(REMOTE_COMMAND_MARKER);
    expect(validateRemoteExecutableName('open-code_2.0')).toBe('open-code_2.0');
    for (const unsafe of ['', '-claude', '../claude', 'claude; touch /tmp/pwn', 'a b']) {
      expect(() => buildIsCommandAvailableCommand(unsafe, TEST_NONCE)).toThrow('name is invalid');
    }
  });

  test('builds the terminal-consent probe under the selected remote project', () => {
    const path = "/srv/team's wiki";
    const command = buildRemoteTerminalConsentCommand(path, TEST_COMPANION_DIGEST, TEST_NONCE);
    expect(command).toContain('terminal-consent');
    expect(command).toBe(
      buildPosixLoginShellCommand(
        `cd ${quotePosix(path)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings "$HOME/.ok/remote/servers/${TEST_COMPANION_DIGEST}/remote-companion.mjs" --nonce '${TEST_NONCE}' terminal-consent`,
      ),
    );
  });

  test('builds marker-framed companion probes and permission-safe atomic installs', () => {
    const probe = buildRemoteCompanionProbeCommand(TEST_COMPANION_DIGEST, TEST_NONCE);
    const install = buildRemoteCompanionInstallCommand(TEST_COMPANION_DIGEST, 42, TEST_NONCE);
    expect(probe).toContain(REMOTE_COMPANION_MARKER);
    expect(install).toContain('mkdtemp');
    expect(install).toContain('0o700');
    expect(install).toContain('0o600');
    expect(install).toContain('sha256');
    expect(install).toContain('rename');
    expect(parseRemoteCompanionStatus(`${companionMarker('ready')}\n`, TEST_NONCE)).toBe('ready');
    expect(parseRemoteCompanionStatus(`${companionMarker('installed')}\n`, TEST_NONCE)).toBe(
      'installed',
    );
    expect(() => buildRemoteCompanionProbeCommand('../unsafe', TEST_NONCE)).toThrow(
      'identity is invalid',
    );
  });

  test('the remote installer writes a private verified file and the probe detects tampering', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-remote-home-'));
    const companion = Buffer.from('#!/usr/bin/env node\nconsole.log("remote");\n');
    const digest = createHash('sha256').update(companion).digest('hex');
    const file = join(home, '.ok', 'remote', 'servers', digest, 'remote-companion.mjs');
    try {
      const install = spawnSync(
        'node',
        [
          '-e',
          REMOTE_COMPANION_INSTALL_NODE_SCRIPT,
          digest,
          String(companion.byteLength),
          TEST_NONCE,
        ],
        {
          input: companion,
          encoding: 'utf8',
          env: { ...process.env, HOME: home },
        },
      );
      expect(install.status).toBe(0);
      expect(install.stdout).toBe(`${companionMarker('installed')}\n`);
      expect(readFileSync(file)).toEqual(companion);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.ok', 'remote')).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, '.ok', 'remote', 'servers')).mode & 0o777).toBe(0o700);

      const probe = () =>
        spawnSync('node', ['-e', REMOTE_COMPANION_PROBE_NODE_SCRIPT, digest, TEST_NONCE], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home },
        });
      expect(probe().stdout).toBe(`${companionMarker('ready')}\n`);
      writeFileSync(file, 'tampered', { mode: 0o600 });
      expect(probe().stdout).toBe(`${companionMarker('missing')}\n`);
      writeFileSync(file, companion, { mode: 0o600 });
      chmodSync(join(home, '.ok', 'remote'), 0o755);
      expect(probe().status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the remote installer rejects symlinked or writable managed parents', () => {
    const companion = Buffer.from('remote companion');
    const digest = createHash('sha256').update(companion).digest('hex');
    const runInstall = (home: string) =>
      spawnSync(
        'node',
        [
          '-e',
          REMOTE_COMPANION_INSTALL_NODE_SCRIPT,
          digest,
          String(companion.byteLength),
          TEST_NONCE,
        ],
        { input: companion, encoding: 'utf8', env: { ...process.env, HOME: home } },
      );

    const symlinkHome = mkdtempSync(join(tmpdir(), 'ok-remote-symlink-home-'));
    const target = mkdtempSync(join(tmpdir(), 'ok-remote-symlink-target-'));
    try {
      symlinkSync(target, join(symlinkHome, '.ok'));
      expect(runInstall(symlinkHome).status).toBe(1);
    } finally {
      rmSync(symlinkHome, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }

    const writableHome = mkdtempSync(join(tmpdir(), 'ok-remote-writable-home-'));
    try {
      mkdirSync(join(writableHome, '.ok'), { mode: 0o770 });
      chmodSync(join(writableHome, '.ok'), 0o770);
      expect(runInstall(writableHome).status).toBe(1);
    } finally {
      rmSync(writableHome, { recursive: true, force: true });
    }
  });
});

describe('remote readiness protocol', () => {
  test('parses v1 readiness for a supported POSIX platform', () => {
    expect(
      parseRemoteReadyLine(
        readyMarker({ platform: 'darwin', projectPath: '/srv/ wiki ' }),
        TEST_NONCE,
      ),
    ).toEqual({
      v: 1,
      nonce: TEST_NONCE,
      port: 43123,
      projectPath: '/srv/ wiki ',
      platform: 'darwin',
      pathSeparator: '/',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      capabilities: ['http', 'ws'],
      owned: true,
    });
    expect(parseRemoteReadyLine('ordinary log output', TEST_NONCE)).toBeNull();
  });

  test('parses prerequisite markers without accepting unframed tool output', () => {
    expect(parseRemoteMachineTest(`${testMarker('ok')}\n`, TEST_NONCE)).toBe('ok');
    expect(parseRemoteMachineTest(`${testMarker('platform-unsupported')}\n`, TEST_NONCE)).toBe(
      'platform-unsupported',
    );
    expect(parseRemoteMachineTest(`${testMarker('node-too-old')}\n`, TEST_NONCE)).toBe(
      'node-too-old',
    );
    expect(parseRemoteMachineTest(`${testMarker('git-too-old')}\n`, TEST_NONCE)).toBe(
      'git-too-old',
    );
    expect(() => parseRemoteMachineTest('node v22.0.0', TEST_NONCE)).toThrow(
      'response was invalid',
    );
    expect(() => parseRemoteMachineTest(`${testMarker('surprise')}\n`, TEST_NONCE)).toThrow(
      'response was invalid',
    );
  });

  test('requires exact protocol, runtime, and HTTP/WebSocket capabilities', () => {
    expect(() => parseRemoteReadyLine(readyMarker({ protocolVersion: 999 }), TEST_NONCE)).toThrow(
      'incompatible',
    );
    expect(() =>
      parseRemoteReadyLine(readyMarker({ runtimeVersion: '0.0.0-other' }), TEST_NONCE),
    ).toThrow('runtime is incompatible');
    expect(() =>
      parseRemoteReadyLine(readyMarker({ runtimeVersion: ` ${RUNTIME_VERSION}` }), TEST_NONCE),
    ).toThrow('runtime is incompatible');
    expect(() => parseRemoteReadyLine(readyMarker({ capabilities: ['http'] }), TEST_NONCE)).toThrow(
      'does not support',
    );
    expect(() => parseRemoteReadyLine(readyMarker({ port: 0 }), TEST_NONCE)).toThrow(
      'port is invalid',
    );
    expect(() => parseRemoteReadyLine(readyMarker({ platform: 'freebsd' }), TEST_NONCE)).toThrow(
      'platform is not supported',
    );
    expect(() => parseRemoteReadyLine(readyMarker({ pathSeparator: '\\' }), TEST_NONCE)).toThrow(
      'separator is not supported',
    );
    expect(parseRemoteReadyLine(readyMarker(), TEST_NONCE, PROTOCOL_VERSION, 32)).toBeNull();
    expect(parseRemoteReadyLine(readyMarker({ nonce: 'B'.repeat(43) }), TEST_NONCE)).toBeNull();
  });

  test('parses bounded project inspections and structured companion errors', () => {
    expect(
      parseRemoteInspection(
        `${REMOTE_INSPECT_MARKER}${JSON.stringify({
          v: 1,
          nonce: TEST_NONCE,
          selectedPath: '/srv/wiki/docs',
          projectPath: '/srv/wiki',
          initialized: true,
        })}\n`,
        TEST_NONCE,
      ),
    ).toEqual({
      selectedPath: '/srv/wiki/docs',
      projectPath: '/srv/wiki',
      initialized: true,
    });
    expect(
      parseRemoteErrorLine(
        `${REMOTE_ERROR_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, code: 'project-uninitialized' })}`,
        TEST_NONCE,
      ),
    ).toMatchObject({ code: 'project-uninitialized' });
    expect(() =>
      parseRemoteErrorLine(
        `${REMOTE_ERROR_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, code: 'unknown' })}`,
        TEST_NONCE,
      ),
    ).toThrow('was invalid');
    expect(() =>
      parseRemoteInspection(
        `${REMOTE_INSPECT_MARKER}${JSON.stringify({
          v: 1,
          nonce: TEST_NONCE,
          selectedPath: 'relative',
          projectPath: '/srv/wiki',
          initialized: false,
        })}\n`,
        TEST_NONCE,
      ),
    ).toThrow('not an absolute path');
  });
});

describe('bounded remote HTTP response reading', () => {
  test('cancels a streamed body as soon as it exceeds the byte cap', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedResponseText({ body }, 1024)).rejects.toMatchObject({
      code: 'output-limit',
    });
    expect(cancelled).toBe(true);
  });
});

describe('remote terminal consent protocol', () => {
  test('parses explicit allow and refusal markers', () => {
    expect(
      parseRemoteTerminalConsent(
        `${REMOTE_TERMINAL_CONSENT_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, allowed: true })}\n`,
        TEST_NONCE,
      ),
    ).toBe(true);
    expect(
      parseRemoteTerminalConsent(
        `${REMOTE_TERMINAL_CONSENT_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, allowed: false })}\n`,
        TEST_NONCE,
      ),
    ).toBe(false);
  });

  test('fails closed on a missing or malformed marker', () => {
    expect(() => parseRemoteTerminalConsent('ordinary output', TEST_NONCE)).toThrow('was missing');
    expect(() =>
      parseRemoteTerminalConsent(
        `${REMOTE_TERMINAL_CONSENT_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, allowed: 'yes' })}\n`,
        TEST_NONCE,
      ),
    ).toThrow('was invalid');
  });
});

describe('RemoteProjectService', () => {
  test('testMachine uses shell:false and returns renderer-safe connection errors', async () => {
    const success = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(`${testMarker('ok')}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(success.spawn));
    expect(await service.testMachine(MACHINE)).toEqual({ ok: true });
    expect(success.calls[0]?.file).toBe('/test/system-ssh');
    expect(success.calls[0]?.options).toEqual({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const denied = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStderr('Permission denied (publickey).\n');
        call.child.close(255);
      });
    });
    const deniedService = new RemoteProjectService(serviceDeps(denied.spawn));
    expect(await deniedService.testMachine(MACHINE)).toEqual({
      ok: false,
      error: 'SSH authentication failed.',
    });
  });

  test('installs the bundled companion over stdin when its content digest is absent', async () => {
    const companion = new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("remote");\n');
    const digest = createHash('sha256').update(companion).digest('hex');
    const spawned = recordingSpawn((call, index) => {
      queueMicrotask(() => {
        if (index === 0) call.child.writeStdout(`${testMarker('ok')}\n`);
        else if (index === 1) call.child.writeStdout(`${companionMarker('missing')}\n`);
        else call.child.writeStdout(`${companionMarker('installed')}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        ensureRemoteCompanion: undefined,
        loadRemoteCompanion: async () => companion,
      }),
    );

    await expect(service.testMachine(MACHINE)).resolves.toEqual({ ok: true });
    expect(spawned.calls).toHaveLength(3);
    expect(spawned.calls[1]?.args.at(-1)).toBe(
      buildRemoteCompanionProbeCommand(digest, TEST_NONCE),
    );
    expect(spawned.calls[2]?.args.at(-1)).toBe(
      buildRemoteCompanionInstallCommand(digest, companion.byteLength, TEST_NONCE),
    );
    expect(spawned.calls[2]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawned.calls[2]?.child.stdinPayloads).toEqual([companion]);
  });

  test('surfaces a writable-home action when companion installation is refused', async () => {
    const companion = new TextEncoder().encode('remote companion');
    const spawned = recordingSpawn((call, index) => {
      queueMicrotask(() => {
        if (index === 0) call.child.writeStdout(`${testMarker('ok')}\n`);
        else if (index === 1) call.child.writeStdout(`${companionMarker('missing')}\n`);
        else call.child.writeStderr('OK_REMOTE_COMPANION_INSTALL_ERROR\n');
        call.child.close(index === 2 ? 1 : 0);
      });
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        ensureRemoteCompanion: undefined,
        loadRemoteCompanion: async () => companion,
      }),
    );

    await expect(service.testMachine(MACHINE)).resolves.toEqual({
      ok: false,
      error:
        'OpenKnowledge could not install remote support. Ensure the SSH home is writable and `~/.ok` is owned by that user, is not a symlink, and is not group- or world-writable.',
    });
  });

  test('coalesces concurrent companion installs for the same saved machine', async () => {
    const companion = new TextEncoder().encode('remote companion');
    let companionProbes = 0;
    let installs = 0;
    const spawned = recordingSpawn((call) => {
      const command = call.args.at(-1) ?? '';
      if (command.includes(REMOTE_TEST_MARKER)) {
        queueMicrotask(() => {
          call.child.writeStdout(`${testMarker('ok')}\n`);
          call.child.close(0);
        });
        return;
      }
      if (call.options.stdio[0] === 'ignore') {
        companionProbes += 1;
        setTimeout(() => {
          call.child.writeStdout(`${companionMarker('missing')}\n`);
          call.child.close(0);
        }, 1);
        return;
      }
      installs += 1;
      queueMicrotask(() => {
        call.child.writeStdout(`${companionMarker('installed')}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        ensureRemoteCompanion: undefined,
        loadRemoteCompanion: async () => companion,
      }),
    );

    await expect(
      Promise.all([service.testMachine(MACHINE), service.testMachine(MACHINE)]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(companionProbes).toBe(1);
    expect(installs).toBe(1);
  });

  test('testMachine reports actionable runtime prerequisite failures', async () => {
    const cases = [
      [
        'platform-unsupported',
        'OpenKnowledge remote projects support macOS and Linux SSH machines.',
      ],
      ['node-missing', 'Install Node.js 24 or newer on the SSH machine.'],
      ['node-too-old', 'Update Node.js on the SSH machine to version 24 or newer.'],
      ['git-missing', 'Install Git 2.31.0 or newer on the SSH machine.'],
      ['git-too-old', 'Update Git on the SSH machine to version 2.31.0 or newer.'],
    ] as const;
    for (const [status, error] of cases) {
      const spawned = recordingSpawn((call) => {
        queueMicrotask(() => {
          call.child.writeStdout(`${testMarker(status)}\n`);
          call.child.close(0);
        });
      });
      const service = new RemoteProjectService(serviceDeps(spawned.spawn));
      expect(await service.testMachine(MACHINE)).toEqual({ ok: false, error });
    }
  });

  test('testMachine inspects the effective OpenSSH config with bounded safe argv', async () => {
    const spawned = recordingSpawn((call, index) => {
      queueMicrotask(() => {
        if (index === 0) {
          call.child.writeStdout(
            'host build-box\nhostname 10.0.0.12\nuser developer\nport 2222\nproxyjump none\n',
          );
        } else {
          call.child.writeStdout(`${testMarker('ok')}\n`);
        }
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, { inspectTunnelConfig: undefined }),
    );

    expect(await service.testMachine(MACHINE)).toEqual({ ok: true });
    expect(spawned.calls).toHaveLength(2);
    expect(spawned.calls[0]?.args).toContain('-G');
    expect(spawned.calls[0]?.args).toContain('ControlPath=none');
    expect(spawned.calls[1]?.args.at(-1)).toContain(REMOTE_TEST_MARKER);
  });

  test('isCommandAvailable uses a validated fixed command probe', async () => {
    const available = recordingSpawn((call, index) => {
      queueMicrotask(() => {
        call.child.writeStdout(`${commandMarker(index === 0)}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(available.spawn));
    expect(await service.isCommandAvailable(MACHINE, 'claude')).toBe(true);
    expect(available.calls[0]?.args.at(-1)).toBe(
      buildIsCommandAvailableCommand('claude', TEST_NONCE),
    );
    expect(await service.isCommandAvailable(MACHINE, 'codex')).toBe(false);

    await expect(service.isCommandAvailable(MACHINE, 'claude; rm -rf /')).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  test('refuses remote tool probes after the effective SSH endpoint drifts', async () => {
    let fingerprint = 'session-fingerprint';
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(`${commandMarker(true)}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        inspectTunnelConfig: async () => fingerprint,
      }),
    );

    await expect(
      service.isCommandAvailable(MACHINE, 'claude', 'session-fingerprint'),
    ).resolves.toBe(true);
    fingerprint = 'changed-fingerprint';
    await expect(
      service.isCommandAvailable(MACHINE, 'claude', 'session-fingerprint'),
    ).rejects.toMatchObject({
      code: 'invalid-machine',
      message: expect.stringContaining('Close and reopen the project'),
    });
    expect(spawned.calls).toHaveLength(1);
  });

  test('listDirectories validates and translates the canonical wire response', async () => {
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(
          `${directoryMarker({
            canonicalPath: '/home/dev/ wiki ',
            parentPath: '/home/dev',
            directories: [
              { name: ' alpha ', path: '/home/dev/ wiki / alpha ' },
              { name: 'beta', path: '/home/dev/ wiki /beta' },
            ],
          })}\n`,
        );
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));
    await expect(service.listDirectories(MACHINE, '~/wiki')).resolves.toEqual({
      path: '/home/dev/ wiki ',
      parentPath: '/home/dev',
      directories: [
        { name: ' alpha ', path: '/home/dev/ wiki / alpha ' },
        { name: 'beta', path: '/home/dev/ wiki /beta' },
      ],
    });
    expect(spawned.calls[0]?.args.at(-1)).not.toContain('~/wiki');
  });

  test('decodes UTF-8 markers split inside a multibyte character', async () => {
    const marker = Buffer.from(
      `${directoryMarker({
        canonicalPath: '/home/dev/café',
        parentPath: '/home/dev',
        directories: [{ name: '研究', path: '/home/dev/café/研究' }],
      })}\n`,
      'utf8',
    );
    const splitAt = marker.indexOf(Buffer.from('é')) + 1;
    expect(splitAt).toBeGreaterThan(0);
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(marker.subarray(0, splitAt));
        call.child.writeStdout(marker.subarray(splitAt));
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));
    await expect(service.listDirectories(MACHINE, '/home/dev/café')).resolves.toEqual({
      path: '/home/dev/café',
      parentPath: '/home/dev',
      directories: [{ name: '研究', path: '/home/dev/café/研究' }],
    });
  });

  test('allows directory payloads above the smaller readiness-marker cap', async () => {
    const directories = Array.from({ length: 500 }, (_, index) => ({
      name: `directory-${index.toString().padStart(4, '0')}`,
      path: `/srv/wiki/directory-${index.toString().padStart(4, '0')}`,
    }));
    const marker = `${directoryMarker({
      canonicalPath: '/srv/wiki',
      parentPath: '/srv',
      directories,
    })}\n`;
    expect(Buffer.byteLength(marker)).toBeGreaterThan(16 * 1024);
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(marker);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));
    const result = await service.listDirectories(MACHINE, '/srv/wiki');
    expect(result.directories).toHaveLength(500);
  });

  test('surfaces the remote directory scan limit explicitly', async () => {
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(`${directoryMarker({ error: 'too-many' })}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));

    await expect(service.listDirectories(MACHINE, '/srv')).rejects.toMatchObject({
      code: 'output-limit',
      message: 'The remote folder contains too many entries.',
    });
  });

  test('surfaces remote directory read failures without forwarding path details', async () => {
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(`${directoryMarker({ error: 'failed' })}\n`);
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));

    await expect(service.listDirectories(MACHINE, '/private/project')).rejects.toMatchObject({
      code: 'ssh-failed',
      message: 'OpenKnowledge could not read that remote folder.',
    });
  });

  test('inspects a project without initializing it', async () => {
    const spawned = recordingProjectSpawn((call) => {
      queueMicrotask(() => {
        call.child.writeStdout(
          `${REMOTE_INSPECT_MARKER}${JSON.stringify({
            v: 1,
            nonce: TEST_NONCE,
            selectedPath: '/srv/wiki',
            projectPath: '/srv/wiki',
            initialized: false,
          })}\n`,
        );
        call.child.close(0);
      });
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));

    await expect(service.inspectProject(MACHINE, '/srv/wiki')).resolves.toEqual({
      selectedPath: '/srv/wiki',
      projectPath: '/srv/wiki',
      initialized: false,
    });
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]?.args.at(-1)).toBe(
      buildRemoteInspectCommand('/srv/wiki', TEST_COMPANION_DIGEST, TEST_NONCE),
    );
  });

  test('starts the remote server and independently closes its tunnel and server owner', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) {
        queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
      } else if (index === 1) {
        emitTunnelReady(call.child);
      }
    });
    const fetch = mock(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ collabUrl: 'ws://localhost:43123/collab', port: 43123 }),
      url,
    }));
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, { fetch, shutdownGraceMs: 5 }),
    );
    const session = await service.startProject(MACHINE, '~/wiki', { initialize: false });

    expect(spawned.calls).toHaveLength(2);
    expect(spawned.calls[0]?.args.at(-1)).toContain('remote-companion.mjs');
    expect(spawned.calls[0]?.args.at(-1)).toContain('--nonce');
    expect(spawned.calls[0]?.args.at(-1)).not.toContain('--initialize');
    expect(spawned.calls[1]?.args).toContain('127.0.0.1:45123:127.0.0.1:43123');
    expect(spawned.calls[0]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawned.calls[1]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:45123/api/config',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(session).toMatchObject({
      localPort: 45123,
      apiOrigin: 'http://127.0.0.1:45123',
      collabUrl: 'ws://127.0.0.1:45123/collab',
      projectPath: '/srv/wiki',
      platform: 'linux',
      pathSeparator: '/',
      owned: true,
    });

    session.closeTunnel();
    session.closeTunnel();
    expect(spawned.calls[0]?.child.stdin.end).not.toHaveBeenCalled();
    expect(spawned.calls[1]?.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawned.calls[0]?.child.kill).not.toHaveBeenCalled();
    expect(spawned.calls[1]?.child.kill).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(spawned.calls[1]?.child.lifecycle).toEqual(['stdin:end', 'kill']);
    expect(spawned.calls[1]?.child.kill).toHaveBeenCalledTimes(1);
    expect(spawned.calls[0]?.child.kill).not.toHaveBeenCalled();

    session.closeServer();
    session.closeServer();
    expect(spawned.calls[0]?.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawned.calls[1]?.child.stdin.end).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(spawned.calls[0]?.child.lifecycle).toEqual(['stdin:end', 'kill']);
    expect(spawned.calls[0]?.child.kill).toHaveBeenCalledTimes(1);
    expect(spawned.calls[1]?.child.kill).toHaveBeenCalledTimes(1);

    session.close();
    session.close();
    expect(spawned.calls[0]?.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawned.calls[1]?.child.stdin.end).toHaveBeenCalledTimes(1);
  });

  test('does not poll HTTP until SSH confirms that its explicit forward is bound', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
      if (index === 1) queueMicrotask(() => call.child.close(255));
    });
    const fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ collabUrl: null, port: 43123 }),
    }));
    const service = new RemoteProjectService(serviceDeps(spawned.spawn, { fetch }));

    await expect(
      service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
    ).rejects.toMatchObject({
      code: 'tunnel-failed',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(spawned.calls[0]?.child.kill).toHaveBeenCalled();
    expect(spawned.calls[1]?.child.kill).toHaveBeenCalled();
  });

  test('accepts only the remote server port announced by the readiness frame', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
      if (index === 1) emitTunnelReady(call.child);
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ collabUrl: null, port: 43124 }),
        }),
        tunnelReadyTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    );

    await expect(
      service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
    ).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  test('fails immediately on non-successful or malformed remote API responses', async () => {
    for (const response of [
      { ok: false, status: 503, text: async () => '' },
      { ok: true, status: 200, text: async () => '{bad json' },
    ]) {
      const spawned = recordingProjectSpawn((call, index) => {
        if (index === 0) queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
        if (index === 1) emitTunnelReady(call.child);
      });
      const fetch = mock(async () => response);
      const service = new RemoteProjectService(serviceDeps(spawned.spawn, { fetch }));

      await expect(
        service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
      ).rejects.toMatchObject({
        code: 'invalid-response',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  test('decodes readiness split inside a multibyte project path', async () => {
    const marker = Buffer.from(`${readyMarker({ projectPath: '/srv/café ' })}\n`, 'utf8');
    const splitAt = marker.indexOf(Buffer.from('é')) + 1;
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) {
        queueMicrotask(() => {
          call.child.writeStdout(marker.subarray(0, splitAt));
          call.child.writeStdout(marker.subarray(splitAt));
        });
      } else if (index === 1) {
        emitTunnelReady(call.child);
      }
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));
    const session = await service.startProject(MACHINE, '/srv/café ', { initialize: false });
    expect(session.projectPath).toBe('/srv/café ');
    session.close();
  });

  test('does not force-kill an owned server that exits after stdin EOF', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) {
        call.child.onStdinEnd = () => queueMicrotask(() => call.child.close(0));
        queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
      } else {
        call.child.onStdinEnd = () => queueMicrotask(() => call.child.close(0));
        emitTunnelReady(call.child);
      }
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn, { shutdownGraceMs: 5 }));
    const session = await service.startProject(MACHINE, '/srv/wiki', { initialize: false });
    session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawned.calls[0]?.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawned.calls[0]?.child.kill).not.toHaveBeenCalled();
    expect(spawned.calls[1]?.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawned.calls[1]?.child.kill).not.toHaveBeenCalled();
  });

  test('rejects an unowned readiness frame', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) {
        queueMicrotask(() => call.child.writeStdout(`${readyMarker({ owned: false })}\n`));
      } else if (index === 1) {
        emitTunnelReady(call.child);
      }
    });
    const service = new RemoteProjectService(serviceDeps(spawned.spawn));
    await expect(
      service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    expect(spawned.calls).toHaveLength(1);
  });

  test('kills both SSH children when the tunneled API never becomes ready', async () => {
    const spawned = recordingProjectSpawn((call, index) => {
      if (index === 0) queueMicrotask(() => call.child.writeStdout(`${readyMarker()}\n`));
      if (index === 1) emitTunnelReady(call.child);
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        fetch: async () => {
          throw new TypeError('not listening');
        },
        tunnelReadyTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    );
    await expect(
      service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(spawned.calls[0]?.child.kill).toHaveBeenCalled();
    expect(spawned.calls[1]?.child.kill).toHaveBeenCalled();
  });

  test('checks typed prerequisites before installing or launching the companion', async () => {
    const cases = [
      [
        'platform-unsupported',
        'unsupported-platform',
        'OpenKnowledge remote projects support macOS and Linux SSH machines.',
      ],
      [
        'node-too-old',
        'prerequisite-outdated',
        'Update Node.js on the SSH machine to version 24 or newer.',
      ],
      ['git-missing', 'prerequisite-missing', 'Install Git 2.31.0 or newer on the SSH machine.'],
      [
        'git-too-old',
        'prerequisite-outdated',
        'Update Git on the SSH machine to version 2.31.0 or newer.',
      ],
    ] as const;
    for (const [status, code, message] of cases) {
      const spawned = recordingSpawn((call) => {
        queueMicrotask(() => {
          call.child.writeStdout(`${testMarker(status)}\n`);
          call.child.close(0);
        });
      });
      const service = new RemoteProjectService(serviceDeps(spawned.spawn));
      await expect(
        service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
      ).rejects.toMatchObject({
        code,
        message,
      });
      expect(spawned.calls).toHaveLength(1);
      expect(spawned.calls[0]?.args.at(-1)).toContain(REMOTE_TEST_MARKER);
    }
  });

  test('surfaces only bounded structured companion startup errors', async () => {
    const cases = [
      ['project-uninitialized', 'project-uninitialized'],
      ['project-initialize-failed', 'project-initialize-failed'],
      ['config-invalid', 'config-invalid'],
      ['content-dir-outside-project', 'content-dir-outside-project'],
      ['startup-failed', 'startup-failed'],
    ] as const;
    for (const [wireCode, code] of cases) {
      const spawned = recordingProjectSpawn((call) => {
        queueMicrotask(() => {
          call.child.writeStdout(
            `${REMOTE_ERROR_MARKER}${JSON.stringify({ v: 1, nonce: TEST_NONCE, code: wireCode })}\n`,
          );
          call.child.close(1);
        });
      });
      const service = new RemoteProjectService(serviceDeps(spawned.spawn));
      await expect(
        service.startProject(MACHINE, '/srv/wiki', { initialize: false }),
      ).rejects.toMatchObject({
        code,
      });
      expect(spawned.calls).toHaveLength(1);
      expect(spawned.calls[0]?.child.kill).toHaveBeenCalled();
    }
  });

  test('bounds child output and terminates an over-producing command', async () => {
    const spawned = recordingSpawn((call) => {
      queueMicrotask(() => call.child.writeStdout('x'.repeat(1025)));
    });
    const service = new RemoteProjectService(
      serviceDeps(spawned.spawn, {
        maxOutputBytes: 1024,
      }),
    );
    await expect(service.listDirectories(MACHINE, '/srv/wiki')).rejects.toMatchObject({
      code: 'output-limit',
    });
    expect(spawned.calls[0]?.child.kill).toHaveBeenCalled();
  });
});
