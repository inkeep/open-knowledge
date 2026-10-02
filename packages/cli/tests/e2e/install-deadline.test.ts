import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createInstallFixture } from './install-fixture.test-helper';
import { installPackedCli } from './packed-install.test-helper';

let fixture: Awaited<ReturnType<typeof createInstallFixture>>;

beforeAll(async () => {
  fixture = await createInstallFixture();
});

afterAll(async () => {
  await fixture.close();
});

function transportFailure(mode: 'locked' | 'fresh'): Error & {
  code: number | string | null;
  killed: boolean;
  signal: string | null;
  stdout: string;
  stderr: string;
} {
  return Object.assign(new Error('Registry request timed out'), {
    code: 1,
    killed: false,
    signal: null,
    stdout: '',
    stderr:
      mode === 'locked'
        ? '{"name":"pnpm:fetching-progress","status":"started"}\nError: ERR_PNPM_TARBALL_FETCH_TARBALL\n\n  × installing dependencies\n  ╰─▶ operation timed out\nRegistry unavailable…\n'
        : 'npm error code ETIMEDOUT\nRegistry unavailable…\n',
  });
}

test.each(['locked', 'fresh'] as const)(
  'fits registry request deadlines inside the acquisition budget in %s mode',
  async (mode) => {
    let clock = 0;
    let attempts = 0;
    const failure = transportFailure(mode);
    const installation = installPackedCli(
      { ...fixture, mode },
      {
        now: () => clock,
        executeInstall: async (_command, args, options) => {
          attempts++;
          const setting = args.find((arg) => arg.startsWith('--fetch-timeout='));
          const requestTimeout = setting
            ? Number(setting.split('=')[1])
            : mode === 'locked'
              ? 60_000
              : 300_000;
          const remaining = options.timeout ?? 0;
          if (requestTimeout >= remaining) {
            clock += remaining;
            throw Object.assign(new Error('Installation deadline expired'), {
              code: null,
              killed: true,
              signal: 'SIGTERM',
              stdout: '',
              stderr: '',
            });
          }
          clock += requestTimeout + 1;
          throw failure;
        },
      },
    );
    await expect(installation).rejects.toMatchObject({
      name: 'CliInstallUnavailableError',
      exitCode: 77,
      outputBytes: 3 * (Buffer.byteLength(failure.stdout) + Buffer.byteLength(failure.stderr)),
    });
    expect(attempts).toBe(3);
  },
);

test.each(['locked', 'fresh'] as const)(
  'keeps classified acquisition unavailable when its deadline expires in %s mode',
  async (mode) => {
    let clock = 0;
    let attempts = 0;
    const installation = installPackedCli(
      { ...fixture, mode },
      {
        now: () => clock,
        executeInstall: async (_command, _args, options) => {
          attempts++;
          clock += options.timeout ?? 0;
          throw Object.assign(transportFailure(mode), {
            code: null,
            killed: true,
            signal: 'SIGTERM',
            stdout: '',
          });
        },
      },
    );
    await expect(installation).rejects.toMatchObject({
      name: 'CliInstallUnavailableError',
      exitCode: 77,
    });
    expect(attempts).toBe(1);
  },
);

test('does not start another installer after the acquisition deadline', async () => {
  let clock = 0;
  let deadline = 0;
  let attempts = 0;
  const installation = installPackedCli(
    { ...fixture, mode: 'fresh' },
    {
      now: () => {
        const current = clock;
        if (attempts > 0) clock = deadline;
        return current;
      },
      executeInstall: async (_command, _args, options) => {
        attempts++;
        if (attempts > 1) throw new Error('Installer started after the deadline');
        deadline = options.timeout ?? 0;
        throw transportFailure('fresh');
      },
    },
  );
  await expect(installation).rejects.toMatchObject({
    name: 'CliInstallUnavailableError',
    exitCode: 77,
  });
  expect(attempts).toBe(1);
});

test.each([
  { name: 'external termination', killed: false, signal: 'SIGTERM', code: null, expired: true },
  { name: 'early termination', killed: true, signal: 'SIGTERM', code: null, expired: false },
  { name: 'another signal', killed: true, signal: 'SIGKILL', code: null, expired: true },
  {
    name: 'output overflow',
    killed: undefined,
    signal: undefined,
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    expired: true,
  },
])(
  'preserves $name and its acquisition diagnostics',
  async ({ name: _name, expired, ...fields }) => {
    let clock = 0;
    let attempts = 0;
    let diagnostics = '';
    const output = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      diagnostics += String(chunk);
      return true;
    });
    const failure = Object.assign(transportFailure('fresh'), fields);
    try {
      const installation = installPackedCli(
        { ...fixture, mode: 'fresh' },
        {
          now: () => clock,
          executeInstall: async (_command, _args, options) => {
            attempts++;
            if (expired) clock += options.timeout ?? 0;
            throw failure;
          },
        },
      );
      await expect(installation).rejects.toBe(failure);
      expect(diagnostics).toContain(failure.stderr);
      expect(attempts).toBe(1);
    } finally {
      output.mockRestore();
    }
  },
);

test.each(['locked', 'fresh'] as const)(
  'does not assign a prior transport failure to a silent deadline in %s mode',
  async (mode) => {
    let clock = 0;
    let attempts = 0;
    const failure = Object.assign(new Error('Installation deadline expired'), {
      code: null,
      killed: true,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });
    const installation = installPackedCli(
      { ...fixture, mode },
      {
        now: () => clock,
        executeInstall: async (_command, _args, options) => {
          attempts++;
          if (attempts === 1) throw transportFailure(mode);
          clock += options.timeout ?? 0;
          throw failure;
        },
      },
    );
    await expect(installation).rejects.toMatchObject({
      message: expect.stringContaining('acquisition deadline elapsed on attempt 2 of 3.'),
      cause: failure,
    });
    expect(attempts).toBe(2);
  },
);

test.each(['locked', 'fresh'] as const)(
  'preserves lifecycle failures at the deadline in %s mode',
  async (mode) => {
    let clock = 0;
    let attempts = 0;
    const failure = Object.assign(transportFailure(mode), {
      code: null,
      killed: true,
      signal: 'SIGTERM',
    });
    if (mode === 'locked') failure.stdout += '{"level":"error","code":"ELIFECYCLE"}\n';
    else failure.stderr += 'npm error code ELIFECYCLE\n';
    const installation = installPackedCli(
      { ...fixture, mode },
      {
        now: () => clock,
        executeInstall: async (_command, _args, options) => {
          attempts++;
          clock += options.timeout ?? 0;
          throw failure;
        },
      },
    );
    await expect(installation).rejects.toMatchObject({
      message: expect.stringContaining('acquisition deadline elapsed on attempt 1 of 3.'),
      cause: failure,
    });
    expect(attempts).toBe(1);
  },
);

test('preserves unclassified pnpm exits with optional acquisition errors', async () => {
  let attempts = 0;
  const failure = Object.assign(transportFailure('locked'), {
    stdout: '',
    stderr:
      '{"name":"pnpm:fetching-progress","status":"started","packageId":"ok-cli-fixture-leaf@1.0.0"}\nRegistry unavailable…\n',
  });
  const installation = installPackedCli(fixture, {
    now: () => 0,
    executeInstall: async () => {
      attempts++;
      throw failure;
    },
  });
  await expect(installation).rejects.toThrow('Packed CLI pnpm installation failed');
  await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
  expect(attempts).toBe(1);
});

const UNFINISHED_LEAF_FETCH =
  '{"name":"pnpm:fetching-progress","status":"started","packageId":"ok-cli-fixture-leaf@1.0.0"}\n';

test('an install killed at the acquisition deadline makes no refetch requests', async () => {
  let clock = 0;
  const before = fixture.requests.length;
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const installation = installPackedCli(
      { ...fixture, mode: 'locked' },
      {
        now: () => clock,
        executeInstall: async (_command, _args, options) => {
          clock += options.timeout ?? 0;
          throw Object.assign(new Error('Installation deadline expired'), {
            code: null,
            killed: true,
            signal: 'SIGTERM',
            stdout: '',
            stderr: UNFINISHED_LEAF_FETCH,
          });
        },
      },
    );
    await expect(installation).rejects.toThrow('acquisition deadline elapsed');
    expect(fixture.requests.slice(before).filter((path) => path.endsWith('.tgz'))).toEqual([]);
  } finally {
    output.mockRestore();
  }
});

test('a silent optional skip with no budget left is not checked against the registry', async () => {
  let clock = 0;
  const before = fixture.requests.length;
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const installation = installPackedCli(
      { ...fixture, mode: 'locked' },
      {
        now: () => clock,
        executeInstall: async (_command, _args, options) => {
          clock += options.timeout ?? 0;
          return { stdout: '', stderr: UNFINISHED_LEAF_FETCH };
        },
      },
    );
    await expect(installation).rejects.toThrow('the acquisition deadline left no time to check it');
    await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
    expect(fixture.requests.slice(before).filter((path) => path.endsWith('.tgz'))).toEqual([]);
  } finally {
    output.mockRestore();
  }
});

test("a failed install with budget left leaves its unfinished fetches to pnpm's own errors", async () => {
  const before = fixture.requests.length;
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const installation = installPackedCli(
      { ...fixture, mode: 'locked' },
      {
        now: () => 0,
        executeInstall: async () => {
          throw Object.assign(new Error('Registry request timed out'), {
            code: 1,
            killed: false,
            signal: null,
            stdout: '',
            stderr: `${UNFINISHED_LEAF_FETCH}Error: ERR_PNPM_TARBALL_FETCH_TARBALL\n\n  × installing dependencies\n  ╰─▶ operation timed out\n`,
          });
        },
      },
    );
    await expect(installation).rejects.toMatchObject({ name: 'CliInstallUnavailableError' });
    expect(fixture.requests.slice(before).filter((path) => path.endsWith('.tgz'))).toEqual([]);
  } finally {
    output.mockRestore();
  }
});
