'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { clipboardCopyOutcome } from '@/lib/share-splash';
import { cn } from '@/lib/utils';

interface SplashCliBlockProps {
  installCommand: string;
  cloneCommand?: string;
  showHeading?: boolean;
}

const COPY_RESET_MS = 2000;
const FAILED_RESET_MS = 5000;

type CopyStatus = 'idle' | 'copied' | 'failed';

export function SplashCliBlock({ installCommand, cloneCommand, showHeading }: SplashCliBlockProps) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [failureSelected, setFailureSelected] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  function scheduleStatusReset(ms: number) {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setStatus('idle');
      resetTimerRef.current = null;
    }, ms);
  }

  const payload = cloneCommand ? `${installCommand}\n${cloneCommand}` : installCommand;

  const handleCopy = async () => {
    let succeeded = true;
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      succeeded = false;
    }
    const outcome = clipboardCopyOutcome(succeeded);
    if (outcome.kind === 'copied') {
      setStatus('copied');
      scheduleStatusReset(COPY_RESET_MS);
      return;
    }
    let selected = false;
    if (codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      selected = true;
    }
    setFailureSelected(selected);
    setStatus('failed');
    scheduleStatusReset(FAILED_RESET_MS);
  };

  const statusLabel =
    status === 'copied'
      ? 'Copied'
      : status === 'failed'
        ? failureSelected
          ? "Couldn't copy — text is selected"
          : "Couldn't copy"
        : 'Copy';

  return (
    <div>
      {}
      {showHeading ? (
        <p className="mb-2 inline-flex w-fit items-center gap-1.5 font-mono text-sm uppercase tracking-wide text-slide-muted">
          {cloneCommand ? 'Open with CLI' : 'Install the CLI'}
        </p>
      ) : null}
      {}
      <div className="not-prose relative" data-testid="splash-cli-body">
        <div className="rounded-lg border bg-slide-bg dark:bg-white/5">
          <pre
            ref={codeRef}
            translate="no"
            className="whitespace-pre-wrap break-words py-3 pr-12 pl-4 font-mono text-sm leading-relaxed text-slide-text"
          >
            <code className="block">{installCommand}</code>
            {cloneCommand ? <code className="block">{cloneCommand}</code> : null}
          </pre>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          data-testid="splash-cli-copy"
          aria-label={
            cloneCommand
              ? 'Copy install and clone commands to clipboard'
              : 'Copy install command to clipboard'
          }
          title={statusLabel}
          data-copy-status={status}
          className={cn(
            'absolute top-2.5 right-2.5 inline-flex size-7 items-center justify-center rounded-md text-slide-muted transition backdrop-blur-xl',
            'hover:bg-black/5 hover:text-slide-text dark:hover:bg-white/10',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slide-accent',
            status === 'copied' && 'text-primary',
          )}
        >
          {status === 'copied' ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {}
          <span className="sr-only" aria-live="polite">
            {statusLabel}
          </span>
        </button>
      </div>
    </div>
  );
}
