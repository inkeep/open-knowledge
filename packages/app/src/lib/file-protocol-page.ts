/**
 * Whether the page itself was loaded over `file:` — the packaged Electron
 * renderer (`loadFile` in `packages/desktop/src/main/index.ts`). A `file:`
 * page's fetches carry `Origin: null`, which loopback-origin-only server
 * routes (e.g. the link-preview anti-proxy gate in
 * `packages/server/src/link-preview/request-gate.ts`) reject by design, so
 * callers use this to hide affordances that can never work on that host.
 * The DEV desktop renderer loads from http://localhost (loopback Origin) and
 * is intentionally NOT matched.
 *
 * `loc` is injectable for tests only (mirrors the `external-link.ts`
 * convention — plain `.test.ts` runs without a DOM `window`); production
 * callers pass nothing.
 */
export function isFileProtocolPage(
  loc: { protocol: string } | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): boolean {
  return loc?.protocol === 'file:';
}
