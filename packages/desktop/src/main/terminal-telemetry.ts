/**
 * Docked-terminal lifecycle telemetry — the main-side half.
 *
 * Wraps `withSpanSync` from the server's telemetry helpers so the terminal's
 * shell lifecycle emits bounded-cardinality spans — never command contents,
 * shell I/O, or raw paths (the privacy line the whole feature holds). When the
 * SDK is disabled (default builds) `withSpanSync` is a no-op so this path adds
 * zero overhead.
 *
 * Only the two intrinsically main-side signals live here: the shell exit/crash
 * (the terminal-manager owns the PTY lifecycle) and the count-only
 * terminal-session marker (the manager is the single point that sees both shell
 * input and session end). The two renderer-originated signals (terminal-opened,
 * shell-consent-granted) emit from the renderer tracer in
 * `@inkeep/open-knowledge/app`'s `lib/terminal-telemetry.ts`.
 */

import { withSpanSync } from '@inkeep/open-knowledge-server';

/**
 * Emit one `ok.desktop.shellExit` span. `crashed` distinguishes a PTY/host
 * crash or spawn failure from a clean shell exit — the reliability signal. No
 * exit code / signal / path is attached: a bounded boolean is all the
 * reliability metric needs and keeps the attribute cardinality at two buckets.
 * SDK disabled → no-op.
 */
export function recordShellExit(info: { crashed: boolean }): void {
  withSpanSync(
    'ok.desktop.shellExit',
    { attributes: { 'ok.desktop.shell_crashed': info.crashed } },
    () => undefined,
  );
}

/**
 * Emit one `ok.desktop.terminalSession` span — the count-only marker for a
 * terminated session that had at least one command run, so non-`claude`
 * (git / npm / build) terminal value is observable independently of `claude`
 * launches. The span itself is the count; it carries no attributes, and the
 * manager never inspects command contents to decide it (only that an input
 * carried a line terminator). SDK disabled → no-op.
 */
export function recordTerminalSession(): void {
  withSpanSync('ok.desktop.terminalSession', {}, () => undefined);
}

/**
 * Emit one `ok.desktop.terminalConcurrentSessions` span carrying the number of
 * shells now live in the window — the count-only concurrency signal. Fired each
 * time a tab opens, so the per-window max over these spans reads both
 * multi-session adoption (any window that reached ≥2) and concurrency depth (the
 * peak). The lone attribute is a small bounded integer; no ptyId, path, or
 * command content is ever attached. SDK disabled → no-op.
 */
export function recordConcurrentSessions(info: { count: number }): void {
  withSpanSync(
    'ok.desktop.terminalConcurrentSessions',
    { attributes: { 'ok.desktop.concurrent_sessions': info.count } },
    () => undefined,
  );
}

/**
 * Emit one `ok.desktop.terminalWindowOpened` span — the count-only adoption
 * marker for the "New Terminal Window" command. The span itself is the count;
 * it carries no attributes (no project path, no command contents), mirroring
 * `recordTerminalSession`. SDK disabled → no-op.
 */
export function recordTerminalWindowOpened(): void {
  withSpanSync('ok.desktop.terminalWindowOpened', {}, () => undefined);
}
