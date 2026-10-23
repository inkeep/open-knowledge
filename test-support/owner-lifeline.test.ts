import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type CommandResult,
  type HolderSeams,
  holdUntilOwnerLeaves,
  spawnUnderOwnerLifeline,
} from './owner-lifeline';

const OK_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FALLBACK_MS = 20_000;
const LEAKED = 'L';

const announceThenIdle = (ready: string): string =>
  `process.stdout.write(${JSON.stringify(ready)}); setTimeout(() => process.stdout.write(${JSON.stringify(LEAKED)}), ${FALLBACK_MS});`;

const grandchild = (ready: string): string =>
  `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(announceThenIdle(ready))}], { stdio: 'inherit' })`;

type Finished = { signal: NodeJS.Signals | null; stdout: string };

function recordingSeams(reportStatus: HolderSeams['reportStatus']) {
  const command = new EventEmitter();
  const steps: string[] = [];
  const seams: HolderSeams = {
    startCommand: () => command,
    lifeline: new PassThrough(),
    reportStatus: (result) => {
      steps.push('report');
      reportStatus(result);
    },
    stopGroup: () => {
      steps.push('stop');
    },
  };
  return { command, steps, seams };
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}

function finish(
  child: ReturnType<typeof spawnUnderOwnerLifeline>['child'],
  onStdout: (stdout: string) => void = () => {},
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      onStdout(stdout);
    });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (_code, signal) => resolve({ signal, stdout }));
  });
}

describe('owner lifeline', () => {
  test("reports the command's exit status, then ends its group, when the command ends on its own", async () => {
    const { child, commandResult } = spawnUnderOwnerLifeline(
      process.execPath,
      ['-e', "process.stdout.write('done'); process.exitCode = 3;"],
      { cwd: OK_ROOT, env: childEnv() },
    );
    expect(await finish(child)).toEqual({ signal: 'SIGKILL', stdout: 'done' });
    expect(await commandResult).toEqual({ code: 3, signal: null });
  });

  test('stops a process the command left running when the command ends', async () => {
    const { child, commandResult } = spawnUnderOwnerLifeline(
      process.execPath,
      ['-e', `${grandchild('G')}.unref();`],
      { cwd: OK_ROOT, env: childEnv() },
    );
    const finished = await finish(child);
    expect(finished.signal).toBe('SIGKILL');
    expect(finished.stdout).not.toContain(LEAKED);
    expect(await commandResult).toEqual({ code: 0, signal: null });
  });

  test("stops every process in its group once its owner's end of the lifeline closes", async () => {
    const { child, commandResult } = spawnUnderOwnerLifeline(
      process.execPath,
      ['-e', `${grandchild('G')};\n${announceThenIdle('C')}`],
      { cwd: OK_ROOT, env: childEnv() },
    );
    const finished = await finish(child, (stdout) => {
      if (stdout.includes('G') && stdout.includes('C')) child.stdin.end();
    });
    expect(finished.signal).toBe('SIGKILL');
    expect([...finished.stdout].sort().join('')).toBe('CG');
    expect(await commandResult).toBeNull();
  });
});

describe('owner lifeline holder', () => {
  test("reports the command's status, then stops its group, when the command exits", () => {
    const reported: CommandResult[] = [];
    const { command, steps, seams } = recordingSeams((result) => {
      reported.push(result);
    });
    holdUntilOwnerLeaves('command', [], seams);
    command.emit('exit', 0, null);
    expect(reported).toEqual([{ code: 0, signal: null }]);
    expect(steps).toEqual(['report', 'stop']);
  });

  test("still stops its group when reporting the command's status fails", () => {
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const { command, steps, seams } = recordingSeams(() => {
      throw brokenPipe;
    });
    holdUntilOwnerLeaves('command', [], seams);
    expect(() => command.emit('exit', 0, null)).toThrow(brokenPipe);
    expect(steps).toEqual(['report', 'stop']);
  });
});
