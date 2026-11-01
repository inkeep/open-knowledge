import ipaddr from 'ipaddr.js';

type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

export type HostClassification =
  | { kind: 'hostname' }
  | { kind: 'ip-literal'; allowed: boolean; canonical: string; family: 4 | 6 };

function parseIpLiteral(host: string): ParsedIp | null {
  const bare =
    host.length >= 2 && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  try {
    if (ipaddr.IPv4.isValid(bare)) return ipaddr.IPv4.parse(bare);
    if (ipaddr.IPv6.isValid(bare)) return ipaddr.IPv6.parse(bare);
  } catch {
    return null;
  }
  return null;
}

export function isPublicUnicastIp(ip: string): boolean {
  const parsed = parseIpLiteral(ip);
  return parsed !== null && parsed.range() === 'unicast';
}

export function classifyHost(host: string): HostClassification {
  const parsed = parseIpLiteral(host);
  if (parsed === null) return { kind: 'hostname' };
  return {
    kind: 'ip-literal',
    allowed: parsed.range() === 'unicast',
    canonical: parsed.toString(),
    family: parsed.kind() === 'ipv6' ? 6 : 4,
  };
}
