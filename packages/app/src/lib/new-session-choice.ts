/**
 * The shape of the sessions dock's "New" split-button primary pick, sticky across
 * the three session families (a bare terminal, a CLI chat, an in-app agent thread).
 *
 * The pick itself is now computed by the shared `resolveLauncherSelection`
 * (`lib/acp/launcher-selection.ts`) — the single, enablement-aware selection rule
 * every launcher surface uses. This module keeps only the button's contract type.
 */

import type { TerminalCli } from '@inkeep/open-knowledge-core';
import type { RegisteredAgent } from '@/lib/acp/registered-agents';

/** The primary pick a New-session click launches. */
export type NewSessionChoice =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'cli'; readonly cli: TerminalCli }
  // `agent === null` means "start an agent, but no concrete one is remembered"
  // — the primary click opens Settings rather than launching blindly.
  | { readonly kind: 'agent'; readonly agent: RegisteredAgent | null };
