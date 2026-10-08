import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export type ChildRun = { status: number | null; signal: NodeJS.Signals | null; output: string };

export type ChildSilenceBoundOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  silenceBoundMs: number;
  outputLimitBytes: number;
};

export function watchForSilence(
  streams: ReadonlyArray<EventEmitter>,
  silenceBoundMs: number,
  onSilent: () => void,
): () => void {
  let timer = setTimeout(onSilent, silenceBoundMs);
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(onSilent, silenceBoundMs);
  };
  for (const stream of streams) stream.on('data', rearm);
  return () => {
    clearTimeout(timer);
    for (const stream of streams) stream.off('data', rearm);
  };
}

export function runChildWithSilenceBound(
  file: string,
  args: ReadonlyArray<string>,
  { cwd, env, signal, silenceBoundMs, outputLimitBytes }: ChildSilenceBoundOptions,
): Promise<ChildRun> {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outputSoFar = () => `${stdout.join('')}\n${stderr.join('')}`;
    const describeStop = (reason: string) =>
      `the harness stopped \`${[file, ...args].join(' ')}\` after ${Math.round(performance.now() - startedAt)} ms because it ${reason}; a stop by the harness is not the child's own verdict. Its output until the stop:\n${outputSoFar()}`;
    const stop = new AbortController();
    let stopReason: string | undefined;
    const stopChild = (reason: string) => {
      if (stop.signal.aborted) return;
      stopReason = reason;
      console.error(describeStop(reason));
      stop.abort();
    };
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.any([signal, stop.signal]),
      killSignal: 'SIGKILL',
    });
    let outputBytes = 0;
    const collect = (chunks: string[]) => (chunk: string) => {
      chunks.push(chunk);
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputLimitBytes) stopChild(`printed more than ${outputLimitBytes} bytes`);
    };
    child.stdout.setEncoding('utf8').on('data', collect(stdout));
    child.stderr.setEncoding('utf8').on('data', collect(stderr));
    const release = watchForSilence([child.stdout, child.stderr], silenceBoundMs, () =>
      stopChild(`printed nothing for ${silenceBoundMs} ms`),
    );
    child.on('error', (error) => {
      if (child.pid !== undefined) return;
      release();
      rejectRun(error);
    });
    child.on('close', (status, exitSignal) => {
      release();
      if (stopReason !== undefined) {
        rejectRun(new Error(describeStop(stopReason)));
      } else if (signal.aborted) {
        rejectRun(signal.reason);
      } else {
        resolveRun({ status, signal: exitSignal, output: outputSoFar() });
      }
    });
  });
}
