'use client';

import { Check, Copy } from 'lucide-react';
import { isValidElement, type ReactNode, useState } from 'react';

type CopyPromptProps = {
  /**
   * The prompt. The whole block is clickable; the flattened text content is what
   * gets copied. Accepts ReactNode (not just string) because a prompt containing
   * a bare URL gets GFM-autolinked into an <a> by MDX, so children arrive as
   * nodes rather than a plain string.
   */
  children: ReactNode;
};

/** Flatten React children (strings, autolinked `<a>`, etc.) to plain text. */
function flattenText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (isValidElement(node)) {
    return flattenText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * Click-to-copy prompt block. The entire element is a button, so clicking the
 * text or the copy affordance copies the prompt to the clipboard and shows a
 * brief "Copied" confirmation. Surfaces use Fumadocs `fd-*` tokens (light/dark);
 * the accent comes from `--ok-accent`, which requires the `ok-overview` scope.
 */
export function CopyPrompt({ children }: CopyPromptProps) {
  const [copied, setCopied] = useState(false);
  const text = flattenText(children).trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context or permission denied) — no-op.
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
