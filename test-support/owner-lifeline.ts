import { spawn } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIFELINE = fileURLToPath(import.meta.url);
const STATUS_FD = 3;

export type CommandResult = { code: number | null; signal: NodeJS.Signals | null };

export function spawnUnderOwnerLifeline(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(process.execPath, [LIFELINE, command, ...args], {
    ...options,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const statusChannel = child.stdio[STATUS_FD] as Readable;
  const commandResult = new Promise<CommandResult | null>((resolve) => {
    let reported = '';
    statusChannel.setEncoding('utf8').on('data', (chunk: string) => {
      reported += chunk;
    });
    statusChannel.once('end', () => {
      resolve(reported === '' ? null : (JSON.parse(reported) as CommandResult));
    });
  });
  return { child, commandResult };
}

function stopOwnGroup(): void {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

type ExitingCommand = {
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export type HolderSeams = {
  startCommand: (command: string, args: readonly string[]) => ExitingCommand;
  lifeline: Pick<NodeJS.ReadableStream, 'once' | 'resume'>;
  reportStatus: (result: CommandResult) => void;
  stopGroup: () => void;
};

const holderProcessSeams = (): HolderSeams => ({
  startCommand: (command, args) =>
    spawn(command, [...args], { stdio: ['ignore', 'inherit', 'inherit'] }),
  lifeline: process.stdin,
  reportStatus: (result) => {
    writeSync(STATUS_FD, JSON.stringify(result));
  },
  stopGroup: stopOwnGroup,
});

export function holdUntilOwnerLeaves(
  command: string,
  args: readonly string[],
  seams: HolderSeams = holderProcessSeams(),
): void {
  const child = seams.startCommand(command, args);
  seams.lifeline.once('end', seams.stopGroup);
  seams.lifeline.resume();
  child.once('exit', (code, signal) => {
    try {
      seams.reportStatus({ code, signal });
    } finally {
      seams.stopGroup();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  holdUntilOwnerLeaves(command, args);
}
