'use client';

import { Check, Copy } from 'lucide-react';
import { isValidElement, type ReactNode, useState } from 'react';

type CopyPromptProps = {
  children: ReactNode;
};

function flattenText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (isValidElement(node)) {
    return flattenText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

export function CopyPrompt({ children }: CopyPromptProps) {
  const [copied, setCopied] = useState(false);
  const text = flattenText(children).trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy prompt to clipboard"
      data-copied={copied}
      className="ok-overview not-prose group my-2.5 flex w-full cursor-pointer items-start gap-3 rounded-lg border border-fd-border bg-fd-card px-4 py-3 text-start text-[0.9375rem] leading-relaxed text-fd-foreground shadow-sm transition hover:border-[var(--ok-accent)] hover:bg-fd-accent/40"
    >
      {/* Quotes + italics are presentational — they signal "this is a prompt".
          The copied payload is `text`, without them. */}
      <span className="flex-1 whitespace-pre-wrap italic">“{text}”</span>
      <span
        className="mt-px inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-medium text-fd-muted-foreground transition-colors group-hover:text-[var(--ok-accent)]"
        style={copied ? { color: 'var(--ok-accent)' } : undefined}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </span>
    </button>
  );
}
