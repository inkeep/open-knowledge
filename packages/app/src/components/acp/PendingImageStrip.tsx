import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { createContext, type ReactNode, use } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export type ImagePreview = { readonly src: string; readonly name: string };

export const ImagePreviewContext = createContext<((preview: ImagePreview) => void) | null>(null);

function extensionLabel(name: string, mimeType: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  const slash = mimeType.lastIndexOf('/');
  if (slash > 0 && slash < mimeType.length - 1) return mimeType.slice(slash + 1).toLowerCase();
  return 'file';
}

export function PendingImageStrip({
  testIdPrefix,
  images,
  uploads,
  onRemove,
}: {
  testIdPrefix: string;
  images: readonly AttachmentPart[];
  uploads: readonly { readonly id: string; readonly name: string; readonly mimeType: string }[];
  onRemove: (index: number) => void;
}): ReactNode {
  const { t } = useLingui();
  const openPreview = use(ImagePreviewContext);
  return (
    <div
      className="flex flex-wrap gap-2 px-3 pt-2 pb-1"
      aria-busy={uploads.length > 0}
      data-testid={`${testIdPrefix}-pending-images`}
    >
      {images.map((image, index) => {
        const key =
          image.kind === 'image' || image.kind === 'blob'
            ? `${index}:${image.name}:${image.data.slice(0, 24)}`
            : `${index}:${image.name}:${image.path}`;
        const src = image.kind === 'image' ? `data:${image.mimeType};base64,${image.data}` : null;
        const label =
          image.kind === 'file' || image.kind === 'folder'
            ? extensionLabel(image.name, '')
            : extensionLabel(image.name, image.mimeType);
        return (
          <div key={key} className="group relative inline-flex size-14" title={image.name}>
            {src !== null && openPreview !== null ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => openPreview({ src, name: image.name })}
                className="size-full items-center justify-center overflow-hidden rounded-md border border-input bg-muted p-0 hover:bg-muted"
                aria-label={image.name}
                data-testid={`${testIdPrefix}-pending-image-preview`}
              >
                <img
                  src={src}
                  alt={image.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              </Button>
            ) : (
              <div className="inline-flex size-full items-center justify-center overflow-hidden rounded-md border border-input bg-muted">
                {src !== null ? (
                  <img
                    src={src}
                    alt={image.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="text-muted-foreground text-xs uppercase">{label}</span>
                )}
              </div>
            )}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(index);
              }}
              aria-label={t`Remove ${image.name}`}
              className="absolute top-0.5 end-0.5 size-5 rounded-full border border-border bg-background/80 p-0 shadow-sm opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              data-testid={`${testIdPrefix}-pending-image-remove`}
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {uploads.map((upload) => {
        const fileName = upload.name;
        return (
          <div
            key={upload.id}
            role="img"
            aria-label={t`Uploading ${fileName}`}
            className="relative inline-flex size-14 items-center justify-center overflow-hidden rounded-md border border-input bg-muted"
            title={upload.name}
            data-testid={`${testIdPrefix}-pending-upload`}
          >
            <Spinner className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
}
