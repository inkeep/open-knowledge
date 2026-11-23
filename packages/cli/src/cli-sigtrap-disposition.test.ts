import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PACKAGE_VERSION } from './constants.ts';

const CLI_PACKAGE_ROOT = resolve(import.meta.dirname, '..');

const DARWIN_SIGCATCH_READER = `
import ctypes, sys
CTL_KERN, KERN_PROC, KERN_PROC_PID = 1, 14, 1
P_PID_OFFSET, P_SIGCATCH_OFFSET = 40, 236
pid = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 4)(CTL_KERN, KERN_PROC, KERN_PROC_PID, pid)
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 4, None, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
    raise OSError(ctypes.get_errno(), "sysctl size query failed")
buffer = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 4, buffer, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
    raise OSError(ctypes.get_errno(), "sysctl read failed")
raw = buffer.raw[: size.value]
if int.from_bytes(raw[P_PID_OFFSET : P_PID_OFFSET + 4], "little", signed=True) != pid:
    raise SystemExit("kinfo_proc layout does not place p_pid where expected")
print(int.from_bytes(raw[P_SIGCATCH_OFFSET : P_SIGCATCH_OFFSET + 4], "little"))
`;

const DISPOSITION_PROBE = `
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [resultPath, scenario, target, scratch, darwinReader] = process.argv.slice(1);
const sigtrapBit = 1n << BigInt(constants.signals.SIGTRAP - 1);

function caughtSignals() {
  if (process.platform === 'linux') {
    const field = readFileSync('/proc/self/status', 'utf8')
      .split('\\n')
      .find((line) => line.startsWith('SigCgt:'));
    return BigInt('0x' + field.slice('SigCgt:'.length).trim());
  }
  if (process.platform === 'darwin') {
    const mask = execFileSync('/usr/bin/python3', ['-I', '-c', darwinReader, String(process.pid)], {
      encoding: 'utf8',
    });
    return BigInt(mask.trim());
  }
  throw new Error('no kernel signal disposition reader for ' + process.platform);
}

function observe() {
  return {
    listeners: process.listenerCount('SIGTRAP'),
    caught: (caughtSignals() & sigtrapBit) !== 0n,
  };
}

const result = { readings: { before: observe() } };
process.once('exit', () => {
  result.readings.exit = observe();
  writeFileSync(resultPath, JSON.stringify(result));
});

if (scenario === 'handler') {
  process.on('SIGTRAP', () => {});
  result.readings.handled = observe();
} else if (scenario === 'cli') {
  process.argv = [process.execPath, target, '--version'];
  await import(pathToFileURL(target).href);
} else if (scenario === 'prompt') {
  const { collectUninstallFeedbackAnswers } = await import(pathToFileURL(target).href);
  result.readings.loaded = observe();
  const input = new PassThrough();
  const output = new PassThrough();
  output._isStdio = true;
  let transcript = '';
  let shown = false;
  output.on('data', (chunk) => {
    process.stderr.write(JSON.stringify(String(chunk)) + '\\n');
    transcript += String(chunk);
    if (!shown && transcript.includes('mind sharing why')) {
      shown = true;
      setImmediate(() => {
        result.readings.open = observe();
        input.write('\\r');
      });
    }
  });
  result.promptAnswers = await collectUninstallFeedbackAnswers({ input, output });
  result.readings.answered = observe();
} else {
  const loaded = await import(pathToFileURL(target).href);
  result.readings.loaded = observe();
  if (scenario !== 'load') {
    const configured = join(scratch, 'configured', 'trust.json');
    const canonical = join(scratch, 'canonical', 'trust.json');
    mkdirSync(join(scratch, 'configured'), { recursive: true });
    mkdirSync(join(scratch, 'canonical'), { recursive: true });
    writeFileSync(canonical, '{}');
    await loaded[scenario](configured, canonical, () => {
      result.piLockHeld = existsSync(configured + '.lock');
      result.readings.held = observe();
    });
    result.readings.released = observe();
  }
}
process.exit(0);
`;

interface Disposition {
  listeners: number;
  caught: boolean;
}

interface ProbeResult {
  readings: Record<string, Disposition>;
  piLockHeld?: boolean;
  promptAnswers?: unknown;
  stdout: string;
}

const DEFAULT_DISPOSITION: Disposition = { listeners: 0, caught: false };
const HANDLED_DISPOSITION: Disposition = { listeners: 1, caught: true };

function allDefault(...readings: string[]): Record<string, Disposition> {
  return Object.fromEntries(readings.map((reading) => [reading, DEFAULT_DISPOSITION]));
}

describe.skipIf(process.platform === 'win32')(
  'SIGTRAP disposition of a process that loads the CLI',
  () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ok-cli-sigtrap-'));
      mkdirSync(join(root, 'home'));
      mkdirSync(join(root, 'scratch'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    async function probe(
      scenario: string,
      target: string,
      signal: AbortSignal,
    ): Promise<ProbeResult> {
      const resultPath = join(root, 'result.json');
      const home = join(root, 'home');
      const child = spawn(
        process.execPath,
        [
          '--conditions=development',
          '--input-type=module',
          '-e',
          DISPOSITION_PROBE,
          resultPath,
          scenario,
          resolve(CLI_PACKAGE_ROOT, target),
          join(root, 'scratch'),
          DARWIN_SIGCATCH_READER,
        ],
        {
          cwd: CLI_PACKAGE_ROOT,
          env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          signal,
          killSignal: 'SIGKILL',
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      try {
        const [code, exitSignal] = await once(child, 'close');
        expect({ code, signal: exitSignal }, stderr).toEqual({ code: 0, signal: null });
        return { ...(JSON.parse(readFileSync(resultPath, 'utf8')) as ProbeResult), stdout };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }

    test('a SIGTRAP handler the process adds shows in both disposition readers', async ({
      signal,
    }) => {
      const result = await probe('handler', 'src/cli.ts', signal);
      expect(result.readings).toEqual({
        before: DEFAULT_DISPOSITION,
        handled: HANDLED_DISPOSITION,
        exit: HANDLED_DISPOSITION,
      });
    });

    test('running the open-knowledge command line keeps SIGTRAP at its default disposition', async ({
      signal,
    }) => {
      const result = await probe('cli', 'src/cli.ts', signal);
      expect(result.stdout).toContain(PACKAGE_VERSION);
      expect(result.readings.before).toEqual(DEFAULT_DISPOSITION);
      expect(result.readings).toEqual(allDefault('before', 'exit'));
    });

    test.for([
      { surface: 'the start command', target: 'src/commands/start.ts' },
      { surface: 'the package entry', target: 'src/index.ts' },
    ])(
      'loading $surface keeps SIGTRAP at its default disposition',
      async ({ target }, { signal }) => {
        const result = await probe('load', target, signal);
        expect(result.readings.before).toEqual(DEFAULT_DISPOSITION);
        expect(result.readings).toEqual(allDefault('before', 'loaded', 'exit'));
      },
    );

    test.for(['withPiTrustLock', 'withPiTrustLockSync'])(
      'holding and releasing a Pi trust lock through %s keeps SIGTRAP at its default disposition',
      async (lockFunction, { signal }) => {
        const result = await probe(lockFunction, 'src/commands/pi-trust-lock.ts', signal);
        expect(result.piLockHeld).toBe(true);
        expect(result.readings.before).toEqual(DEFAULT_DISPOSITION);
        expect(result.readings).toEqual(allDefault('before', 'loaded', 'held', 'released', 'exit'));
      },
    );

    test('showing and answering the uninstall feedback prompt keeps SIGTRAP at its default disposition', async ({
      signal,
    }) => {
      const result = await probe('prompt', 'src/commands/uninstall-feedback.ts', signal);
      expect(result.promptAnswers).toEqual({});
      expect(result.readings.before).toEqual(DEFAULT_DISPOSITION);
      expect(result.readings).toEqual(allDefault('before', 'loaded', 'open', 'answered', 'exit'));
    });
  },
);
