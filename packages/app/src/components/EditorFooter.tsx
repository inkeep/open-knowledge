import { Plural, useLingui } from '@lingui/react/macro';
import { ChevronUp, GitBranch, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCurrentBranch } from '@/hooks/use-current-branch';
import { useWorktrees } from '@/hooks/use-worktrees';
import type { DocumentStats } from '@/lib/document-stats';
import { checkoutIdentity } from './checkout-identity';

interface EditorFooterProps {
  stats: DocumentStats;
  selectionStats?: DocumentStats | null;
  showStats?: boolean;
  composerBadge?: { onReopen: () => void } | null;
}

export function EditorFooter({
  stats,
  selectionStats,
  showStats = true,
  composerBadge,
}: EditorFooterProps) {
  const { t } = useLingui();
  const branch = useCurrentBranch();
  const worktreeModel = useWorktrees();
  const desktopConfig = typeof window !== 'undefined' ? window.okDesktop?.config : undefined;
  const { checkoutDetail } = checkoutIdentity({
    projectName: desktopConfig?.projectName ?? null,
    branch,
    worktreeModel,
  });
  const projectPath = desktopConfig?.projectPath ?? null;
  if (!showStats && checkoutDetail === null && composerBadge == null) return null;
  const active = selectionStats ?? stats;
  const isSelection = selectionStats != null;
  const { words, chars, tokens } = active;
  return (
    <section
      aria-label={
        !showStats
          ? t`Editor status bar`
          : isSelection
            ? t`Selection statistics`
            : t`Document statistics`
      }
      className="relative flex h-6 shrink-0 items-center justify-between gap-3 bg-background px-3 text-2xs text-muted-foreground"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full h-2 bg-linear-to-t from-background to-transparent"
      />
      {composerBadge ? (
        <Button
          type="button"
          variant="outline"
          onClick={composerBadge.onReopen}
          data-testid="ask-ai-reopen-badge"
          className="-translate-x-1/2 absolute bottom-0 left-1/2 z-10 h-auto gap-1 rounded-md rounded-b-none bg-card px-2.5 py-0.5 text-2xs font-normal text-muted-foreground shadow-sm hover:text-foreground active:not-aria-[haspopup]:translate-y-0"
        >
          <Sparkles className="size-3" aria-hidden />
          {t`Ask AI`}
          <ChevronUp className="size-3" aria-hidden />
        </Button>
      ) : null}
      <span className="flex min-w-0 items-center gap-3">
        {checkoutDetail !== null ? (
          <CheckoutDetail detail={checkoutDetail} projectPath={projectPath} />
        ) : null}
      </span>
      {showStats ? (
        <span className="flex shrink-0 items-center gap-3">
          {isSelection ? (
            <span
              className="font-medium text-foreground/70"
              data-testid="editor-footer-selected-label"
            >
              {t`Selected`}
            </span>
          ) : null}
          <span>
            <span className="tabular-nums">{active.words.toLocaleString()}</span>{' '}
            <Plural value={words} one="word" other="words" />
          </span>
          <span>
            <span className="tabular-nums">{active.chars.toLocaleString()}</span>{' '}
            <Plural value={chars} one="char" other="chars" />
          </span>
          <span>
            {active.tokens > 0 ? '~' : ''}
            <span className="tabular-nums">{active.tokens.toLocaleString()}</span>{' '}
            <Plural value={tokens} one="token" other="tokens" />
          </span>
        </span>
      ) : null}
    </section>
  );
}

function CheckoutDetail({ detail, projectPath }: { detail: string; projectPath: string | null }) {
  const row = (
    <span className="flex min-w-0 items-center gap-1" data-testid="editor-footer-branch">
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{detail}</span>
    </span>
  );
  if (projectPath === null) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- tooltip-on-static-text pattern — focusable span lets keyboard users surface the full project path that mouse users see on hover.
          tabIndex={0}
          className="flex min-w-0"
          data-testid="editor-footer-checkout"
        >
          {row}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs break-all">
        {projectPath}
      </TooltipContent>
    </Tooltip>
  );
}
