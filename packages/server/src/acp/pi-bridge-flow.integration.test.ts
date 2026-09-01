import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ThreadEvent,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import {
  AcpThreadManager,
  type AcpThreadManagerOptions,
  type PiAcpBridgeEnsureResult,
  type PiAcpBridgeProbe,
} from './thread-manager.ts';

const log = getLogger('pi-bridge-flow-test');

const EXAMPLE_AGENT = join(
  dirname(Bun.resolveSync('@agentclientprotocol/sdk', import.meta.dirname)),
  'examples/agent.js',
);

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('the example agent never uses client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pi-bridge-flow-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function piRegistryFetch(binDir: string): typeof fetch {
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, {
    mode: 0o755,
  });
  const stub = join(binDir, 'npx');
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nexec ${process.execPath} ${EXAMPLE_AGENT}\n`,
    { mode: 0o755 },
  );
  return (async () =>
    new Response(
      JSON.stringify({
        agents: [
          {
            id: 'pi-acp',
            name: 'pi',
            version: '1.0.0',
            distribution: { npx: { package: '@fake/pi', env: { PATH: binDir } } },
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function makeManager(seams: {
  probePiAcpBridge?: AcpThreadManagerOptions['probePiAcpBridge'];
  ensurePiAcpBridge?: AcpThreadManagerOptions['ensurePiAcpBridge'];
}): AcpThreadManager {
  const localDir = tmp();
  const manager = new AcpThreadManager({
    contentDir: tmp(),
    localDir,
    globalDir: null,
    registry: new AcpRegistry({ localDir, log, fetchImpl: piRegistryFetch(tmp()) }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    getServerUrl: () => 'http://127.0.0.1:4242',
    getMcpStdioCommand: () => ({ command: 'open-knowledge', args: ['mcp', '--port', '4242'] }),
    resolveLoginShellPath: async () => null,
    log,
    ...seams,
  });
  managers.push(manager);
  return manager;
}

async function collect(
  manager: AcpThreadManager,
  threadId: string,
  sink: ThreadEvent[],
): Promise<void> {
  await manager.subscribe(threadId, 0, (frame: ThreadServerFrame) => {
    if (frame.op === 'event') sink.push(frame.event);
    else if (frame.op === 'events') sink.push(...frame.events);
  });
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function findRequest(
  events: ThreadEvent[],
): Extract<ThreadEvent, { kind: 'pi_bridge_consent_request' }> | undefined {
  return events.find(
    (e): e is Extract<ThreadEvent, { kind: 'pi_bridge_consent_request' }> =>
      e.kind === 'pi_bridge_consent_request',
  );
}

function findStatus(
  events: ThreadEvent[],
): Extract<ThreadEvent, { kind: 'pi_bridge_status' }> | undefined {
  return events.find(
    (e): e is Extract<ThreadEvent, { kind: 'pi_bridge_status' }> => e.kind === 'pi_bridge_status',
  );
}

const BRIDGE_PATH = '/tmp/pi-project/.pi/extensions/open-knowledge.ts';

const unprovisioned: PiAcpBridgeProbe = {
  bridgePath: BRIDGE_PATH,
  bridge: 'absent',
  trust: 'untrusted',
  bridgeLoadable: false,
  otherExtensions: [],
};

const provisioned: PiAcpBridgeProbe = {
  bridgePath: BRIDGE_PATH,
  bridge: 'own-current',
  trust: 'trusted',
  bridgeLoadable: true,
};

const ensured: PiAcpBridgeEnsureResult = {
  ok: true,
  bridgePath: BRIDGE_PATH,
  bridge: 'written',
  trust: 'added',
};

async function startThread(
  manager: AcpThreadManager,
  events: ThreadEvent[],
): Promise<{ threadId: string }> {
  const info = await manager.createThread({ agent: { source: 'registry', id: 'pi-acp' } });
  await collect(manager, info.threadId, events);
  return { threadId: info.threadId };
}

async function waitReady(manager: AcpThreadManager, threadId: string): Promise<void> {
  await waitFor(() => manager.getInfo(threadId)?.status === 'ready', 15_000, 'the thread to start');
}

describe('pi bridge consent flow', () => {
  test('an already-provisioned project starts silently — no prompt, no provisioning', async () => {
    let ensureCalls = 0;
    const manager = makeManager({
      probePiAcpBridge: () => provisioned,
      ensurePiAcpBridge: () => {
        ensureCalls += 1;
        return ensured;
      },
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitReady(manager, threadId);
    expect(findRequest(events)).toBeUndefined();
    expect(findStatus(events)).toBeUndefined();
    expect(ensureCalls).toBe(0);
  }, 30_000);

  test('approve → the bridge is provisioned before the session opens', async () => {
    const seen: string[] = [];
    const manager = makeManager({
      probePiAcpBridge: (cwd) => {
        seen.push(cwd);
        return unprovisioned;
      },
      ensurePiAcpBridge: () => ensured,
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);

    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the consent request');
    const req = findRequest(events);
    if (req === undefined) throw new Error('unreachable');
    expect(req.bridgePath).toBe(BRIDGE_PATH);
    expect(req.agentName).toBe(manager.getInfo(threadId)?.agent.name);
    expect(req.cwd).toBe(seen[0]);
    expect(manager.getInfo(threadId)?.status).not.toBe('ready');

    manager.respondPiBridgeConsent(threadId, req.requestId, { kind: 'granted' });
    await waitReady(manager, threadId);
    await waitFor(() => findStatus(events) !== undefined, 5_000, 'the outcome event');
    const status = findStatus(events);
    expect(status).toMatchObject({
      state: 'ready',
      requestId: req.requestId,
      bridge: 'written',
      trust: 'added',
    });
    expect(events.some((e) => e.kind === 'pi_bridge_consent_resolved')).toBe(true);
  }, 30_000);

  test('refuse → the thread runs anyway, and the next thread asks again', async () => {
    let ensureCalls = 0;
    const manager = makeManager({
      probePiAcpBridge: () => unprovisioned,
      ensurePiAcpBridge: () => {
        ensureCalls += 1;
        return ensured;
      },
    });

    const first: ThreadEvent[] = [];
    const one = await startThread(manager, first);
    await waitFor(() => findRequest(first) !== undefined, 15_000, 'the first consent request');
    const refused = findRequest(first);
    if (refused === undefined) throw new Error('unreachable');
    manager.respondPiBridgeConsent(one.threadId, refused.requestId, { kind: 'declined' });

    await waitReady(manager, one.threadId);
    await waitFor(
      () => first.some((e) => e.kind === 'pi_bridge_consent_resolved'),
      5_000,
      'the refusal to land in the transcript',
    );
    expect(ensureCalls).toBe(0);
    expect(findStatus(first)).toBeUndefined();
    expect(first.find((e) => e.kind === 'pi_bridge_consent_resolved')).toMatchObject({
      decision: 'declined',
    });

    const second: ThreadEvent[] = [];
    const two = await startThread(manager, second);
    await waitFor(() => findRequest(second) !== undefined, 15_000, 'the second consent request');
    const retry = findRequest(second);
    if (retry === undefined) throw new Error('unreachable');
    manager.respondPiBridgeConsent(two.threadId, retry.requestId, { kind: 'granted' });
    await waitReady(manager, two.threadId);
    expect(ensureCalls).toBe(1);
  }, 45_000);

  test('a resume of a declined thread does not ask again', async () => {
    let ensureCalls = 0;
    const manager = makeManager({
      probePiAcpBridge: () => unprovisioned,
      ensurePiAcpBridge: () => {
        ensureCalls += 1;
        return ensured;
      },
    });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({
      agent: { source: 'registry', id: 'pi-acp' },
      prompt: 'hello',
    });
    await collect(manager, info.threadId, events);
    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the first consent request');
    const first = findRequest(events);
    if (first === undefined) throw new Error('unreachable');
    manager.respondPiBridgeConsent(info.threadId, first.requestId, { kind: 'declined' });
    await waitFor(
      () => events.some((e) => e.kind === 'user_message'),
      15_000,
      'the first prompt to reach the transcript',
    );
    await manager.closeThread(info.threadId);

    const resumed: ThreadEvent[] = [];
    await collect(manager, info.threadId, resumed);
    await manager.resumeThread(info.threadId).catch(() => undefined);
    const asked = (): Extract<ThreadEvent, { kind: 'pi_bridge_consent_request' }> | undefined =>
      resumed.find(
        (e): e is Extract<ThreadEvent, { kind: 'pi_bridge_consent_request' }> =>
          e.kind === 'pi_bridge_consent_request' && e.requestId !== first.requestId,
      );
    expect(asked()).toBeUndefined();
    expect(ensureCalls).toBe(0);
  }, 45_000);

  test('the consent request carries the other extensions the trust would cover', async () => {
    const manager = makeManager({
      probePiAcpBridge: () => ({ ...unprovisioned, otherExtensions: ['theirs.ts'] }),
      ensurePiAcpBridge: () => ensured,
    });
    const events: ThreadEvent[] = [];
    await startThread(manager, events);
    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the consent request');
    expect(findRequest(events)?.otherExtensions).toEqual(['theirs.ts']);
  }, 45_000);

  test('a foreign file at the managed path is reported, never prompted about', async () => {
    let ensureCalls = 0;
    const manager = makeManager({
      probePiAcpBridge: () => ({ ...unprovisioned, bridge: 'foreign' }),
      ensurePiAcpBridge: () => {
        ensureCalls += 1;
        return ensured;
      },
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitReady(manager, threadId);
    await waitFor(() => findStatus(events) !== undefined, 5_000, 'the limitation event');
    expect(findRequest(events)).toBeUndefined();
    expect(ensureCalls).toBe(0);
    expect(findStatus(events)).toMatchObject({
      state: 'foreign-file',
      bridgePath: BRIDGE_PATH,
    });
    expect(findStatus(events)?.requestId).toBeUndefined();
  }, 30_000);

  test('a half-landed provisioning reports which half failed and proceeds toolless', async () => {
    const manager = makeManager({
      probePiAcpBridge: () => unprovisioned,
      ensurePiAcpBridge: () => ({
        ok: false,
        bridgePath: BRIDGE_PATH,
        bridge: 'written',
        trust: 'refused-unreadable',
        error: 'trust store is not a readable JSON object',
      }),
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the consent request');
    const req = findRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondPiBridgeConsent(threadId, req.requestId, { kind: 'granted' });

    await waitReady(manager, threadId);
    await waitFor(() => findStatus(events) !== undefined, 5_000, 'the outcome event');
    expect(findStatus(events)).toMatchObject({
      state: 'trust-failed',
      requestId: req.requestId,
      bridge: 'written',
      trust: 'refused-unreadable',
      detail: 'trust store is not a readable JSON object',
    });
  }, 30_000);

  test('a provisioning seam that throws is reported, not fatal to the thread', async () => {
    const manager = makeManager({
      probePiAcpBridge: () => unprovisioned,
      ensurePiAcpBridge: () => {
        throw new Error('disk on fire');
      },
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the consent request');
    const req = findRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondPiBridgeConsent(threadId, req.requestId, { kind: 'granted' });

    await waitReady(manager, threadId);
    await waitFor(() => findStatus(events) !== undefined, 5_000, 'the outcome event');
    expect(findStatus(events)).toMatchObject({ state: 'bridge-failed', detail: 'disk on fire' });
  }, 30_000);

  test('unwired seams start the thread with no prompt and no events', async () => {
    const manager = makeManager({});
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitReady(manager, threadId);
    expect(findRequest(events)).toBeUndefined();
    expect(findStatus(events)).toBeUndefined();
  }, 30_000);

  test('closing a parked thread releases session setup', async () => {
    const manager = makeManager({
      probePiAcpBridge: () => unprovisioned,
      ensurePiAcpBridge: () => ensured,
    });
    const events: ThreadEvent[] = [];
    const { threadId } = await startThread(manager, events);
    await waitFor(() => findRequest(events) !== undefined, 15_000, 'the consent request');
    await manager.closeThread(threadId);
    expect(manager.getInfo(threadId)?.status).not.toBe('ready');
  }, 30_000);
});
