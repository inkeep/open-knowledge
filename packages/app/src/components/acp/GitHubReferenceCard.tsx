import type { GitHubReferencePreview } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { useGitHubReference } from './github-reference';
import {
  diffBlocks,
  type ReferenceStatusLine,
  type ReferenceStatusTone,
  referenceStatusLine,
} from './reference-status';

type Lifecycle = GitHubReferencePreview['lifecycle'];

const PILL_CLASS: Record<Lifecycle, string> = {
  open: 'bg-green-700',
  draft: 'bg-neutral-500',
  merged: 'bg-violet-600',
  closed: 'bg-red-600',
  completed: 'bg-violet-600',
  'not-planned': 'bg-neutral-500',
};

const TONE_CLASS: Record<ReferenceStatusTone, string> = {
  success: 'text-green-700 dark:text-green-400',
  attention: 'text-amber-700 dark:text-amber-400',
  severe: 'text-orange-700 dark:text-orange-400',
  danger: 'text-red-700 dark:text-red-400',
};

const BLOCK_CLASS = {
  add: 'bg-green-600',
  del: 'bg-red-600',
  none: 'bg-muted-foreground/25',
} as const;

function lifecycleIcon(preview: GitHubReferencePreview): LucideIcon {
  if (preview.kind === 'issue') {
    if (preview.lifecycle === 'open') return CircleDot;
    return preview.lifecycle === 'not-planned' ? CircleSlash : CircleCheck;
  }
  if (preview.lifecycle === 'merged') return GitMerge;
  if (preview.lifecycle === 'draft') return GitPullRequestDraft;
  return preview.lifecycle === 'open' ? GitPullRequest : GitPullRequestClosed;
}

function openedOn(iso: string, locale: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale || undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

function useLifecycleLabel(): (lifecycle: Lifecycle) => string {
  const { t } = useLingui();
  return (lifecycle) => {
    switch (lifecycle) {
      case 'open':
        return t({ message: 'Open', context: 'GitHub pull request or issue state' });
      case 'draft':
        return t({ message: 'Draft', context: 'GitHub pull request or issue state' });
      case 'merged':
        return t({ message: 'Merged', context: 'GitHub pull request or issue state' });
      case 'not-planned':
        return t({ message: 'Not planned', context: 'GitHub pull request or issue state' });
      default:
        return t({ message: 'Closed', context: 'GitHub pull request or issue state' });
    }
  };
}

function useStatusText(): (line: ReferenceStatusLine) => string {
  const { t } = useLingui();
  return (line) => {
    switch (line.kind) {
      case 'queued': {
        const position = line.position;
        return position === null ? t`In the merge queue` : t`#${position} in the merge queue`;
      }
      case 'queue-unmergeable':
        return t`In the merge queue, but it can't merge`;
      case 'conflicts':
        return t`Has merge conflicts`;
      case 'changes-requested':
        return t`Changes requested`;
      case 'checks-failing':
        return t`Required checks are failing`;
      case 'auto-merge':
        return t`Auto-merge is on`;
      case 'review-required':
        return t`Waiting for review`;
      case 'checks-running':
        return t`Checks are running`;
      case 'blocked':
        return t`Blocked from merging`;
      case 'unstable':
        return t`Some checks failed, but it can still merge`;
      case 'behind':
        return t`Behind the base branch`;
      case 'approved':
        return t`Approved and ready to merge`;
      case 'ready':
        return t`Ready to merge`;
      default:
        return line satisfies never;
    }
  };
}

export function GitHubReferenceCard({ preview }: { preview: GitHubReferencePreview }): ReactNode {
  const { t, i18n } = useLingui();
  const lifecycleLabel = useLifecycleLabel();
  const statusText = useStatusText();
  const Icon = lifecycleIcon(preview);
  const status = referenceStatusLine(preview);
  const date = openedOn(preview.createdAt, i18n.locale);
  const { additions, deletions, author } = preview;
  return (
    <div data-testid="github-reference-card" className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
        <span className="truncate">{preview.repo}</span>
        {date !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={preview.createdAt} className="shrink-0">
              {date}
            </time>
          </>
        ) : null}
      </div>
      <div className="line-clamp-3 font-medium text-sm leading-snug">
        {preview.title} <span className="font-normal text-muted-foreground">#{preview.number}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          data-testid="github-reference-state"
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-white text-xs',
            PILL_CLASS[preview.lifecycle],
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {lifecycleLabel(preview.lifecycle)}
        </span>
        {additions !== undefined && deletions !== undefined ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs tabular-nums"
            role="img"
            aria-label={t`Lines changed: ${additions} added, ${deletions} removed`}
          >
            <span className="text-green-700 dark:text-green-400">+{additions}</span>
            <span className="text-red-700 dark:text-red-400">−{deletions}</span>
            <span className="inline-flex gap-px" aria-hidden="true">
              {diffBlocks(additions, deletions).map((block, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the five blocks are positional
                  key={index}
                  className={cn('size-2 rounded-[2px]', BLOCK_CLASS[block])}
                />
              ))}
            </span>
          </span>
        ) : null}
      </div>
      {status !== null ? (
        <div
          data-testid="github-reference-status"
          className={cn('text-xs', TONE_CLASS[status.tone])}
        >
          {statusText(status)}
        </div>
      ) : null}
      {author !== null ? (
        <div className="text-muted-foreground text-xs">{t`Opened by ${author}`}</div>
      ) : null}
    </div>
  );
}

export function GitHubReferenceLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children?: ReactNode;
}): ReactNode {
  const [wanted, setWanted] = useState(false);
  const preview = useGitHubReference(wanted ? href : null);
  return (
    <HoverCard open={wanted} onOpenChange={setWanted} openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          data-streamdown="link"
          className={className}
        >
          {children}
        </a>
      </HoverCardTrigger>
      {preview !== null ? (
        <HoverCardContent side="bottom" align="start" className="w-80">
          <GitHubReferenceCard preview={preview} />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}
