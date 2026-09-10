import { Trans, useLingui } from '@lingui/react/macro';
import { UploadIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { isExternalFileDrag } from '@/components/file-tree-adapter';
import { useImageAttachmentProblemMessage } from '@/components/ImageAttachments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ACCEPTED_IMAGE_TYPES,
  type ImageAttachmentProblem,
  imageAttachmentsProblem,
} from '@/lib/image-attachments';
import { cn } from '@/lib/utils';

interface ReportBugImageDropzoneProps {
  files: readonly File[];
  onChange: (files: File[]) => void;
  disabled: boolean;
}

export function ReportBugImageDropzone({ files, onChange, disabled }: ReportBugImageDropzoneProps) {
  const { t } = useLingui();
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<{
    files: readonly File[];
    problem: ImageAttachmentProblem;
  } | null>(null);
  const problem = rejection?.files === files ? rejection.problem : null;
  const problemMessage = useImageAttachmentProblemMessage();

  function addFiles(picked: FileList | null) {
    if (disabled || picked === null || picked.length === 0) return;
    const unique = new Map(files.map((file) => [`${file.name}:${file.size}`, file]));
    for (const file of Array.from(picked)) unique.set(`${file.name}:${file.size}`, file);
    const next = [...unique.values()];
    const error = imageAttachmentsProblem(next);
    setRejection(error === null ? null : { files, problem: error });
    if (error === null) onChange(next);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button
        variant="outline"
        className={cn(
          'h-auto min-h-40 w-full flex-col gap-1 whitespace-normal border-dashed bg-muted/30 px-4 py-5 text-center aria-disabled:opacity-50',
          dragging && !disabled && 'border-primary bg-primary/10',
        )}
        aria-label={t`Attach images`}
        aria-describedby={hintId}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) picker.current?.click();
        }}
        onDragOver={(event) => {
          if (!isExternalFileDrag(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <UploadIcon className="mb-1 size-5 text-muted-foreground" aria-hidden="true" />
        <span>
          <Trans>Drop images here</Trans>
        </span>
        <span className="text-1sm font-normal text-primary underline underline-offset-4">
          <Trans>Browse files</Trans>
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          <Trans>Up to 3 screenshots or photos</Trans>
        </span>
      </Button>
      <Input
        ref={picker}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        disabled={disabled}
        className="hidden"
        aria-label={t`Attach images`}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        <Trans>Images aren't redacted.</Trans>
      </p>
      <p role="status" className="text-xs text-destructive empty:hidden">
        {problem !== null && (
          <>
            <Trans>No images added.</Trans> <span>{problemMessage(problem)}</span>
          </>
        )}
      </p>
    </div>
  );
}
