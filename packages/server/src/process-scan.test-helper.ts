import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export interface FakeChildProcessInput {
  stdout: Iterable<string | Buffer> | AsyncIterable<string | Buffer>;
  stderr?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  error?: Error;
}

export function fakeChildProcess(input: FakeChildProcessInput) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Readable.from(input.stdout),
    stderr: Readable.from(input.stderr === undefined ? [] : [input.stderr]),
    killed: input.killed ?? false,
  });
  let open = 2;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('close', () => {
      if (--open === 0)
        child.emit('close', input.status === undefined ? 0 : input.status, input.signal ?? null);
    });
  }
  const { error } = input;
  if (error) process.nextTick(() => child.emit('error', error));
  return child;
}
