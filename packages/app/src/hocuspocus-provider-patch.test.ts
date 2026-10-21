import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { describe, expect, onTestFinished, test, vi } from 'vitest';

const PACKAGE_NAME = '@hocuspocus/provider';
const PATCH_FILE = '@hocuspocus%2Fprovider@4.0.0-rc.1.patch';
const PATCHED_VERSION = '4.0.0-rc.1';

const PATCH_MARKER = 'OK patch: forced-close emits close.';

const UPSTREAM_DIRECT_ONCLOSE = /this\.onClose\(\s*\{/;

const FORCED_BRANCH_OPENER = 'this.closeTries > 2';

const FORCED_BRANCH_CLOSER = '} else';

const FORCED_BRANCH_WINDOW = 1200;

const PATCHED_ARTIFACTS = [
  { label: 'ESM bundle', relativePath: ['dist', 'hocuspocus-provider.esm.js'] },
  { label: 'CJS bundle', relativePath: ['dist', 'hocuspocus-provider.cjs'] },
  { label: 'TypeScript source', relativePath: ['src', 'HocuspocusProviderWebsocket.ts'] },
] as const;

function repoRoot(): string {
  return join(import.meta.dirname, '..', '..', '..');
}

function installedPackageDir(): string {
  const resolved = import.meta.resolve(PACKAGE_NAME);
  let dir = dirname(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved);

  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === PACKAGE_NAME) return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not resolve the installed directory for ${PACKAGE_NAME}`);
}

function forcedCloseBranch(source: string, label: string): string {
  const start = source.indexOf(FORCED_BRANCH_OPENER);
  if (start === -1) {
    throw new Error(
      `Could not find the forced-close branch (\`${FORCED_BRANCH_OPENER}\`) in ${label}. ` +
        `Upstream has probably restructured \`checkConnection\` — re-port ` +
        `patches/${PATCH_FILE} and update this test's matchers.`,
    );
  }
  const fallbackEnd = start + FORCED_BRANCH_WINDOW;
  const closer = source.indexOf(FORCED_BRANCH_CLOSER, start);
  const end = closer === -1 || closer > fallbackEnd ? fallbackEnd : closer;
  return source.slice(start, end);
}

describe('@hocuspocus/provider forced-close patch verification', () => {
  test('the direct-onClose matcher matches the upstream shape it guards against', () => {
    const upstreamSource = 'this.onClose({\n\t\t\t\tevent: {\n\t\t\t\t\tcode: 4408,';
    const upstreamDist = 'this.onClose({ event: {\n\t\t\t\tcode: 4408,';

    expect(upstreamSource).toMatch(UPSTREAM_DIRECT_ONCLOSE);
    expect(upstreamDist).toMatch(UPSTREAM_DIRECT_ONCLOSE);

    expect('this.emit("close", { event: {').not.toMatch(UPSTREAM_DIRECT_ONCLOSE);
  });

  test('the patch is registered in pnpm-workspace.yaml patchedDependencies', () => {
    const workspaceYaml = readFileSync(join(repoRoot(), 'pnpm-workspace.yaml'), 'utf8');
    const block = workspaceYaml.match(/^patchedDependencies:\n((?:[ \t]+\S.*\n?)+)/m);
    expect(block).not.toBeNull();

    const patched: Record<string, string> = {};
    for (const line of (block?.[1] ?? '').split('\n')) {
      const entry = line.match(/^\s+(['"]?)(.+?)\1:\s+(\S+)\s*$/);
      if (entry) patched[entry[2]] = entry[3];
    }

    expect(patched[`${PACKAGE_NAME}@${PATCHED_VERSION}`]).toBe(`patches/${PATCH_FILE}`);
  });

  test('the patch file on disk touches every shipped artifact', () => {
    const patchContent = readFileSync(join(repoRoot(), 'patches', PATCH_FILE), 'utf8');

    for (const artifact of PATCHED_ARTIFACTS) {
      const path = artifact.relativePath.join('/');
      expect(patchContent, `${path} missing from the patch file`).toContain(path);
    }
    expect(patchContent).toContain(PATCH_MARKER);
    expect(patchContent).toContain('this.emit("close"');
  });

  for (const artifact of PATCHED_ARTIFACTS) {
    describe(artifact.label, () => {
      test('the forced-close branch emits close instead of calling onClose', () => {
        const path = join(installedPackageDir(), ...artifact.relativePath);
        const branch = forcedCloseBranch(readFileSync(path, 'utf8'), path);

        expect(branch).toContain(PATCH_MARKER);
        expect(branch).toContain('this.emit("close"');
        expect(branch).not.toMatch(UPSTREAM_DIRECT_ONCLOSE);

        expect(branch).toContain('4408');
        expect(branch).toContain('"forced"');
      });
    });
  }

  test('the synced setter emits only on the false-to-true edge', () => {
    const provider = new HocuspocusProvider({
      url: 'ws://localhost:1/collab',
      name: `edge-gate-${Date.now()}`,
      autoConnect: false,
    });
    try {
      const seen: unknown[] = [];
      provider.on('synced', (payload: unknown) => seen.push(payload));
      provider.synced = true;
      provider.synced = true;
      provider.synced = false;
      expect(seen).toEqual([{ state: true }]);
    } finally {
      try {
        provider.destroy();
      } catch {}
    }
  });
});

class OwnedWebSocket {
  static instances: OwnedWebSocket[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly url: string;
  readyState = 0;
  binaryType = 'arraybuffer';
  identifier = '';
  closed = false;

  constructor(url: string) {
    this.url = url;
    OwnedWebSocket.instances.push(this);
  }

  addEventListener(name: string, handler: (payload: unknown) => void): void {
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name: string, handler: (payload: unknown) => void): void {
    this.listeners.get(name)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  emit(name: string, payload: unknown = {}): void {
    for (const handler of this.listeners.get(name) ?? []) handler(payload);
  }
}

describe('@hocuspocus/provider destroy-reconnect patch verification', () => {
  test('destroy prevents a queued reconnect from creating another socket', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    OwnedWebSocket.instances = [];
    const websocket = new HocuspocusProviderWebsocket({
      url: 'ws://localhost:1/collab',
      autoConnect: false,
      WebSocketPolyfill: OwnedWebSocket,
      delay: 1_000,
      initialDelay: 0,
      minDelay: 1_000,
      maxDelay: 1_000,
      jitter: false,
      maxAttempts: 1,
    });
    onTestFinished(() => {
      websocket.destroy();
    });

    void websocket.connect();
    await Promise.resolve();
    const first = OwnedWebSocket.instances[0];
    if (!first) throw new Error('expected first socket');
    first.emit('open', {});
    const timersBeforeClose = vi.getTimerCount();
    first.emit('close', { code: 1006, reason: 'fixture-drop' });
    expect(
      vi.getTimerCount() - timersBeforeClose,
      `closing an open socket should queue exactly one reconnect timer; re-derive this fixture against patches/${PATCH_FILE}`,
    ).toBe(1);

    websocket.destroy();
    await vi.runOnlyPendingTimersAsync();
    expect(
      OwnedWebSocket.instances,
      `destroy() left the queued reconnect armed; check the reconnect-timer hunks in patches/${PATCH_FILE}`,
    ).toHaveLength(1);
    expect(websocket.shouldConnect).toBe(false);
  });
});
