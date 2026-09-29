import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type {
  ThreadEvent,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { THREAD_REOPEN_OP_TIMEOUT_MS } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';

const BLOCKING_CONSENT_BUDGET_MS = Math.floor(THREAD_REOPEN_OP_TIMEOUT_MS / 2);
const OPEN_PATH_CONSENT_BUDGET_MS = 5 * 60 * 1000;

import { ZipFile } from 'yazl';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { withLocalAcquisitionRegistry } from './acquisition-contract.test-helper.ts';
import { MINIMUM_NPX_NODE_MAJOR } from './launch.ts';
import { describeRuntime, ensureManagedRuntime, findManagedRuntime } from './managed-runtime.ts';
import {
  installNodeFixture,
  npmCli,
  registryPackage,
  writeExecutable,
} from './package-acquisition.test-helper.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import { AcpThreadManager } from './thread-manager.ts';

const log = getLogger('managed-runtime-flow-test');
const MANAGED_NODE_VERSION = describeRuntime('node').version;

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
  distribution: { npx: { package: '@fake/agent', env: { PATH: '' } } },
};

function fakeNodeTarball(
  dir: string,
  npxBody = '#!/bin/sh\nexit 0\n',
  nodeVersion = MANAGED_NODE_VERSION,
): { bytes: Buffer; sha: string } {
  const treeRoot = join(dir, 'tree');
  const binDir = join(treeRoot, 'node-vTEST', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\necho ${nodeVersion}\n`, { mode: 0o755 });
  writeFileSync(join(binDir, 'npx'), npxBody, { mode: 0o755 });
  const tarPath = join(dir, 'node.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', treeRoot, 'node-vTEST']);
  const bytes = readFileSync(tarPath);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

function fakeNodeFetch(bytes: Buffer, sha: string, agent: unknown = NPX_AGENT): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('agentclientprotocol')) {
      return new Response(JSON.stringify({ agents: [agent] }), { status: 200 });
    }
    if (u.endsWith('SHASUMS256.txt')) {
      const names = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(
        (n) => `${sha}  node-${MANAGED_NODE_VERSION}-${n}.tar.gz`,
      );
      names.push(
        ...['win-arm64', 'win-x64'].map((n) => `${sha}  node-${MANAGED_NODE_VERSION}-${n}.zip`),
      );
      return new Response(`${names.join('\n')}\n`, { status: 200 });
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;
}

function writeNodeVersion(binDir: string, version: string): void {
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
}

function makeManager(opts: {
  contentDir: string;
  localDir: string;
  runtimeRoot: string;
  fetchImpl: typeof fetch;
  resolveLoginShellPath?: () => Promise<string | null>;
}): AcpThreadManager {
  const manager = new AcpThreadManager({
    contentDir: opts.contentDir,
    localDir: opts.localDir,
    globalDir: null,
    registry: new AcpRegistry({ localDir: opts.localDir, log, fetchImpl: opts.fetchImpl }),
    permissions: new AcpPermissionStore(opts.localDir, log),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    runtimeInstall: {
      root: opts.runtimeRoot,
      fetchImpl: opts.fetchImpl,
    },
    resolveLoginShellPath: opts.resolveLoginShellPath ?? (async () => null),
    log,
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

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
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

describe('package admission after runtime preparation', () => {
  test.each(['system', 'login-shell', 'managed'] as const)(
    '%s runtime performs real npm admission in its isolated cwd',
    async (source) => {
      await withLocalAcquisitionRegistry(async (home) => {
        const realNpx = npmCli('npx');
        const realNpm = npmCli('npm');
        expect(existsSync(realNpm)).toBe(true);
        const admissionLog = join(home, 'admission.jsonl');
        const selectedBin = join(home, 'selected', 'node-vTEST', 'bin');
        mkdirSync(selectedBin, { recursive: true });
        installNodeFixture(selectedBin);
        writeExecutable(
          join(selectedBin, 'npx'),
          `const r=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(realNpx)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(r.status ?? 1);`,
        );
        const npmScript = writeExecutable(
          join(selectedBin, 'npm'),
          `require('node:fs').appendFileSync(${JSON.stringify(admissionLog)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),before:process.env.npm_config_before,executable:process.argv[1]})+'\\n');const r=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(realNpm)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(r.status ?? 1);`,
        );
        const empty = join(home, 'empty');
        mkdirSync(empty);
        if (source === 'login-shell') {
          writeExecutable(join(empty, 'node'), "process.stdout.write('v1.0.0\\n');");
          writeExecutable(join(empty, 'npx'), 'process.exit(0);');
        }
        let bytes: Buffer;
        if (process.platform === 'win32') {
          const zip = new ZipFile();
          for (const entry of readdirSync(selectedBin)) {
            const path = join(selectedBin, entry);
            zip.addFile(path, relative(join(home, 'selected'), path).replaceAll('\\', '/'));
          }
          zip.end();
          const chunks: Buffer[] = [];
          for await (const chunk of zip.outputStream) chunks.push(chunk);
          bytes = Buffer.concat(chunks);
        } else {
          const tarPath = join(home, 'runtime.tar.gz');
          execFileSync('tar', ['-czf', tarPath, '-C', join(home, 'selected'), 'node-vTEST']);
          bytes = readFileSync(tarPath);
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        const agent = {
          ...registryPackage(
            'is-number@7.0.0',
            'npx',
            source === 'login-shell'
              ? undefined
              : { PATH: source === 'system' ? selectedBin : empty },
          ),
          id: 'npxagent',
        };
        process.env.npm_config_before = '1970-01-01';
        if (source === 'login-shell') process.env.PATH = empty;
        const manager = makeManager({
          contentDir: home,
          localDir: tmp(),
          runtimeRoot: tmp(),
          fetchImpl: fakeNodeFetch(bytes, sha, agent),
          resolveLoginShellPath: async () => (source === 'login-shell' ? selectedBin : null),
        });
        const events: ThreadEvent[] = [];
        try {
          const info = await manager.createThread({
            agent: { source: 'registry', id: 'npxagent' },
          });
          await collect(manager, info.threadId, events);
          if (source === 'managed') {
            await expect.poll(() => findConsentRequest(events), { timeout: 10_000 }).toBeDefined();
            expect(existsSync(admissionLog)).toBe(false);
            const consent = findConsentRequest(events);
            if (!consent) throw new Error('missing runtime consent');
            manager.respondRuntimeConsent(info.threadId, consent.requestId, { kind: 'granted' });
          }
          await expect
            .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 25_000 })
            .toBe('error');
          if (source === 'managed') {
            const consentAt = events.findIndex((event) => event.kind === 'runtime_consent_request');
            expect(consentAt).toBeGreaterThanOrEqual(0);
            const afterConsent = events
              .slice(consentAt)
              .flatMap((event) => (event.kind === 'status' ? [event.status] : []));
            expect(
              afterConsent,
              'a managed runtime that really downloads must report installing',
            ).toContain('installing');
          }
          expect(
            existsSync(admissionLog),
            'selected npm must perform admission before ACP starts',
          ).toBe(true);
          const probes = readFileSync(admissionLog, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(probes[0]).toMatchObject({
            args: expect.arrayContaining(['pack', '--dry-run', '--ignore-scripts', '--json']),
            cwd: join(home, '.ok', 'acp-npx-cwd'),
            before: '1970-01-01',
          });
          if (source !== 'managed') expect(probes[0].executable).toBe(npmScript);
          else expect(probes[0].executable).not.toBe(npmScript);
          await expect
            .poll(
              () => events.some((event) => event.kind === 'status' && event.status === 'error'),
              { timeout: 5000 },
            )
            .toBe(true);
          const failure = events
            .filter((event) => event.kind === 'status' && event.status === 'error')
            .at(-1);
          expect(failure).toMatchObject({
            failure: {
              reason: 'connect',
              machineDetail: expect.stringMatching(/ETARGET|ENOVERSIONS/),
            },
          });
        } finally {
          await manager.destroy();
        }
      });
    },
    90_000,
  );

  test.each(['declined', 'closed'] as const)(
    'compatibility control: %s runtime consent does not acquire a package',
    async (decision) => {
      await withLocalAcquisitionRegistry(async (home) => {
        const empty = join(home, 'empty');
        mkdirSync(empty);
        const agent = {
          ...registryPackage('is-number@7.0.0', 'npx', { PATH: empty }),
          id: 'npxagent',
        };
        const manager = makeManager({
          contentDir: home,
          localDir: tmp(),
          runtimeRoot: tmp(),
          fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'f'.repeat(64), agent),
        });
        const events: ThreadEvent[] = [];
        try {
          const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
          await collect(manager, info.threadId, events);
          await expect.poll(() => findConsentRequest(events), { timeout: 10_000 }).toBeDefined();
          const request = findConsentRequest(events);
          if (!request) throw new Error('missing runtime consent');
          if (decision === 'closed') await manager.closeThread(info.threadId);
          else {
            manager.respondRuntimeConsent(info.threadId, request.requestId, { kind: 'declined' });
            await expect
              .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 5000 })
              .toBe('error');
          }
          expect(existsSync(join(home, 'npm-cache', '_cacache'))).toBe(false);
          const consentAt = events.findIndex((event) => event.kind === 'runtime_consent_request');
          expect(consentAt).toBeGreaterThanOrEqual(0);
          expect(
            events
              .slice(consentAt)
              .some((event) => event.kind === 'status' && event.status === 'spawning'),
          ).toBe(false);
        } finally {
          await manager.destroy();
        }
      });
    },
    30_000,
  );
});

describe('managed-runtime consent + download flow', () => {
  test('normal launch cleans stale staging after a runtime is installed', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const fetchImpl = fakeNodeFetch(bytes, sha);
    await ensureManagedRuntime('node', log, { root: runtimeRoot, fetchImpl });

    const staleDir = join(runtimeRoot, 'node', `.install-${MANAGED_NODE_VERSION}-orphaned`);
    mkdirSync(staleDir, { recursive: true });
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(staleDir, staleTime, staleTime);

    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl,
    });
    await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });

    await waitFor(() => !existsSync(staleDir), 3_000, 'stale runtime staging cleanup');
  });

  test('grant → download → install', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
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
    expect(req?.reason).toBe('missing');

    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'granted' });

    await waitFor(
      () => events.some((e) => e.kind === 'runtime_consent_resolved'),
      3_000,
      'consent resolved',
    );
    const installed = await pollInstalled(runtimeRoot);
    expect(installed).not.toBeNull();
    expect(installed?.kind).toBe('node');
  });

  test('decline → actionable error, no download', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
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
  });

  test('a manifest-supplied PATH is never widened by the login shell', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    let probes = 0;
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64)),
      resolveLoginShellPath: async () => {
        probes += 1;
        return '/should/never/be/consulted';
      },
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 5_000, 'consent request');
    expect(probes).toBe(0);
  });

  test('an interpreter that resolves but crashes routes to the managed runtime', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const brokenBin = tmp();
    writeFileSync(
      join(brokenBin, 'npx'),
      '#!/bin/sh\necho "dyld[1]: Library not loaded: libicui18n.74.dylib" >&2\nkill -ABRT $$\n',
      { mode: 0o755 },
    );
    const { bytes, sha } = fakeNodeTarball(stage);
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(bytes, sha, {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: brokenBin } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'consent request');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    expect(req.reason).toBe('broken');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'granted' });

    const installed = await pollInstalled(runtimeRoot);
    expect(installed).not.toBeNull();
  }, 20_000);

  test('a runnable Node 16 routes to the managed runtime despite a healthy npx', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const oldBin = tmp();
    writeFileSync(join(oldBin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeNodeVersion(oldBin, 'v16.14.2');
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: oldBin } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);
    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'consent request');

    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    expect(req.reason).toBe('broken');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'declined' });
    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      10_000,
      'incompatible runtime error',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('Node.js v16.14.2 is incompatible');
    expect(errEvent?.detail).toContain(`Node.js ${MINIMUM_NPX_NODE_MAJOR} or newer is required`);
  }, 20_000);

  test('letting the incompatible-Node offer expire drops the offer it just withdrew', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const oldBin = tmp();
    writeFileSync(join(oldBin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeNodeVersion(oldBin, 'v16.14.2');
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: oldBin } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await collect(manager, info.threadId, events);
      await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'consent request');
      await vi.advanceTimersByTimeAsync(OPEN_PATH_CONSENT_BUDGET_MS + 1_000);
      await waitFor(
        () => events.some((e) => e.kind === 'runtime_consent_resolved'),
        10_000,
        'the offer to expire on the budget the start is waiting on',
      );
    } finally {
      vi.useRealTimers();
    }
    const resolved = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'runtime_consent_resolved' }> =>
        e.kind === 'runtime_consent_resolved',
    );
    expect(resolved?.decision).toBe('timeout');
    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      20_000,
      'incompatible runtime error',
    );
    const expiredEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(expiredEvent?.detail).toContain('Node.js v16.14.2 is incompatible');
    expect(expiredEvent?.detail).toContain('expired before it was answered');
    expect(
      expiredEvent?.detail,
      'offering the download again would contradict the sentence reporting that the offer lapsed',
    ).not.toContain('let Open Knowledge download a private compatible copy');
  }, 30_000);

  test.skipIf(process.platform === 'win32')(
    'a compatible login-shell Node replaces a stale GUI-inherited Node',
    async () => {
      const contentDir = tmp();
      const localDir = tmp();
      const runtimeRoot = tmp();
      const oldBin = tmp();
      const newBin = tmp();
      const calls = join(tmp(), 'calls.log');
      writeFileSync(join(oldBin, 'npx'), `#!/bin/sh\necho "old:$*" >> ${calls}\nexit 0\n`, {
        mode: 0o755,
      });
      writeNodeVersion(oldBin, 'v16.14.2');
      writeFileSync(join(newBin, 'npx'), `#!/bin/sh\necho "new:$*" >> ${calls}\nexit 0\n`, {
        mode: 0o755,
      });
      writeNodeVersion(newBin, 'v24.13.0');

      const priorPath = process.env.PATH;
      process.env.PATH = oldBin;
      try {
        const manager = makeManager({
          contentDir,
          localDir,
          runtimeRoot,
          fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
            ...NPX_AGENT,
            distribution: { npx: { package: '@fake/agent' } },
          }),
          resolveLoginShellPath: async () => newBin,
        });

        const events: ThreadEvent[] = [];
        const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
        await collect(manager, info.threadId, events);
        await waitFor(
          () => manager.getInfo(info.threadId)?.status === 'error',
          10_000,
          'the fake adapter to exit',
        );

        expect(findConsentRequest(events)).toBeUndefined();
        const invocations = readFileSync(calls, 'utf8').trim().split('\n');
        expect(invocations).toContain('old:--version');
        expect(invocations).not.toContain('old:-y @fake/agent');
        expect(invocations).toContain('new:--version');
        expect(invocations).toContain('new:-y @fake/agent');
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      }
    },
    20_000,
  );

  test('declining after a crash reports the broken interpreter, not a missing one', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const brokenBin = tmp();
    writeFileSync(
      join(brokenBin, 'npx'),
      '#!/bin/sh\necho "dyld[1]: Library not loaded: libicui18n.74.dylib" >&2\nkill -ABRT $$\n',
      { mode: 0o755 },
    );
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: brokenBin } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'consent request');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'declined' });

    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      10_000,
      'error status',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('is installed but failed to run');
    expect(errEvent?.detail).toContain('SIGABRT');
    expect(errEvent?.detail).not.toContain("isn't installed");
    expect(await findManagedRuntime('node', runtimeRoot)).toBeNull();
  }, 20_000);

  test('a declined offer comes back on the next launch', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(bytes, sha),
    });

    const first: ThreadEvent[] = [];
    const one = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, one.threadId, first);
    await waitFor(() => findConsentRequest(first) !== undefined, 5_000, 'first consent request');
    const declined = findConsentRequest(first);
    if (declined === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(one.threadId, declined.requestId, { kind: 'declined' });
    await waitFor(
      () => first.some((e) => e.kind === 'status' && e.status === 'error'),
      5_000,
      'first launch failed',
    );

    const second: ThreadEvent[] = [];
    const two = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, two.threadId, second);
    await waitFor(() => findConsentRequest(second) !== undefined, 5_000, 'second consent request');

    const retry = findConsentRequest(second);
    if (retry === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(two.threadId, retry.requestId, { kind: 'granted' });
    expect(await pollInstalled(runtimeRoot)).not.toBeNull();
  }, 20_000);
});

describe('interpreter health probe', () => {
  test('an incompatible managed Node asks the user to update OK instead of blaming the machine', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage, undefined, 'v16.14.2');
    const fetchImpl = fakeNodeFetch(bytes, sha);
    const manager = makeManager({ contentDir, localDir, runtimeRoot, fetchImpl });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'download offer');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'granted' });

    await waitFor(
      () =>
        events.some((e) => e.kind === 'status' && e.status === 'error') ||
        events.filter((e) => e.kind === 'runtime_consent_request').length > 1,
      15_000,
      'managed runtime incompatibility verdict',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('Update Open Knowledge');
    expect(errEvent?.detail).not.toContain('antivirus');
    expect(errEvent?.detail).not.toContain('security policy');
    expect(errEvent?.detail).not.toContain('unsupported CPU');
    expect(events.filter((e) => e.kind === 'runtime_consent_request')).toHaveLength(1);
  }, 30_000);

  test('a damaged managed runtime is replaced, not reported as the dead end', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const fetchImpl = fakeNodeFetch(bytes, sha);

    const installed = await ensureManagedRuntime('node', log, { root: runtimeRoot, fetchImpl });
    const launcher = installed.kind === 'node' ? installed.npxBin : installed.uvxBin;
    writeFileSync(launcher, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });

    const manager = makeManager({ contentDir, localDir, runtimeRoot, fetchImpl });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'repair offer');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    expect(req.reason).toBe('damaged');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'granted' });

    await waitFor(
      async () => {
        const runtime = await findManagedRuntime('node', runtimeRoot);
        if (runtime === null) return false;
        const bin = runtime.kind === 'node' ? runtime.npxBin : runtime.uvxBin;
        return !readFileSync(bin, 'utf8').includes('ABRT');
      },
      15_000,
      'runtime replaced',
    );
  }, 30_000);

  test('a replacement that is also broken reports the machine, not the user', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage, '#!/bin/sh\nkill -ABRT $$\n');
    const fetchImpl = fakeNodeFetch(bytes, sha);
    await ensureManagedRuntime('node', log, { root: runtimeRoot, fetchImpl });

    const manager = makeManager({ contentDir, localDir, runtimeRoot, fetchImpl });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'repair offer');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'granted' });

    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      15_000,
      'error status',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('downloaded a fresh copy');
    expect(errEvent?.detail).toContain('still');
    expect(errEvent?.detail).not.toContain('delete that directory');
    expect(errEvent?.detail).not.toContain('icu4c');
    expect(events.filter((e) => e.kind === 'runtime_consent_request')).toHaveLength(1);
  }, 40_000);

  test('declining the repair says the copy is damaged, not missing', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const fetchImpl = fakeNodeFetch(bytes, sha);
    const installed = await ensureManagedRuntime('node', log, { root: runtimeRoot, fetchImpl });
    const launcher = installed.kind === 'node' ? installed.npxBin : installed.uvxBin;
    writeFileSync(launcher, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });

    const manager = makeManager({ contentDir, localDir, runtimeRoot, fetchImpl });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);

    await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'repair offer');
    const req = findConsentRequest(events);
    if (req === undefined) throw new Error('unreachable');
    manager.respondRuntimeConsent(info.threadId, req.requestId, { kind: 'declined' });

    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      10_000,
      'error status',
    );
    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('damaged');
    expect(errEvent?.detail).not.toContain("isn't installed");
  }, 30_000);

  test('letting the repair offer expire says it lapsed, not that it was declined', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const stage = tmp();
    const { bytes, sha } = fakeNodeTarball(stage);
    const fetchImpl = fakeNodeFetch(bytes, sha);
    const installed = await ensureManagedRuntime('node', log, { root: runtimeRoot, fetchImpl });
    const launcher = installed.kind === 'node' ? installed.npxBin : installed.uvxBin;
    writeFileSync(launcher, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });

    const manager = makeManager({ contentDir, localDir, runtimeRoot, fetchImpl });
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await collect(manager, info.threadId, events);
      await waitFor(() => findConsentRequest(events) !== undefined, 10_000, 'repair offer');
      await vi.advanceTimersByTimeAsync(OPEN_PATH_CONSENT_BUDGET_MS + 1_000);
      await waitFor(
        () => events.some((e) => e.kind === 'runtime_consent_resolved'),
        10_000,
        'the offer to expire on the budget the start is waiting on',
      );
    } finally {
      vi.useRealTimers();
    }
    const resolved = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'runtime_consent_resolved' }> =>
        e.kind === 'runtime_consent_resolved',
    );
    expect(resolved?.decision).toBe('timeout');
    await waitFor(
      () => events.some((e) => e.kind === 'status' && e.status === 'error'),
      20_000,
      'error status',
    );

    const errEvent = events.find(
      (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
        e.kind === 'status' && e.status === 'error',
    );
    expect(errEvent?.detail).toContain('damaged');
    expect(errEvent?.detail).toContain('expired before it was answered');
    expect(errEvent?.detail).not.toContain(
      'Start the agent again to let OK download a fresh copy.',
    );
  }, 30_000);

  test('Retry re-probes an interpreter that broke after it was cached healthy', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const binDir = tmp();
    const npxPath = join(binDir, 'npx');
    writeFileSync(npxPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeNodeVersion(binDir, 'v24.0.0');
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: binDir } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);
    await waitFor(
      () => manager.getInfo(info.threadId)?.status === 'error',
      10_000,
      'the thread to fail',
    );
    expect(findConsentRequest(events)).toBeUndefined();

    writeFileSync(npxPath, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });
    void manager.retryThread(info.threadId).catch(() => {});

    await waitFor(
      () => findConsentRequest(events) !== undefined,
      10_000,
      'the retry to notice the interpreter broke',
    );
  }, 30_000);

  test('Retry gives the runtime offer the budget the caller is waiting on', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const binDir = tmp();
    const npxPath = join(binDir, 'npx');
    writeFileSync(npxPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeNodeVersion(binDir, 'v24.0.0');
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: binDir } } },
      }),
    });

    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await collect(manager, info.threadId, events);
    await waitFor(
      () => manager.getInfo(info.threadId)?.status === 'error',
      10_000,
      'the thread to fail',
    );

    writeFileSync(npxPath, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      void manager.retryThread(info.threadId).catch(() => {});
      await waitFor(
        () => findConsentRequest(events) !== undefined,
        10_000,
        'the retry to offer the managed runtime',
      );

      await vi.advanceTimersByTimeAsync(BLOCKING_CONSENT_BUDGET_MS + 1_000);
      await waitFor(
        () => events.some((e) => e.kind === 'runtime_consent_resolved'),
        10_000,
        'the offer to expire on the budget the client is waiting on',
      );
      const resolved = events.find(
        (e): e is Extract<ThreadEvent, { kind: 'runtime_consent_resolved' }> =>
          e.kind === 'runtime_consent_resolved',
      );
      expect(resolved?.decision).toBe('timeout');

      await waitFor(
        () => events.filter((e) => e.kind === 'status' && e.status === 'error').length >= 2,
        10_000,
        'the retry to surface the expired offer',
      );
      const surfaced = events
        .filter(
          (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
            e.kind === 'status' && e.status === 'error',
        )
        .at(-1);
      expect(surfaced?.detail).toContain('expired before it was answered');
      expect(
        surfaced?.detail,
        'the expiry sentence is shared with the incompatible-Node route, so it cannot pin this one',
      ).toContain('is installed but failed to run');
      expect(surfaced?.detail).toContain('Reinstall or repair Node.js');
      expect(surfaced?.detail).not.toContain("isn't installed");
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  test('a healthy interpreter is probed once, not once per thread', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const runtimeRoot = tmp();
    const binDir = tmp();
    const calls = join(binDir, 'calls.log');
    writeFileSync(join(binDir, 'npx'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 0\n`, {
      mode: 0o755,
    });
    writeNodeVersion(binDir, 'v24.0.0');
    const manager = makeManager({
      contentDir,
      localDir,
      runtimeRoot,
      fetchImpl: fakeNodeFetch(Buffer.from('unused'), 'x'.repeat(64), {
        ...NPX_AGENT,
        distribution: { npx: { package: '@fake/agent', env: { PATH: binDir } } },
      }),
    });

    const versionProbes = (): number =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .split('\n')
            .filter((l) => l.trim() === '--version').length
        : 0;

    const first = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await waitFor(
      () => manager.getInfo(first.threadId)?.status === 'error',
      10_000,
      'the first thread to finish its launch attempt',
    );
    expect(versionProbes()).toBe(1);
    const second = await manager.createThread({ agent: { source: 'registry', id: 'npxagent' } });
    await waitFor(
      () => manager.getInfo(second.threadId)?.status === 'error',
      10_000,
      'the second thread to launch',
    );
    expect(versionProbes()).toBe(1);
  }, 30_000);
});

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
