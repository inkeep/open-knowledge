import { useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ClaudeReadiness, OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

const CLAUDE_CODE_DOCS_URL = 'https://docs.claude.com/en/docs/claude-code';

interface ClaudeReadinessBannerProps {
  readonly readiness: ClaudeReadiness;
  readonly bridge: OkDesktopBridge;
  readonly onDismiss: () => void;
}

type BannerKind = 'claude-missing' | 'mcp-needs-rewire';

function bannerKind(readiness: ClaudeReadiness): BannerKind | null {
  if (readiness.claude === 'not-found') return 'claude-missing';
  if (readiness.claude === 'present' && readiness.mcp === 'needs-rewire') {
    return 'mcp-needs-rewire';
  }
  return null;
}

export function ClaudeReadinessBanner({
  readiness,
  bridge,
  onDismiss,
}: ClaudeReadinessBannerProps) {
  const { t } = useLingui();
  const kind = bannerKind(readiness);
  if (kind === null) return null;

  const isClaudeMissing = kind === 'claude-missing';
  const message = isClaudeMissing
    ? t`Claude Code (claude) isn't installed or on your PATH.`
    : t`Claude Code is installed, but OpenKnowledge tools aren't connected to it yet.`;
  const actionLabel = isClaudeMissing ? t`Get Claude Code` : t`Connect tools`;

  function handleAction() {
    if (isClaudeMissing) {
      void bridge.shell.openExternal(CLAUDE_CODE_DOCS_URL);
      return;
    }
    bridge.terminal
      .rewireClaudeMcp()
      .then((result) => {
        if (result.rewireError != null) {
          toast.error(t`Couldn't connect OpenKnowledge tools to Claude Code. Please try again.`);
          return;
        }
        onDismiss();
      })
      .catch((err) => {
        console.warn('[terminal] rewireClaudeMcp failed:', err);
        toast.error(t`Couldn't connect OpenKnowledge tools to Claude Code. Please try again.`);
      });
  }

  return (
    <TerminalNoticeBanner
      testId="terminal-readiness-banner"
      onDismiss={onDismiss}
      action={
        <Button size="sm" variant="secondary" className="shrink-0" onClick={handleAction}>
          {actionLabel}
        </Button>
      }
    >
      {message}
    </TerminalNoticeBanner>
  );
}
