import type {
  UninstallNoticeChecklistItem,
  UninstallNoticeScreen as UninstallNoticeSpec,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check } from 'lucide-react';
import { useEffect, useId } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface UninstallNoticeScreenProps {
  notice: UninstallNoticeSpec;
  onConfirm: () => void;
  /** Only reachable on a two-button notice. */
  onCancel: () => void;
  /** Ask main to reveal the cleanup log. Non-terminal — the screen stays up. */
  onRevealLog: () => void;
}

function NoticeChecklist({ items }: { items: readonly UninstallNoticeChecklistItem[] }) {
  return (
    <ol className="mb-1.5">
      {items.map((item, index) => (
        <li key={item.label} className="relative pb-5 pl-[30px] last:pb-1">
          {index < items.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute top-[22px] bottom-0.5 left-[9px] w-0.5 bg-border"
            />
          )}
          {/* The check glyph is a shape channel rather than colour alone, and the
              visually-hidden word carries the same state to a screen reader. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-px left-0 inline-flex size-5 items-center justify-center rounded-full',
              item.done
                ? 'bg-primary/15 text-primary'
                : 'border-[1.5px] border-muted-foreground/50',
            )}
          >
            {item.done && <Check className="size-3" />}
          </span>
          <span className="sr-only">
            {item.done ? <Trans>Done.</Trans> : <Trans>To do.</Trans>}
          </span>
          <span className="block">
            <span className="font-medium">{item.label}</span>
            {item.detail !== undefined && (
              <span className="mt-0.5 block text-muted-foreground leading-snug">{item.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The confirm, completion and failure screens. They differ only in the content
 * main sends down, so they are one component rather than three.
 *
 * Two shapes, and the difference is load-bearing: a notice carrying
 * `cancelLabel` is a question whose safe answer is Cancel, so Cancel holds
 * focus and Escape maps to it. A single-button notice is an acknowledgement
 * with nothing else to choose, so Escape confirms. Main maps a window close the
 * same two ways.
 */
export function UninstallNoticeScreen({
  notice,
  onConfirm,
  onCancel,
  onRevealLog,
}: UninstallNoticeScreenProps) {
  const { t } = useLingui();
  const titleId = useId();
  const bodyId = useId();
  const hasCancel = notice.cancelLabel !== undefined;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (hasCancel) onCancel();
      else onConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [hasCancel, onCancel, onConfirm]);

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="flex h-dvh flex-col bg-background text-foreground"
    >
      <header className="shrink-0 space-y-4 px-6 pt-5 pb-3.5">
        <h1 id={titleId} className="font-medium text-base leading-none">
          {notice.title}
        </h1>
        {notice.subtitle !== undefined && (
          <p className="text-muted-foreground text-sm leading-snug">{notice.subtitle}</p>
        )}
      </header>

      <div id={bodyId} className="flex min-h-0 flex-1 flex-col px-6 pt-1 pb-4 text-sm">
        {notice.paragraphs.map((text) => (
          <p key={text} className="mb-2.5 leading-normal">
            {text}
          </p>
        ))}
        {notice.checklist !== undefined && <NoticeChecklist items={notice.checklist} />}
        {notice.log !== undefined && (
          <section
            aria-label={t`Cleanup log`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region per WCAG 2.1.1 — the log is the only in-product account of what cleanup failed to remove, so reading it must not require a pointer.
            tabIndex={0}
            className="subtle-scrollbar mt-0.5 mb-2.5 min-h-20 flex-1 overflow-auto rounded-lg border border-border border-dotted bg-muted/40 px-3 py-2.5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <pre className="select-text whitespace-pre-wrap font-mono text-xs leading-relaxed wrap-anywhere">
              {notice.log}
            </pre>
          </section>
        )}
        {notice.footnote !== undefined && (
          <p className="select-text text-muted-foreground text-xs wrap-anywhere">
            {notice.footnote}
          </p>
        )}
        {notice.logRevealLabel !== undefined && (
          <p className="mt-0.5">
            <Button
              type="button"
              variant="link-muted"
              size="xs"
              className="h-auto px-0 underline underline-offset-2"
              onClick={onRevealLog}
            >
              {notice.logRevealLabel}
            </Button>
          </p>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2.5 border-border border-t bg-muted/50 px-6 pt-3.5 pb-4">
        {notice.cancelLabel !== undefined && (
          <Button type="button" variant="outline-mono" autoFocus onClick={onCancel}>
            {notice.cancelLabel}
          </Button>
        )}
        <Button
          type="button"
          variant={notice.danger === true ? 'destructive' : 'default'}
          autoFocus={!hasCancel}
          onClick={onConfirm}
        >
          {notice.confirmLabel}
        </Button>
      </footer>
    </div>
  );
}
