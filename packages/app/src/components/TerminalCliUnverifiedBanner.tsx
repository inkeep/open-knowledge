/**
 * Unverified-CLI banner for the docked terminal. When an "Open in <Agent>"
 * launch cannot VERIFY the CLI's presence (the login-shell probe timed out or
 * failed, or the preflight IPC itself rejected), the panel suppresses the bake
 * and renders this strip over the plain-shell fallback.
 *
 * Sibling of `TerminalCliMissingBanner`, which handles the verified `not-found`
 * verdict. The two are deliberately distinct: the probe producer's contract
 * (claude-readiness) forbids presenting an UNKNOWN as positive absence, so this
 * copy makes no absence claim — the binary may well be installed while the
 * probe flaked. Like its sibling it is `role="status"` (announced when it
 * appears) and dismissible.
 */
import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

interface TerminalCliUnverifiedBannerProps {
  readonly cli: TerminalCli;
  /** Dismiss the banner for this panel session. */
  readonly onDismiss: () => void;
}

export function TerminalCliUnverifiedBanner({ cli, onDismiss }: TerminalCliUnverifiedBannerProps) {
  const { t } = useLingui();
  const { bin, displayName } = TERMINAL_CLIS[cli];

  return (
    <TerminalNoticeBanner testId="terminal-cli-unverified-banner" onDismiss={onDismiss}>
      {t`Couldn't verify that ${displayName} (${bin}) is available, so this is a plain shell. You can still run ${bin} yourself.`}
    </TerminalNoticeBanner>
  );
}
