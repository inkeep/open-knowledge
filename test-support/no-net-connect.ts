import { AsyncLocalStorage } from 'node:async_hooks';
import { type Dispatcher, getGlobalDispatcher } from 'undici';
import { aroundAll, aroundEach, type RunnerTask } from 'vitest';

const INSTALLED = Symbol.for('ok.test.noNetConnect.installed');

interface BlockScope {
  kind: 'test' | 'file';
  name: string;
  expected: string[];
  unexpected: NetConnectBlockedError[];
  drained: boolean;
}

const activeScope = new AsyncLocalStorage<BlockScope>();
function newScope(kind: BlockScope['kind'], name: string): BlockScope {
  return { kind, name, expected: [], unexpected: [], drained: false };
}

const collectionScope = newScope('file', '<outside a test>');

function scopeFor(task: RunnerTask): BlockScope {
  const names = [task.name];
  for (let suite = task.suite; suite; suite = suite.suite) names.unshift(suite.name);
  return newScope('test', names.join(' > '));
}

function assertNoUnexpectedBlocks(...scopes: BlockScope[]): void {
  const errors: Error[] = [];
  for (const scope of scopes) {
    scope.drained = true;
    errors.push(...scope.unexpected.splice(0));
    const expected = scope.expected.splice(0);
    if (expected.length) {
      errors.push(
        new Error(`Expected network blocks did not occur in ${scope.name}: ${expected.join(', ')}`),
      );
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      errors.map((error) => `${error.name}: ${error.message}`).join('\n'),
    );
  }
}

const UNVERIFIABLE_ORIGIN = '<unverifiable-origin>';

function reportAfterScope(what: string, scope: BlockScope): void {
  process.stderr.write(
    `[no-net-connect] ${what} for "${scope.name}" after that scope completed. ` +
      'Reported, not enforced: the ledger for that scope was already drained, so nothing ' +
      'fails. Await the work that reaches the network, or move it inside the test.\n',
  );
}

export function expectBlockedNetworkRequest(hostname: string): void {
  const scope = activeScope.getStore();
  if (scope?.kind !== 'test')
    throw new Error('Expected network blocks must be declared inside a test, not suite hooks');
  if (scope.drained) {
    reportAfterScope(`Declared a block for "${hostname}"`, scope);
    return;
  }
  scope.expected.push(hostname.toLowerCase());
}

function blockHost(hostname: string, scope: BlockScope): never {
  const blocked = new NetConnectBlockedError(hostname, scope.name);
  if (scope.drained) reportAfterScope(`Blocked a request to "${hostname}"`, scope);
  else {
    const expectedIndex = scope.expected.indexOf(hostname.toLowerCase());
    if (expectedIndex >= 0) scope.expected.splice(expectedIndex, 1);
    else scope.unexpected.push(blocked);
  }
  throw blocked;
}

function checkTarget(target: URL, scope: BlockScope): void {
  if (SOCKETLESS_PROTOCOLS.has(target.protocol) || isLoopbackHostname(target.hostname)) return;
  blockHost(target.hostname, scope);
}

function checkDispatchOrigin(origin: Dispatcher.DispatchOptions['origin'], scope: BlockScope): void {
  if (origin instanceof URL) {
    checkTarget(origin, scope);
    return;
  }
  if (typeof origin === 'string') {
    try {
      checkTarget(new URL(origin), scope);
      return;
    } catch (error) {
      if (error instanceof NetConnectBlockedError) throw error;
    }
  }
  blockHost(UNVERIFIABLE_ORIGIN, scope);
}

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const LOOPBACK_V4_RE = new RegExp(`^127\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = bare.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith('.localhost')) return true;
  return LOOPBACK_V4_RE.test(lower);
}

function resolveTarget(input: unknown): URL | null {
  const base = typeof globalThis.location?.href === 'string' ? globalThis.location.href : undefined;
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof (input as { url?: unknown })?.url === 'string'
          ? (input as { url: string }).url
          : null;
  if (raw === null) return null;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

const SOCKETLESS_PROTOCOLS = new Set(['data:', 'blob:', 'file:']);

export class NetConnectBlockedError extends Error {
  override readonly name = 'NetConnectBlockedError' as const;
  constructor(hostname: string, testName: string) {
    super(
      `Blocked an outbound network request to "${hostname}" from test: ${testName}. ` +
        'Unit tests must be hermetic: only loopback hosts are reachable. Fake the ' +
        'dependency at its seam, or point it at a CLOSED loopback port for a real transport error. ' +
        'Deliberate guard tests must call expectBlockedNetworkRequest(hostname) before the request. ' +
        'Unexpected blocks fail the owning test even when the request error is caught.',
    );
  }
}

export type FetchInit = RequestInit & { dispatcher?: Dispatcher };

export type DispatcherRequestInit = FetchInit & { dispatcher: Dispatcher };

export function installNoNetConnect(): void {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') return;
  if ((realFetch as { [INSTALLED]?: boolean })[INSTALLED] === true) return;

  const guardedFetch = async (input: Parameters<typeof realFetch>[0], init?: FetchInit) => {
    const scope = activeScope.getStore() ?? collectionScope;
    const target = resolveTarget(input);
    if (target !== null) checkTarget(target, scope);
    const upstream = init?.dispatcher ?? getGlobalDispatcher();
    const dispatcher = upstream.compose((dispatch) => (options, handler) => {
      checkDispatchOrigin(options.origin, scope);
      return dispatch(options, handler);
    });
    const guardedInit: FetchInit = { ...init, dispatcher };
    try {
      return await realFetch(input, guardedInit);
    } catch (error) {
      if (error instanceof Error && error.cause instanceof NetConnectBlockedError) {
        throw error.cause;
      }
      throw error;
    }
  };

  Object.defineProperty(guardedFetch, INSTALLED, { value: true });
  globalThis.fetch = guardedFetch;
}

installNoNetConnect();

aroundEach(async (runTest, { task }) => {
  const scope = scopeFor(task);
  await activeScope.run(scope, async () => {
    try {
      await runTest();
    } finally {
      assertNoUnexpectedBlocks(scope);
    }
  });
});

aroundAll(async (runSuite) => {
  const scope = newScope('file', '<suite hooks>');
  await activeScope.run(scope, async () => {
    try {
      await runSuite();
    } finally {
      assertNoUnexpectedBlocks(scope, collectionScope);
    }
  });
});
