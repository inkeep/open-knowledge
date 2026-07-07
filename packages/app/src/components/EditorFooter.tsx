import { Plural, useLingui } from '@lingui/react/macro';
import { ChevronUp, GitBranch, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type EditorFooterIdentity,
  useEditorFooterIdentity,
} from '@/hooks/use-editor-footer-identity';
import type { DocumentStats } from '@/lib/document-stats';
import { cn } from '@/lib/utils';

interface EditorFooterProps {
  stats: DocumentStats;
  /** Selection-scoped stats. When non-null, the stats group reflects the
   *  current selection (prefixed "Selected"); when null it shows `stats`
   *  (whole document). */
  selectionStats?: DocumentStats | null;
  /** Stats group renders only when there's a real doc scope. When false and
   *  identity is also empty, the footer renders nothing. */
  showStats?: boolean;
  /** When set, a "Ask AI" reopen badge renders next to the stats — shown only
   *  while the bottom composer is dismissed. Clicking it reopens the composer. */
  composerBadge?: { onReopen: () => void } | null;
  /** Reserve extra right padding so the right-aligned stats clear the
   *  bottom-dock "Show terminal" reveal tab, which floats over the footer's
   *  bottom-right corner when the terminal is hidden. */
  reserveRightGutter?: boolean;
}

export function EditorFooter({
  stats,
  selectionStats,
  showStats = true,
  composerBadge,
  reserveRightGutter = false,
}: EditorFooterProps) {
  const { t } = useLingui();
  const identity = useEditorFooterIdentity();
  if (!showStats && identity === null && composerBadge == null) return null;
  // A non-null selectionStats scopes the counts to the current selection.
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
      className={cn(
        'relative flex h-6 shrink-0 items-center justify-between gap-3 bg-background px-3 text-2xs text-muted-foreground',
        // Clear the bottom-dock reveal tab that floats over the bottom-right.
        reserveRightGutter && 'pr-12',
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full h-2 bg-linear-to-t from-background to-transparent"
      />
      {/* Reopen tab — centered and flush to the footer's bottom edge (the
          collapsed counterpart to the composer's top-center collapse handle).
          The Button base applies `active:translate-y-px` (a press-down nudge);
          on this edge-anchored tab that 1px shoves it past the viewport bottom
          and pops a transient scrollbar while held, so neutralize it here. */}
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
