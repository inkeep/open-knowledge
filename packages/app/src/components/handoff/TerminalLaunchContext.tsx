/**
 * Launch-intent context for the docked-terminal "Open in terminal" entry point
 * — the in-app twin of the Claude Desktop deep-link handoff.
 *
 * The handoff menus (header sparkle dropdown, FileTree row submenu, empty-space
 * submenu) all build a `HandoffDispatchInput` from the same doc / folder /
 * selection context. The deep-link surfaces dispatch that input to a URL; the
 * terminal surface hands it here instead. `launchInTerminal` composes the same
 * scope-specific prompt the deep-link puts in `q=` and routes it to the
 * terminal session.
 *
 * Desktop-only: a real value is provided ONLY when the desktop terminal bridge
 * is present. On the web host (a sandboxed browser surface that cannot host a
 * real OS shell) `useTerminalLaunch()` returns `null`, and the menu rows that
 * consume it render nothing.
 */
import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use } from 'react';
import type { HandoffDispatchInput } from './useHandoffDispatch';

export interface TerminalLaunchContextValue {
  /**
   * Open the docked terminal and launch the chosen agent `cli` (`claude` /
   * `codex` / `cursor`) with the prompt composed from this handoff input
   * (deep-link parity). Human-only — driven by a UI click.
   */
  readonly launchInTerminal: (input: HandoffDispatchInput, cli: TerminalCli) => void;
}

const TerminalLaunchContext = createContext<TerminalLaunchContextValue | null>(null);

export function TerminalLaunchProvider({
  value,
  children,
}: {
  /** `null` disables the entry point (web host / no terminal bridge). */
  readonly value: TerminalLaunchContextValue | null;
  readonly children: ReactNode;
}): ReactNode {
  return <TerminalLaunchContext value={value}>{children}</TerminalLaunchContext>;
}

/**
 * Returns the launcher when the docked terminal is available, else `null`.
 * Consumers render the "Open in terminal" row only on a non-null value, so the
 * entry point is desktop-gated without each surface re-deriving host detection.
 */
export function useTerminalLaunch(): TerminalLaunchContextValue | null {
  return use(TerminalLaunchContext);
}
