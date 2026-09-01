import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';

export function ExternalLinkPreviewCard({ metadata }: { metadata: LinkPreviewMetadata }) {
  const faviconSrc = metadata.faviconDataUri?.startsWith('data:image/')
    ? metadata.faviconDataUri
    : null;

  return (
    <div data-slot="external-link-preview-card" className="mt-2.5 border-t border-border/70 pt-2.5">
      <div className="flex items-center gap-1.5">
        {faviconSrc ? (
          <img
            data-slot="external-link-preview-favicon"
            src={faviconSrc}
            alt=""
            aria-hidden="true"
            width={16}
            height={16}
            className="size-4 shrink-0 rounded-sm"
          />
        ) : null}
        <span
          data-slot="external-link-preview-domain"
          className="truncate text-xs font-medium text-muted-foreground"
        >
          {metadata.domain}
        </span>
      </div>

      {metadata.title ? (
        <div
          data-slot="external-link-preview-title"
          className="mt-1 line-clamp-2 text-sm font-medium text-foreground"
        >
          {metadata.title}
        </div>
      ) : null}

      {metadata.description ? (
        <p
          data-slot="external-link-preview-description"
          className="mt-1 line-clamp-3 text-xs text-muted-foreground"
        >
          {metadata.description}
        </p>
      ) : null}
    </div>
  );
}
