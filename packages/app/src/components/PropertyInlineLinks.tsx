import type { ReactNode } from 'react';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';
import {
  hasInlineLinks,
  type PropertyInlineSegment,
  tokenizePropertyInlineLinks,
} from './property-inline-link-tokens';

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
  className?: string;
}

export function PropertyInlineLinks({ text, className }: PropertyInlineLinksProps): ReactNode {
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
  const key = index;
  switch (seg.type) {
    case 'text':
      return <span key={key}>{seg.value}</span>;

    case 'wikilink': {
      const label = seg.alias ?? (seg.anchor ? `${seg.target}#${seg.anchor}` : seg.target);
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
