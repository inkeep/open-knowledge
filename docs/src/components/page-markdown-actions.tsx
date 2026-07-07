'use client';

import { Check, ChevronDown, Copy, FileText } from 'lucide-react';
import { useState } from 'react';
import { ClaudeIcon } from '@/components/icons/claude';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface PageMarkdownActionsProps {
  /** Same-origin path to the raw Markdown, e.g. `/docs/get-started/overview.md`. */
  markdownPath: string;
  /** Absolute URL to the raw Markdown — handed to ChatGPT / Claude to fetch. */
  markdownUrl: string;
  /** Positioning classes from the call site (the control owns its own visual style). */
  className?: string;
}

/** Surfaces use Fumadocs `fd-*` tokens so the control matches the docs theme. */
const menuContentClass = 'border-fd-border bg-fd-popover text-fd-popover-foreground';
const menuItemClass = 'gap-2 focus:bg-fd-accent focus:text-fd-accent-foreground';

/**
 * Per-page "Copy Markdown" affordance for the docs site: a split control whose
 * main button copies the page's raw Markdown to the clipboard, with a dropdown
 * for viewing the `.md` source or handing the page to ChatGPT / Claude. Pairs
 * with the `…/<slug>.md` route so agents (and humans) can grab one clean page
 * instead of the rendered HTML shell.
 */
export function PageMarkdownActions({
  markdownPath,
  markdownUrl,
  className,
}: PageMarkdownActionsProps) {
  const [copied, setCopied] = useState(false);

  const copyMarkdown = async () => {
    try {
      const res = await fetch(markdownPath);
      if (!res.ok) return;
      await navigator.clipboard.writeText(await res.text());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard / fetch unavailable (insecure context, offline) — no-op.
    }
  };

  // Hand the page to an assistant by URL rather than pasting the body: the
  // assistant fetches the clean `.md`, keeping the deep link short.
  const prompt = `Read ${markdownUrl} so I can ask questions about it.`;
  const chatGptUrl = `https://chatgpt.com/?hints=search&q=${encodeURIComponent(prompt)}`;
  const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

  return (
    <div
      className={cn(
        'not-prose inline-flex w-fit items-stretch overflow-hidden rounded-md border border-fd-border text-fd-muted-foreground text-xs',
        className,
      )}
    >
      <button
        type="button"
        onClick={copyMarkdown}
        // Reflect the copied state in the accessible name, not just the visible
        // label, so screen readers announce the transition.
        aria-label={copied ? 'Copied' : 'Copy this page as Markdown'}
        data-copied={copied}
        className="inline-flex cursor-pointer items-center gap-1.5 px-2.5 py-1 font-medium transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-inset"
      >
        {copied ? (
          <Check className="size-3 text-fd-primary" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy page'}</span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More Markdown options"
          className="inline-flex cursor-pointer items-center border-fd-border border-l px-1 transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-inset"
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuContentClass}>
          <DropdownMenuItem asChild className={menuItemClass}>
            <a href={markdownPath} target="_blank" rel="noreferrer">
              <FileText className="size-4" aria-hidden="true" />
              View as Markdown
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={menuItemClass}>
            <a href={chatGptUrl} target="_blank" rel="noreferrer">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-4 items-center justify-center rounded-full',
                  'bg-fd-foreground font-bold text-[10px] text-fd-background',
                )}
              >
                AI
              </span>
              Open in ChatGPT
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={menuItemClass}>
            <a href={claudeUrl} target="_blank" rel="noreferrer">
              {/* Decorative — the "Open in Claude" label is the accessible name. */}
              <ClaudeIcon aria-hidden="true" className="size-4 text-[#d97757]" />
              Open in Claude
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
