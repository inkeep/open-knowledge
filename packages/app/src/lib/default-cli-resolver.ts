/**
 * The single deterministic rule for "which CLI does New chat launch?" — shared
 * by the header + tab-strip New-chat buttons and the "Ask X" bubble default so
 * every entry point agrees on the same CLI.
 *
 * A New chat only ever launches a terminal CLI, so an app-target sticky pick
 * (a `HandoffTarget` id, e.g. `claude-code`) is intentionally ignored here —
 * `parseStickyCliId` returns `null` for it and resolution falls through to the
 * installed-priority auto-pick. Priority order is `TERMINAL_CLI_IDS` itself
 * (claude > codex > opencode > cursor); reusing it keeps the auto-pick order in
 * lockstep with the visible launch-row order rather than duplicating a list.
 */

import { TERMINAL_CLI_IDS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { parseStickyCliId } from './unified-agent-store';

/**
 * Resolve the default CLI from the raw sticky pick and the installed-CLI map:
 *
 *   1. sticky parses to a CLI ({@link parseStickyCliId}) → it, unconditionally.
 *      An explicit pick is honored even when the CLI is KNOWN-absent: the user
 *      chose it, so launching it (and surfacing the "Get <CLI>" missing-CLI
 *      banner) respects that choice rather than silently substituting whatever
 *      happens to be installed. The install state is irrelevant to this branch;
 *      it also means a click during the cold-start probe window keeps the
 *      remembered pick — matching the Ask-X bubble.
 *   2. else the first known-installed CLI by `TERMINAL_CLI_IDS` priority;
 *   3. else `'claude'` (the install-nudge default — launching it surfaces the
 *      existing "Get Claude" banner when nothing is on PATH).
 *
 * `installed` is a partial map: an unresolved probe leaves keys `undefined`
 * (unknown), distinct from `false` (probed, not on PATH). It gates only the
 * priority auto-pick (branch 2), which needs a positive `true` and so waits for
 * the probe rather than guessing; the explicit sticky pick ignores it entirely.
 */
export function resolveDefaultCli(
  sticky: string | null,
  installed: Partial<Record<TerminalCli, boolean>>,
): TerminalCli {
  const stickyCli = parseStickyCliId(sticky);
  if (stickyCli) return stickyCli;
  return TERMINAL_CLI_IDS.find((cli) => installed[cli] === true) ?? 'claude';
}
