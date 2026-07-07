import { CreatePageSuccessSchema } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { usePageList } from '@/components/PageListContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  type FolderConfigHandle,
  type TemplateMenuEntry,
  useFolderConfig,
} from '@/hooks/use-folder-config';
import { emitDocumentsChanged } from '@/lib/documents-events';
import {
  isEditableShortcutTarget,
  matchesKeyboardShortcut,
  type ShortcutEventLike,
  type ShortcutPlatform,
} from '@/lib/keyboard-shortcuts';
import { parseServerResponse } from '@/lib/parse-server-response';
import { cn } from '@/lib/utils';
import { type DocExtension, detectExtension } from './extension-picker-utils';
import { sortTemplatesForPicker } from './template-picker-utils';

const BLANK_TEMPLATE_VALUE = '__blank__';

interface NewItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'file' | 'folder';
  initialDir: string;
  /**
   * Pre-fills the file name input. Only applies when `kind === 'file'`;
   * ignored when `kind === 'folder'` (folder always defaults to `index.md`).
   */
  suggestedName?: string;
  /**
   * Pre-selects a template in the picker by `name` (the filename without `.md`).
   * Only applies when `kind === 'file'`. If the template is not present in the
   * resolved cascade for `initialDir`, the picker falls back to "Blank note".
   */
  initialTemplate?: string;
  /**
   * When the dialog is opened *as* "new from template" (vs the blank "New
   * File" flow), default the picker to the first resolved template — folder-
   * local first, then inherited — instead of "Blank note". Ignored when
   * `initialTemplate` pins a specific template, or when no templates resolve
   * (falls back to "Blank note"). Only applies when `kind === 'file'`.
   */
  defaultToTemplate?: boolean;
  description?: ReactNode;
  onCreated?: (docName: string) => void;
  /**
   * Optional pre-fetched folder config snapshot. When the dialog is co-mounted
   * alongside other consumers of `useFolderConfig(initialDir)` (e.g. inside
   * `FolderOverview`, which already fetches the same path for its
   * `FolderPropertiesCard` + `TemplatesCard`), the parent can thread its
   * handle here to dedup the fetch. Omit to let the dialog self-fetch
   * (standalone callers like the file-tree shortcut).
   */
  folderConfig?: FolderConfigHandle;
}

/**
 * Stable discriminant for a path-validation failure. The renderer maps each
 * key to localized copy via `pathErrorDescriptor` — keeping `validatePath`
 * locale-agnostic (and trivially unit-testable) instead of returning prose.
 */
type PathValidationError = 'empty' | 'dotdot' | 'leading-slash' | 'backslash' | 'null-byte';

export function validatePath(value: string): PathValidationError | null {
  if (!value.trim()) return 'empty';
  if (value.includes('..')) return 'dotdot';
  if (value.startsWith('/')) return 'leading-slash';
  if (value.includes('\\')) return 'backslash';
  if (value.includes('\0')) return 'null-byte';
  return null;
}

/** Localized copy for each `validatePath` failure key. */
function pathErrorDescriptor(error: PathValidationError): MessageDescriptor {
  switch (error) {
    case 'empty':
      return msg`Name cannot be empty`;
    case 'dotdot':
      return msg`Path cannot contain ".."`;
    case 'leading-slash':
      return msg`Path cannot start with "/"`;
    case 'backslash':
      return msg`Path cannot contain backslashes`;
    case 'null-byte':
      return msg`Path cannot contain null bytes`;
  }
}

export function ensureMdExtension(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return name;
  return `${name}.md`;
}

/**
 * Compose the final path to POST to /api/create-page.
 *
 * Precedence for the final extension:
 *  1. If `fileName` already carries a supported extension (.md or .mdx),
 *     it wins — Finder-like "typed-in extension always authoritative."
 *  2. Otherwise, the optional `fileExtension` override applies.
 *  3. If neither is set, defaults to `.md` (the dialog never passes an
 *     override, so new files are `.md` unless the name carries `.mdx`).
 *
 * Returns the canonical path relative to the content directory (no leading slash).
 */
export function composeNewItemPath(args: {
  kind: 'file' | 'folder';
  initialDir: string;
  fileName: string;
  fileExtension?: DocExtension;
  folderName?: string;
}): string {
  const trimmed = args.fileName.trim();
  const sniffed = detectExtension(trimmed);
  // Typed-in extension wins over picker state. When neither is present,
  // `fileExtension` (or its default `.md`) applies.
  const file = sniffed ? trimmed : `${trimmed}${args.fileExtension ?? '.md'}`;
  if (args.kind === 'folder') {
    const folder = (args.folderName ?? '').trim();
    const base = args.initialDir ? `${args.initialDir}/${folder}` : folder;
    return `${base}/${file}`;
  }
  return args.initialDir ? `${args.initialDir}/${file}` : file;
}

export function isNewItemShortcut(e: ShortcutEventLike, platform?: ShortcutPlatform): boolean {
  if (isEditableShortcutTarget(e.target)) return false;
  return matchesKeyboardShortcut(e, 'new-item', platform);
}

function selectBasename(input: HTMLInputElement) {
  const value = input.value;
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex > 0) {
    input.setSelectionRange(0, dotIndex);
  } else {
    input.select();
  }
}

export function NewItemDialog({
  open,
  onOpenChange,
  kind,
  initialDir,
  suggestedName,
  initialTemplate,
  defaultToTemplate,
  description,
  onCreated,
  folderConfig: folderConfigOverride,
}: NewItemDialogProps) {
  const { t } = useLingui();
  const { addPage } = usePageList();
  // Skip the self-fetch when the parent supplied a pre-fetched handle —
  // `useFolderConfig(null)` returns idle without hitting `/api/folder-config`.
  // The unconditional call keeps the hooks order stable across renders;
  // the path-null gate is the dedup mechanism, not a conditional hook.
  const selfFetch = useFolderConfig(folderConfigOverride ? null : initialDir);
  const folderConfig = folderConfigOverride ?? selfFetch;
  const [fileName, setFileName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>(BLANK_TEMPLATE_VALUE);
  // Tracks whether the user has manually touched the "Start from" picker this
  // open-cycle, so the async `defaultToTemplate` effect (which fires once the
  // cascade resolves) doesn't stomp an explicit choice.
  const [templateUserPicked, setTemplateUserPicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorField, setErrorField] = useState<'folder' | 'file' | 'form' | null>(null);
  const errorId = useId();
  const folderInputId = useId();
  const fileInputId = useId();
  const templatePickerLabelId = useId();
  const templatePickerTriggerId = useId();
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setErrorField(null);
      setBusy(false);
      setFolderName('');
      // Provisional selection. `initialTemplate` pins a specific template;
      // otherwise start at Blank and let the async `defaultToTemplate` effect
      // promote to the first resolved template once the cascade loads.
      setSelectedTemplate(
        kind === 'file' && initialTemplate ? initialTemplate : BLANK_TEMPLATE_VALUE,
      );
      setTemplateUserPicked(false);
      // Reset transient popover state — the dialog is mounted persistently
      // (FileTree/CommandPalette/FolderOverview keep it in the tree), so a
      // close path that left the popover open would flash it open on the
      // next reopen before Radix re-anchors.
      setTemplatePickerOpen(false);
      // Extension is always `.md` unless the user types a supported extension
      // into the name (Finder-like, honored at compose time) — so the typed
      // name is kept verbatim here, no sniff/strip.
      setFileName(kind === 'file' ? (suggestedName ?? 'untitled') : 'index');
    }
  }, [open, kind, suggestedName, initialTemplate]);

  const templates: TemplateMenuEntry[] =
    folderConfig.state.status === 'ready'
      ? sortTemplatesForPicker(folderConfig.state.data.folder.templates_available ?? [])
      : [];
  // If the seeded `initialTemplate` doesn't exist in the resolved cascade
  // (renamed, deleted, or shadowed since the caller captured the name), fall
  // back to Blank so the user sees a coherent picker instead of a phantom
  // selection that would 400 at create time. The dep is `folderConfig.state`
  // (reference-stable between fetches), not the freshly-sorted `templates`
  // array (which would re-trigger the effect on every render).
  useEffect(() => {
    if (!open) return;
    if (selectedTemplate === BLANK_TEMPLATE_VALUE) return;
    if (folderConfig.state.status !== 'ready') return;
    const available = folderConfig.state.data.folder.templates_available ?? [];
    if (!available.some((t) => t.name === selectedTemplate)) {
      setSelectedTemplate(BLANK_TEMPLATE_VALUE);
    }
  }, [open, selectedTemplate, folderConfig.state]);
  // `defaultToTemplate` promotion: when the dialog is opened as "new from
  // template" (not via a pinned `initialTemplate`, not the blank New File
  // flow), default the picker to the first resolved template once the cascade
  // loads. `sortTemplatesForPicker` orders folder-local before inherited, so
  // `[0]` is the closest-scoped template. Skipped after a manual pick, and a
  // no-op when nothing resolves (stays Blank).
  useEffect(() => {
    if (!open || !defaultToTemplate || initialTemplate) return;
    if (templateUserPicked) return;
    if (folderConfig.state.status !== 'ready') return;
    const sorted = sortTemplatesForPicker(folderConfig.state.data.folder.templates_available ?? []);
    if (sorted.length > 0) setSelectedTemplate(sorted[0].name);
  }, [open, defaultToTemplate, initialTemplate, templateUserPicked, folderConfig.state]);
  const showTemplatePicker = kind === 'file';
  const templatesLoading =
    folderConfig.state.status === 'loading' || folderConfig.state.status === 'idle';
  const templatesError = folderConfig.state.status === 'error' ? folderConfig.state.message : null;

  function handleFileNameChange(next: string) {
    setFileName(next);
    setError(null);
  }

  function composePath(): string {
    // No `fileExtension` arg — `composeNewItemPath` defaults to `.md`, and a
    // supported extension typed into the name (e.g. `notes.mdx`) still wins
    // via its internal sniff (Finder-like, honored for power users).
    return composeNewItemPath({
      kind,
      initialDir,
      fileName,
      folderName,
    });
  }

  function getClientError(): { message: string; field: 'folder' | 'file' } | null {
    if (kind === 'folder') {
      const folderErr = validatePath(folderName.trim());
      if (folderErr) {
        const detail = t(pathErrorDescriptor(folderErr));
        return { message: t`Folder name: ${detail}`, field: 'folder' };
      }
    }
    const fileErr = validatePath(fileName.trim());
    if (fileErr) return { message: t(pathErrorDescriptor(fileErr)), field: 'file' };
    return null;
  }

  const isSubmitDisabled = busy || !fileName.trim() || (kind === 'folder' && !folderName.trim());

  async function handleCreate() {
    const clientError = getClientError();
    if (clientError) {
      setError(clientError.message);
      setErrorField(clientError.field);
      return;
    }

    setBusy(true);
    setError(null);
    setErrorField(null);
    const path = composePath();
    // Picker state: BLANK_TEMPLATE_VALUE → no template parameter (preserves
    // today's blank-doc behavior). Otherwise forward the template name.
    const templateParam =
      kind === 'file' && selectedTemplate !== BLANK_TEMPLATE_VALUE ? selectedTemplate : undefined;
    const requestBody: { path: string; template?: string } = { path };
    if (templateParam !== undefined) requestBody.template = templateParam;

    try {
      const res = await fetch('/api/create-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      // Mutation flow — use the canonical parseServerResponse helper
      // for consistency with sibling FileTree.tsx mutations (rename,
      // delete). Surfaces the typed RFC 9457 title on error and the
      // schema-parsed success body on success in one pass.
      const status = res.status;
      const parsed = await parseServerResponse(res, t`Server error (HTTP ${status})`);
      if (!parsed.ok) {
        setBusy(false);
        setError(parsed.title);
        setErrorField('form');
        return;
      }
      const success = CreatePageSuccessSchema.safeParse(parsed.body);
      setBusy(false);
      if (!success.success) {
        setError(kind === 'folder' ? t`Failed to create folder` : t`Failed to create file`);
        setErrorField('form');
        return;
      }
      const docName = success.data.docName;
      onOpenChange(false);
      window.location.hash = `#/${docName}`;
      addPage(docName);
      emitDocumentsChanged(['files', 'backlinks', 'graph']);
      onCreated?.(docName);
    } catch (err) {
      console.warn('[NewItemDialog] create failed:', err);
      setBusy(false);
      setError(t`Network error — please try again`);
      setErrorField('form');
    }
  }

  const dirDisplay = initialDir || t`(root)`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* data-ok-layer-spawned — consumed by InteractionLayer's outside-click
        dismiss logic. When this dialog is opened
        from a PropPanel (InternalLinkPropPanel's Create-Page affordance),
        clicking inside it should NOT dismiss the PropPanel. Tagging the
        shared NewItemDialog is safe because it's always modal — interacting
        with it is exclusive, so there's no PropPanel-dismiss scenario to
        preserve when the dialog is open from elsewhere. */}
      <DialogContent className="sm:max-w-md" data-ok-layer-spawned="">
        <DialogHeader>
          <DialogTitle>
            {kind === 'file' ? <Trans>New file</Trans> : <Trans>New folder</Trans>}
          </DialogTitle>
          <DialogDescription>
            {description ?? (
              <Trans>
                Create in <span className="font-medium text-foreground">{dirDisplay}</span>
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 pb-1">
          {showTemplatePicker && (
            <div className="flex flex-col gap-2">
              {/*
               * No `htmlFor` on the label — the trigger is a button with
               * role="combobox" + a self-referencing aria-labelledby
               * ("<label> <trigger>") that concatenates the static "Start
               * from" label with the button's own selected-value text. A
               * label/htmlFor pair on a button only forwards click → focus,
               * not click → open, so it'd surprise users carrying intuition
               * from native <select>.
               */}
              <span id={templatePickerLabelId} className="text-sm font-medium">
                <Trans>Start from</Trans>
              </span>
              {templatesError ? (
                <p role="alert" className="text-1sm text-destructive">
                  <Trans>
                    Could not load templates: {templatesError}. You can still create a blank note.
                  </Trans>
                </p>
              ) : null}
              <TemplatePickerCombobox
                triggerId={templatePickerTriggerId}
                labelledById={templatePickerLabelId}
                open={templatePickerOpen}
                onOpenChange={setTemplatePickerOpen}
                value={selectedTemplate}
                onValueChange={(next) => {
                  setSelectedTemplate(next);
                  setTemplateUserPicked(true);
                }}
                templates={templates}
                loading={templatesLoading}
              />
              {!templatesLoading && !templatesError && templates.length === 0 ? (
                // Discoverability signpost: cmdk's CommandEmpty only fires
                // on a search miss, not on a structurally-empty list. With
                // the sidebar shortcut also hidden when no templates
                // resolve, the user has no in-product hint about where
                // templates come from.
                <p className="text-1sm text-muted-foreground">
                  <Trans>
                    No templates yet. Add one in this folder's Templates section, or in Settings →
                    Templates.
                  </Trans>
                </p>
              ) : null}
            </div>
          )}
          {kind === 'folder' && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor={folderInputId}>
                <Trans>Folder name</Trans>
              </label>
              <Input
                ref={folderInputRef}
                id={folderInputId}
                value={folderName}
                onChange={(e) => {
                  setFolderName(e.target.value);
                  setError(null);
                }}
                placeholder="folder-name"
                autoFocus
                aria-describedby={
                  error && (errorField === 'folder' || errorField === 'form') ? errorId : undefined
                }
                aria-invalid={
                  error && (errorField === 'folder' || errorField === 'form') ? true : undefined
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const folderErr = validatePath(folderName.trim());
                    if (folderErr) {
                      const detail = t(pathErrorDescriptor(folderErr));
                      setError(t`Folder name: ${detail}`);
                      setErrorField('folder');
                      return;
                    }
                    fileInputRef.current?.focus();
                  }
                }}
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor={fileInputId}>
              {kind === 'folder' ? <Trans>First file name</Trans> : <Trans>File name</Trans>}
            </label>
            <Input
              ref={fileInputRef}
              id={fileInputId}
              value={fileName}
              onChange={(e) => handleFileNameChange(e.target.value)}
              placeholder="my-note"
              autoFocus={kind === 'file'}
              aria-describedby={
                error && (errorField === 'file' || errorField === 'form') ? errorId : undefined
              }
              aria-invalid={
                error && (errorField === 'file' || errorField === 'form') ? true : undefined
              }
              onFocus={(e) => selectBasename(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSubmitDisabled) void handleCreate();
              }}
            />
            {error && (
              <p id={errorId} role="alert" className="text-1sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono uppercase"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={handleCreate} disabled={isSubmitDisabled}>
            {busy ? <Trans>Creating</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TemplatePickerComboboxProps {
  triggerId: string;
  labelledById: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  templates: readonly TemplateMenuEntry[];
  loading: boolean;
}

function TemplatePickerCombobox({
  triggerId,
  labelledById,
  open,
  onOpenChange,
  value,
  onValueChange,
  templates,
  loading,
}: TemplatePickerComboboxProps) {
  const { t } = useLingui();
  const listboxId = useId();
  const selected = templates.find((tpl) => tpl.name === value);
  const isBlank = value === BLANK_TEMPLATE_VALUE;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          // aria-controls only carries a real referent when the popup is
          // mounted; the listbox is portaled-on-open by Radix, so the id
          // doesn't resolve while closed. Per WAI-ARIA APG combobox
          // pattern, gate aria-controls on `open`.
          aria-controls={open ? listboxId : undefined}
          aria-labelledby={`${labelledById} ${triggerId}`}
          disabled={loading}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {loading ? (
                <Trans>Loading templates</Trans>
              ) : isBlank ? (
                <Trans>Blank note</Trans>
              ) : (
                (selected?.title ?? selected?.name ?? value)
              )}
            </span>
            {!loading && !isBlank && selected ? <ScopeBadge entry={selected} /> : null}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        // Keep focus inside the Command's input rather than bouncing back to
        // the trigger button — Radix's default onOpenAutoFocus on
        // PopoverContent focuses the root, which then forwards to whichever
        // child has tabindex=0. cmdk's <CommandInput> doesn't auto-focus
        // unless we route focus to it explicitly.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
        }}
        // Popover-inside-Dialog: Radix Dialog wraps content in
        // react-remove-scroll, whose document-level wheel/touchmove
        // listeners preventDefault native scroll on portaled descendants
        // (the popover renders to document.body, outside the dialog's
        // DOM tree). stopPropagation here keeps the event from reaching
        // those listeners, so native scroll fires normally.
        // https://github.com/radix-ui/primitives/issues/1159
        onWheel={(e) => {
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
        }}
      >
        <Command>
          <CommandInput placeholder={t`Search templates`} />
          <CommandList id={listboxId} className="subtle-scrollbar">
            <CommandEmpty>
              <Trans>No templates found.</Trans>
            </CommandEmpty>
            {templates.map((tpl) => {
              const title = tpl.title ?? tpl.name;
              const subName = tpl.title && tpl.title !== tpl.name ? tpl.name : undefined;
              // cmdk filters on `value` + `keywords`. Bake the searchable
              // fields (title, name, description, scope, source folder)
              // into keywords so typing any matches. source_folder is
              // included because the inherited-scope badge surfaces it on
              // the row — users who see "marketing/posts" expect to be
              // able to type it. `value` stays unique-per-row so cmdk's
              // selection state doesn't collide on duplicate display titles.
              const itemKey = `${tpl.scope}:${tpl.source_folder}:${tpl.name}`;
              return (
                <CommandItem
                  key={itemKey}
                  value={itemKey}
                  keywords={[
                    title,
                    tpl.name,
                    tpl.description ?? '',
                    tpl.scope,
                    tpl.source_folder ?? '',
                  ]}
                  onSelect={() => {
                    onValueChange(tpl.name);
                    onOpenChange(false);
                  }}
                  className="items-start gap-3"
                >
                  <Check
                    className={cn(
                      'mt-1 size-4 shrink-0',
                      value === tpl.name ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{title}</span>
                      {subName ? (
                        <code className="font-mono text-2xs text-muted-foreground shrink-0">
                          {subName}
                        </code>
                      ) : null}
                      <ScopeBadge entry={tpl} className="ml-auto" />
                    </div>
                    {tpl.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {tpl.description}
                      </p>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
            {/* Blank note sits last: templates are the primary intent of the
              "Start from" picker, and the blank fallback is the least-specific
              choice. */}
            <CommandItem
              value="Blank note empty"
              onSelect={() => {
                onValueChange(BLANK_TEMPLATE_VALUE);
                onOpenChange(false);
              }}
              className="items-start gap-3"
            >
              <Check
                className={cn(
                  'mt-1 size-4 shrink-0',
                  value === BLANK_TEMPLATE_VALUE ? 'opacity-100' : 'opacity-0',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">
                  <Trans>Blank note</Trans>
                </span>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  <Trans>Empty starting content</Trans>
                </p>
              </div>
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ScopeBadge({ entry, className }: { entry: TemplateMenuEntry; className?: string }) {
  if (entry.scope === 'inherited') {
    return (
      <Badge variant="gray" className={cn('shrink-0 text-2xs', className)}>
        {entry.source_folder || <Trans>root</Trans>}
      </Badge>
    );
  }
  return null;
}
