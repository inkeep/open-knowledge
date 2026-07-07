/**
 * `PropertyInlineLinks` — render a YAML-frontmatter property value with
 * its embedded link syntax (`[[Page]]`, `[text](url)`, bare http(s) URLs)
 * surfaced as clickable elements rather than raw markdown source.
 *
 * Used inside the property panel's `ListWidget` non-tag chips and
 * `TextWidget` plain-text view so a value like
 * `[[some/page]] — description` renders as
 *   <chip target="some/page">some/page</chip> — description
 * instead of the raw `[[some/page]] — description` text.
 *
 * Click semantics:
 *   - Wikilink   → navigates the host window to `#/<target>` (hash route).
 *     Cmd/Ctrl/middle-click is not specially handled — wiki targets
 *     resolve to the same doc tab regardless of modifier, and a property-
 *     panel chip is not a primary navigation surface.
 *   - Markdown link / autolink → delegates to `dispatchExternalLinkClick`
 *     for `http(s)://` so Electron's openExternal routes through the OS
 *     default browser. Relative / `mailto:` etc. fall back to the
 *     anchor's default behavior.
 *
 * The component takes no commit-related props — it's read-only render,
 * paired with sibling editing affordances (textarea / pencil button) in
 * the parent widget.
 */

import type { ReactNode } from 'react';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';
import {
  hasInlineLinks,
  type PropertyInlineSegment,
  tokenizePropertyInlineLinks,
} from './property-inline-link-tokens';

/**
 * Hash route a wikilink target points to. Matches the `navigateToDoc`
 * helpers in `ActivityModeContent.tsx`, `CommandPalette.tsx`, etc. —
 * one source of truth would be nice.
 */
function hashFromTarget(target: string, anchor: string | null): string {
  const docHash = target
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const anchorSuffix = anchor ? `#${encodeURIComponent(anchor)}` : '';
  return `#/${docHash}${anchorSuffix}`;
}

interface PropertyInlineLinksProps {
  text: string;
  /** Optional className passed through to the outer `<span>`. */
  className?: string;
}

export function PropertyInlineLinks({ text, className }: PropertyInlineLinksProps): ReactNode {
  // Fast path: most property values are plain text. The widgets that wrap
  // this component already pre-check via `hasInlineLinks`, but render the
  // guard here too so the component is safe to drop in anywhere without
  // requiring callers to opt into the optimization.
  if (!hasInlineLinks(text)) {
    return <span className={className}>{text}</span>;
  }

  const segments = tokenizePropertyInlineLinks(text);
  return (
    <span className={className} data-testid="property-inline-links">
      {segments.map((seg, i) => renderSegment(seg, i))}
    </span>
  );
}

function renderSegment(seg: PropertyInlineSegment, index: number): ReactNode {
  // Segment identity doesn't outlive a render — the input text is the
  // thing that changes, and React's reconciler handles position-keyed
  // children correctly when the parent re-renders.
  const key = index;
  switch (seg.type) {
    case 'text':
      return <span key={key}>{seg.value}</span>;

    case 'wikilink': {
      const label = seg.alias ?? (seg.anchor ? `${seg.target}#${seg.anchor}` : seg.target);
      // `<a href="#/...">` lets the browser's native nav handle the
      // hash change — same surface every other in-app nav already
      // uses (CommandPalette, ActivityModeContent, PresenceBar). No
      // custom onClick needed; keyboard activation works for free.
      return (
        <a
          key={key}
          href={hashFromTarget(seg.target, seg.anchor)}
          data-testid="property-inline-wikilink"
          data-target={seg.target}
          title={seg.target}
          className={cn(
            'rounded-sm px-0.5 text-azure-blue underline decoration-azure-blue/40 underline-offset-2 hover:decoration-azure-blue dark:text-sky-blue dark:decoration-sky-blue/40 dark:hover:decoration-sky-blue',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {label}
        </a>
      );
    }

    case 'link':
      return (
        <a
          key={key}
          href={seg.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="property-inline-link"
          // Same dispatch pattern as `TextWidget`'s URL chip — routes
          // through Electron's `shell.openExternal` allowlist when the
          // desktop bridge is mounted; falls through to the anchor's
          // default `target="_blank"` on web.
          onClick={(e) => dispatchExternalLinkClick(e, seg.url)}
          onAuxClick={(e) => {
            if (e.button === 1) dispatchExternalLinkClick(e, seg.url);
          }}
          title={seg.url}
          className={cn(
            'text-azure-blue underline decoration-azure-blue/40 underline-offset-2 hover:decoration-azure-blue dark:text-sky-blue dark:decoration-sky-blue/40 dark:hover:decoration-sky-blue',
            'focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {seg.text}
        </a>
      );

    case 'autolink':
      return (
        <a
          key={key}
          href={seg.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="property-inline-autolink"
          onClick={(e) => dispatchExternalLinkClick(e, seg.url)}
          onAuxClick={(e) => {
            if (e.button === 1) dispatchExternalLinkClick(e, seg.url);
          }}
          title={seg.url}
          className={cn(
            'text-azure-blue underline decoration-azure-blue/40 underline-offset-2 hover:decoration-azure-blue dark:text-sky-blue dark:decoration-sky-blue/40 dark:hover:decoration-sky-blue',
            'focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {seg.url}
        </a>
      );
  }
}
