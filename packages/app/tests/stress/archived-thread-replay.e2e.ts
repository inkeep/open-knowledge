import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadServerFrame } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { expect, stubAgentCatalog, test, threadRosterDelivered } from './_helpers';

test('history replays a conversation archived from another connection without reloading', async ({
  page,
  api,
  workerServer,
}) => {
  const uid = randomUUID();
  const docName = `history-replay-${uid}`;
  const agentId = `history-agent-${uid}`;
  const message = `Message preserved through archive ${uid}`;
  await api.seedDocs([{ name: docName, markdown: '# History replay\n' }]);
  const localDir = join(workerServer.contentDir, '.ok', 'local');
  mkdirSync(localDir, { recursive: true });
  const agentPath = join(localDir, 'history-replay-agent.mjs');
  writeFileSync(
    agentPath,
    `let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: {} }
      : request.method === 'session/new'
        ? { sessionId: 'history-replay' }
        : request.method === 'session/prompt'
          ? { stopReason: 'end_turn' }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      { id: agentId, name: 'History Replay Agent', command: process.execPath, args: [agentPath] },
    ]),
  );
  await page.addInitScript((id) => {
    window.localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({
        agents: [{ source: 'custom', id, name: 'History Replay Agent' }],
        defaultKey: `custom:${id}`,
      }),
    );
  }, agentId);
  const frames: ThreadServerFrame[] = [];
  const sent: unknown[] = [];
  let threadConnections = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/collab/thread')) return;
    threadConnections += 1;
    socket.on('framereceived', ({ payload }) => {
      frames.push(JSON.parse(String(payload)) as ThreadServerFrame);
    });
    socket.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload))));
  });
  await stubAgentCatalog(page);
  const roster = threadRosterDelivered(page);
  await page.goto(`/#/${docName}`);
  await roster;
  await page.getByTestId('header-pane-button-agents').click();
  const panel = page.locator('[data-agents-panel-mount]');
  await expect(panel.getByRole('tab')).toHaveCount(1);
  await expect
    .poll(() => frames.find((frame) => frame.op === 'created')?.info.threadId)
    .toBeDefined();
  const created = frames.find((frame) => frame.op === 'created');
  if (created?.op !== 'created') throw new Error('The UI did not create its thread');
  const threadId = created.info.threadId;
  await expect
    .poll(() => frames.some((frame) => frame.op === 'info' && frame.info.status === 'ready'))
    .toBe(true);
  const composer = panel.getByTestId('agent-thread-composer');
  await composer.fill(message);
  await composer.press('Enter');
  await expect(panel.getByText(message, { exact: true })).toBeVisible();
  const connectionCount = threadConnections;
  const controller = new WebSocket(`ws://127.0.0.1:${workerServer.port}/collab/thread`);
  try {
    await new Promise<void>((resolve, reject) => {
      controller.addEventListener('open', () => {
        controller.send(JSON.stringify({ op: 'close', threadId }));
      });
      controller.addEventListener('message', ({ data }) => {
        const frame = JSON.parse(String(data)) as ThreadServerFrame;
        if (frame.op === 'error') reject(new Error(frame.message));
        if (
          frame.op === 'threads' &&
          frame.threads.some((info) => info.threadId === threadId && info.archived === true)
        ) {
          resolve();
        }
      });
      controller.addEventListener('error', () => reject(new Error('Archive socket failed')));
    });
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Chat history' }).click();
    await page.getByTestId(`agent-thread-history-open-${threadId}`).click();
    await expect(panel.getByText(message, { exact: true })).toBeVisible();
    expect(threadConnections).toBe(connectionCount);
    await page.screenshot({ path: test.info().outputPath('archived-replay.png') });
  } finally {
    await test.info().attach('thread-frames', {
      body: JSON.stringify({ frames, sent, threadConnections }),
      contentType: 'application/json',
    });
    if (controller.readyState === WebSocket.OPEN) {
      controller.send(JSON.stringify({ op: 'delete', threadId }));
    }
    controller.close();
  }
});
