import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, type TestContext, test } from 'vitest';
import { DESKTOP_VARIANTS, parseDesktopVariantName } from '../../src/shared/desktop-variant';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const packageDirInput = process.env.OK_LINUX_PACKAGE_DIR?.trim() ?? '';
const packageDir = packageDirInput === '' ? null : resolve(desktopRoot, packageDirInput);

const PTY_PROBE_OUTPUT = 'node-pty-spawned';

interface NodePtyProbeRun {
  error: Error | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runNodePtyProbe(
  executable: string,
  nodePty: string,
  signal: AbortSignal,
): Promise<NodePtyProbeRun> {
  const probe = [
    `const pty = require(${JSON.stringify(nodePty)});`,
    `const child = pty.spawn('/bin/sh', ['-c', 'printf ${PTY_PROBE_OUTPUT}'], {});`,
    "let output = '';",
    'child.onData((data) => { output += data; });',
    'child.onExit(({ exitCode }) => process.stdout.write(JSON.stringify({ output, exitCode })));',
  ].join('\n');
  return new Promise((resolveRun) => {
    const run: NodePtyProbeRun = { error: null, code: null, signal: null, stdout: '', stderr: '' };
    const child = spawn(executable, ['-e', probe], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      signal,
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      run.stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      run.stderr += chunk;
    });
    child.on('error', (error) => {
      run.error = error;
    });
    child.on('close', (code, closeSignal) => {
      run.code = code;
      run.signal = closeSignal;
      resolveRun(run);
    });
  });
}

function nodePtyProbeProblems(executable: string, run: NodePtyProbeRun): string[] {
  if (run.error?.name === 'AbortError') return ['it was stopped when the test timed out'];
  if (run.error) return [`${executable} could not be run: ${run.error.message}`];
  if (run.signal !== null) return [`it was killed by ${run.signal}`];
  if (run.code !== 0) return [`it exited ${run.code}`];
  let result: { output?: unknown; exitCode?: unknown };
  try {
    result = JSON.parse(run.stdout);
  } catch {
    return ['it printed no node-pty result'];
  }
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`the shell node-pty spawned exited ${result.exitCode}`);
  if (!String(result.output).includes(PTY_PROBE_OUTPUT)) {
    problems.push(`the shell's output lacks "${PTY_PROBE_OUTPUT}"`);
  }
  return problems;
}

function probeTranscript(executable: string, run: NodePtyProbeRun): string {
  return [
    `node-pty probe through ${executable}`,
    `stdout: ${JSON.stringify(run.stdout.slice(-400))}`,
    `stderr: ${JSON.stringify(run.stderr)}`,
  ].join('\n');
}

async function expectNodePtyProbeSpawns(
  executable: string,
  nodePty: string,
  { signal, onTestFailed }: TestContext,
): Promise<void> {
  const probe = runNodePtyProbe(executable, nodePty, signal);
  const expectSpawned = (run: NodePtyProbeRun) =>
    expect(nodePtyProbeProblems(executable, run), probeTranscript(executable, run)).toEqual([]);
  onTestFailed(async () => {
    if (signal.aborted) expectSpawned(await probe);
  });
  expectSpawned(await probe);
}

const workspaceNodePty = () => dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));

type ProbeTest = readonly [suite: string, name: string];

const LOCAL_PROBE_TEST: ProbeTest = [
  'node-pty probe',
  'loads node-pty in Node mode and spawns a command',
];
const PACKAGED_PROBE_TEST: ProbeTest = [
  'packaged Linux terminal',
  'loads node-pty from the packaged app with its own Electron and spawns a command',
];

const FAIL_NATIVE_LOADS = [
  "if (process.env.ELECTRON_RUN_AS_NODE === '1') {",
  '  const dlopen = process.dlopen;',
  '  process.dlopen = (module, _filename, ...flags) => dlopen(module, __filename, ...flags);',
  '}',
].join('\n');

function hangAfterPrinting(stdout: string, stderr: string): string {
  return [
    "if (process.env.ELECTRON_RUN_AS_NODE === '1') {",
    "  const { writeSync } = require('node:fs');",
    `  writeSync(1, ${JSON.stringify(`${stdout}\n`)});`,
    `  writeSync(2, ${JSON.stringify(`${stderr}\n`)});`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '}',
  ].join('\n');
}

function scratchDirectory(onTestFinished: TestContext['onTestFinished']): string {
  const directory = mkdtempSync(join(tmpdir(), 'ok-pty-probe-report-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function faultEnvironment(scratch: string, fault: string): Record<string, string> {
  const preload = join(scratch, 'fault.cjs');
  writeFileSync(preload, fault);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('VITEST')) continue;
    if (key === 'GITHUB_STEP_SUMMARY' || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim();
  return env;
}

async function failureReport(
  [suite, name]: ProbeTest,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<{ report: string; output: string }> {
  const vitest = join(
    dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitest,
        'run',
        relative(desktopRoot, fileURLToPath(import.meta.url)),
        '--testNamePattern',
        `${suite}(?: >)? ${name}$`,
        '--reporter=github-actions',
        '--maxWorkers=1',
      ],
      { cwd: desktopRoot, env, signal },
    );
    let captured = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      captured += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      captured += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolveOutput(captured));
  });
  const report = output
    .split('\n')
    .filter((line) => line.startsWith('::error '))
    .map((line) => [line.slice(0, line.indexOf('::', 2)), line.slice(line.indexOf('::', 2) + 2)])
    .filter(([properties]) => properties?.includes(`${suite} > ${name}`))
    .map(([, data]) =>
      (data ?? '').replace(/%(0A|0D|25)/g, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    )
    .join('\n');
  return { report, output };
}

async function expectHangReported(
  probeTest: ProbeTest,
  scratch: string,
  signal: AbortSignal,
  env: Record<string, string> = {},
): Promise<void> {
  const stdout = `probe-stdout-${randomUUID()}`;
  const stderr = `probe-stderr-${randomUUID()}`;
  const { report, output } = await failureReport(
    probeTest,
    { ...faultEnvironment(scratch, hangAfterPrinting(stdout, stderr)), ...env },
    signal,
  );
  expect(report, output).toMatch(/timed? ?out/i);
  expect(report, output).toContain(stdout);
  expect(report, output).toContain(stderr);
}

describe('node-pty probe', () => {
  const finished = { error: null, code: 0, signal: null, stderr: '' };
  const result = (output: string, exitCode: number) => JSON.stringify({ output, exitCode });

  test.each<[string, NodePtyProbeRun, string[]]>([
    [
      'passes a shell that printed the marker and exited 0',
      { ...finished, stdout: result(PTY_PROBE_OUTPUT, 0) },
      [],
    ],
    [
      'names the executable it could not run',
      { ...finished, error: new Error('spawn /app/openknowledge ENOENT'), code: -2, stdout: '' },
      ['/app/openknowledge could not be run: spawn /app/openknowledge ENOENT'],
    ],
    [
      'names the test timeout that stopped it',
      {
        ...finished,
        error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        code: null,
        signal: 'SIGTERM',
        stdout: '',
      },
      ['it was stopped when the test timed out'],
    ],
    [
      'names the signal that killed it',
      { ...finished, code: null, signal: 'SIGSEGV', stdout: '' },
      ['it was killed by SIGSEGV'],
    ],
    ['names its exit status', { ...finished, code: 1, stdout: '' }, ['it exited 1']],
    [
      'names output that is not a probe result',
      { ...finished, stdout: '' },
      ['it printed no node-pty result'],
    ],
    [
      'names the exit status of the shell node-pty spawned',
      { ...finished, stdout: result(PTY_PROBE_OUTPUT, 2) },
      ['the shell node-pty spawned exited 2'],
    ],
    [
      'names shell output without the marker',
      { ...finished, stdout: result('', 0) },
      [`the shell's output lacks "${PTY_PROBE_OUTPUT}"`],
    ],
  ])('%s', (_label, run, expected) => {
    expect(nodePtyProbeProblems('/app/openknowledge', run)).toEqual(expected);
  });

  test.skipIf(process.platform === 'win32')(
    'loads node-pty in Node mode and spawns a command',
    (context) => expectNodePtyProbeSpawns(process.execPath, workspaceNodePty(), context),
  );

  test('reports an executable that does not exist', async ({ signal }) => {
    const missing = join(desktopRoot, 'dist-desktop', 'missing', 'openknowledge');
    const run = await runNodePtyProbe(missing, workspaceNodePty(), signal);
    expect(nodePtyProbeProblems(missing, run)).toEqual([
      `${missing} could not be run: spawn ${missing} ENOENT`,
    ]);
  });

  test('ends the probe when its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runNodePtyProbe(process.execPath, workspaceNodePty(), controller.signal);
    expect(nodePtyProbeProblems(process.execPath, run)).toEqual([
      'it was stopped when the test timed out',
    ]);
  });
});

describe.skipIf(packageDir === null)('packaged Linux terminal', () => {
  test('loads node-pty from the packaged app with its own Electron and spawns a command', async (context) => {
    expect(
      process.platform,
      'OK_LINUX_PACKAGE_DIR must only be set in a Linux packaging lane',
    ).toBe('linux');
    const variant = DESKTOP_VARIANTS[parseDesktopVariantName(process.env.OK_DESKTOP_VARIANT)];
    const executable = join(packageDir as string, variant.linuxExecutableName);
    await expectNodePtyProbeSpawns(
      executable,
      join(packageDir as string, 'resources', 'app.asar', 'node_modules', 'node-pty'),
      context,
    );
  });
});

describe.skipIf(packageDir !== null)('node-pty probe failure report', () => {
  test.skipIf(process.platform === 'win32')(
    'names the timeout and attaches the output so far when the probe hangs',
    async ({ signal, onTestFinished }) => {
      await expectHangReported(LOCAL_PROBE_TEST, scratchDirectory(onTestFinished), signal);
    },
    Number.POSITIVE_INFINITY,
  );

  test.skipIf(process.platform !== 'linux')(
    'names the timeout and attaches the output so far when the packaged probe hangs',
    async ({ signal, onTestFinished }) => {
      const scratch = scratchDirectory(onTestFinished);
      const packageRoot = join(scratch, 'package');
      mkdirSync(packageRoot);
      const variant = DESKTOP_VARIANTS[parseDesktopVariantName(process.env.OK_DESKTOP_VARIANT)];
      symlinkSync(process.execPath, join(packageRoot, variant.linuxExecutableName));
      await expectHangReported(PACKAGED_PROBE_TEST, scratch, signal, {
        OK_LINUX_PACKAGE_DIR: packageRoot,
      });
    },
    Number.POSITIVE_INFINITY,
  );

  test.skipIf(process.platform === 'win32')(
    'names the error a failed node-pty load threw',
    async ({ signal, onTestFinished }) => {
      const env = faultEnvironment(scratchDirectory(onTestFinished), FAIL_NATIVE_LOADS);
      const direct = spawnSync(
        process.execPath,
        ['-e', `require(${JSON.stringify(workspaceNodePty())})`],
        { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
      );
      const [, thrown = ''] = /^\w*Error: (.+)$/m.exec(direct.stderr) ?? [];
      expect(thrown, direct.stderr).not.toBe('');
      const { report, output } = await failureReport(LOCAL_PROBE_TEST, env, signal);
      expect(report, output).toContain(thrown);
    },
    Number.POSITIVE_INFINITY,
  );
});
