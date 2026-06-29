
import { describe, expect, test } from 'bun:test';
import { extractOkBinaryPath } from '../utils/process-scan.ts';
import type { LockState } from './lock-state.ts';
import { isDesktopCommand, renderTable, runPs, timeAgo } from './ps.ts';

const ELECTRON_UTILITY_COMMAND =
  '/path/to/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US';


function makeAliveServer(overrides?: {
  worktreeRoot?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
  hostname?: string;
}): LockState {
  return {
    status: 'alive',
    lockPath: `${overrides?.worktreeRoot ?? '/tmp/notes'}/.ok/server.lock`,
    lock: {
      pid: overrides?.pid ?? 12345,
      hostname: overrides?.hostname ?? 'test-host',
      port: overrides?.port ?? 5173,
      startedAt: overrides?.startedAt ?? '2026-05-05T08:00:00.000Z',
      worktreeRoot: overrides?.worktreeRoot ?? '/tmp/notes',
    },
  };
}

function makeDeadServer(overrides?: {
  worktreeRoot?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
}): LockState {
  return {
    status: 'dead-pid',
    lockPath: `${overrides?.worktreeRoot ?? '/tmp/old-project'}/.ok/server.lock`,
    lock: {
      pid: overrides?.pid ?? 44444,
      hostname: 'test-host',
      port: overrides?.port ?? 5173,
      startedAt: overrides?.startedAt ?? '2026-05-01T00:00:00.000Z',
      worktreeRoot: overrides?.worktreeRoot ?? '/tmp/old-project',
    },
  };
}

function makeForeignServer(overrides?: {
  worktreeRoot?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
}): LockState {
  return {
    status: 'foreign-host',
    lockPath: `${overrides?.worktreeRoot ?? '/tmp/shared'}/.ok/server.lock`,
    lock: {
      pid: overrides?.pid ?? 99999,
      hostname: 'other-host',
      port: overrides?.port ?? 6000,
      startedAt: overrides?.startedAt ?? '2026-05-04T10:00:00.000Z',
      worktreeRoot: overrides?.worktreeRoot ?? '/tmp/shared',
    },
  };
}

const missingLock: LockState = {
  status: 'missing',
  lockPath: '/tmp/notes/.ok/ui.lock',
};

const corruptLock: LockState = {
  status: 'corrupt',
  lockPath: '/tmp/notes/.ok/ui.lock',
};


describe('timeAgo', () => {
  test('returns seconds when diff < 60s', () => {
    const now = new Date('2026-05-05T10:00:30.000Z').getTime();
    expect(timeAgo('2026-05-05T10:00:00.000Z', now)).toBe('30s');
  });

  test('returns minutes ago when diff < 1h', () => {
    const now = new Date('2026-05-05T10:05:00.000Z').getTime();
    expect(timeAgo('2026-05-05T10:00:00.000Z', now)).toBe('5m ago');
  });

  test('returns hours ago when diff < 24h', () => {
    const now = new Date('2026-05-05T12:00:00.000Z').getTime();
    expect(timeAgo('2026-05-05T10:00:00.000Z', now)).toBe('2h ago');
  });

  test('returns days ago when diff >= 24h', () => {
    const now = new Date('2026-05-08T10:00:00.000Z').getTime();
    expect(timeAgo('2026-05-05T10:00:00.000Z', now)).toBe('3d ago');
  });

  test('returns — for invalid ISO string', () => {
    expect(timeAgo('not-a-date')).toBe('—');
  });
});


describe('runPs default (alive + foreign-host)', () => {
  test('shows alive server, hides dead-pid server', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });
    const deadServerState = makeDeadServer({ worktreeRoot: '/tmp/old-project' });

    const lockDirs = ['/tmp/notes/.ok', '/tmp/old-project/.ok'];
    const lockMap: Record<string, Record<string, LockState>> = {
      '/tmp/notes/.ok': { server: aliveServerState, ui: missingLock },
      '/tmp/old-project/.ok': { server: deadServerState, ui: missingLock },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir, name) => lockMap[lockDir]?.[name] ?? missingLock,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/notes');
    expect(output).not.toContain('/tmp/old-project');
  });

  test('shows foreign-host server by default (hostname drift case)', async () => {
    const foreignServerState = makeForeignServer({ worktreeRoot: '/tmp/shared' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/shared/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? foreignServerState : missingLock),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/shared');
    expect(output).toContain('foreign');
  });

  test('prints empty state message when no alive servers', async () => {
    const deadServerState = makeDeadServer({ worktreeRoot: '/tmp/old-project' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/old-project/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServerState : missingLock),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toBe('No open-knowledge servers found.');
  });

  test('prints empty state message when no servers discovered at all', async () => {
    const lines: string[] = [];
    await runPs({
      discover: async () => [],
      inspect: () => missingLock,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toBe('No open-knowledge servers found.');
  });
});


describe('runPs --all', () => {
  test('includes dead-pid entries', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });
    const deadServerState = makeDeadServer({ worktreeRoot: '/tmp/old-project' });

    const lockDirs = ['/tmp/notes/.ok', '/tmp/old-project/.ok'];
    const lockMap: Record<string, Record<string, LockState>> = {
      '/tmp/notes/.ok': { server: aliveServerState, ui: missingLock },
      '/tmp/old-project/.ok': { server: deadServerState, ui: missingLock },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir, name) => lockMap[lockDir]?.[name] ?? missingLock,
      all: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/notes');
    expect(output).toContain('/tmp/old-project');
    expect(output).toContain('stale');
    expect(output).toContain('running');
  });

  test('includes foreign-host entries', async () => {
    const foreignServerState = makeForeignServer({ worktreeRoot: '/tmp/shared' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/shared/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? foreignServerState : missingLock),
      all: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/shared');
    expect(output).toContain('foreign');
  });
});


describe('isDesktopCommand', () => {
  test('returns true for Electron utility process with NodeService sub-type', () => {
    expect(isDesktopCommand(ELECTRON_UTILITY_COMMAND)).toBe(true);
  });

  test('returns false for CLI start command', () => {
    expect(
      isDesktopCommand('/usr/local/bin/node /opt/open-knowledge/packages/cli/dist/cli.mjs start'),
    ).toBe(false);
  });

  test('returns false for null command', () => {
    expect(isDesktopCommand(null)).toBe(false);
  });

  test('returns false for non-Electron Chromium utility (e.g. VS Code, Slack)', () => {
    expect(
      isDesktopCommand(
        '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility --utility-sub-type=network.mojom.NetworkService',
      ),
    ).toBe(false);
    expect(
      isDesktopCommand(
        '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=utility',
      ),
    ).toBe(false);
  });
});

describe('runPs desktop labeling', () => {
  test('alive server with --type=utility command shows "desktop" label', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : missingLock),
      resolveCommand: () => ELECTRON_UTILITY_COMMAND,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/notes');
    expect(output).toContain('desktop');
    expect(output).not.toMatch(/\brunning\b/);
  });

  test('foreign-host server with --type=utility command shows "desktop", not "foreign"', async () => {
    const foreignServerState = makeForeignServer({ worktreeRoot: '/tmp/vault' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/vault/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? foreignServerState : missingLock),
      resolveCommand: () => ELECTRON_UTILITY_COMMAND,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/vault');
    expect(output).toContain('desktop');
    expect(output).not.toContain('foreign');
  });

  test('alive server with non-utility command keeps "running" label', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : missingLock),
      resolveCommand: () =>
        '/usr/local/bin/node /opt/open-knowledge/packages/cli/dist/cli.mjs start',
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('running');
    expect(output).not.toContain('desktop');
  });

  test('JSON output exposes isDesktop flag', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : missingLock),
      resolveCommand: () => ELECTRON_UTILITY_COMMAND,
      json: true,
      log: (msg) => lines.push(msg),
    });

    const parsed = JSON.parse(lines.join('\n')) as Array<{ isDesktop: boolean }>;
    expect(parsed[0]?.isDesktop).toBe(true);
  });

  test('dead-pid + Electron command keeps "stale" label (not "desktop")', async () => {
    const deadServerState = makeDeadServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServerState : missingLock),
      resolveCommand: () => ELECTRON_UTILITY_COMMAND,
      all: true, // dead-pid hidden by default
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('stale');
    expect(output).not.toContain('desktop');
  });
});


describe('runPs --json', () => {
  test('includes all statuses unconditionally', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });
    const deadServerState = makeDeadServer({ worktreeRoot: '/tmp/old-project' });

    const lockDirs = ['/tmp/notes/.ok', '/tmp/old-project/.ok'];
    const lockMap: Record<string, Record<string, LockState>> = {
      '/tmp/notes/.ok': { server: aliveServerState, ui: missingLock },
      '/tmp/old-project/.ok': { server: deadServerState, ui: missingLock },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir, name) => lockMap[lockDir]?.[name] ?? missingLock,
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    const dirs = (parsed as Array<{ directory: string }>).map((e) => e.directory);
    expect(dirs).toContain('/tmp/notes');
    expect(dirs).toContain('/tmp/old-project');
  });

  test('json output shape has required fields', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes', port: 5173 });
    const aliveUiState: LockState = {
      status: 'alive',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: 23456,
        hostname: 'test-host',
        port: 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : aliveUiState),
      resolveCommand: () => '/usr/local/bin/node /tmp/open-knowledge/packages/cli/src/cli.ts start',
      resolveUsage: (pid) =>
        pid === 12345 ? { cpuPercent: 1.2, memPercent: 3.4 } : { cpuPercent: 5.6, memPercent: 7.8 },
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as Array<{
      directory: string;
      server: {
        port: number;
        status: string;
        pid: number;
        startedAt: string;
        usage: { cpuPercent: number; memPercent: number } | null;
      };
      ui: {
        port: number;
        status: string;
        pid: number;
        startedAt: string;
        usage: { cpuPercent: number; memPercent: number } | null;
      } | null;
      hostname: string;
      lockPath: string;
      binary: string | null;
      command: string | null;
      isDesktop: boolean;
      displayStatus: string;
    }>;

    expect(parsed).toHaveLength(1);
    const entry = parsed[0];
    if (!entry) throw new Error('Expected at least one entry in JSON output');
    expect(entry.directory).toBe('/tmp/notes');
    expect(entry.server.port).toBe(5173);
    expect(entry.server.status).toBe('alive');
    expect(entry.server.pid).toBe(12345);
    expect(typeof entry.server.startedAt).toBe('string');
    expect(entry.ui).not.toBeNull();
    expect(entry.ui?.port).toBe(3001);
    expect(entry.server.usage).toEqual({ cpuPercent: 1.2, memPercent: 3.4 });
    expect(entry.ui?.status).toBe('alive');
    expect(entry.ui?.usage).toEqual({ cpuPercent: 5.6, memPercent: 7.8 });
    expect(entry.hostname).toBe('test-host');
    expect(typeof entry.lockPath).toBe('string');
    expect(entry.binary).toBe('/tmp/open-knowledge/packages/cli/src/cli.ts');
    expect(entry.command).toBe(
      '/usr/local/bin/node /tmp/open-knowledge/packages/cli/src/cli.ts start',
    );
    expect(entry.isDesktop).toBe(false);
    expect(entry.displayStatus).toBe('running');
  });

  test('ui is null when ui lock is missing', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : missingLock),
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as Array<{ ui: null | object }>;
    expect(parsed[0]?.ui).toBeNull();
  });

  test('ui is null when ui lock is corrupt', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServerState : corruptLock),
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as Array<{ ui: null | object }>;
    expect(parsed[0]?.ui).toBeNull();
  });
});


describe('PORTS column', () => {
  test('server port 0 shows (starting)', async () => {
    const startingServer = makeAliveServer({ worktreeRoot: '/tmp/starting', port: 0 });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/starting/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? startingServer : missingLock),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('(starting)');
  });

  test('missing ui shows — in PORTS', async () => {
    const aliveServer = makeAliveServer({ worktreeRoot: '/tmp/notes', port: 5173 });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServer : missingLock),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('5173 / —');
  });

  test('alive ui shows port in PORTS', async () => {
    const aliveServer = makeAliveServer({ worktreeRoot: '/tmp/notes', port: 5173 });
    const aliveUi: LockState = {
      status: 'alive',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: 23456,
        hostname: 'test-host',
        port: 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServer : aliveUi),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('5173 / 3001');
  });

  test('foreign-host ui shows port in PORTS (post inspectLock-reorder)', async () => {
    const aliveServer = makeAliveServer({ worktreeRoot: '/tmp/notes', port: 5173 });
    const foreignUi: LockState = {
      status: 'foreign-host',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: 23456,
        hostname: 'old-bonjour-name',
        port: 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServer : foreignUi),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('5173 / 3001');
  });
});


describe('ui-orphan label', () => {
  function makeAliveUi(overrides?: { pid?: number; port?: number }): LockState {
    return {
      status: 'alive',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: overrides?.pid ?? 23456,
        hostname: 'test-host',
        port: overrides?.port ?? 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };
  }
  function makeForeignUi(overrides?: { pid?: number; port?: number }): LockState {
    return {
      status: 'foreign-host',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: overrides?.pid ?? 23456,
        hostname: 'old-bonjour-name',
        port: overrides?.port ?? 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };
  }

  test('dead server + alive ui → "ui-orphan", visible by default', async () => {
    const deadServer = makeDeadServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServer : makeAliveUi()),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('/tmp/notes');
    expect(output).toContain('ui-orphan');
    expect(output).not.toMatch(/\bstale\b/);
  });

  test('dead server + foreign-host ui (live PID) also → "ui-orphan"', async () => {
    const deadServer = makeDeadServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServer : makeForeignUi()),
      log: (msg) => lines.push(msg),
    });

    expect(lines.join('\n')).toContain('ui-orphan');
  });

  test('dead server + dead ui → "stale" (not orphan)', async () => {
    const deadServer = makeDeadServer({ worktreeRoot: '/tmp/notes' });
    const deadUi: LockState = {
      status: 'dead-pid',
      lockPath: '/tmp/notes/.ok/ui.lock',
      lock: {
        pid: 999,
        hostname: 'test-host',
        port: 3001,
        startedAt: '2026-05-05T08:01:00.000Z',
        worktreeRoot: '/tmp/notes',
      },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServer : deadUi),
      all: true, // stale needs --all to show at all
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('stale');
    expect(output).not.toContain('ui-orphan');
  });

  test('alive server + alive ui → "running" (orphan only when server dead)', async () => {
    const aliveServer = makeAliveServer({ worktreeRoot: '/tmp/notes' });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? aliveServer : makeAliveUi()),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('running');
    expect(output).not.toContain('ui-orphan');
  });

  test('ui-orphan row shows live UI PID, not dead server PID', async () => {
    const deadServer = makeDeadServer({ worktreeRoot: '/tmp/notes', pid: 44444 });
    const aliveUi = makeAliveUi({ pid: 23456 });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: (_lockDir, name) => (name === 'server' ? deadServer : aliveUi),
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('ui-orphan');
    expect(output).toContain('23456'); // UI PID
    expect(output).not.toContain('44444'); // dead server PID
  });
});


describe('server lock missing/corrupt discards entry', () => {
  test('missing server lock: entry discarded', async () => {
    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/gone/.ok'],
      inspect: () => missingLock,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toBe('No open-knowledge servers found.');
  });

  test('corrupt server lock: entry discarded', async () => {
    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/gone/.ok'],
      inspect: () => corruptLock,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toBe('No open-knowledge servers found.');
  });
});


describe('renderTable', () => {
  test('renders header row', () => {
    const output = renderTable([]);
    expect(output).toBe('No open-knowledge servers found.');
  });

  test('table has DIRECTORY, PORTS, CPU/MEM, STATUS, PID, STARTED, BINARY header columns', () => {
    const entry = {
      directory: '/tmp/notes',
      server: {
        port: 5173,
        status: 'alive' as const,
        pid: 12345,
        startedAt: '2026-05-05T08:00:00.000Z',
        usage: { cpuPercent: 1.2, memPercent: 3.4 },
      },
      ui: null,
      hostname: 'test-host',
      lockPath: '/tmp/notes/.ok/server.lock',
      binary: '/tmp/open-knowledge/packages/cli/src/cli.ts',
      command: '/usr/local/bin/node /tmp/open-knowledge/packages/cli/src/cli.ts start',
      isDesktop: false,
    };

    const output = renderTable([entry]);
    const firstLine = output.split('\n')[0] ?? '';
    expect(firstLine).toContain('DIRECTORY');
    expect(firstLine).toContain('PORTS');
    expect(firstLine).toContain('CPU/MEM');
    expect(firstLine).toContain('STATUS');
    expect(firstLine).toContain('PID');
    expect(firstLine).toContain('STARTED');
    expect(firstLine).toContain('BINARY');
    expect(output).toContain('1.2% / 3.4% | —');
    expect(output).toContain('/tmp/open-knowledge/packages/cli/src/cli.ts');
  });
});


describe('extractOkBinaryPath', () => {
  test('extracts source cli path from node invocation', () => {
    expect(
      extractOkBinaryPath(
        'node /Users/mike/src/agents-private/public/open-knowledge/packages/cli/src/cli.ts start',
      ),
    ).toBe('/Users/mike/src/agents-private/public/open-knowledge/packages/cli/src/cli.ts');
  });

  test('extracts npx-installed open-knowledge bin path', () => {
    expect(
      extractOkBinaryPath(
        '/usr/local/bin/node /Users/mike/.npm/_npx/64e3e56af53daa3b/node_modules/.bin/open-knowledge start',
      ),
    ).toBe('/Users/mike/.npm/_npx/64e3e56af53daa3b/node_modules/.bin/open-knowledge');
  });

  test('ignores package specifier in npm exec parent command', () => {
    expect(extractOkBinaryPath('npm exec @inkeep/open-knowledge mcp HOME=/Users/mike')).toBeNull();
  });
});
