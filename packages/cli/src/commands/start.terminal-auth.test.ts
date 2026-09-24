import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigSchema } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BootedStartServer, bootStartServer, runStartCommand, startCommand } from './start.ts';

const bootServerCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@inkeep/open-knowledge-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inkeep/open-knowledge-server')>();
  return {
    ...actual,
    bootServer: (opts: Parameters<typeof actual.bootServer>[0]) => {
      bootServerCalls.push(opts as unknown as Record<string, unknown>);
      return actual.bootServer(opts);
    },
  };
});

describe('--terminal-auth reaches bootServer', () => {
  let tmpDir: string;
  let booted: BootedStartServer | null = null;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-terminal-auth-'));
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    bootServerCalls.length = 0;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {}
      booted = null;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('bootStartServer passes terminalAuthAvailable on, and only when it is true', async () => {
    booted = await bootStartServer({
      config: ConfigSchema.parse({}),
      cwd: tmpDir,
      host: '127.0.0.1',
      skipAutoInit: true,
      terminalAuthAvailable: true,
    });
    expect(bootServerCalls).toHaveLength(1);
    expect(bootServerCalls[0]?.terminalAuthAvailable).toBe(true);
    await booted.destroy();
    booted = null;

    booted = await bootStartServer({
      config: ConfigSchema.parse({}),
      cwd: tmpDir,
      host: '127.0.0.1',
      skipAutoInit: true,
    });
    expect(bootServerCalls).toHaveLength(2);
    expect(bootServerCalls[1]).not.toHaveProperty('terminalAuthAvailable');
  });

  test('the start command forwards --terminal-auth to bootServer, and nothing without it', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exits: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as never);
    const stopServer = async (expected: number) => {
      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(exits).toHaveLength(expected), { timeout: 20_000 });
    };
    try {
      await runStartCommand(ConfigSchema.parse({}), {
        terminalAuth: true,
        only: 'server',
        openBrowser: false,
      });
      expect(bootServerCalls).toHaveLength(1);
      expect(bootServerCalls[0]?.terminalAuthAvailable).toBe(true);
      await stopServer(1);

      await runStartCommand(ConfigSchema.parse({}), { only: 'server', openBrowser: false });
      expect(bootServerCalls).toHaveLength(2);
      expect(bootServerCalls[1]).not.toHaveProperty('terminalAuthAvailable');
      await stopServer(2);
    } finally {
      cwdSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }, 60_000);

  test('the start command parses the hidden flag into its options', async () => {
    const cmd = startCommand(() => ConfigSchema.parse({}));
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    let captured: Record<string, unknown> = {};
    cmd.action((opts: Record<string, unknown>) => {
      captured = opts;
    });
    await cmd.parseAsync(['--terminal-auth', '--no-open-browser'], { from: 'user' });
    expect(captured.terminalAuth).toBe(true);
    expect(cmd.helpInformation()).not.toContain('--terminal-auth');
  });
});
