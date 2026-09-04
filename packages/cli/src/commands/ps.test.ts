import { describe, expect, test } from 'vitest';
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
  capabilities?: string[];
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
      ...(overrides?.capabilities !== undefined ? { capabilities: overrides.capabilities } : {}),
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
  lockPath: '/tmp/notes/.ok/server.lock',
};

const corruptLock: LockState = {
  status: 'corrupt',
  lockPath: '/tmp/notes/.ok/server.lock',
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
      '/tmp/notes/.ok': { server: aliveServerState },
      '/tmp/old-project/.ok': { server: deadServerState },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir) => lockMap[lockDir]?.server ?? missingLock,
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
      inspect: () => foreignServerState,
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
      inspect: () => deadServerState,
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
      '/tmp/notes/.ok': { server: aliveServerState },
      '/tmp/old-project/.ok': { server: deadServerState },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir) => lockMap[lockDir]?.server ?? missingLock,
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
      inspect: () => foreignServerState,
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
      inspect: () => aliveServerState,
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
      inspect: () => foreignServerState,
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
      inspect: () => aliveServerState,
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
      inspect: () => aliveServerState,
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
      inspect: () => deadServerState,
      resolveCommand: () => ELECTRON_UTILITY_COMMAND,
      all: true,
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
      '/tmp/notes/.ok': { server: aliveServerState },
      '/tmp/old-project/.ok': { server: deadServerState },
    };

    const lines: string[] = [];
    await runPs({
      discover: async () => lockDirs,
      inspect: (lockDir) => lockMap[lockDir]?.server ?? missingLock,
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
    const aliveServerState = makeAliveServer({
      worktreeRoot: '/tmp/notes',
      port: 5173,
      capabilities: ['http', 'ws', 'ui'],
    });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: () => aliveServerState,
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
    expect(entry.ui?.port).toBe(5173);
    expect(entry.ui?.pid).toBe(12345);
    expect(entry.server.usage).toEqual({ cpuPercent: 1.2, memPercent: 3.4 });
    expect(entry.ui?.status).toBe('alive');
    expect(entry.ui?.usage).toEqual({ cpuPercent: 1.2, memPercent: 3.4 });
    expect(entry.hostname).toBe('test-host');
    expect(typeof entry.lockPath).toBe('string');
    expect(entry.binary).toBe('/tmp/open-knowledge/packages/cli/src/cli.ts');
    expect(entry.command).toBe(
      '/usr/local/bin/node /tmp/open-knowledge/packages/cli/src/cli.ts start',
    );
    expect(entry.isDesktop).toBe(false);
    expect(entry.displayStatus).toBe('running');
  });

  test('ui is null when server.lock explicitly omits the ui capability (--only server)', async () => {
    const aliveServerState = makeAliveServer({
      worktreeRoot: '/tmp/notes',
      capabilities: ['http', 'ws'],
    });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: () => aliveServerState,
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as Array<{ ui: null | object }>;
    expect(parsed[0]?.ui).toBeNull();
  });

  test('ui reflects the server optimistically when server.lock omits `capabilities` (pre-v2)', async () => {
    const aliveServerState = makeAliveServer({ worktreeRoot: '/tmp/notes', port: 5173 });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: () => aliveServerState,
      json: true,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    const parsed = JSON.parse(output) as Array<{ ui: { port: number } | null }>;
    expect(parsed[0]?.ui).not.toBeNull();
    expect(parsed[0]?.ui?.port).toBe(5173);
  });
});

describe('PORTS column', () => {
  test('server port 0 shows (starting)', async () => {
    const startingServer = makeAliveServer({ worktreeRoot: '/tmp/starting', port: 0 });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/starting/.ok'],
      inspect: () => startingServer,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('(starting)');
  });

  test('server without the ui capability shows — in PORTS', async () => {
    const aliveServer = makeAliveServer({
      worktreeRoot: '/tmp/notes',
      port: 5173,
      capabilities: ['http', 'ws'],
    });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: () => aliveServer,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('5173 / —');
  });

  test('ui-capable server shows the shared port in PORTS (single-listener)', async () => {
    const aliveServer = makeAliveServer({
      worktreeRoot: '/tmp/notes',
      port: 5173,
      capabilities: ['http', 'ws', 'ui'],
    });

    const lines: string[] = [];
    await runPs({
      discover: async () => ['/tmp/notes/.ok'],
      inspect: () => aliveServer,
      log: (msg) => lines.push(msg),
    });

    const output = lines.join('\n');
    expect(output).toContain('5173 / 5173');
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
