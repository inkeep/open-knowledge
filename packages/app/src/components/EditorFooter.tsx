import { Plural, useLingui } from '@lingui/react/macro';
import { ChevronUp, GitBranch, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type EditorFooterIdentity,
  useEditorFooterIdentity,
} from '@/hooks/use-editor-footer-identity';
import type { DocumentStats } from '@/lib/document-stats';

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
  const identity = useEditorFooterIdentity();
  if (!showStats && identity === null && composerBadge == null) return null;
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
      {}
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
        {identity !== null ? <IdentityRow identity={identity} /> : null}
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

function IdentityRow({ identity }: { identity: EditorFooterIdentity }) {
  const { projectName, projectPath, branch } = identity;
  return (
    <>
      {projectName !== null ? (
        projectPath ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip-on-static-text pattern — focusable span lets keyboard users surface the full project path that mouse users see on hover. */}
              <span tabIndex={0} className="truncate" data-testid="editor-footer-project-name">
                {projectName}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs break-all">
              {projectPath}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="truncate" data-testid="editor-footer-project-name">
            {projectName}
          </span>
        )
      ) : null}
      {branch !== null ? (
        <span className="flex min-w-0 items-center gap-1" data-testid="editor-footer-branch">
          <GitBranch aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
    </>
  );
}
