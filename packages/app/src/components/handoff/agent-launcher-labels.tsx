/**
 * Shared launcher copy — the agent names and primary-button verbs every picker
 * surface uses: the split-button menus, the "Open with AI" popover, the
 * file-tree submenus, and the Configure-agents list.
 *
 * One module rather than inline JSX per surface for two reasons: the rows and
 * the primary button must not drift apart, and the Lingui macro needs a bare
 * identifier to emit the named placeholders (`{displayName} Desktop`,
 * `Open {displayName} Desktop`, `Ask {agentName}`). Interpolating
 * `target.displayName` directly emits a positional `{0}` and forks a duplicate
 * catalog entry per call site.
 *
 * The verb split is the point: work that stays in this window is something you
 * ASK, work that leaves for another application is something you OPEN.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

/**
 * Row label — "Claude Desktop". The suffix is load-bearing: the Terminal
 * section right above carries rows with the same brand names, and the two
 * launch different things.
 */
export function DesktopAppName({ displayName }: { displayName: string }): ReactNode {
  return <Trans>{displayName} Desktop</Trans>;
}

/**
 * Primary-button label when an external app is the selection — "Open Claude
 * Desktop". The verb is "Open", not the in-app "Ask", because the
 * click hands the work to another application.
 */
export function OpenDesktopAppLabel({ displayName }: { displayName: string }): ReactNode {
  return <Trans>Open {displayName} Desktop</Trans>;
}

/** Primary-button label for an in-app agent — "Ask Claude Agent". */
export function AskAgentNameLabel({ agentName }: { agentName: string }): ReactNode {
  return <Trans>Ask {agentName}</Trans>;
}
