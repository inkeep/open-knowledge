/**
 * The single gate a crashed session's app version passes through before it
 * reaches a log line or the body of a bug report.
 *
 * Two witnesses answer "which build died" — the Crashpad annotation inside a
 * minidump, and the `appVersion` the previous session left in its sentinel —
 * and neither is a file this process wrote during this run. Both destinations
 * are line-oriented, so a value carrying a line break could forge the context
 * printed around it, and one with no ceiling could push the rest of a report
 * out of view. One function rather than a check per witness, so the two cannot
 * come to disagree about what a version is allowed to be.
 *
 * Stated as a whitelist rather than a list of characters to reject: the
 * versions we produce are `app.getVersion()`, printable ASCII by construction,
 * so anything outside that is not a version this app can vouch for. A reject
 * list can be under-enumerated — U+0085, U+2028/U+2029, the C1 block and the
 * bidi overrides all affect how a line renders and none of them is a C0
 * control — while "what may pass" cannot.
 */

/** Ample for a semver string with build metadata; a real one is tens of bytes. */
const MAX_VERSION_LENGTH = 256;

const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;

/**
 * `value` when it is safe to print as a version, otherwise null. Null means
 * "unknown", and callers must let it stay unknown: substituting the running
 * version answers a different question than the one asked, and is
 * indistinguishable from a true answer at the point it is read.
 */
export function asReportableAppVersion(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_VERSION_LENGTH) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < FIRST_PRINTABLE_ASCII || code > LAST_PRINTABLE_ASCII) return null;
  }
  return value;
}
