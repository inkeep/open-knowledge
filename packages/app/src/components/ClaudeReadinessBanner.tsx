/**
 * Actionable readiness banner for the docked terminal. After the PTY is
 * running, the panel probes Claude Code readiness and renders this strip when
 * something blocks the `type claude and it works` flow:
 *   - `claude` not on PATH → a help affordance (open the Claude Code docs).
 *   - `claude` present but the `open-knowledge` MCP server missing from
 *     `~/.claude.json` → a re-wire affordance (re-arms MCP consent).
 *
 * Renders nothing when claude is present + wired, or when the probe verdict is
 * `unknown` (a flaky probe must never surface a false "not installed"). The
 * strip is `role="status"` so screen readers announce it when it appears, and
 * dismissible so a non-Claude user (git/npm) isn't nagged. It is a flow strip
 * above the terminal (the parent pushes the canvas down), not an overlay — so
 * it never covers the shell prompt or first output in the degraded states.
 */
import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ClaudeReadiness, OkDesktopBridge } from '@/lib/desktop-bridge-types';

/** Claude Code docs landing — install + setup instructions live here. */
const CLAUDE_CODE_DOCS_URL = 'https://docs.claude.com/en/docs/claude-code';

interface ClaudeReadinessBannerProps {
  readonly readiness: ClaudeReadiness;
  readonly bridge: OkDesktopBridge;
  /** Dismiss the banner for this panel session. */
  readonly onDismiss: () => void;
}

type BannerKind = 'claude-missing' | 'mcp-needs-rewire';

function bannerKind(readiness: ClaudeReadiness): BannerKind | null {
  if (readiness.claude === 'not-found') return 'claude-missing';
  // claude must be present before nudging about MCP wiring — `unknown` is not
  // a green light, and a not-found claude has nothing to wire tools into.
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
    // Re-arm MCP wiring. Only dismiss the banner on success — on failure keep
    // it visible (plus a toast) so the user can retry, rather than silently
    // swallowing the failure and leaving them with no affordance.
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
    <div
      role="status"
      // Stable test seam: the editor page carries several app-wide role="status"
      // nodes (SelectionAnnouncer, ConnectingBanner), so smoke tests scope to this
      // attribute instead of an ambiguous getByRole('status'). Mirrors the
      // [data-terminal-status] / settings-terminal-toggle data-testid convention.
      data-testid="terminal-readiness-banner"
      className="flex shrink-0 items-center gap-3 border-border border-b bg-muted px-3 py-2 text-foreground text-xs"
    >
      <p className="min-w-0 flex-1">{message}</p>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={handleAction}>
        {actionLabel}
      </Button>
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
