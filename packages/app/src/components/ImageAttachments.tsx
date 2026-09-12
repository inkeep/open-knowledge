import { Trans, useLingui } from '@lingui/react/macro';
import { Paperclip, X } from 'lucide-react';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_IMAGE_TYPES,
  formatFileSize,
  type ImageAttachmentProblem,
  MAX_IMAGE_ATTACHMENTS,
  mergeImageAttachments,
} from '@/lib/image-attachments';

const MAX_ATTACHMENTS = MAX_IMAGE_ATTACHMENTS;

import { cn } from '@/lib/utils';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from './ui/attachment';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const ImageAttachmentPreview: FC<{ file: File }> = ({ file }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img src={url} alt="" className="size-full object-cover" /> : null;
};

export interface ImageAttachmentPickerProps {
  files: readonly File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
}

export const ImageAttachmentPicker: FC<ImageAttachmentPickerProps> = ({
  files,
  onChange,
  disabled = false,
  className,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atMax = files.length >= MAX_ATTACHMENTS;
  const blocked = disabled || atMax;
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('inline-flex', blocked && 'cursor-not-allowed', className)}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={blocked}
                onClick={() => fileInputRef.current?.click()}
                className="size-7 text-muted-foreground"
              >
                <Paperclip className="size-4" />
                <span className="sr-only">
                  <Trans>Attach images</Trans>
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {atMax ? (
              <Trans>Maximum {MAX_ATTACHMENTS} attachments</Trans>
            ) : (
              <Trans>Attach images</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={(e) => {
          onChange(mergeImageAttachments(files, e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
};

export interface ImageAttachmentListProps {
  files: readonly File[];
  onChange: (files: File[]) => void;
  error?: string | null;
}

export const ImageAttachmentList: FC<ImageAttachmentListProps> = ({
  files,
  onChange,
  error = null,
}) => {
  const { t } = useLingui();
  if (files.length === 0 && error === null) return null;
  return (
    <>
      {files.length > 0 && (
        <AttachmentGroup>
          {files.map((file, index) => (
            <Attachment key={`${file.name}:${file.size}`} size="xs">
              <AttachmentMedia variant="image">
                <ImageAttachmentPreview file={file} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{file.name}</AttachmentTitle>
                <AttachmentDescription>{formatFileSize(file.size)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  aria-label={t`Remove ${file.name}`}
                  onClick={() => onChange(files.filter((_, i) => i !== index))}
                >
                  <X className="size-3.5" />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
    </>
  );
};

export function useImageAttachmentProblemMessage(): (
  problem: ImageAttachmentProblem | null,
) => string | null {
  const { t } = useLingui();
  return (problem) => {
    if (problem === null) return null;
    if (problem === 'count') return t`You can attach up to ${MAX_ATTACHMENTS} images.`;
    if (problem === 'type') return t`Only PNG, JPEG, or WebP images are allowed.`;
    return t`Attachments must total under 3 MB.`;
  };
}
