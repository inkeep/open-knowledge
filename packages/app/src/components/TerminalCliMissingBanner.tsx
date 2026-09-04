import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

interface TerminalCliMissingBannerProps {
  readonly cli: TerminalCli;
  readonly bridge: OkDesktopBridge;
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
