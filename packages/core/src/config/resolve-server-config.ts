import type { Config } from './schema.ts';
import { DEFAULT_SERVER_BIND, IDLE_SHUTDOWN_DURATION_RE } from './schema.ts';

export const DEFAULT_LOOPBACK_IDLE_SHUTDOWN = '30m';

export interface ServerRuntimeConfig {
  port: number | undefined;
  bind: readonly string[];
  externalUrl: string | undefined;
  allowExternal: boolean;
  openBrowser: boolean;
  idleShutdown: string;
  loopbackOnly: boolean;
}

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const LOOPBACK_V4_RE = new RegExp(`^127\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

export function isLoopbackBindAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  return LOOPBACK_V4_RE.test(normalized);
}

export function isLoopbackOnlyBind(bind: readonly string[]): boolean {
  return bind.every(isLoopbackBindAddress);
}

export function requiresExternalConsent(
  resolved: Pick<ServerRuntimeConfig, 'loopbackOnly'>,
): boolean {
  return !resolved.loopbackOnly;
}

export function idleShutdownToMs(value: string): number | null {
  if (value === 'off') return null;
  if (!IDLE_SHUTDOWN_DURATION_RE.test(value)) {
    throw new Error(`invalid idleShutdown duration: ${JSON.stringify(value)}`);
  }
  const amount = Number(value.slice(0, -1));
  switch (value.at(-1)) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    default:
      return amount * 3_600_000;
  }
}

export function resolveServerRuntimeConfig(config: Config | undefined): ServerRuntimeConfig {
  const server = config?.server;

  const bind =
    server?.bind === undefined || server.bind.length === 0 ? DEFAULT_SERVER_BIND : server.bind;
  const loopbackOnly = isLoopbackOnlyBind(bind);

  const port = server?.port;
  const externalUrl = server?.externalUrl;

  const exposed = (server?.allowExternal ?? false) && externalUrl !== undefined;

  return {
    port,
    bind,
    externalUrl,
    allowExternal: server?.allowExternal ?? false,
    openBrowser: server?.openBrowser ?? loopbackOnly,
    idleShutdown:
      server?.idleShutdown ?? (loopbackOnly && !exposed ? DEFAULT_LOOPBACK_IDLE_SHUTDOWN : 'off'),
    loopbackOnly,
  };
}
