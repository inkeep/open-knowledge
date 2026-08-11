/**
 * Shared loopback-origin guard for unauthenticated local HTTP surfaces.
 *
 * `null` and `file://` are the two serializations of a local-file page's
 * origin (the packaged Electron renderer loads via `loadFile`): fetch/XHR
 * send `Origin: null`, but Chromium's WebSocket handshake sends
 * `Origin: file://`. They carry the same trust level — rejecting one while
 * allowing the other only breaks the desktop renderer's WS surfaces
 * (`/collab/thread`) while its HTTP calls sail through.
 */
export function isAllowedApiOrigin(origin: string): boolean {
  if (origin === 'null' || origin === 'file://') return true;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}
