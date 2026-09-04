// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches the existing PropertyWidgets.tsx posture — raw `<input>` is the typed-input affordance shared across every frontmatter widget; migrating to shadcn `<Input>` is the file-wide pre-rule backlog described in PropertyWidgets.tsx's top-of-file ignore comment.

import { ALLOWED_IMAGE_MIME_TYPES } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { ImagePlus, Smile, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FrimousseEmojiPicker } from '@/components/emoji-picker';
import type { CommonWidgetProps } from '@/components/PropertyWidgets';
import { resolvePageCover, resolvePageIcon } from '@/components/page-header-utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { UploadFailedError } from '@/editor/image-upload/upload-failure';
import { uploadFile } from '@/editor/image-upload/upload-file';
import { cn } from '@/lib/utils';

export function PageIconWidget({ keyName, value, onCommit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const resolved = resolvePageIcon(draft);

  return (
    <div className="flex w-full items-center gap-2">
      <input
        type="text"
        data-testid="page-icon-widget"
        data-key={keyName}
        value={draft}
        placeholder={t`📝 or assets/icon.png`}
        aria-label={t`${keyName} value`}
        className="flex-1 min-h-7 border-transparent bg-transparent px-2 py-1 text-sm leading-tight shadow-none outline-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-0 rounded-sm dark:bg-transparent dark:focus-visible:bg-muted"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          if (revertingRef.current) {
            revertingRef.current = false;
            return;
          }
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            if (draft !== value) onCommit(draft);
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            revertingRef.current = true;
            setDraft(value);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t`Open emoji picker for ${keyName}`}
            data-testid="page-icon-preview"
            data-kind={resolved.kind}
            className={cn(
              'flex h-7 w-7 flex-none items-center justify-center rounded-sm text-base transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              resolved.kind === 'unsupported' && 'text-muted-foreground/60',
            )}
          >
            <PageIconPreviewContent resolved={resolved} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end" aria-label={t`Emoji picker`}>
          <FrimousseEmojiPicker
            onSelect={(emoji) => {
              setDraft(emoji);
              onCommit(emoji);
              setPickerOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function PageCoverWidget({ keyName, value, onCommit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const resolved = resolvePageCover(draft);

  async function handleFile(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const result = await uploadFile(file, ALLOWED_IMAGE_MIME_TYPES);
      if (!mountedRef.current) return;
      setDraft(result.url);
      onCommit(result.url);
      setUploading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      const message =
        err instanceof UploadFailedError ? err.message : t`Upload failed — please try again`;
      setUploadError(message);
      setUploading(false);
    }
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  function clearCover() {
    setDraft('');
    onCommit('');
    setUploadError(null);
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex w-full items-center gap-2">
        {}
        <input
          type="text"
          data-testid="page-cover-widget"
          data-key={keyName}
          value={draft}
          placeholder={t`Paste image URL or click upload`}
          aria-label={t`${keyName} value`}
          className="flex-1 min-h-7 border-transparent bg-transparent px-2 py-1 text-sm leading-tight shadow-none outline-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-0 rounded-sm dark:bg-transparent dark:focus-visible:bg-muted"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            if (revertingRef.current) {
              revertingRef.current = false;
              return;
            }
            if (draft !== value) onCommit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (draft !== value) onCommit(draft);
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              revertingRef.current = true;
              setDraft(value);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={uploading ? t`Uploading ${keyName}` : t`Upload ${keyName}`}
          disabled={uploading}
          onClick={pickFile}
          data-testid="page-cover-upload"
        >
          {uploading ? (
            <Upload className="size-4 animate-pulse" />
          ) : (
            <ImagePlus className="size-4" />
          )}
        </Button>
        {}
        <button
          type="button"
          aria-label={t`Replace ${keyName}`}
          data-testid="page-cover-preview"
          data-kind={resolved.kind}
          onClick={pickFile}
          className={cn(
            'flex h-7 w-12 flex-none items-center justify-center overflow-hidden rounded-sm text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            resolved.kind === 'unsupported' && 'text-muted-foreground/60',
          )}
        >
          <PageCoverPreviewContent resolved={resolved} />
        </button>
        {resolved.kind !== 'unsupported' && draft !== '' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Clear ${keyName}`}
            onClick={clearCover}
            data-testid="page-cover-clear"
          >
            <X className="size-4" />
          </Button>
        ) : null}
        {}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.currentTarget.value = '';
            if (file) void handleFile(file);
          }}
        />
      </div>
      {uploadError ? (
        <div className="text-destructive text-xs" role="alert">
          {uploadError}
        </div>
      ) : null}
    </div>
  );
}

function PageIconPreviewContent({ resolved }: { resolved: ReturnType<typeof resolvePageIcon> }) {
  if (resolved.kind === 'emoji') {
    return <span>{resolved.value}</span>;
  }
  if (resolved.kind === 'url' || resolved.kind === 'path') {
    return (
      <img
        src={resolved.value}
        alt=""
        className="h-full w-full rounded-md object-cover"
        draggable={false}
        referrerPolicy="no-referrer"
      />
    );
  }
  return <Smile className="size-4" aria-hidden />;
}

function PageCoverPreviewContent({ resolved }: { resolved: ReturnType<typeof resolvePageCover> }) {
  if (resolved.kind === 'url' || resolved.kind === 'path') {
    return (
      <img
        src={resolved.value}
        alt=""
        className="h-full w-full object-cover"
        draggable={false}
        referrerPolicy="no-referrer"
      />
    );
  }
  return <ImagePlus className="size-4" aria-hidden />;
}
