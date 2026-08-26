/**
 * The Crashpad annotation OK uses to record editor display-lock state on a
 * renderer dump, shared by the only two sites that may name it: the preload,
 * which writes it, and the minidump reader in main, which reads it back.
 *
 * One definition rather than two string literals, because a drift between the
 * writer's key and the reader's key would not fail anything — it would produce
 * dumps that silently carry no display-lock state, which is exactly the
 * undiagnosable shape the key exists to remove.
 */

/**
 * Annotation key. Crashpad silently ignores keys over 39 bytes, so this stays
 * far inside that ceiling; the `ok_` prefix keeps it clear of Chromium's own
 * keys (`ax_mode`, `ptype`, and the rest) in a dump's annotation list.
 */
export const DISPLAY_LOCK_CRASH_KEY = 'ok_display_lock';

/**
 * Byte ceiling the preload enforces on a value before handing it to Crashpad.
 *
 * Electron's own documentation is self-contradictory here: the
 * `addExtraParameter` section states a 20320-byte value limit while the
 * `start()` notes state 127 bytes for the same mechanism. Crashpad truncates an
 * over-long value silently, and a truncated reading is worse than a missing one
 * because it still parses and would therefore be trusted during triage. So the
 * conservative figure is the one enforced, and the writer drops rather than
 * sends anything above it. Callers are expected to stay well under this by
 * construction; the cap is a boundary safety net, not a budget to spend.
 */
export const DISPLAY_LOCK_CRASH_KEY_MAX_BYTES = 127;
