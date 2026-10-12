import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_LAUNCH_FAILURE_LOG } from '@inkeep/open-knowledge-core';
import type { ThreadEvent, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { waitWithinTestBudget } from '../wait-within-test-budget.test-helper.ts';
import {
  type HeldInstallRegistry,
  withHeldInstallRegistry,
} from './held-install-registry.test-helper.ts';
import { descendantsOf, processEnded } from './npx-cache-entry.test-helper.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry, type RegistryAgent } from './registry.ts';
import { AcpThreadManager, type PiAcpBridgeProbe } from './thread-manager.ts';

const log = getLogger('superseded-launch-test');
const CODEX = 'codex-acp';
const PI = 'pi-acp';
const NEW_WINDOW = 400_000;
const WAIT = { timeoutMs: 15_000 };
const QUIET_MS = 1_500;
const SUPERSEDED_STATUS_LOG = '[acp-threads] status suppressed for a superseded launch';

const sessionManager = {
  getSession: async () => {
    throw new Error('the scripted agent never uses client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

const SCRIPTED_AGENT = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const STATE = process.env.AGENT_STATE;
const startsPath = STATE + '/starts.jsonl';
let window = null;
try {
  window = JSON.parse(process.env.CODEX_CONFIG ?? '{}').model_context_window ?? null;
} catch {}
appendFileSync(startsPath, JSON.stringify({ pid: process.pid, window }) + '\\n');
const startedPids = () =>
  readFileSync(startsPath, 'utf8').split('\\n').filter((l) => l !== '').map((l) => JSON.parse(l).pid);
const startIndex = startedPids().indexOf(process.pid) + 1;
const youngerStarted = () => {
  const pids = startedPids();
  return pids.length > pids.indexOf(process.pid) + 1;
};
const caps = (process.env.FAKE_CAPS ?? '').split(',').filter(Boolean);
const known = new Set(['sess-' + process.pid]);
const modelOptions = (value) => [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: value,
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
  },
];
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const when = (ready, fn) => {
  if (ready()) return fn();
  const timer = setInterval(() => {
    if (ready()) {
      clearInterval(timer);
      fn();
    }
  }, 20);
};
const opened = (name) => () => existsSync(STATE + '/' + name);
const always = () => true;
const lingersAfterFailedInit = process.env.FAIL_FIRST_INIT_AND_LINGER === '1' && startIndex === 1;
if (lingersAfterFailedInit) process.on('SIGTERM', () => {});
setInterval(() => {
  if (existsSync(STATE + '/shutdown')) process.exit(0);
  if (lingersAfterFailedInit && existsSync(STATE + '/first-exit-open')) process.exit(0);
}, 50);
process.stdin.on('end', () => {
  if (!lingersAfterFailedInit) process.exit(0);
});
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (msg.method === 'initialize') {
      const agentCapabilities = {};
      if (caps.includes('resume')) agentCapabilities.sessionCapabilities = { resume: {} };
      const initResult = { protocolVersion: 1, agentCapabilities };
      if (process.env.AUTH_MODE === '1') initResult.authMethods = [{ id: 'login', name: 'Log in' }];
      const accept = () => reply(initResult);
      if (lingersAfterFailedInit) {
        fail(-32603, 'initialize refused by the first agent (pid ' + process.pid + ')');
      } else if (process.env.FAIL_INIT_WHEN_YOUNGER === '1') {
        when(
          () => youngerStarted() || opened('init-open')(),
          () =>
            youngerStarted()
              ? fail(-32603, 'initialize refused: a younger agent started (pid ' + process.pid + ')')
              : accept(),
        );
      } else {
        when(process.env.HOLD_FIRST_INIT === '1' && startIndex === 1 ? opened('init-open') : always, accept);
      }
    } else if (msg.method === 'authenticate') {
      appendFileSync(STATE + '/authed', process.pid + '\\n');
      reply({});
    } else if (msg.method === 'session/new' && process.env.AUTH_MODE === '1' && !existsSync(STATE + '/authed')) {
      fail(-32000, 'Authentication required');
    } else if (msg.method === 'session/new') {
      appendFileSync(STATE + '/session-requests.log', process.pid + '\\n');
      const result = { sessionId: 'sess-' + process.pid };
      if (process.env.CONFIG_MODE === '1') result.configOptions = modelOptions('a');
      when(
        process.env.HOLD_FIRST_SESSION === '1' && startIndex === 1 ? opened('first-session-open') : always,
        () => reply(result),
      );
    } else if (msg.method === 'session/set_config_option') {
      appendFileSync(STATE + '/config-requests.log', process.pid + '\\n');
      when(
        process.env.HOLD_FIRST_CONFIG === '1' && startIndex === 1 ? opened('first-config-open') : always,
        () => reply({ configOptions: modelOptions(msg.params.value) }),
      );
    } else if (msg.method === 'session/resume') {
      known.add(msg.params.sessionId);
      reply({});
    } else if (msg.method === 'session/prompt') {
      const text = msg.params.prompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\\n');
      appendFileSync(
        STATE + '/prompts.jsonl',
        JSON.stringify({ pid: process.pid, sessionId: msg.params.sessionId, text }) + '\\n',
      );
      if (known.has(msg.params.sessionId)) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: msg.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'served by ' + process.pid },
            },
          },
        });
        reply({ stopReason: 'end_turn' });
      } else {
        fail(-32002, 'unknown session ' + msg.params.sessionId + ' (agent pid ' + process.pid + ')');
      }
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`;

type StartedAgent = { pid: number; window: number | null };
type Received = { pid: number; sessionId: string; text: string };
type Settled = { ok: true; info: ThreadInfo } | { ok: false; error: string };

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
let agentStates: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(managers.map((manager) => manager.destroy()));
  for (const state of agentStates) writeFileSync(join(state, 'shutdown'), '');
  await waitWithinTestBudget(
    'every scripted agent to exit',
    () => agentStates.every((state) => startedIn(state).every(({ pid }) => processEnded(pid))),
    { timeoutMs: 10_000 },
  ).catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  managers = [];
  agentStates = [];
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-launch-'));
  dirs.push(dir);
  return dir;
}

function linesOf(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
}

function startedIn(state: string): StartedAgent[] {
  return linesOf(join(state, 'starts.jsonl')).map((line) => JSON.parse(line) as StartedAgent);
}

function settle(change: Promise<ThreadInfo>): Promise<Settled> {
  return change.then(
    (info) => ({ ok: true as const, info }),
    (err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

async function anchorOrQuiet(what: string, anchor: () => boolean): Promise<void> {
  const startedAt = Date.now();
  try {
    await waitWithinTestBudget(what, anchor, { timeoutMs: QUIET_MS });
  } catch (err) {
    const quietHeld =
      err instanceof Error &&
      err.message.startsWith(`timed out waiting for ${what} after `) &&
      Date.now() - startedAt >= QUIET_MS;
    if (!quietHeld) throw err;
  }
}

function supersededFailureReports(warn: ReturnType<typeof vi.spyOn>, threadId: string): number {
  return warn.mock.calls.filter((call: unknown[]) => {
    const [fields, message] = call;
    const report = fields as { threadId?: string; status?: string };
    return (
      message === SUPERSEDED_STATUS_LOG && report.threadId === threadId && report.status === 'error'
    );
  }).length;
}

function quietPeriod(): Promise<void> {
  return anchorOrQuiet('a superseded launch to act', () => false);
}

function scriptedHarness(
  env: Record<string, string> = {},
  entry: { id?: string; command?: string } = {},
) {
  const contentDir = tmp();
  const localDir = tmp();
  const state = tmp();
  agentStates.push(state);
  const agentPath = join(localDir, 'scripted-agent.mjs');
  writeFileSync(agentPath, SCRIPTED_AGENT);
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      {
        id: entry.id ?? CODEX,
        name: 'Scripted agent',
        command: entry.command ?? 'node',
        args: [agentPath],
        env: { AGENT_STATE: state, ...env },
      },
    ]),
  );
  const held: Array<PromiseWithResolvers<string | null>> = [];
  let holding = false;
  let closeGate: PromiseWithResolvers<void> | null = null;
  let closeReached = false;
  const manager = new AcpThreadManager({
    contentDir,
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => {
        throw new Error('offline test');
      }) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager: {
      ...sessionManager,
      closeAllForAgent: async () => {
        closeReached = true;
        await closeGate?.promise;
      },
    } as unknown as AgentSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    log,
    projectSkillSourceDir: null,
    resolveLoginShellPath: async () => {
      if (!holding) return null;
      const call = Promise.withResolvers<string | null>();
      held.push(call);
      return call.promise;
    },
  });
  managers.push(manager);
  const started = (): StartedAgent[] => startedIn(state);
  return {
    manager,
    localDir,
    hold: (on: boolean) => {
      holding = on;
    },
    heldCount: () => held.length,
    release: (call: number) => held[call]?.resolve(null),
    holdClose: () => {
      closeGate = Promise.withResolvers<void>();
    },
    closeHeld: () => closeReached,
    releaseClose: () => closeGate?.resolve(),
    started,
    liveAgents: (): StartedAgent[] => started().filter(({ pid }) => !processEnded(pid)),
    received: (): Received[] =>
      linesOf(join(state, 'prompts.jsonl')).map((line) => JSON.parse(line) as Received),
    configRequests: () => linesOf(join(state, 'config-requests.log')),
    sessionRequests: () => linesOf(join(state, 'session-requests.log')),
    open: (gate: string) => writeFileSync(join(state, gate), ''),
    launchFailures: (): string[] => {
      const path = join(localDir, ACP_LAUNCH_FAILURE_LOG);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('=== acp launch failure ')
        .slice(1)
        .map((entry) => {
          const [header = '', detail = ''] = entry.split('\n');
          return `${/reason=(\S+)/.exec(header)?.[1] ?? 'unknown'}: ${detail}`;
        });
    },
  };
}

const PI_PROJECT = {
  project: 'ready',
  cwd: '/tmp/pi-project',
  canonicalCwd: '/tmp/pi-project',
  bridgePath: '/tmp/pi-project/.pi/extensions/open-knowledge.ts',
  trustPath: '/tmp/pi-home/.pi/agent/trust.json',
  otherExtensions: [],
} as const;
const PI_BRIDGE_LOADABLE: PiAcpBridgeProbe = {
  ...PI_PROJECT,
  bridge: 'own-current',
  trust: 'trusted',
  bridgeLoadable: true,
};
const PI_BRIDGE_ABSENT: PiAcpBridgeProbe = {
  ...PI_PROJECT,
  bridge: 'absent',
  trust: 'untrusted',
  bridgeLoadable: false,
};
const PI_BRIDGE_FOREIGN: PiAcpBridgeProbe = {
  ...PI_PROJECT,
  bridge: 'foreign',
  trust: 'untrusted',
  bridgeLoadable: false,
};

function piHarness(env: Record<string, string> = {}) {
  const localDir = tmp();
  const state = tmp();
  const binDir = tmp();
  agentStates.push(state);
  const agentPath = join(localDir, 'scripted-agent.mjs');
  writeFileSync(agentPath, SCRIPTED_AGENT);
  const node = JSON.stringify(process.execPath);
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexec ${node} "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(binDir, 'npx'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nexec ${node} ${JSON.stringify(agentPath)}\n`,
    { mode: 0o755 },
  );
  const agent: RegistryAgent = {
    id: PI,
    name: 'Scripted Pi',
    version: '1.0.0',
    distribution: {
      npx: { package: '@fake/pi', env: { PATH: binDir, AGENT_STATE: state, ...env } },
    },
  };
  const held: Array<PromiseWithResolvers<PiAcpBridgeProbe>> = [];
  let holding = false;
  const manager = new AcpThreadManager({
    contentDir: tmp(),
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => new Response(JSON.stringify({ agents: [agent] }))) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    log,
    projectSkillSourceDir: null,
    resolveLoginShellPath: async () => null,
    probePiAcpBridge: () => {
      if (!holding) return PI_BRIDGE_LOADABLE;
      const call = Promise.withResolvers<PiAcpBridgeProbe>();
      held.push(call);
      return call.promise;
    },
    ensurePiAcpBridge: () => ({
      ok: true,
      bridgePath: PI_PROJECT.bridgePath,
      bridge: 'written',
      trust: 'added',
    }),
  });
  managers.push(manager);
  return {
    manager,
    holdProbes: (on: boolean) => {
      holding = on;
    },
    heldProbes: () => held.length,
    releaseProbe: (call: number, answer: PiAcpBridgeProbe) => held[call]?.resolve(answer),
  };
}

function catalogHarness(opts: { browser?: boolean } = {}) {
  const localDir = tmp();
  const state = tmp();
  const binDir = tmp();
  agentStates.push(state);
  const agentPath = join(localDir, 'scripted-agent.mjs');
  writeFileSync(agentPath, SCRIPTED_AGENT);
  const node = JSON.stringify(process.execPath);
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexec ${node} "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(binDir, 'npx'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nexec ${node} ${JSON.stringify(agentPath)}\n`,
    { mode: 0o755 },
  );
  const agent: RegistryAgent = {
    id: CODEX,
    name: 'Scripted catalog codex',
    version: '1.0.0',
    distribution: { npx: { package: '@fake/codex', env: { PATH: binDir, AGENT_STATE: state } } },
  };
  const heldCatalogs: Array<PromiseWithResolvers<RegistryAgent[]>> = [];
  let holdingCatalog = false;
  const heldShells: Array<PromiseWithResolvers<string | null>> = [];
  let holdingShell = false;
  let browserNpxLookups = 0;
  let browserInstalls = 0;
  const browserSeams =
    opts.browser === true
      ? {
          globalDir: tmp(),
          agentBrowserTools: () => true,
          resolveBrowserNpx: () => {
            browserNpxLookups += 1;
            return { npx: join(binDir, 'npx'), path: binDir };
          },
          ensureBrowserPackage: async () => {
            browserInstalls += 1;
          },
        }
      : {};
  const manager = new AcpThreadManager({
    contentDir: tmp(),
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log,
      ttlMs: 0,
      fetchImpl: (async () => {
        if (!holdingCatalog) return new Response(JSON.stringify({ agents: [agent] }));
        const call = Promise.withResolvers<RegistryAgent[]>();
        heldCatalogs.push(call);
        return new Response(JSON.stringify({ agents: await call.promise }));
      }) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    log,
    projectSkillSourceDir: null,
    ...browserSeams,
    resolveLoginShellPath: async () => {
      if (!holdingShell) return null;
      const call = Promise.withResolvers<string | null>();
      heldShells.push(call);
      return call.promise;
    },
  });
  managers.push(manager);
  const started = (): StartedAgent[] => startedIn(state);
  return {
    manager,
    agent,
    holdCatalog: (on: boolean) => {
      holdingCatalog = on;
    },
    heldCatalogs: () => heldCatalogs.length,
    releaseCatalog: (call: number, agents: RegistryAgent[]) => heldCatalogs[call]?.resolve(agents),
    holdShell: (on: boolean) => {
      holdingShell = on;
    },
    heldShells: () => heldShells.length,
    releaseShell: (call: number) => heldShells[call]?.resolve(null),
    browserNpxLookups: () => browserNpxLookups,
    browserInstalls: () => browserInstalls,
    liveAgents: (): StartedAgent[] => started().filter(({ pid }) => !processEnded(pid)),
    received: (): Received[] =>
      linesOf(join(state, 'prompts.jsonl')).map((line) => JSON.parse(line) as Received),
  };
}

async function observe(manager: AcpThreadManager, threadId: string) {
  const seen = new Map<number, ThreadEvent>();
  await manager.subscribe(threadId, 0, (frame) => {
    if (frame.op === 'event') seen.set(frame.seq, frame.event);
    else if (frame.op === 'events') {
      frame.events.forEach((event, index) => {
        seen.set(frame.fromSeq + index, event);
      });
    }
  });
  const events = (afterSeq = -1): Array<{ seq: number; event: ThreadEvent }> =>
    [...seen.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b)
      .map(([seq, event]) => ({ seq, event }));
  const statuses = (afterSeq = -1): string[] =>
    events(afterSeq).flatMap(({ event }) =>
      event.kind === 'status'
        ? [event.detail === undefined ? event.status : `${event.status}: ${event.detail}`]
        : [],
    );
  return { events, statuses };
}

type View = Awaited<ReturnType<typeof observe>>;

function userMessagesIn(view: View): string[] {
  return view
    .events()
    .flatMap(({ event }) => (event.kind === 'user_message' ? [event.content] : []));
}

function launchReadiesBeforeFirstUserMessage(view: View): string[] {
  const events = view.events().map(({ event }) => event);
  const firstUserMessage = events.findIndex((event) => event.kind === 'user_message');
  return readiesIn(
    events
      .slice(0, firstUserMessage === -1 ? events.length : firstUserMessage)
      .flatMap((event) => (event.kind === 'status' ? [event.status] : [])),
  );
}

function piBridgeEventsIn(view: View): string[] {
  return view
    .events()
    .flatMap(({ event }) =>
      event.kind === 'pi_bridge_consent_request' || event.kind === 'pi_bridge_status'
        ? [event.kind]
        : [],
    );
}

function errorsIn(statuses: string[]): string[] {
  return statuses.filter((status) => status.startsWith('error'));
}

function readiesIn(statuses: string[]): string[] {
  return statuses.filter((status) => status === 'ready');
}

async function promptTurn(
  manager: AcpThreadManager,
  threadId: string,
  view: View,
  text: string,
): Promise<{ refused: string | null; stopReason: string | null; servedBy: number | null }> {
  const from = manager.getInfo(threadId)?.lastSeq ?? -1;
  try {
    manager.sendPrompt(threadId, text);
  } catch (err) {
    return {
      refused: err instanceof Error ? err.message : String(err),
      stopReason: null,
      servedBy: null,
    };
  }
  await waitWithinTestBudget(
    `the turn for "${text}" to end or fail`,
    () =>
      view
        .events(from)
        .some(
          ({ event }) =>
            event.kind === 'turn_ended' || (event.kind === 'status' && event.status === 'error'),
        ),
    WAIT,
  );
  const after = view.events(from).map(({ event }) => event);
  const ended = after.find((event) => event.kind === 'turn_ended');
  const served = /served by (\d+)/.exec(JSON.stringify(after));
  return {
    refused: null,
    stopReason: ended?.kind === 'turn_ended' ? ended.stopReason : null,
    servedBy: served === null ? null : Number(served[1]),
  };
}

async function closeAndAwaitAgentsGone(
  harness: ReturnType<typeof scriptedHarness>,
  threadId: string,
): Promise<StartedAgent[]> {
  await harness.manager.closeThread(threadId);
  await waitWithinTestBudget(
    'every agent the thread started to exit after close',
    () => harness.liveAgents().length === 0,
    { timeoutMs: 5_000 },
  ).catch(() => {});
  return harness.liveAgents();
}

describe('a context window change superseding a thread first launch', () => {
  test('a change before the first launch spawns leaves one agent on the new window, ready once, serving prompts and stopped on close', async () => {
    const harness = scriptedHarness();
    harness.hold(true);
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    await waitWithinTestBudget(
      'the restart to wait before spawning',
      () => harness.heldCount() === 2,
      WAIT,
    );
    harness.hold(false);
    harness.release(0);
    harness.release(1);

    expect(await changed).toMatchObject({
      ok: true,
      info: { status: 'ready', contextWindow: NEW_WINDOW },
    });
    await anchorOrQuiet(
      'a second ready from the superseded launch',
      () => readiesIn(view.statuses()).length >= 2,
    );
    const live = harness.liveAgents();
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect.soft(readiesIn(view.statuses())).toEqual(['ready']);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 45_000);

  test('a first launch superseded before it spawns starts no agent when released ahead of the restart', async () => {
    const harness = scriptedHarness();
    harness.hold(true);
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    await waitWithinTestBudget(
      'the restart to wait before spawning',
      () => harness.heldCount() === 2,
      WAIT,
    );
    harness.hold(false);
    harness.release(0);
    await anchorOrQuiet('the superseded launch to spawn', () => harness.started().length > 0);
    expect(harness.started()).toEqual([]);
    harness.release(1);
    const outcome = await changed;
    await anchorOrQuiet(
      'a second ready from the superseded launch',
      () => readiesIn(view.statuses()).length >= 2,
    );

    expect.soft(outcome).toMatchObject({
      ok: true,
      info: { status: 'ready', contextWindow: NEW_WINDOW },
    });
    const live = harness.liveAgents();
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect.soft(readiesIn(view.statuses())).toEqual(['ready']);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 45_000);

  test('a first launch the change stops during initialize reports no failure while the restart is pending', async () => {
    const warn = vi.spyOn(log, 'warn');
    const harness = scriptedHarness({ HOLD_FIRST_INIT: '1' });
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first agent to start and wait on initialize',
      () => harness.started().length === 1,
      WAIT,
    );
    harness.hold(true);
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    await waitWithinTestBudget(
      'the restart to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    await waitWithinTestBudget(
      'the stopped first launch to settle its failure as superseded',
      () => supersededFailureReports(warn, info.threadId) === 1,
      WAIT,
    );
    await quietPeriod();

    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(harness.launchFailures()).toEqual([]);
    harness.hold(false);
    harness.release(0);
    expect.soft(await changed).toMatchObject({
      ok: true,
      info: { status: 'ready', contextWindow: NEW_WINDOW },
    });
    const live = harness.liveAgents();
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 45_000);

  test('a first launch the change stops while its session opens reports no failure while the restart is pending', async () => {
    const warn = vi.spyOn(log, 'warn');
    const harness = scriptedHarness({ HOLD_FIRST_SESSION: '1' });
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first agent to request its session and wait for it',
      () => harness.sessionRequests().length === 1,
      WAIT,
    );
    harness.hold(true);
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    await waitWithinTestBudget(
      'the restart to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    await waitWithinTestBudget(
      'the stopped first launch to settle its failure as superseded',
      () => supersededFailureReports(warn, info.threadId) === 1,
      WAIT,
    );
    await quietPeriod();

    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(harness.launchFailures()).toEqual([]);
    harness.hold(false);
    harness.release(0);
    expect.soft(await changed).toMatchObject({
      ok: true,
      info: { status: 'ready', contextWindow: NEW_WINDOW },
    });
    await quietPeriod();
    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(harness.launchFailures()).toEqual([]);
    const live = harness.liveAgents();
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 45_000);

  test('a first launch superseded before it spawns starts no agent when released after the restart agent has started', async () => {
    const harness = scriptedHarness({ FAIL_INIT_WHEN_YOUNGER: '1' });
    harness.hold(true);
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    await waitWithinTestBudget(
      'the restart to wait before spawning',
      () => harness.heldCount() === 2,
      WAIT,
    );
    harness.hold(false);
    harness.release(1);
    await waitWithinTestBudget(
      'the restart agent to start and wait on initialize',
      () => harness.started().length === 1,
      WAIT,
    );
    harness.release(0);
    await anchorOrQuiet('the superseded launch to spawn', () => harness.started().length > 1);
    expect(harness.started()).toHaveLength(1);
    harness.open('init-open');

    expect.soft(await changed).toMatchObject({
      ok: true,
      info: { status: 'ready', contextWindow: NEW_WINDOW },
    });
    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(harness.launchFailures()).toEqual([]);
    const live = harness.liveAgents();
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 45_000);

  test('a change while the remembered model applies delivers the initial prompt exactly once, to the agent the thread owns', async () => {
    const harness = scriptedHarness({ CONFIG_MODE: '1', HOLD_FIRST_CONFIG: '1' });
    const info = await harness.manager.createThread({
      agent: { source: 'custom', id: CODEX },
      prompt: 'hello first',
      settings: { config: { model: 'b' } },
    });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to publish config options and send the remembered model',
      () =>
        harness.manager.getInfo(info.threadId)?.configOptions != null &&
        harness.configRequests().length === 1,
      WAIT,
    );
    expect({
      status: harness.manager.getInfo(info.threadId)?.status,
      hasStartedWork: harness.manager.hasStartedWork(info.threadId),
    }).toEqual({ status: 'spawning', hasStartedWork: false });

    expect
      .soft(await settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW)))
      .toMatchObject({ ok: true, info: { status: 'running', contextWindow: NEW_WINDOW } });
    await waitWithinTestBudget(
      'the initial prompt turn to end',
      () => view.events().some(({ event }) => event.kind === 'turn_ended'),
      { timeoutMs: 10_000 },
    ).catch(() => {});
    await quietPeriod();

    const live = harness.liveAgents();
    const events = view.events().map(({ event }) => event);
    const firstUserMessage = events.findIndex((event) => event.kind === 'user_message');
    const launchStatuses = events
      .slice(0, firstUserMessage === -1 ? events.length : firstUserMessage)
      .flatMap((event) => (event.kind === 'status' ? [event.status] : []));
    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(readiesIn(launchStatuses)).toEqual(['ready']);
    expect
      .soft(events.flatMap((event) => (event.kind === 'user_message' ? [event.content] : [])))
      .toEqual(['hello first']);
    expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
    expect(
      harness
        .received()
        .map(({ pid, text }) => ({ pid, initialPrompt: text.includes('hello first') })),
    ).toEqual([{ pid: live[0]?.pid, initialPrompt: true }]);
  }, 45_000);

  test('a first launch released after an archive and resume never acts on the resumed thread', async () => {
    const harness = scriptedHarness({ FAKE_CAPS: 'resume' });
    await harness.manager.init();
    harness.hold(true);
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    harness.hold(false);
    expect(await settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW))).toMatchObject(
      { ok: true, info: { status: 'ready' } },
    );
    expect(await promptTurn(harness.manager, info.threadId, view, 'first turn')).toMatchObject({
      stopReason: 'end_turn',
    });
    await harness.manager.closeThread(info.threadId);
    expect(harness.manager.getInfo(info.threadId)?.archived).toBe(true);
    expect((await harness.manager.resumeThread(info.threadId)).status).toBe('ready');
    const resumed = harness.liveAgents();
    expect(resumed).toHaveLength(1);
    const startedBeforeRelease = harness.started().length;
    const releasedAt = harness.manager.getInfo(info.threadId)?.lastSeq ?? -1;

    harness.release(0);
    await anchorOrQuiet(
      'the superseded launch to spawn',
      () => harness.started().length > startedBeforeRelease,
    );
    await quietPeriod();

    expect.soft(view.statuses(releasedAt)).toEqual([]);
    expect.soft(harness.liveAgents()).toEqual(resumed);
    expect
      .soft(await promptTurn(harness.manager, info.threadId, view, 'after release'))
      .toEqual({ refused: null, stopReason: 'end_turn', servedBy: resumed[0]?.pid });
    expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
  }, 60_000);

  test('a change requested after the first launch opens its session but before it is ready is refused once that launch delivers the initial prompt exactly once, after one ready', async () => {
    const harness = scriptedHarness({ CONFIG_MODE: '1' });
    harness.hold(true);
    const info = await harness.manager.createThread({
      agent: { source: 'custom', id: CODEX },
      prompt: 'hello first',
    });
    const change: { outcome?: Promise<Settled> } = {};
    await harness.manager.subscribe(info.threadId, 0, (frame) => {
      if (
        change.outcome !== undefined ||
        frame.op !== 'info' ||
        frame.info.status !== 'spawning' ||
        frame.info.configOptions == null
      ) {
        return;
      }
      change.outcome = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    harness.hold(false);
    harness.release(0);
    await waitWithinTestBudget(
      'the first launch to open its session and publish config options',
      () => change.outcome !== undefined,
      WAIT,
    );

    expect
      .soft(await change.outcome)
      .toEqual({ ok: false, error: 'start a new chat to change the context window' });
    await waitWithinTestBudget(
      'the initial prompt turn to end',
      () => view.events().some(({ event }) => event.kind === 'turn_ended'),
      { timeoutMs: 10_000 },
    ).catch(() => {});
    await quietPeriod();

    const live = harness.liveAgents();
    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(launchReadiesBeforeFirstUserMessage(view)).toEqual(['ready']);
    expect.soft(userMessagesIn(view)).toEqual(['hello first']);
    expect.soft(live.map(({ window }) => window)).toEqual([null]);
    expect(
      harness
        .received()
        .map(({ pid, text }) => ({ pid, initialPrompt: text.includes('hello first') })),
    ).toEqual([{ pid: live[0]?.pid, initialPrompt: true }]);
  }, 45_000);

  test.skipIf(process.platform === 'win32')(
    'a change requested at the failed first launch failure report sends no initial prompt',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: CODEX },
        prompt: 'hello first',
      });
      const change: { outcome?: Promise<Settled> } = {};
      await harness.manager.subscribe(info.threadId, 0, (frame) => {
        if (change.outcome !== undefined || frame.op !== 'info' || frame.info.status !== 'error') {
          return;
        }
        symlinkSync(process.execPath, agentNode);
        change.outcome = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.release(0);
      await waitWithinTestBudget(
        'the restart to wait before spawning',
        () => harness.heldCount() === 2,
        WAIT,
      );
      await quietPeriod();
      harness.hold(false);
      harness.release(1);

      expect(change.outcome).toBeDefined();
      expect
        .soft(await change.outcome)
        .toMatchObject({ ok: true, info: { status: 'ready', contextWindow: NEW_WINDOW } });
      await quietPeriod();

      expect.soft(userMessagesIn(view)).toEqual([]);
      expect.soft(harness.received()).toEqual([]);
      const live = harness.liveAgents();
      expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
      expect(await promptTurn(harness.manager, info.threadId, view, 'hello')).toEqual({
        refused: null,
        stopReason: 'end_turn',
        servedBy: live[0]?.pid,
      });
    },
    45_000,
  );

  test.skipIf(process.platform === 'win32')(
    'a change requested at the failed first launch failure report sends no initial prompt while the failed agent is still exiting',
    async () => {
      const harness = scriptedHarness({ FAIL_FIRST_INIT_AND_LINGER: '1' });
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: CODEX },
        prompt: 'hello first',
      });
      const change: { outcome?: Promise<Settled> } = {};
      await harness.manager.subscribe(info.threadId, 0, (frame) => {
        if (change.outcome !== undefined || frame.op !== 'info' || frame.info.status !== 'error') {
          return;
        }
        change.outcome = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the change to start a second agent',
        () => harness.started().length === 2,
        WAIT,
      );
      const [failed] = harness.started();
      expect(change.outcome).toBeDefined();
      expect(failed !== undefined && !processEnded(failed.pid)).toBe(true);
      harness.open('first-exit-open');

      expect
        .soft(await change.outcome)
        .toMatchObject({ ok: true, info: { status: 'ready', contextWindow: NEW_WINDOW } });
      await waitWithinTestBudget(
        'the failed first agent to exit',
        () => failed !== undefined && processEnded(failed.pid),
        WAIT,
      );
      await quietPeriod();

      expect.soft(userMessagesIn(view)).toEqual([]);
      expect.soft(harness.received()).toEqual([]);
      const live = harness.liveAgents();
      expect.soft(live.map(({ window }) => window)).toEqual([NEW_WINDOW]);
      expect(await promptTurn(harness.manager, info.threadId, view, 'hello')).toEqual({
        refused: null,
        stopReason: 'end_turn',
        servedBy: live[0]?.pid,
      });
    },
    45_000,
  );
});

describe('a retry superseding a thread first launch', () => {
  test.skipIf(process.platform === 'win32')(
    'a retry requested at the failed first launch failure report reports no failure after its own spawning status and serves the thread from one agent',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { id: 'retried-agent', command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: 'retried-agent' },
      });
      const retry: { outcome?: Promise<Settled>; afterSeq?: number } = {};
      await harness.manager.subscribe(info.threadId, 0, (frame) => {
        if (retry.outcome !== undefined || frame.op !== 'info' || frame.info.status !== 'error') {
          return;
        }
        symlinkSync(process.execPath, agentNode);
        retry.afterSeq = frame.info.lastSeq;
        retry.outcome = settle(harness.manager.retryThread(info.threadId));
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.release(0);
      await waitWithinTestBudget(
        'the retry to wait before spawning',
        () => harness.heldCount() === 2,
        WAIT,
      );
      await quietPeriod();

      const takeover = view
        .events(retry.afterSeq)
        .find(({ event }) => event.kind === 'status' && event.status === 'spawning');
      expect(takeover).toBeDefined();
      expect.soft(errorsIn(view.statuses(takeover?.seq))).toEqual([]);
      harness.hold(false);
      harness.release(1);
      expect.soft(await retry.outcome).toMatchObject({ ok: true, info: { status: 'ready' } });
      const live = harness.liveAgents();
      expect.soft(live).toHaveLength(1);
      expect
        .soft(await promptTurn(harness.manager, info.threadId, view, 'hello'))
        .toEqual({ refused: null, stopReason: 'end_turn', servedBy: live[0]?.pid });
      expect(await closeAndAwaitAgentsGone(harness, info.threadId)).toEqual([]);
    },
    45_000,
  );

  test.skipIf(process.platform === 'win32')(
    'a retry requested at the failed first launch failure report sends no initial prompt',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { id: 'retried-agent', command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: 'retried-agent' },
        prompt: 'hello first',
      });
      const retry: { outcome?: Promise<Settled> } = {};
      await harness.manager.subscribe(info.threadId, 0, (frame) => {
        if (retry.outcome !== undefined || frame.op !== 'info' || frame.info.status !== 'error') {
          return;
        }
        symlinkSync(process.execPath, agentNode);
        retry.outcome = settle(harness.manager.retryThread(info.threadId));
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.release(0);
      await waitWithinTestBudget(
        'the retry to wait before spawning',
        () => harness.heldCount() === 2,
        WAIT,
      );
      await quietPeriod();
      harness.hold(false);
      harness.release(1);

      expect(retry.outcome).toBeDefined();
      expect.soft(await retry.outcome).toMatchObject({ ok: true, info: { status: 'ready' } });
      await quietPeriod();

      expect.soft(userMessagesIn(view)).toEqual([]);
      expect.soft(harness.received()).toEqual([]);
      const live = harness.liveAgents();
      expect(await promptTurn(harness.manager, info.threadId, view, 'hello')).toEqual({
        refused: null,
        stopReason: 'end_turn',
        servedBy: live[0]?.pid,
      });
    },
    45_000,
  );
});

describe.skipIf(process.platform === 'win32')(
  'a context window change while the catalog agent npx package installs',
  () => {
    function heldCodexManager(held: HeldInstallRegistry): AcpThreadManager {
      const localDir = mkdtempSync(join(held.home, 'local-'));
      const contentDir = mkdtempSync(join(held.home, 'content-'));
      const agent: RegistryAgent = {
        id: CODEX,
        name: 'Held install codex',
        version: '1.0.0',
        distribution: { npx: { package: held.npmPackage } },
      };
      return new AcpThreadManager({
        contentDir,
        localDir,
        globalDir: null,
        registry: new AcpRegistry({
          localDir,
          log,
          fetchImpl: (async () =>
            new Response(JSON.stringify({ agents: [agent] }))) as typeof fetch,
        }),
        permissions: new AcpPermissionStore(localDir, log),
        sessionManager,
        isExcludedPath: () => false,
        isIgnoredPath: () => false,
        log,
        resolveLoginShellPath: async () => null,
        projectSkillSourceDir: null,
      });
    }

    test('the change starts one agent, reports ready once, and leaves nothing the thread started alive after close', async () => {
      expect(
        () => descendantsOf(process.pid),
        'this test reads the process table with ps',
      ).not.toThrow();
      await withHeldInstallRegistry(async (held) => {
        const preexisting = new Set(descendantsOf(process.pid));
        const started = new Set<number>();
        const liveSinceStart = (): number[] => {
          const live = descendantsOf(process.pid).filter((pid) => !preexisting.has(pid));
          for (const pid of live) started.add(pid);
          return live;
        };
        const manager = heldCodexManager(held);
        try {
          const info = await manager.createThread({ agent: { source: 'registry', id: CODEX } });
          const view = await observe(manager, info.threadId);
          await waitWithinTestBudget(
            'npm to request the held dependency tarball mid-install',
            () => {
              liveSinceStart();
              return held.requested('npm-dependency') === 1;
            },
            { timeoutMs: 60_000 },
          );
          const changed = settle(manager.setContextWindow(info.threadId, NEW_WINDOW));
          await waitWithinTestBudget(
            'the restart to join the in-flight install',
            () => {
              liveSinceStart();
              return view.statuses().filter((status) => status === 'installing').length >= 2;
            },
            { timeoutMs: 30_000 },
          );
          held.release('npm-dependency');

          expect
            .soft(await changed)
            .toMatchObject({ ok: true, info: { status: 'ready', contextWindow: NEW_WINDOW } });
          await anchorOrQuiet('a second ready from the superseded launch', () => {
            liveSinceStart();
            return readiesIn(view.statuses()).length >= 2;
          });
          expect.soft(readiesIn(view.statuses())).toEqual(['ready']);
          await manager.closeThread(info.threadId);
          await waitWithinTestBudget(
            'every process the thread started to exit after close',
            () => liveSinceStart().length === 0 && [...started].every(processEnded),
            { timeoutMs: 15_000 },
          ).catch(() => {});
          expect(liveSinceStart()).toEqual([]);
        } finally {
          held.release('npm-dependency');
          await manager.destroy();
        }
      });
    }, 150_000);
  },
);

describe.skipIf(process.platform === 'win32')(
  'a Pi bridge step of a launch that is no longer current',
  () => {
    test('a sign-in the retry superseded asks for no Pi bridge consent once its bridge probe returns', async () => {
      const harness = piHarness({ AUTH_MODE: '1' });
      const info = await harness.manager.createThread({ agent: { source: 'registry', id: PI } });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to park on sign-in',
        () => harness.manager.getInfo(info.threadId)?.status === 'auth_required',
        WAIT,
      );
      harness.holdProbes(true);
      const signIn = settle(harness.manager.authenticateThread(info.threadId, 'login'));
      await waitWithinTestBudget(
        'the sign-in to probe the Pi bridge',
        () => harness.heldProbes() === 1,
        WAIT,
      );
      harness.holdProbes(false);
      expect(await settle(harness.manager.retryThread(info.threadId))).toMatchObject({
        ok: true,
        info: { status: 'ready' },
      });

      harness.releaseProbe(0, PI_BRIDGE_ABSENT);
      expect
        .soft(await signIn)
        .toEqual({ ok: false, error: 'the thread was restarted during the sign-in' });
      await anchorOrQuiet(
        'the superseded sign-in to touch the Pi bridge',
        () => piBridgeEventsIn(view).length > 0,
      );
      expect(piBridgeEventsIn(view)).toEqual([]);
    }, 45_000);

    test('a resume closed while its bridge probe is pending reports no Pi bridge status on the archived thread', async () => {
      const harness = piHarness();
      await harness.manager.init();
      const info = await harness.manager.createThread({ agent: { source: 'registry', id: PI } });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to be ready',
        () => harness.manager.getInfo(info.threadId)?.status === 'ready',
        WAIT,
      );
      expect(await promptTurn(harness.manager, info.threadId, view, 'first turn')).toMatchObject({
        stopReason: 'end_turn',
      });
      await harness.manager.closeThread(info.threadId);
      harness.holdProbes(true);
      const resumed = settle(harness.manager.resumeThread(info.threadId));
      await waitWithinTestBudget(
        'the resume to probe the Pi bridge',
        () => harness.heldProbes() === 1,
        WAIT,
      );
      await harness.manager.closeThread(info.threadId);
      expect(harness.manager.getInfo(info.threadId)?.archived).toBe(true);

      harness.releaseProbe(0, PI_BRIDGE_FOREIGN);
      expect.soft(await resumed).toEqual({ ok: false, error: 'thread closed during resume' });
      await anchorOrQuiet(
        'the closed resume to touch the Pi bridge',
        () => piBridgeEventsIn(view).length > 0,
      );
      expect(piBridgeEventsIn(view)).toEqual([]);
    }, 45_000);
  },
);

describe.skipIf(process.platform === 'win32')(
  'a browser step of a launch that is no longer current',
  () => {
    test('a first launch a context window change supersedes while it looks up its login shell for the browser never finds the browser npx or installs the browser', async () => {
      const harness = catalogHarness({ browser: true });
      harness.holdShell(true);
      const info = await harness.manager.createThread({ agent: { source: 'registry', id: CODEX } });
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldShells() === 1,
        WAIT,
      );
      harness.releaseShell(0);
      await waitWithinTestBudget(
        'the first launch to look up its login shell for the browser',
        () => harness.heldShells() === 2,
        WAIT,
      );
      const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
      await waitWithinTestBudget(
        'the restart to wait before spawning',
        () => harness.heldShells() === 3,
        WAIT,
      );
      harness.holdShell(false);
      harness.releaseShell(2);
      expect(await changed).toMatchObject({
        ok: true,
        info: { status: 'ready', contextWindow: NEW_WINDOW },
      });
      expect({
        lookups: harness.browserNpxLookups(),
        installs: harness.browserInstalls(),
      }).toEqual({ lookups: 1, installs: 1 });

      harness.releaseShell(1);
      await anchorOrQuiet(
        'the superseded launch to look up the browser npx',
        () => harness.browserNpxLookups() > 1,
      );

      expect({
        lookups: harness.browserNpxLookups(),
        installs: harness.browserInstalls(),
      }).toEqual({ lookups: 1, installs: 1 });
      expect(harness.manager.getInfo(info.threadId)?.status).toBe('ready');
    }, 45_000);
  },
);

describe('a first launch that stays current', () => {
  test('a change refused before it takes over leaves the first launch to start the thread and deliver its prompt once', async () => {
    const harness = scriptedHarness();
    harness.hold(true);
    const info = await harness.manager.createThread({
      agent: { source: 'custom', id: CODEX },
      prompt: 'hello first',
    });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the first launch to wait before spawning',
      () => harness.heldCount() === 1,
      WAIT,
    );
    writeFileSync(join(harness.localDir, 'acp-agents.json'), JSON.stringify([]));

    await expect(harness.manager.setContextWindow(info.threadId, NEW_WINDOW)).rejects.toThrow(
      /no custom agent/,
    );
    harness.hold(false);
    harness.release(0);
    await waitWithinTestBudget(
      'the initial prompt turn to end',
      () => view.events().some(({ event }) => event.kind === 'turn_ended'),
      WAIT,
    );
    await quietPeriod();

    const live = harness.liveAgents();
    expect.soft(errorsIn(view.statuses())).toEqual([]);
    expect.soft(launchReadiesBeforeFirstUserMessage(view)).toEqual(['ready']);
    expect.soft(userMessagesIn(view)).toEqual(['hello first']);
    expect.soft(harness.started().map(({ window }) => window)).toEqual([null]);
    expect.soft(harness.manager.getInfo(info.threadId)?.contextWindow).toBeNull();
    expect(
      harness
        .received()
        .map(({ pid, text }) => ({ pid, initialPrompt: text.includes('hello first') })),
    ).toEqual([{ pid: live[0]?.pid, initialPrompt: true }]);
  }, 45_000);

  test.skipIf(process.platform === 'win32')(
    'a change refused while the first launch moves past a check leaves that launch to start the thread and deliver its prompt once',
    async () => {
      const harness = catalogHarness();
      harness.holdShell(true);
      const info = await harness.manager.createThread({
        agent: { source: 'registry', id: CODEX },
        prompt: 'hello first',
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldShells() === 1,
        WAIT,
      );
      harness.holdCatalog(true);
      const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
      await waitWithinTestBudget(
        'the change to look its agent up in the catalog',
        () => harness.heldCatalogs() === 1,
        WAIT,
      );
      harness.holdShell(false);
      harness.releaseShell(0);
      await waitWithinTestBudget(
        'the initial prompt turn to end',
        () => view.events().some(({ event }) => event.kind === 'turn_ended'),
        WAIT,
      ).catch(() => {});
      harness.releaseCatalog(0, [{ ...harness.agent, id: 'another-agent' }]);

      expect
        .soft(await changed)
        .toEqual({ ok: false, error: `agent '${CODEX}' is not in the registry` });
      await quietPeriod();
      const live = harness.liveAgents();
      expect.soft(errorsIn(view.statuses())).toEqual([]);
      expect.soft(launchReadiesBeforeFirstUserMessage(view)).toEqual(['ready']);
      expect.soft(userMessagesIn(view)).toEqual(['hello first']);
      expect.soft(harness.manager.getInfo(info.threadId)?.contextWindow).toBeNull();
      expect(
        harness
          .received()
          .map(({ pid, text }) => ({ pid, initialPrompt: text.includes('hello first') })),
      ).toEqual([{ pid: live[0]?.pid, initialPrompt: true }]);
    },
    45_000,
  );

  test.skipIf(process.platform === 'win32')(
    'a retry after the first launch has failed sends no initial prompt',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { id: 'retried-agent', command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: 'retried-agent' },
        prompt: 'hello first',
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.hold(false);
      harness.release(0);
      await waitWithinTestBudget(
        'the first launch to fail',
        () => errorsIn(view.statuses()).length > 0,
        WAIT,
      );
      await quietPeriod();

      symlinkSync(process.execPath, agentNode);
      expect
        .soft(await settle(harness.manager.retryThread(info.threadId)))
        .toMatchObject({ ok: true, info: { status: 'ready' } });
      await quietPeriod();

      expect.soft(userMessagesIn(view)).toEqual([]);
      expect.soft(harness.received()).toEqual([]);
      const live = harness.liveAgents();
      expect(await promptTurn(harness.manager, info.threadId, view, 'hello')).toEqual({
        refused: null,
        stopReason: 'end_turn',
        servedBy: live[0]?.pid,
      });
    },
    45_000,
  );
});

describe('a launch requested while the thread is closing', () => {
  test.skipIf(process.platform === 'win32')(
    'a retry requested while the thread is closing is refused and starts no agent',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { id: 'retried-agent', command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: 'retried-agent' },
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.hold(false);
      harness.release(0);
      await waitWithinTestBudget(
        'the first launch to fail',
        () => errorsIn(view.statuses()).length > 0,
        WAIT,
      );
      await quietPeriod();

      harness.holdClose();
      const closing = harness.manager.closeThread(info.threadId);
      await waitWithinTestBudget('the close to clean up sessions', () => harness.closeHeld(), WAIT);
      symlinkSync(process.execPath, agentNode);
      const retried = await settle(harness.manager.retryThread(info.threadId));
      harness.releaseClose();
      await closing;
      await anchorOrQuiet(
        'an agent to start for the closed thread',
        () => harness.started().length > 0,
      );

      expect.soft(retried).toEqual({ ok: false, error: 'the thread is closing' });
      expect.soft(harness.manager.getInfo(info.threadId)?.archived).toBe(true);
      expect(harness.started()).toEqual([]);
    },
    45_000,
  );

  test('a context window change requested while the thread is closing is refused and starts no agent', async () => {
    const harness = scriptedHarness();
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    await waitWithinTestBudget(
      'the first launch to be ready',
      () => harness.manager.getInfo(info.threadId)?.status === 'ready',
      WAIT,
    );
    const first = harness.started();

    harness.holdClose();
    const closing = harness.manager.closeThread(info.threadId);
    await waitWithinTestBudget('the close to clean up sessions', () => harness.closeHeld(), WAIT);
    const changed = await settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    harness.releaseClose();
    await closing;
    await anchorOrQuiet(
      'an agent to start for the closed thread',
      () => harness.started().length > first.length,
    );

    expect.soft(changed).toEqual({ ok: false, error: 'the thread is closing' });
    expect(harness.started()).toEqual(first);
  }, 45_000);

  test.skipIf(process.platform === 'win32')(
    'a retry requested just before a close begins is refused when its agent lookup returns and starts no agent',
    async () => {
      const binDir = tmp();
      const agentNode = join(binDir, 'agent-node');
      symlinkSync(process.execPath, agentNode);
      const harness = scriptedHarness({}, { id: 'retried-agent', command: agentNode });
      harness.hold(true);
      const info = await harness.manager.createThread({
        agent: { source: 'custom', id: 'retried-agent' },
      });
      const view = await observe(harness.manager, info.threadId);
      await waitWithinTestBudget(
        'the first launch to wait before spawning',
        () => harness.heldCount() === 1,
        WAIT,
      );
      unlinkSync(agentNode);
      harness.hold(false);
      harness.release(0);
      await waitWithinTestBudget(
        'the first launch to fail',
        () => errorsIn(view.statuses()).length > 0,
        WAIT,
      );
      await quietPeriod();
      symlinkSync(process.execPath, agentNode);

      harness.holdClose();
      const retried = settle(harness.manager.retryThread(info.threadId));
      const closing = harness.manager.closeThread(info.threadId);
      await waitWithinTestBudget('the close to clean up sessions', () => harness.closeHeld(), WAIT);
      expect.soft(await retried).toEqual({ ok: false, error: 'the thread is closing' });
      harness.releaseClose();
      await closing;
      await anchorOrQuiet(
        'an agent to start for the closed thread',
        () => harness.started().length > 0,
      );

      expect.soft(harness.manager.getInfo(info.threadId)?.archived).toBe(true);
      expect(harness.started()).toEqual([]);
    },
    45_000,
  );

  test('a context window change requested just before a close begins is refused when its agent lookup returns and starts no agent', async () => {
    const harness = scriptedHarness();
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    await waitWithinTestBudget(
      'the first launch to be ready',
      () => harness.manager.getInfo(info.threadId)?.status === 'ready',
      WAIT,
    );
    const first = harness.started();

    harness.holdClose();
    const changed = settle(harness.manager.setContextWindow(info.threadId, NEW_WINDOW));
    const closing = harness.manager.closeThread(info.threadId);
    await waitWithinTestBudget('the close to clean up sessions', () => harness.closeHeld(), WAIT);
    expect.soft(await changed).toEqual({ ok: false, error: 'the thread is closing' });
    harness.releaseClose();
    await closing;
    await anchorOrQuiet(
      'an agent to start for the closed thread',
      () => harness.started().length > first.length,
    );

    expect(harness.started()).toEqual(first);
  }, 45_000);

  test('a sign-in requested while the thread is closing is refused as closing, as a retry is', async () => {
    const harness = scriptedHarness({ AUTH_MODE: '1' });
    const info = await harness.manager.createThread({ agent: { source: 'custom', id: CODEX } });
    await waitWithinTestBudget(
      'the first launch to park on a sign-in',
      () => harness.manager.getInfo(info.threadId)?.status === 'auth_required',
      WAIT,
    );

    harness.holdClose();
    const closing = harness.manager.closeThread(info.threadId);
    await waitWithinTestBudget('the close to clean up sessions', () => harness.closeHeld(), WAIT);
    const signIn = await settle(harness.manager.authenticateThread(info.threadId, 'login'));
    const retried = await settle(harness.manager.retryThread(info.threadId));
    harness.releaseClose();
    await closing;

    expect.soft(signIn).toEqual({ ok: false, error: 'the thread is closing' });
    expect(retried).toEqual({ ok: false, error: 'the thread is closing' });
  }, 45_000);

  test('a resume requested while the thread is closing is refused and starts no agent', async () => {
    const harness = scriptedHarness({ FAKE_CAPS: 'resume' });
    await harness.manager.init();
    const info = await harness.manager.createThread({
      agent: { source: 'custom', id: CODEX },
      prompt: 'hello first',
    });
    const view = await observe(harness.manager, info.threadId);
    await waitWithinTestBudget(
      'the initial prompt turn to end',
      () => view.events().some(({ event }) => event.kind === 'turn_ended'),
      WAIT,
    );
    const first = harness.started();
    const resume: { outcome?: Promise<Settled> } = {};
    await harness.manager.subscribe(info.threadId, 0, (frame) => {
      if (resume.outcome !== undefined || frame.op !== 'info' || frame.info.archived !== true) {
        return;
      }
      resume.outcome = settle(harness.manager.resumeThread(info.threadId));
    });

    await harness.manager.closeThread(info.threadId);
    await anchorOrQuiet(
      'an agent to start for the closing thread',
      () => harness.started().length > first.length,
    );

    expect(resume.outcome).toBeDefined();
    expect.soft(await resume.outcome).toEqual({ ok: false, error: 'the thread is closing' });
    expect.soft(harness.manager.getInfo(info.threadId)?.archived).toBe(true);
    expect(harness.started()).toEqual(first);
  }, 45_000);
});
