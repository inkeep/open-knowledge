/**
 * Frontmatter widgets for the special `icon` + `cover` keys.
 *
 * Both store a plain string — no new `FrontmatterType` is needed (the
 * `keyName === 'icon' | 'cover'` precedent mirrors the `keyName ===
 * 'tags'` chip-rendering in `ListWidget`). Storage stays YAML-portable;
 * the widget just specializes the input UX with affordances tuned to
 * the value's expected shape.
 *
 * `PageIconWidget` — a text input (for direct emoji paste + image
 * path / URL) PLUS a click-to-pick preview chip on the right that
 * opens a `frimousse` emoji picker popover. Selecting an emoji
 * replaces the field value with the chosen glyph.
 *
 * `PageCoverWidget` — a file picker that uploads through the editor's
 * existing `/api/upload` pipeline (`uploadFile` from `image-upload/
 * upload-file.ts`). The returned content-dir path lands in the
 * frontmatter; a "paste URL" affordance still accepts an external
 * `https://` image URL for authors who don't want to upload.
 *
 * Classification + safety lives in `page-header-utils.ts` so the
 * widget previews, property-panel input validation, and the
 * `PageHeader` renderer share one source of truth.
 */

// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches the existing PropertyWidgets.tsx posture — raw `<input>` is the typed-input affordance shared across every frontmatter widget; migrating to shadcn `<Input>` is the file-wide pre-rule backlog described in PropertyWidgets.tsx's top-of-file ignore comment.

import { ALLOWED_IMAGE_MIME_TYPES } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { EmojiPicker, type EmojiPickerListComponents } from 'frimousse';
import { ImagePlus, Smile, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommonWidgetProps } from '@/components/PropertyWidgets';
import { resolvePageCover, resolvePageIcon } from '@/components/page-header-utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { uploadFile } from '@/editor/image-upload/upload-file';
import { cn } from '@/lib/utils';

/**
 * `icon` frontmatter input. Combines a free-form text input (for
 * pasting emoji or image paths / URLs) with a click-to-open emoji
 * picker on the preview chip. The picker writes the selected emoji
 * directly to the frontmatter — no intermediate "press OK" step.
 *
 * Shape mirrors `CommonWidgetProps<string>` (from `PropertyWidgets`)
 * so the `keyName`-conditional dispatch in `FrontmatterRow.Widget`
 * doesn't have to thread a separate prop type per specialized widget.
 */
export function PageIconWidget({ keyName, value, onCommit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  // Synchronously flag an in-flight Escape-revert so the blur handler
  // (which fires immediately after the keydown's `.blur()`) skips the
  // commit. `setDraft(value)` is async — without this flag, the blur
  // handler reads the stale draft from the keystroke closure and
  // commits it before React re-renders with the reverted value.
  // Mirrors `TextWidget`'s `revertingRef` pattern.
  const revertingRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Resync the local draft from the YAML when the input is not focused
  // — same pattern as TextWidget. Without this, a remote CRDT edit to
  // `icon` would be invisible to this widget until the user re-focused.
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
            // Ghost-style — transparent until hover. Matches the trash /
            // drag-handle / type-icon buttons in `FrontmatterRow`.
            className={cn(
              'flex h-7 w-7 flex-none items-center justify-center rounded-sm text-base transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              resolved.kind === 'unsupported' && 'text-muted-foreground/60',
            )}
          >
            <PageIconPreviewContent resolved={resolved} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
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

/**
 * `cover` frontmatter input. File-upload posture (not free-form path
 * typing): the primary affordance is a "Choose image…" button that
 * opens the native file picker; on selection, the file uploads
 * through the editor's existing `/api/upload` pipeline and the
 * returned path lands in the frontmatter. A secondary "paste URL"
 * input remains visible for authors who want to point at an external
 * `https://` image without uploading. A current-value preview chip on
 * the right doubles as a click-target for the file picker AND
 * surfaces an `X` button to clear the cover entirely.
 *
 * See `PageIconWidget` for the `CommonWidgetProps` shape rationale.
 */
export function PageCoverWidget({ keyName, value, onCommit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  // See `PageIconWidget` — synchronous flag so the blur handler can
  // skip commit when Escape just reverted the draft.
  const revertingRef = useRef(false);
  // Guards `handleFile`'s post-await state writes + `onCommit` push
  // against an unmounted component. `setUploading(false)` on an
  // unmounted host is benign in React 18+ but `onCommit` writes into
  // `bindFrontmatterDoc`, which may be disposed by the time the upload
  // returns — surface check, not the load-bearing dispose guard.
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
    // No `try/finally` — React Compiler's BuildHIR doesn't lower
    // TryStatement with a finalizer clause. Mirror the cleanup into
    // both branches; the no-finally split is the established workaround
    // until the compiler ships finally support.
    try {
      const result = await uploadFile(file, ALLOWED_IMAGE_MIME_TYPES);
      if (!mountedRef.current) return;
      setDraft(result.url);
      onCommit(result.url);
      setUploading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      // Map known error shapes to user-facing strings; raw `err.message`
      // can leak parser diagnostics ("Upload response is not JSON.") or
      // stack-trace fragments that confuse end users. `TypeError` from a
      // failed `fetch()` indicates a connectivity problem; everything
      // else collapses into a generic retry hint.
      const message =
        err instanceof TypeError
          ? t`Network error — check your connection and try again`
          : t`Upload failed — please try again`;
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
        {/* URL field — secondary affordance. Authors who want to point
            at an external `https://` image (already uploaded elsewhere,
            Unsplash, etc.) paste the URL here and the path-resolution
            in `page-header-utils.ts` treats it as kind: 'url'. */}
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
        {/* Preview chip — clickable: opens the file picker so authors
            who recognize the affordance from other image upload
            surfaces in OK (PropPanel's image picker, drag/drop) reach
            it instinctively. When the field has a value, also surface
            an `X` clear button next to it. */}
        <button
          type="button"
          aria-label={t`Replace ${keyName}`}
          data-testid="page-cover-preview"
          data-kind={resolved.kind}
          onClick={pickFile}
          // Ghost-style — transparent until hover.
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
        {/* Hidden file input — mounted permanently so `pickFile()` can
            synchronously trigger it from any button click. The same
            `change` handler runs whether the user clicked the upload
            button or the preview chip. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the input so picking the same file twice in a row
            // still fires `change` (browsers de-dupe identical values
            // by default).
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
        // External-host icons (`url` kind) leak Referer without this.
        // Match the `<PageHeader>` + wiki-link chip + `Embed` /
        // `CodeBlockView` / `Image` posture.
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

/**
 * Themed component overrides for `EmojiPicker.List` — extracted to a
 * module-level constant so React Compiler can hoist the object literal
 * once (the picker re-renders on every keystroke; an inline object
 * would create a new identity each pass and force the virtualised
 * list to remount its rows).
 */
const EMOJI_LIST_COMPONENTS: EmojiPickerListComponents = {
  CategoryHeader: ({ category, ...props }) => (
    <div
      {...props}
      className="bg-popover px-3 pt-3 pb-1.5 font-medium text-muted-foreground text-xs"
    >
      {category.label}
    </div>
  ),
  Row: ({ children, ...props }) => (
    <div {...props} className="scroll-my-1.5 px-1.5">
      {children}
    </div>
  ),
  Emoji: ({ emoji, ...props }) => (
    <button
      type="button"
      {...props}
      className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
    >
      {emoji.emoji}
    </button>
  ),
};

/**
 * Frimousse-backed emoji picker, themed to match OK's shadcn surface
 * (popover bg, accent on hover, ring on focus). Keeps the picker
 * compact (320px) and constrained vertically so it fits inside the
 * popover without scrolling the page. The `onSelect` callback fires
 * with the rendered emoji string (multi-codepoint sequences already
 * joined by `frimousse`).
 */
function FrimousseEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { t } = useLingui();
  return (
    <EmojiPicker.Root
      className="isolate flex h-[326px] w-[320px] flex-col bg-popover text-popover-foreground"
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
    >
      <EmojiPicker.Search
        className="z-10 mx-2 mt-2 rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={t`Search emoji`}
        autoFocus
      />
      <EmojiPicker.Viewport className="relative flex-1 outline-none">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          <Trans>Loading</Trans>
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          <Trans>No emoji found.</Trans>
        </EmojiPicker.Empty>
        <EmojiPicker.List className="select-none pb-1.5" components={EMOJI_LIST_COMPONENTS} />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
