import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  excludeWorkingDirectoryFromProgramLookup,
  isProgramLookupSwitch,
  withReceivedProgramLookup,
} from './windows-program-lookup.ts';

const SWITCH = 'NoDefaultCurrentDirectoryInExePath';

function startedWith(
  received: Record<string, string>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const own: Record<string, string | undefined> = { ...received };
  excludeWorkingDirectoryFromProgramLookup(own, platform);
  return Object.fromEntries(
    Object.entries(own).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe('excludeWorkingDirectoryFromProgramLookup', () => {
  test('on Windows, a process that did not receive the switch sets it in its own environment', () => {
    const own = startedWith({ Path: 'C:\\Windows\\System32' }, 'win32');
    expect(Object.keys(own).filter(isProgramLookupSwitch)).toEqual([SWITCH]);
    expect(own.Path).toBe('C:\\Windows\\System32');
  });

  test('on Windows, a switch the process received stays as it came, whatever its value or spelling', () => {
    for (const received of [
      { [SWITCH]: '1' },
      { [SWITCH]: '' },
      { NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' },
    ]) {
      expect(startedWith(received, 'win32')).toEqual(received);
    }
  });

  test('on other platforms the environment is left as it came', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(startedWith({ PATH: '/usr/bin' }, platform)).toEqual({ PATH: '/usr/bin' });
    }
  });
});

describe('withReceivedProgramLookup', () => {
  test('gives a child the switch as the first process received it, after each process in the chain set it', () => {
    for (const received of [
      {},
      { [SWITCH]: '1' },
      { [SWITCH]: '' },
      { NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' },
    ]) {
      const first = { Path: 'C:\\Windows\\System32', ...received };
      const second = startedWith(startedWith(first, 'win32'), 'win32');
      expect(withReceivedProgramLookup(second)).toEqual(first);
    }
  });
});

describe('isProgramLookupSwitch', () => {
  test('names the switch in any spelling and nothing else', () => {
    expect(isProgramLookupSwitch(SWITCH)).toBe(true);
    expect(isProgramLookupSwitch(SWITCH.toUpperCase())).toBe(true);
    expect(isProgramLookupSwitch('Path')).toBe(false);
    expect(isProgramLookupSwitch(`${SWITCH}X`)).toBe(false);
  });
});

const run = promisify(execFile);

const CHILD = `
const [moduleUrl, name, exclude] = process.argv.slice(1);
const { excludeWorkingDirectoryFromProgramLookup } = await import(moduleUrl);
if (exclude === 'exclude') excludeWorkingDirectoryFromProgramLookup();
const { spawnSync } = await import('node:child_process');
const started = spawnSync(name, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' });
process.stdout.write(JSON.stringify(started.error ? { error: started.error.code } : { ran: started.stdout }));
`;

test.skipIf(process.platform !== 'win32')(
  'on Windows, a process that excluded the working directory does not start a program from it by name',
  async ({ signal, onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'ok-program-lookup-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const name = `ok-lookup-probe-${randomUUID().slice(0, 8)}`;
    const program = join(directory, `${name}.exe`);
    await copyFile(process.execPath, program);
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const env = { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32') };

    const direct = await run(program, ['-e', 'process.stdout.write(process.execPath)'], {
      env,
      signal,
      encoding: 'utf8',
    });
    expect(direct.stdout).toBe(program);

    const lookup = async (mode: 'exclude' | 'default') => {
      const { stdout } = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          CHILD,
          new URL('./windows-program-lookup.ts', import.meta.url).href,
          name,
          mode,
        ],
        { cwd: directory, env, signal, encoding: 'utf8' },
      );
      return JSON.parse(stdout) as unknown;
    };

    expect(await lookup('default')).toEqual({ ran: program });
    expect(await lookup('exclude')).toEqual({ error: 'ENOENT' });
  },
);
