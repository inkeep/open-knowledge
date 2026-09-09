import { expect } from 'vitest';

const INSTALLED = Symbol.for('ok.test.noNetConnect.installed');

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
        'Unit tests must be hermetic — only loopback hosts are reachable. Fake the ' +
        'dependency at its seam, or point it at a CLOSED loopback port when you need a ' +
        'real transport error. See test-support/no-net-connect.ts.',
    );
  }
}

export function installNoNetConnect(): void {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') return;
  if ((realFetch as { [INSTALLED]?: boolean })[INSTALLED] === true) return;

  const guardedFetch = async function guardedFetch(
    input: Parameters<typeof realFetch>[0],
    init?: Parameters<typeof realFetch>[1],
  ): ReturnType<typeof realFetch> {
    const target = resolveTarget(input);
    if (
      target !== null &&
      !SOCKETLESS_PROTOCOLS.has(target.protocol) &&
      !isLoopbackHostname(target.hostname)
    ) {
      const testName = expect.getState().currentTestName ?? '<outside a test>';
      const blocked = new NetConnectBlockedError(target.hostname, testName);
      console.error(`[no-net-connect] ${blocked.message}`);
      throw blocked;
    }
    return realFetch(input, init);
  } as typeof realFetch;

  (guardedFetch as { [INSTALLED]?: boolean })[INSTALLED] = true;
  globalThis.fetch = guardedFetch;
}

installNoNetConnect();
