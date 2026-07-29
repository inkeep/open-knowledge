/**
 * Secret/PII redaction for `ok bug-report` bundles. The pattern list is now
 * canonical in `@inkeep/open-knowledge-core` (shared with the renderer
 * console-capture forwarder so the two can't drift); this module re-exports it
 * under the bundle-assembly names its callers already use.
 *
 * This is the ship-path backstop for the on-disk diagnostics logs (which now
 * include captured renderer/browser console output): `redactContent` runs over
 * every bundled file before it leaves the machine. It is best-effort pattern
 * matching, not a guarantee.
 */

export { redactSecrets as redactContent, SECRET_PATTERN_NAMES } from '@inkeep/open-knowledge-core';
