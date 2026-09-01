// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { MessageSquare, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DispatchPayload } from './comments-client';
import { revealPropertyValueRange } from './property-row-rect';
import { revealComment } from './reveal-comment';
import { revealQueue } from './reveal-queue';
import { getThreadById, useQueueSelection } from './store';
import type { CommentThread } from './types';

export function useSelectedCommentCount(): number {
  return useQueueSelection().length;
}

export interface CommentDocTally {
  docName: string;
  count: number;
}

export function useSelectedCommentDocs(): readonly CommentDocTally[] {
  const selected = useQueueSelection();
  const byDoc = new Map<string, number>();
  for (const id of selected) {
    const docName = getThreadById(id)?.docName;
    if (docName === undefined) continue;
    byDoc.set(docName, (byDoc.get(docName) ?? 0) + 1);
  }
  return [...byDoc].map(([docName, count]) => ({ docName, count }));
}

export function QueuedCommentsChip({
  count,
  docs = [],
  attached,
  onAttach,
  onDismiss,
}: {
  count: number;
  docs?: readonly CommentDocTally[];
  attached: boolean;
  onAttach: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  if (count === 0) return null;
  if (!attached) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={false}
        aria-label={t`Add your comments to this message`}
        onClick={onAttach}
        data-testid="composer-context-chip-comments"
        className={cn(
          'h-auto min-h-0 gap-1 rounded-md border border-dashed bg-transparent px-1.5 py-0.5',
          'text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <Plus className="size-3" />
        <Trans>Comments</Trans>
      </Button>
    );
  }
  return (
    <span
      data-testid="composer-context-chip-comments"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-1.5',
        'text-xs text-muted-foreground',
      )}
    >
      {}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t`Show these comments in the Comments panel`}
            onClick={() => revealQueue()}
            data-testid="composer-comments-open-panel"
            className="h-auto min-h-0 gap-1 px-0.5 py-0 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            <MessageSquare className="size-3" />
            {}
            {docs.length > 1 ? (
              <Trans>
                <Plural value={count} one="# comment" other="# comments" /> across{' '}
                <Plural value={docs.length} one="# file" other="# files" />
              </Trans>
            ) : (
              <Plural value={count} one="# comment" other="# comments" />
            )}
          </Button>
        </TooltipTrigger>
        {}
        <TooltipContent className="max-w-64">
          {docs.length > 1 ? (
            <ul className="flex flex-col gap-0.5">
              {docs.map((doc) => (
                <li key={doc.docName} className="flex items-baseline gap-1.5">
                  <span className="tabular-nums">{doc.count}</span>
                  <span className="truncate">{docBasename(doc.docName)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Trans>Show these comments in the Comments panel</Trans>
          )}
        </TooltipContent>
      </Tooltip>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t`Leave these comments out of this message`}
        onClick={onDismiss}
        className="size-4 p-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </Button>
    </span>
  );
}

export function docBasename(docName: string): string {
  const slash = docName.lastIndexOf('/');
  return slash >= 0 ? docName.slice(slash + 1) : docName;
}

export function propertyAddress(key: string, path: readonly (string | number)[]): string {
  let out = key;
  for (const step of path) out += typeof step === 'number' ? `[${step}]` : `.${step}`;
  return out;
}

export function revealThread(thread: CommentThread): void {
  revealComment({
    docName: thread.docName,
    quote: thread.target.kind === 'property' ? '' : (thread.anchor?.quote ?? ''),
    threadId: thread.id,
    context: thread.anchor ?? undefined,
  });
  const { target, anchor } = thread;
  if (target.kind !== 'property' || anchor === null) return;
  let attempts = 0;
  const attempt = (): void => {
    const done = revealPropertyValueRange({
      key: target.key,
      path: target.path,
      quote: anchor.quote,
      start: anchor.start,
      end: anchor.end,
    });
    if (done) return;
    attempts += 1;
    if (attempts >= REVEAL_FRAME_BUDGET) return;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

const REVEAL_FRAME_BUDGET = 30;

export interface CommentBatchItem {
  docName: string;
  body: string;
  propertyKey: string | null;
  quote: string;
  anchorLost: boolean;
  prefix: string;
  suffix: string;
  repeats: boolean;
}

export function toCommentBatchItem(payload: DispatchPayload): CommentBatchItem {
  return {
    docName: payload.docName,
    body: payload.instruction,
    propertyKey: payload.property,
    quote: payload.passage?.exact ?? '',
    anchorLost: payload.anchorLost,
    prefix: payload.passage?.prefix ?? '',
    suffix: payload.passage?.suffix ?? '',
    repeats: payload.passageRepeats,
  };
}

const CONTEXT_CHARS = 48;

function trimTail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trimStart();
  return flat.length > CONTEXT_CHARS ? `…${flat.slice(-CONTEXT_CHARS)}` : flat;
}

function trimHead(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trimEnd();
  return flat.length > CONTEXT_CHARS ? `${flat.slice(0, CONTEXT_CHARS)}…` : flat;
}

function locatingNote(item: CommentBatchItem): string | null {
  if (!item.repeats) return null;
  const before = trimTail(item.prefix);
  const after = trimHead(item.suffix);
  if (before === '' && after === '') return null;
  const where =
    before === ''
      ? `at the start of the file, followed by "${after}"`
      : after === ''
        ? `at the end of the file, preceded by "${before}"`
        : `between "${before}" and "${after}"`;
  return `(This text appears more than once in the file. The one meant is ${where} — match that context rather than the first occurrence.)`;
}

export interface ExtraPassage {
  docName: string;
  markdown: string;
}

export function composeCommentBatchInstruction(
  items: readonly CommentBatchItem[],
  sharedInstruction: string,
  passage?: ExtraPassage,
): string {
  const shared = sharedInstruction.trim();
  const lines: string[] = [];
  lines.push(
    shared.length > 0
      ? shared
      : 'Address the following review comments by editing the documents directly.',
  );
  lines.push('');
  lines.push(items.length === 1 ? 'The comment:' : `The ${items.length} comments:`);
  items.forEach((item, i) => {
    lines.push('');
    if (item.propertyKey) {
      const quoted = item.quote.trim();
      if (quoted === '') {
        lines.push(
          `${i + 1}. In \`${item.docName}\`, on the \`${item.propertyKey}\` property (frontmatter):`,
        );
        lines.push('');
        lines.push(`   ${item.body.trim()}`);
      } else {
        lines.push(
          `${i + 1}. In \`${item.docName}\`, on this text within the \`${item.propertyKey}\` property (frontmatter):`,
        );
        lines.push('');
        for (const line of quoted.split('\n')) lines.push(`   > ${line}`);
        lines.push('');
        lines.push(`   ${item.body.trim()}`);
      }
      if (item.anchorLost) {
        lines.push('');
        lines.push(
          quoted === ''
            ? `   (Note: \`${item.propertyKey}\` is no longer in this document's frontmatter — it was renamed or removed since the comment was written. Do not apply this to a different property; if you cannot tell what it now refers to, say so instead of guessing.)`
            : `   (Note: that text is no longer in \`${item.propertyKey}\` — the value was edited, reshaped, or removed since the comment was written. Do not apply this to a different property or a different part of the value; if you cannot tell what it now refers to, say so instead of guessing.)`,
        );
      }
      return;
    }
    lines.push(`${i + 1}. In \`${item.docName}\`, on this passage:`);
    lines.push('');
    for (const line of item.quote.split('\n')) lines.push(`   > ${line}`);
    lines.push('');
    lines.push(`   ${item.body.trim()}`);
    const locator = locatingNote(item);
    if (locator !== null) {
      lines.push('');
      lines.push(`   ${locator}`);
    }
    if (item.anchorLost) {
      lines.push('');
      lines.push(
        '   (Note: this passage is no longer in the document — it was edited or removed since the comment was written. Do not apply this to a different passage; if you cannot tell what it now refers to, say so instead of guessing.)',
      );
    }
  });
  if (passage && passage.markdown.trim().length > 0) {
    lines.push('');
    lines.push(`Also in scope, selected in \`${passage.docName}\` (not a comment):`);
    lines.push('');
    for (const line of passage.markdown.trim().split('\n')) lines.push(`> ${line}`);
  }
  return lines.join('\n');
}
