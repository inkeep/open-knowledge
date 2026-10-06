import { type ChildProcess, type StdioOptions, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCleanupOrder } from './cleanup-order.test-helper.ts';

const CONTROL = fileURLToPath(new URL('./cleanup-order-control.cjs', import.meta.url));
const GATE = fileURLToPath(new URL('./cleanup-order-gate.cjs', import.meta.url));
const WITH_IPC: StdioOptions = ['ignore', 'pipe', 'pipe', 'ipc'];

type Exit = [code: number | null, signal: NodeJS.Signals | null];

interface Participant {
  role: 'runner' | 'server' | 'remover';
  child: ChildProcess;
  output: string[];
  closed: Promise<Exit>;
}

function report(failure: unknown, participants: Participant[]): Error {
  const sections = participants.map(
    ({ role, child, output }) =>
      `--- ${role} (pid ${child.pid}, code ${child.exitCode}, signal ${child.signalCode})\n${output.join('')}`,
  );
  const message = failure instanceof Error ? failure.message : String(failure);
  return new Error([message, ...sections].join('\n'), { cause: failure });
}

export async function runCleanupOrderControl(
  outputDir: string,
  progress: 'yield' | 'exit' | 'remover',
) {
  const ordering = await createCleanupOrder(outputDir, 'control');
  const participants: Participant[] = [];
  const dismissed = new Set<ChildProcess>();
  let reject: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const interrupt = (child: ChildProcess, error: Error) => {
    if (!dismissed.has(child)) reject(error);
  };
  const during = <T>(wait: Promise<T>) => Promise.race([wait, interrupted]);
  const reply = ({ child }: Participant) =>
    new Promise<void>((resolve) => child.once('message', () => resolve()));

  function start(role: Participant['role'], args: string[], stdio: StdioOptions) {
    const child = spawn(process.execPath, args, { env: ordering.env, stdio });
    const closed = new Promise<Exit>((resolve) => {
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const acknowledged = ordering.events.some(
          (event) => event.pid === child.pid && event.phase === 'ack:remove',
        );
        if (!acknowledged) {
          interrupt(
            child,
            new Error(
              `cleanup ordering ${role} exited during the control protocol (code ${code}, signal ${signal})`,
            ),
          );
        }
        resolve([code, signal]);
      });
    });
    const participant: Participant = { role, child, output: [], closed };
    participants.push(participant);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => participant.output.push(chunk.toString('utf8')));
    }
    child.on('error', (error) =>
      interrupt(child, new Error(`cleanup ordering ${role} failed`, { cause: error })),
    );
    if (child.pid === undefined) throw new Error(`cleanup ordering ${role} did not spawn`);
    return { ...participant, pid: child.pid };
  }

  function send({ role, child }: Participant, message: string) {
    if (!child.connected)
      throw new Error(`cleanup ordering ${role} disconnected before ${message}`);
    child.send(message, (error) => {
      if (error) {
        interrupt(
          child,
          new Error(`cleanup ordering ${role} did not receive ${message}`, { cause: error }),
        );
      }
    });
  }

  let failure: unknown;
  try {
    const runner = start('runner', [CONTROL, 'runner'], WITH_IPC);
    const server = start('server', [CONTROL, 'server'], WITH_IPC);
    await during(ordering.beforeOwnerExit(server.pid));
    const recorded = reply(server);
    send(server, 'before-record');
    await during(ordering.waitForArrival('before-record', server.pid));
    if (progress === 'remover') {
      const remover = start('remover', [GATE, 'remove'], ['ignore', 'pipe', 'pipe']);
      await during(ordering.waitForArrival('remove', remover.pid));
      await during(recorded);
      const completed = reply(server);
      send(server, 'after-record');
      await during(ordering.waitForArrival('after-record', server.pid));
      send(runner, 'yield');
      await during(completed);
      const removerExit = await during(remover.closed);
      return {
        removerExit,
        order: ordering.events.flatMap((event) => {
          if (event.pid === remover.pid && event.phase === 'remove') return ['request'];
          if (event.pid === server.pid && event.phase === 'after-record') return ['write-complete'];
          if (event.pid === remover.pid && event.phase === 'ack:remove') return ['acknowledgment'];
          return [];
        }),
      };
    }
    if (progress === 'exit') {
      dismissed.add(runner.child);
      send(runner, 'finish');
    } else {
      const yielded = reply(runner);
      send(runner, 'yield');
      await during(yielded);
    }
    await during(recorded);
    return {
      order: ordering.events.flatMap((event) => {
        if (event.pid === server.pid && event.phase === 'before-record') return ['request'];
        if (event.pid === runner.pid && event.phase === progress) return ['progress'];
        if (event.pid === server.pid && event.phase === 'ack:before-record')
          return ['acknowledgment'];
        return [];
      }),
    };
  } catch (error) {
    failure = error;
  } finally {
    for (const { child } of participants) dismissed.add(child);
    await ordering.close();
    for (const participant of participants) {
      if (participant.child.connected) send(participant, 'finish');
    }
    await Promise.all(participants.map(({ closed }) => closed));
  }
  throw report(failure, participants);
}
