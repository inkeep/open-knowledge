#!/usr/bin/env node
import { FuseState, FuseV1Options } from '@electron/fuses';

/**
 * Canonical fuse configuration. This is the single source of
 * truth for both `afterPack.mjs` (flip) and `afterSign.mjs` (verify).
 * Flip-time and verify-time must compare against the same map — any
 * drift means the paranoid post-sign check silently passes on values the
 * flip didn't actually set.
 *
 * Keys are `FuseV1Options` indices (numeric). Values are booleans (true =
 * enable, false = disable). The verifier maps boolean → `FuseState.ENABLE` /
 * `FuseState.DISABLE` via `expectedFuseState()` and then compares raw
 * FuseState values — never collapses to booleans. This is load-bearing
 * because `FuseState` has four values (DISABLE, ENABLE, REMOVED, INHERIT);
 * a boolean collapse maps REMOVED/INHERIT to `false` and silently accepts
 * fuses that should have been explicitly DISABLE.
 */
// RunAsNode is ENABLED.
//
// The bundled `ok.sh` wrapper's `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" …`
// invocation requires this fuse to be enabled in packaged builds — with the
// fuse disabled, Electron silently ignores the env var and launches the GUI
// instead of executing the CLI. That would break the entire CLI-on-PATH
// + first-launch MCP wiring path in the packaged `.app`. VS Code, Atom, and
// the Electron-as-Node-host pattern all depend on RunAsNode
// being enabled for the same reason.
//
// Defense-in-depth retained:
//   - `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation` keep
//     the asar-loaded renderer + main scripts integrity-checked.
//   - `EnableNodeOptionsEnvironmentVariable` stays DISABLED so a hostile
//     `NODE_OPTIONS` in the user's shell can't inject `--require` into the
//     Electron-as-Node invocation. The wrapper also re-exports user-supplied
//     `NODE_OPTIONS` as `OK_NODE_OPTIONS` then unsets it, double-guarding.
//   - Post-sign `@electron/fuses read` verification (afterSign.mjs) still
//     diffs actual vs expected against this map — drift fails the release
//     pipeline.
//   - Bundle-modification attacks require admin write access to /Applications
//     (already a full-compromise scenario). Gatekeeper notarization ticket
//     validates on download (quarantine bit path); local tampering is out of
//     scope for the code-signing threat model.
// EnableCookieEncryption is DISABLED. Audit found exactly one cookie in the
// packaged Cookies SQLite store — shadcn's `sidebar_state=true|false`
// open/closed flag set from a file:// page. file:// cookies have
// `is_secure: 0` so Chromium's cookie-encryption path never engages on
// them (it gates on is_secure: 1). The fuse-on path was a no-op for our
// actual cookie traffic while triggering a Keychain prompt at every
// first launch — defense-in-depth that defended nothing. Re-enable when
// a feature actually stores a secret in a cookie (would coincide with
// adding a webview to a third-party service).
export const targetFuses = {
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/**
 * Human-readable name for a `FuseState` value. Used in verifier error
 * messages so `expected ENABLE, got REMOVED` beats `expected 49, got 114`.
 */
export function fuseStateName(state) {
  switch (state) {
    case FuseState.DISABLE:
      return 'DISABLE';
    case FuseState.ENABLE:
      return 'ENABLE';
    case FuseState.REMOVED:
      return 'REMOVED';
    case FuseState.INHERIT:
      return 'INHERIT';
    default:
      return `UNKNOWN(${state})`;
  }
}

/**
 * Map the canonical boolean expectation to the `FuseState` the post-sign
 * verifier must see. `true` → `FuseState.ENABLE`, `false` → `FuseState.DISABLE`.
 * Any other observed state (REMOVED, INHERIT) is a mismatch — the signing
 * pipeline should not leave fuses in those states.
 */
export function expectedFuseState(expectedValue) {
  return expectedValue ? FuseState.ENABLE : FuseState.DISABLE;
}
