import type { UninstallNoticeScreen as UninstallNoticeSpec } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useId } from 'react';
import { Button } from '@/components/ui/button';

interface UninstallNoticeScreenProps {
  notice: UninstallNoticeSpec;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UninstallNoticeScreen({ notice, onConfirm, onCancel }: UninstallNoticeScreenProps) {
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
      <header className="shrink-0 px-6 pt-5 pb-3.5">
        <h1 id={titleId} className="font-medium text-base leading-none">
          {notice.title}
        </h1>
      </header>

      <div id={bodyId} className="flex min-h-0 flex-1 flex-col px-6 pt-1 pb-4 text-sm">
        {notice.paragraphs.map((text) => (
          <p key={text} className="mb-2.5 leading-normal">
            {text}
          </p>
        ))}
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
