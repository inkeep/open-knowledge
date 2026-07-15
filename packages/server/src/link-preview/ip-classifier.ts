/**
 * SSRF IP classifier — the pure allow/deny decision for whether an outbound
 * link-preview fetch may target a given host or resolved address.
 *
 * Allowlist semantics: a target is permitted ONLY when it is a public unicast
 * address. Every other range ipaddr.js recognizes — loopback, RFC1918 private,
 * link-local (which includes the 169.254.169.254 cloud-metadata endpoint),
 * unique-local, carrier-grade NAT, multicast, unspecified, IPv4-mapped-IPv6,
 * and any reserved range added upstream later — is denied by default. Denying
 * IPv4-mapped-IPv6 (::ffff:a.b.c.d) wholesale is deliberate: it is a known SSRF
 * bypass spelling, and the allowlist rejects it without special-casing because
 * its range is never 'unicast'. Same unicast-only posture as the editor's
 * clipboard URL-portability classifier.
 *
 * IP-literal hosts are canonicalized before classification so a blocked address
 * spelled as decimal (2130706433), octal (0177.0.0.1), hex (0x7f000001),
 * short-form (127.1), or IPv4-mapped-IPv6 (::ffff:127.0.0.1) cannot slip past a
 * naive equality check; ipaddr.js does the numeric canonicalization in parse().
 *
 * Pure and total: no I/O, and any malformed input yields a deny/hostname
 * outcome instead of throwing. A host this module reports as 'hostname' is not
 * trusted — the caller must still resolve it and run every resolved address
 * back through isPublicUnicastIp (a name like `localhost` or `127.0.0.1.` is a
 * hostname here yet resolves to loopback).
 */

import ipaddr from 'ipaddr.js';

type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

/** Outcome of interpreting a URL host as either an IP literal or a DNS name. */
export type HostClassification =
  | { kind: 'hostname' }
  | { kind: 'ip-literal'; allowed: boolean; canonical: string; family: 4 | 6 };

/**
 * Parse a host as an IP literal in any spelling ipaddr.js accepts (dotted quad,
 * decimal/octal/hex integers, short forms, IPv6, optionally bracketed IPv6).
 * Returns null for anything that is not an IP literal (a DNS name) or that
 * fails to parse. The string boundary is the only place this module touches
 * untyped, potentially hostile input, so the parse guard lives here.
 */
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

/**
 * True only when `ip` is a public unicast address. Intended for validating each
 * address returned by DNS resolution before a connection is pinned to it.
 * Returns false (deny) for private/reserved ranges and for any string that is
 * not a parseable IP.
 */
export function isPublicUnicastIp(ip: string): boolean {
  const parsed = parseIpLiteral(ip);
  return parsed !== null && parsed.range() === 'unicast';
}

/**
 * Classify a URL host. An IP literal is canonicalized and range-checked here; a
 * DNS name is reported as 'hostname' so the caller resolves it and validates
 * each resolved address with isPublicUnicastIp.
 */
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
