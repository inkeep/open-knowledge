export function isLoopbackAddress(remote: string | undefined): boolean {
  if (!remote) return false;
  if (remote === '::1') return true;
  if (remote.startsWith('::ffff:127.')) return true;
  if (remote.startsWith('127.')) return true;
  return false;
}

export function isAllowedWorkspaceHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return false;
    const inner = host.slice(1, close);
    const trailing = host.slice(close + 1);
    if (trailing !== '' && !/^:\d+$/.test(trailing)) return false;
    return inner === '::1';
  }
  const colon = host.lastIndexOf(':');
  const hostname = colon >= 0 ? host.slice(0, colon) : host;
  const portPart = colon >= 0 ? host.slice(colon + 1) : null;
  if (portPart !== null && !/^\d+$/.test(portPart)) return false;
  if (hostname === 'localhost') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}
