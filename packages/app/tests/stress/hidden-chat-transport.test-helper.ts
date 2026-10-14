import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ThreadClientFrame,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { WorkerServer } from './_helpers';

interface HiddenChatAgent {
  readonly agentId: string;
  readonly threadId: string;
  createThread(): Promise<string>;
  release(): void;
  waitForFinalChunk(targetThreadId?: string): Promise<void>;
  finish(): void;
  closeThread(threadId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startHiddenChatAgent(workerServer: WorkerServer): Promise<HiddenChatAgent> {
  const localDir = join(workerServer.contentDir, '.ok', 'local');
  mkdirSync(localDir, { recursive: true });
  const agentId = `hidden-chat-${randomUUID()}`;
  const scriptPath = join(localDir, `${agentId}.mjs`);
  const releasePath = join(localDir, `${agentId}.release`);
  const finishPath = join(localDir, `${agentId}.finish`);
  writeFileSync(
    scriptPath,
    `import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
const releasePath = ${JSON.stringify(releasePath)};
const finishPath = ${JSON.stringify(finishPath)};
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const notify = (text) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'hidden-chat-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\\n');
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: frame.id, result });
    if (frame.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
    else if (frame.method === 'session/new') reply({ sessionId: 'hidden-chat-session' });
    else if (frame.method === 'session/prompt') {
      let released = false;
      const watcher = watch(dirname(releasePath), { persistent: false }, () => complete());
      const complete = () => {
        if (released || !existsSync(releasePath)) return;
        released = true;
        watcher.close();
        notify(' and completed while hidden');
        const finishWatcher = watch(dirname(finishPath), { persistent: false }, () => finish());
        const finish = () => {
          if (!existsSync(finishPath)) return;
          finishWatcher.close();
          reply({ stopReason: 'end_turn' });
        };
        finish();
      };
      notify('Streaming');
      complete();
    } else if (frame.id !== undefined) reply({});
  }
});
`,
  );
  const agentsPath = join(localDir, 'acp-agents.json');
  const registeredAgents = existsSync(agentsPath)
    ? (JSON.parse(readFileSync(agentsPath, 'utf8')) as unknown[])
    : [];
  writeFileSync(
    agentsPath,
    JSON.stringify([
      ...registeredAgents,
      {
        id: agentId,
        name: 'Hidden activity fixture',
        command: process.execPath,
        args: [scriptPath],
      },
    ]),
  );

  const socket = new WebSocket(`ws://127.0.0.1:${workerServer.port}/collab/thread`);
  const frames: ThreadServerFrame[] = [];
  const listeners = new Set<(frame: ThreadServerFrame) => void>();
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as ThreadServerFrame;
    frames.push(frame);
    for (const listener of listeners) listener(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('thread fixture socket failed')), {
      once: true,
    });
  });
  const send = (frame: ThreadClientFrame) => socket.send(JSON.stringify(frame));
  const waitForFrame = (matches: (frame: ThreadServerFrame) => boolean, fromIndex = 0) =>
    new Promise<ThreadServerFrame>((resolve, reject) => {
      const found = frames.slice(fromIndex).find(matches);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(
          new Error(
            `thread fixture frame timeout; saw ${frames.map((frame) => frame.op).join(', ')}`,
          ),
        );
      }, 20_000);
      const listener = (frame: ThreadServerFrame) => {
        if (!matches(frame)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(frame);
      };
      listeners.add(listener);
    });
  const reqId = `create-${randomUUID()}`;
  send({ op: 'create', reqId, agent: { source: 'custom', id: agentId } });
  const created = await waitForFrame((frame) => frame.op === 'created' && frame.reqId === reqId);
  if (created.op !== 'created') throw new Error('fixture thread did not return its created frame');
  const threadId = created.info.threadId;
  await waitForFrame(
    (frame) =>
      frame.op === 'info' && frame.info.threadId === threadId && frame.info.status === 'ready',
  );

  const closeThread = async (id: string) => {
    const closeFromIndex = frames.length;
    send({ op: 'close', threadId: id });
    const closed = await waitForFrame((frame) => frame.op === 'threads', closeFromIndex);
    if (closed.op !== 'threads') return;
    if (closed.threads.some((thread) => thread.threadId === id && thread.archived === true)) {
      const deleteFromIndex = frames.length;
      send({ op: 'delete', threadId: id });
      await waitForFrame(
        (frame) =>
          frame.op === 'threads' && !frame.threads.some((thread) => thread.threadId === id),
        deleteFromIndex,
      );
    }
  };

  return {
    agentId,
    threadId,
    createThread: async () => {
      const nextReqId = `create-${randomUUID()}`;
      send({ op: 'create', reqId: nextReqId, agent: { source: 'custom', id: agentId } });
      const nextCreated = await waitForFrame(
        (frame) => frame.op === 'created' && frame.reqId === nextReqId,
      );
      if (nextCreated.op !== 'created') throw new Error('fixture thread was not created');
      return nextCreated.info.threadId;
    },
    release: () => writeFileSync(releasePath, 'ready'),
    waitForFinalChunk: async (targetThreadId = threadId) => {
      if (targetThreadId !== threadId) {
        const subscribeFromIndex = frames.length;
        send({ op: 'subscribe', threadId: targetThreadId, sinceSeq: 0 });
        await waitForFrame(
          (frame) => frame.op === 'subscribed' && frame.threadId === targetThreadId,
          subscribeFromIndex,
        );
      }
      await waitForFrame(
        (frame) =>
          frame.op === 'events' &&
          frame.threadId === targetThreadId &&
          frame.events.some(
            (event) =>
              event.kind === 'session_update' &&
              event.update.sessionUpdate === 'agent_message_chunk' &&
              event.update.content.type === 'text' &&
              event.update.content.text === ' and completed while hidden',
          ),
      );
    },
    finish: () => writeFileSync(finishPath, 'ready'),
    closeThread,
    close: async () => {
      try {
        await closeThread(threadId);
      } finally {
        socket.close();
      }
    },
  };
}
