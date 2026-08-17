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
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TerminalCliUnverifiedBannerProps {
  readonly cli: TerminalCli;
  /** Dismiss the banner for this panel session. */
  readonly onDismiss: () => void;
}

export function TerminalCliUnverifiedBanner({ cli, onDismiss }: TerminalCliUnverifiedBannerProps) {
  const { t } = useLingui();
  const { bin, displayName } = TERMINAL_CLIS[cli];

  return (
    <div
      role="status"
      data-testid="terminal-cli-unverified-banner"
      className="flex shrink-0 items-center gap-3 border-border border-b bg-muted px-3 py-2 text-foreground text-xs"
    >
      <p className="min-w-0 flex-1">
        {t`Couldn't verify that ${displayName} (${bin}) is available, so this is a plain shell. You can still run ${bin} yourself.`}
      </p>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t`Dismiss`}
        className="size-6 shrink-0"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}
