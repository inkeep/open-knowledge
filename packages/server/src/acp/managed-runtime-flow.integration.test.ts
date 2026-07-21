/**
 * The consent-gated managed-runtime launch path, driven through the real
 * `AcpThreadManager`. A registry agent distributed via `npx` is launched with
 * an empty `PATH` (so the system `npx` can't resolve), which forces the
 * download flow: the manager emits a `runtime_consent_request`, parks the
 * launch, and — once granted through `respondRuntimeConsent` — downloads +
 * verifies a synthetic Node runtime served through a fake `fetch`.
 *
 * Everything but the network + `~/.ok` is real: the archive is extracted,
 * checksum-verified, installed, and the launcher relocated by the same code
 * production uses.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ThreadEvent,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { findManagedRuntime, readRuntimeConsent } from './managed-runtime.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import { AcpThreadManager } from './thread-manager.ts';

const log = getLogger('managed-runtime-flow-test');

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('unused');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'runtime-flow-test-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const NPX_AGENT = {
  id: 'npxagent',
  name: 'NPX Agent',
  version: '1.0.0',
  // Empty PATH forces the system `npx` to be unresolvable → download flow.
  distribution: { npx: { package: '@fake/agent', env: { PATH: '' } } },
};

/** Synthetic Node runtime tree (`node-vTEST/bin/{node,npx}`) as a `.tar.gz`. */
function fakeNodeTarball(dir: string): { bytes: Buffer; sha: string } {
  const treeRoot = join(dir, 'tree');
  const binDir = join(treeRoot, 'node-vTEST', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const tarPath = join(dir, 'node.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', treeRoot, 'node-vTEST']);
  const bytes = readFileSync(tarPath);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

function fakeNodeFetch(bytes: Buffer, sha: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('agentclientprotocol')) {
      return new Response(JSON.stringify({ agents: [NPX_AGENT] }), { status: 200 });
    }
    if (u.endsWith('SHASUMS256.txt')) {
      const names = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(
        (n) => `${sha}  node-v24.18.0-${n}.tar.gz`,
      );
      return new Response(`${names.join('\n')}\n`, { status: 200 });
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;
}

function makeManager(opts: {
  contentDir: string;
  localDir: string;
  runtimeRoot: string;
  consentHome: string;
  fetchImpl: typeof fetch;
}): AcpThreadManager {
  const manager = new AcpThreadManager({
    contentDir: opts.contentDir,
    localDir: opts.localDir,
    registry: new AcpRegistry({ localDir: opts.localDir, log, fetchImpl: opts.fetchImpl }),
    permissions: new AcpPermissionStore(opts.localDir, log),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    runtimeInstall: {
      root: opts.runtimeRoot,
      consentHome: opts.consentHome,
      fetchImpl: opts.fetchImpl,
    },
    log,
  });
  managers.push(manager);
  return manager;
}

/** Subscribe and collect every thread event into `sink`. */
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

function findConsentRequest(
  events: ThreadEvent[],
): Extract<ThreadEvent, { kind: 'runtime_consent_request' }> | undefined {
  return events.find(
    (e): e is Extract<ThreadEvent, { kind: 'runtime_consent_request' }> =>
      e.kind === 'runtime_consent_request',
  );
}

describe('managed-runtime consent + download flow', () => {
  test('grant → download → install + persist consent', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const consentHome = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      consentHome,
      fetchImpl: fakeNodeFetch(bytes, sha),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 5_000, 'consent request');
    const req = findConsentRequest(events);
    expect(req?.runtime).toBe('node');
    expect(req?.provides).toBe('npx');
    expect(req?.agentName).toBe('NPX Agent');

    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, {
      kind: 'granted',
      remember: true,
    });

    // The runtime downloads, verifies, and installs into the seam's root.
    await waitFor(
      () => events.some((e) => e.kind === 'runtime_consent_resolved'),
      3_000,
      'consent resolved',
    );
    const installed = await pollInstalled(runtimeRoot);
    expect(installed).not.toBeNull();
    expect(installed?.kind).toBe('node');

    // "Remember" persisted the decision.
    expect((await readRuntimeConsent(consentHome)).node).toBe('granted');
  });

  test('decline → actionable error, no download', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const consentHome = tmp();
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      consentHome,
      // No tarball needed — the decline path never downloads.
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64)),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 5_000, 'consent request');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'declined' });

    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      3_000,
      'error status',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('npx');
    expect(await findManagedRuntime('node', runtimeRoot)).toBeNull();
    expect((await readRuntimeConsent(consentHome)).node).toBeUndefined();
  });

  test('a persisted grant skips the prompt entirely', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const consentHome = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    // Pre-record consent so the manager should download without asking.
    writeFileSync(
      join(consentHome, 'acp-runtime-consent.json'),
      JSON.stringify({ version: 1, node: 'granted' }),
    );
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      consentHome,
      fetchImpl: fakeNodeFetch(bytes, sha),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    const installed = await pollInstalled(runtimeRoot);
    expect(installed).not.toBeNull();
    // No consent prompt was ever emitted.
    expect(findConsentRequest(events)).toBeUndefined();
  });
});

/** Poll for the installed runtime (the download resolves asynchronously). */
async function pollInstalled(
  runtimeRoot: string,
): Promise<Awaited<ReturnType<typeof findManagedRuntime>>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const found = await findManagedRuntime('node', runtimeRoot);
    if (found !== null) return found;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}
