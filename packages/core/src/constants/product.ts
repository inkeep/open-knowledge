/**
 * Human-facing product/brand name. Centralized so the runtime TS prose
 * surfaces — the macOS About panel, window titles, CLI status lines, and
 * non-localized renderer toasts — share one source of truth instead of
 * scattered string literals.
 *
 * This is DISPLAY prose, NOT a technical identifier. The kebab/scoped/
 * reverse-DNS slugs are deliberately separate and MUST NOT be derived from
 * this value:
 *   - npm package        `@inkeep/open-knowledge`
 *   - macOS appId        `com.inkeep.open-knowledge`
 *   - deep-link scheme   `openknowledge://`
 *   - MCP server name /  `open-knowledge`
 *     keyring service
 *   - shadow writer-ID   `openknowledge-service`
 *
 * Build-time identity (electron-builder `productName`, package.json) cannot
 * import this constant — those are static config and stay in lockstep via
 * the `helper-bundle-name-agreement` test.
 * Localized renderer strings cannot use it either (lingui keys on the source
 * string), so it covers the raw-literal TS surfaces only.
 */
export const PRODUCT_NAME = 'OpenKnowledge';
