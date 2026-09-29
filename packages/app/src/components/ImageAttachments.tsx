import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Paperclip, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type FC,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { isExternalFileDrag } from '@/components/file-tree-adapter';
import { collectImageFiles } from '@/lib/acp/image-attachment';
import {
  ACCEPTED_IMAGE_TYPES,
  formatFileSize,
  type ImageAttachmentProblem,
  imageAttachmentsProblem,
  MAX_IMAGE_ATTACHMENTS,
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
import { Textarea } from './ui/textarea';
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

interface ImageAttachmentPickerProps {
  files: readonly File[];
  onPick: (picked: FileList | null) => void;
  disabled?: boolean;
  className?: string;
}

const ImageAttachmentPicker: FC<ImageAttachmentPickerProps> = ({
  files,
  onPick,
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
          onPick(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
};

interface ImageAttachmentListProps {
  files: readonly File[];
  onChange: (files: File[]) => void;
  error?: ReactNode;
}

const ImageAttachmentList: FC<ImageAttachmentListProps> = ({ files, onChange, error = null }) => {
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
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </>
  );
};

function useImageAttachmentProblemMessage(): (
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

function ImageAttachmentAnnouncer({ count }: { count: number }) {
  return (
    <span role="status" className="sr-only">
      {count > 0 && <Plural value={count} one="# image attached" other="# images attached" />}
    </span>
  );
}

export interface ImageAttachmentIntake {
  files: readonly File[];
  setFiles: (files: File[]) => void;
  disabled: boolean;
  add: (picked: ArrayLike<File> | null) => void;
  clearProblem: () => void;
  problem: ImageAttachmentProblem | null;
  dragging: boolean;
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function useImageAttachmentIntake({
  files,
  onChange,
  disabled,
}: {
  files: readonly File[];
  onChange: (files: File[]) => void;
  disabled: boolean;
}): ImageAttachmentIntake {
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<{
    files: readonly File[];
    problem: ImageAttachmentProblem;
  } | null>(null);

  function add(picked: ArrayLike<File> | null) {
    if (disabled || picked === null || picked.length === 0) return;
    const unique = new Map(files.map((file) => [`${file.name}:${file.size}`, file]));
    for (const file of Array.from(picked)) unique.set(`${file.name}:${file.size}`, file);
    const next = [...unique.values()];
    const error = imageAttachmentsProblem(next);
    setRejection(error === null ? null : { files, problem: error });
    if (error === null) onChange(next);
  }

  return {
    files,
    setFiles: onChange,
    disabled,
    add,
    clearProblem: () => setRejection(null),
    problem: rejection?.files === files ? rejection.problem : null,
    dragging: dragging && !disabled,
    onPaste(event) {
      if (disabled) return;
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      const pasted = collectImageFiles(event.clipboardData);
      if (pasted.length === 0) return;
      event.preventDefault();
      add(pasted);
    },
    onDragOver(event) {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      if (!disabled) setDragging(true);
    },
    onDragLeave(event) {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        setDragging(false);
    },
    onDrop(event) {
      setDragging(false);
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      add(event.dataTransfer.files);
    },
  };
}

export interface ImageAttachmentTextareaProps
  extends Omit<
    ComponentProps<typeof Textarea>,
    'disabled' | 'onDragOver' | 'onDragLeave' | 'onDrop'
  > {
  intake: ImageAttachmentIntake;
  error?: string | null;
  hint?: ReactNode;
}

export function ImageAttachmentTextarea({
  intake,
  error = null,
  hint,
  className,
  'aria-describedby': describedBy,
  ...textareaProps
}: ImageAttachmentTextareaProps) {
  const hintId = useId();
  const problemMessage = useImageAttachmentProblemMessage();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: file drop target only; keyboard users paste or use the attach button. */}
      <div
        className="relative"
        onDragOver={intake.onDragOver}
        onDragLeave={intake.onDragLeave}
        onDrop={intake.onDrop}
      >
        <Textarea
          {...textareaProps}
          disabled={intake.disabled}
          aria-describedby={[describedBy, hintId].filter(Boolean).join(' ')}
          className={cn(
            'resize-none pb-9',
            className,
            intake.dragging && 'border-primary bg-primary/5',
          )}
        />
        <ImageAttachmentPicker
          files={intake.files}
          onPick={intake.add}
          disabled={intake.disabled}
          className="absolute bottom-1.5 start-1.5"
        />
        <ImageAttachmentAnnouncer count={intake.files.length} />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        <Trans>Drop, paste, or attach up to {MAX_ATTACHMENTS} images.</Trans>
        {hint !== undefined && <> {hint}</>}
      </p>
      <ImageAttachmentList
        files={intake.files}
        onChange={intake.setFiles}
        error={
          error ??
          (intake.problem === null ? null : (
            <>
              <Trans>No images added.</Trans> <span>{problemMessage(intake.problem)}</span>
            </>
          ))
        }
      />
    </div>
  );
}
