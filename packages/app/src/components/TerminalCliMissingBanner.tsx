/**
 * Missing-CLI banner for the docked terminal. When an "Open in terminal" launch
 * targets a non-Claude agent CLI (Codex / Cursor) whose binary isn't on the
 * login-shell PATH, the panel suppresses the (broken) launch and renders this
 * strip instead: a one-line "not installed" message plus a "Get <Brand>"
 * affordance that opens the CLI's install docs.
 *
 * The Claude CLI has its own richer readiness strip (`ClaudeReadinessBanner`,
 * which also covers the MCP-wiring nudge); this one is the codex/cursor
 * equivalent of just its `not-found` branch. Like that banner it is
 * `role="status"` (announced when it appears) and dismissible so a user who
 * meant to use the shell for something else isn't nagged.
 */
import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

interface TerminalCliMissingBannerProps {
  readonly cli: TerminalCli;
  readonly bridge: OkDesktopBridge;
  /** Dismiss the banner for this panel session. */
  readonly onDismiss: () => void;
}

export function TerminalCliMissingBanner({
  cli,
  bridge,
  onDismiss,
}: TerminalCliMissingBannerProps) {
  const { t } = useLingui();
  const { bin, displayName, docsUrl } = TERMINAL_CLIS[cli];

  return (
    <TerminalNoticeBanner
      testId="terminal-cli-missing-banner"
      onDismiss={onDismiss}
      action={
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => void bridge.shell.openExternal(docsUrl)}
        >
          {t`Get ${displayName}`}
        </Button>
      }
    >
      {t`${displayName} (${bin}) isn't installed or on your PATH.`}
    </TerminalNoticeBanner>
  );
}
