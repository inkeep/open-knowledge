import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

interface TerminalCliUnverifiedBannerProps {
  readonly cli: TerminalCli;
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
