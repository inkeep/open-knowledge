import { Command, CommanderError } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import { type V1StatusDocument, type V1StopDocument, v1Result } from './supervision-json-v1.ts';
import { addV1FormatOption, writeV1Document } from './supervision-json-v1-output.ts';

const statusDocument: V1StatusDocument = {
  schemaVersion: 1,
  command: 'status',
  result: v1Result('status', 'observed'),
  project: { root: '/projects/wiki', resolution: 'cwd' },
  server: {
    lock: { path: '/projects/wiki/.ok/local/server.lock', state: 'missing' },
    process: null,
    alive: false,
    identity: null,
    runtimeVersion: null,
    protocolVersion: null,
    capabilities: null,
    launchKind: null,
    readiness: { status: 'not-running', checkedAt: null, degraded: [] },
    runtime: null,
  },
};

const refusedStopDocument: V1StopDocument = {
  schemaVersion: 1,
  command: 'stop',
  result: v1Result('stop', 'clients-connected', 'Two clients remain.'),
  target: { kind: 'project', value: null, projectRoot: '/projects/wiki' },
  force: false,
  targets: [
    {
      lockPath: '/projects/wiki/.ok/local/server.lock',
      projectRoot: '/projects/wiki',
      serverInstanceId: null,
      pid: 1234,
      port: 4242,
      code: 'clients-connected',
      detail: 'Two clients remain.',
    },
  ],
};

function captureWrite(document: V1StatusDocument | V1StopDocument) {
  const stdout: Buffer[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const completed = writeV1Document(document, {
    write: (bytes, offset) => {
      const remaining = Buffer.from(bytes).subarray(offset);
      stdout.push(remaining);
      return remaining.length;
    },
    diagnostic: (message) => stderr.push(message),
    setExitCode: (code) => exits.push(code),
  });
  return { completed, stdout: Buffer.concat(stdout).toString('utf8'), stderr, exits };
}

async function parseIsolatedCommand(name: 'status' | 'ps' | 'stop' | 'clean', args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const actions: Array<{ format?: string; json?: boolean }> = [];
  const program = new Command().exitOverride().configureOutput({
    writeOut: (value) => stdout.push(value),
    writeErr: (value) => stderr.push(value),
  });
  const command = new Command(name)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => stdout.push(value),
      writeErr: (value) => stderr.push(value),
    })
    .action((options: { format?: string; json?: boolean }) => {
      actions.push(options);
    });
  if (name === 'status' || name === 'ps') command.option('--json');
  program.addCommand(addV1FormatOption(command, name === 'status' || name === 'ps'));

  let exitCode = 0;
  try {
    await program.parseAsync([name, ...args], { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), actions, exitCode };
}

describe('v1 document writer', () => {
  test('emits one complete object and one newline with no diagnostic bytes', () => {
    const status = captureWrite(statusDocument);
    expect(status).toEqual({
      completed: true,
      stdout: `${JSON.stringify(statusDocument)}\n`,
      stderr: [],
      exits: [0],
    });
    expect(JSON.parse(status.stdout)).toEqual(statusDocument);
    expect(status.stdout.split('\n')).toHaveLength(2);

    const refused = captureWrite(refusedStopDocument);
    expect(refused.stdout).toBe(`${JSON.stringify(refusedStopDocument)}\n`);
    expect(refused.stderr).toEqual([]);
    expect(refused.exits).toEqual([1]);
  });

  test('completes short writes without adding another document', () => {
    const chunks: Buffer[] = [];
    const exits: number[] = [];
    expect(
      writeV1Document(statusDocument, {
        write: (bytes, offset) => {
          const chunk = Buffer.from(bytes).subarray(offset, offset + 3);
          chunks.push(chunk);
          return chunk.length;
        },
        setExitCode: (code) => exits.push(code),
      }),
    ).toBe(true);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(`${JSON.stringify(statusDocument)}\n`);
    expect(exits).toEqual([0]);
  });

  test('serialization and write failures use stderr and exit 1', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const stderr: string[] = [];
    const exits: number[] = [];
    const writes: Uint8Array[] = [];
    const deps = {
      write: (bytes: Uint8Array) => {
        writes.push(bytes);
        throw new Error('EPIPE');
      },
      diagnostic: (message: string) => stderr.push(message),
      setExitCode: (code: 0 | 1) => exits.push(code),
    };

    expect(writeV1Document(cyclic as unknown as V1StatusDocument, deps)).toBe(false);
    expect(writes).toEqual([]);
    expect(stderr[0]).toContain('Could not write supervision JSON');
    expect(exits).toEqual([1]);

    expect(writeV1Document(statusDocument, deps)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(stderr[1]).toContain('EPIPE');
    expect(exits).toEqual([1, 1]);
  });

  test('the default failure diagnostic goes to stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exits: number[] = [];
    try {
      expect(
        writeV1Document(statusDocument, {
          write: () => {
            throw new Error('closed pipe');
          },
          setExitCode: (code) => exits.push(code),
        }),
      ).toBe(false);
      expect(stderr).toHaveBeenCalledWith('Could not write supervision JSON: closed pipe');
      expect(exits).toEqual([1]);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('isolated v1 format option', () => {
  test.each(['status', 'ps', 'stop', 'clean'] as const)(
    '%s accepts both spellings of json-v1',
    async (name) => {
      for (const args of [['--format', 'json-v1'], ['--format=json-v1']]) {
        const parsed = await parseIsolatedCommand(name, args);
        expect(parsed.exitCode).toBe(0);
        expect(parsed.stdout).toBe('');
        expect(parsed.stderr).toBe('');
        expect(parsed.actions).toHaveLength(1);
        expect(parsed.actions[0]?.format).toBe('json-v1');
      }
    },
  );

  test.each(['status', 'ps', 'stop', 'clean'] as const)(
    '%s rejects unsupported and missing values before its action',
    async (name) => {
      for (const args of [['--format', 'yaml'], ['--format']]) {
        const parsed = await parseIsolatedCommand(name, args);
        expect(parsed.exitCode).not.toBe(0);
        expect(parsed.stdout).toBe('');
        expect(parsed.stderr).toContain('error:');
        expect(parsed.actions).toEqual([]);
      }
    },
  );

  test.each(['status', 'ps'] as const)(
    '%s rejects legacy --json conflicts in either order',
    async (name) => {
      for (const args of [
        ['--json', '--format', 'json-v1'],
        ['--format', 'json-v1', '--json'],
      ]) {
        const parsed = await parseIsolatedCommand(name, args);
        expect(parsed.exitCode).not.toBe(0);
        expect(parsed.stdout).toBe('');
        expect(parsed.stderr).toContain('cannot be used with option');
        expect(parsed.actions).toEqual([]);
      }
    },
  );

  test.each(['stop', 'clean'] as const)('%s still rejects --json', async (name) => {
    const parsed = await parseIsolatedCommand(name, ['--json', '--format', 'json-v1']);
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.stdout).toBe('');
    expect(parsed.stderr).toContain("unknown option '--json'");
    expect(parsed.actions).toEqual([]);
  });
});
