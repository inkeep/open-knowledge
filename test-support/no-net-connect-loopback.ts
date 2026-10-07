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
