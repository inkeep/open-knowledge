
import {
  type ClassifiedLinkTarget,
  classifyMarkdownHref,
  isExternalHref,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/core';
import { posToDOMRect } from '@tiptap/core';
import { CircleAlert, File, FolderOpen, Globe, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { InteractionPropPanel } from '../../components/InteractionPropPanel';
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import { usePageList } from '../../components/PageListContext';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { type CreatePageSeed, createPageFromSeedAndUpdate } from '../../lib/create-page';
import { normalizeDocNameInput } from '../../lib/doc-paths';
import { cn } from '../../lib/utils';
import {
  buildCurrentRelativeMarkdownHref,
  classifyCurrentMarkdownHref,
  handleChipLinkClick,
  toInternalHashHref,
} from '../internal-link-helpers';
import {
  type LinkPathSuggestion,
  LinkPathSuggestionInput,
  preventLinkPathSuggestionDialogDismiss,
} from '../link-path-suggestions';
import { isSafeNavigationUrl } from '../safe-navigation-url';
import { CopyButton } from './LinkPropPanelCopy';
import { consumePendingLinkEdit } from './link-edit-autoopen';
import { getCurrentMarkInfo } from './mark-interaction-bridge';
import { useHeadings } from './use-headings';
import { isResolvedWikiLinkTarget } from './wiki-link-helpers';

export type MarkdownLinkEditMode = 'doc' | 'anchor' | 'external';

export function getMarkdownLinkEditMode(
  value: string,
  fallback: MarkdownLinkEditMode,
): MarkdownLinkEditMode {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('#')) return 'anchor';
  if (isExternalHref(trimmed)) return 'external';
  return 'doc';
}

function getInitialMarkdownLinkEditMode(target: ClassifiedLinkTarget | null): MarkdownLinkEditMode {
  if (target?.kind === 'doc') return 'doc';
  if (target?.kind === 'anchor') return 'anchor';
  return 'external';
}

interface EditMarkdownLinkDialogProps {
  open: boolean;
  href: string;
  text: string;
  pages: Set<string>;
  folderPaths: Set<string>;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (href: string, text: string, labelChanged: boolean) => void;
}

function EditMarkdownLinkDialog({
  open,
  href,
  text,
  pages,
  folderPaths,
  loading,
  onOpenChange,
  onSave,
}: EditMarkdownLinkDialogProps) {
  const [editTarget, setEditTarget] = useState('');
  const [editAnchor, setEditAnchor] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editMode, setEditMode] = useState<MarkdownLinkEditMode>('doc');
  const targetId = useId();
  const anchorId = useId();
  const labelId = useId();
  const headingListId = useId();
  const { t } = useLingui();

  const prevOpenRef = useRef(false);
  const labelSnapshotRef = useRef('');

  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    if (prevOpenRef.current) return;
    prevOpenRef.current = true;
    labelSnapshotRef.current = text;
    setEditLabel(text);
    const classified = classifyCurrentMarkdownHref(href);
    setEditMode(getInitialMarkdownLinkEditMode(classified));
    if (classified?.kind === 'doc') {
      setEditTarget(classified.docName);
      setEditAnchor(classified.anchor ?? '');
      return;
    }
    if (classified?.kind === 'anchor') {
      setEditTarget(`#${classified.anchor}`);
      setEditAnchor('');
      return;
    }
    setEditTarget(classified?.kind === 'external' ? classified.url : href);
    setEditAnchor('');
  }, [open, href, text]);

  const docTarget = normalizeDocNameInput(editTarget);
  const docTargetMode = editMode === 'doc';
  const resolvedDocTarget = docTargetMode && isResolvedWikiLinkTarget(docTarget, pages);
  const headings = useHeadings(docTarget, resolvedDocTarget && open);
  const showHeadings = !!headings?.length;

  function handleSave() {
    const trimmedTarget = editTarget.trim();
    if (!trimmedTarget) return;
    const nextHref = docTargetMode
      ? buildCurrentRelativeMarkdownHref(docTarget, editAnchor.trim() || null)
      : trimmedTarget;
    const labelChanged = editLabel.trim() !== labelSnapshotRef.current.trim();
    onSave(nextHref, editLabel, labelChanged);
    onOpenChange(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }

  function handlePathSuggestionSelect(suggestion: LinkPathSuggestion) {
    setEditTarget(suggestion.path);
    setEditMode('doc');
    setEditAnchor('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        data-ok-layer-spawned=""
        onPointerDownOutside={preventLinkPathSuggestionDialogDismiss}
        onFocusOutside={preventLinkPathSuggestionDialogDismiss}
        onInteractOutside={preventLinkPathSuggestionDialogDismiss}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Edit markdown link</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Update the destination and optional section anchor.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 pb-1">
          <div>
            <label className="mb-1.5 inline-block text-sm font-medium" htmlFor={targetId}>
              {docTargetMode ? <Trans>Page</Trans> : <Trans>Link target</Trans>}
            </label>
            <LinkPathSuggestionInput
              id={targetId}
              value={editTarget}
              pages={pages}
              folderPaths={folderPaths}
              loading={loading}
              onValueChange={(nextValue) => {
                setEditTarget(nextValue);
                setEditMode((current) => getMarkdownLinkEditMode(nextValue, current));
              }}
              onSuggestionSelect={handlePathSuggestionSelect}
              placeholder={t`guides/install or https://example.com`}
              autoFocus
              onKeyDown={handleKeyDown}
            />
          </div>

          <div>
            <label className="mb-1.5 inline-block text-sm font-medium" htmlFor={labelId}>
              <Trans>
                Label <span className="font-normal text-muted-foreground">(visible link text)</span>
              </Trans>
            </label>
            <Input
              id={labelId}
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              placeholder={t`Display text`}
              onKeyDown={handleKeyDown}
            />
          </div>

          {docTargetMode ? (
            <div>
              <label className="mb-1.5 inline-block text-sm font-medium" htmlFor={anchorId}>
                <Trans>
                  Section{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional heading anchor)
                  </span>
                </Trans>
              </label>
              <Input
                id={anchorId}
                value={editAnchor}
                onChange={(e) => setEditAnchor(e.target.value)}
                placeholder={t`heading-slug`}
                onKeyDown={handleKeyDown}
              />
              {/*
                  Heading-list is plain click-to-toggle buttons — not a
                  WAI-ARIA listbox. Previously declared role="listbox" /
                  role="option" but lacked the matching keyboard model
                  (arrow nav, aria-activedescendant). axe-core flags the
                  role + missing keyboard model as a conflict; native
                  button semantics already match the actual interaction.
                */}
              {showHeadings ? (
                <div
                  id={headingListId}
                  className="mt-1.5 max-h-36 overflow-y-auto subtle-scrollbar rounded-md border border-border bg-muted/30"
                >
                  {headings.map((heading) => (
                    <button
                      key={`${heading.slug}-${heading.level}-${heading.text}`}
                      type="button"
                      aria-pressed={editAnchor === heading.slug}
                      className={cn(
                        'flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                        editAnchor === heading.slug && 'bg-accent text-accent-foreground',
                      )}
                      style={{ paddingLeft: `${(heading.level - 1) * 12 + 8}px` }}
                      onClick={() => setEditAnchor(editAnchor === heading.slug ? '' : heading.slug)}
                    >
                      <span className="w-7 shrink-0 font-mono text-[10px] text-muted-foreground">
                        H{heading.level}
                      </span>
                      <span className="truncate">{heading.text}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={!editTarget.trim()}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InternalLinkPropPanelProps {
  editor: Editor;
  nodeId: string;
  sourceDocName: string;
  onClose: () => void;
  onNavigate: (newTab: boolean) => boolean;
}

export function InternalLinkPropPanel({
  editor,
  nodeId,
  sourceDocName,
  onClose,
  onNavigate,
}: InternalLinkPropPanelProps) {
  const info = getCurrentMarkInfo(editor.state, nodeId);
  const href = (info?.attrs?.href as string | undefined) ?? '';

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (consumePendingLinkEdit(nodeId)) setEditDialogOpen(true);
  }, [nodeId]);

  const { addPage, folderPaths, pages, loading } = usePageList();
  const { t } = useLingui();

  if (!info) {
    return null;
  }

  const linkText = editor.state.doc.textBetween(info.from, info.to);
  const target = href ? classifyMarkdownHref(href, sourceDocName) : null;

  function handleSave(nextHref: string, nextText: string, labelChanged: boolean) {
    const live = getCurrentMarkInfo(editor.state, nodeId);
    if (!live) return;
    const trimmedText = nextText.trim();
    if (!labelChanged || !trimmedText) {
      editor
        .chain()
        .setTextSelection({ from: live.from, to: live.to })
        .extendMarkRange('link')
        .updateAttributes('link', { href: nextHref })
        .run();
      return;
    }
    const linkType = editor.schema.marks.link;
    if (!linkType) return;
    const linkMark = linkType.create({ href: nextHref });
    const textNode = editor.schema.text(trimmedText, [linkMark]);
    editor.view.dispatch(editor.state.tr.replaceWith(live.from, live.to, textNode));
  }

  function handleRemove() {
    const live = getCurrentMarkInfo(editor.state, nodeId);
    if (!live) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: live.from, to: live.to })
      .extendMarkRange('link')
      .unsetLink()
      .run();
    onClose();
  }

  function handleEmptyHrefDialogOpenChange(open: boolean) {
    if (open) {
      setEditDialogOpen(true);
      return;
    }

    const live = getCurrentMarkInfo(editor.state, nodeId);
    const liveHref = (live?.attrs?.href as string | undefined) ?? '';
    if (liveHref) {
      setEditDialogOpen(false);
      return;
    }

    if (live) {
      editor.chain().focus().deleteRange({ from: live.from, to: live.to }).run();
    }
    onClose();
  }

  const editDialog = (
    <EditMarkdownLinkDialog
      open={editDialogOpen}
      href={href}
      text={linkText}
      pages={pages}
      folderPaths={folderPaths}
      loading={loading}
      onOpenChange={href ? setEditDialogOpen : handleEmptyHrefDialogOpenChange}
      onSave={handleSave}
    />
  );

  if (!href) {
    return <>{editDialog}</>;
  }

  const displayHref =
    target?.kind === 'doc'
      ? `${target.docName}${target.anchor ? `#${target.anchor}` : ''}`
      : target?.kind === 'anchor'
        ? `#${target.anchor}`
        : target?.kind === 'external'
          ? target.url
          : href;

  function updateMissingLinkHref(docName: string) {
    const live = getCurrentMarkInfo(editor.state, nodeId);
    if (!live) return;
    editor
      .chain()
      .setTextSelection({ from: live.from, to: live.to })
      .extendMarkRange('link')
      .updateAttributes('link', {
        href: buildCurrentRelativeMarkdownHref(
          docName,
          target?.kind === 'doc' ? (target.anchor ?? null) : null,
        ),
      })
      .run();
  }

  let stateLabel: { icon: React.ReactNode; text: string; className: string };
  let isUnresolved = false;
  let isFolder = false;
  let missingCreateSeed: CreatePageSeed | null = null;

  if (loading) {
    stateLabel = {
      icon: <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />,
      text: t`Loading`,
      className: 'text-muted-foreground/80',
    };
  } else if (target?.kind === 'asset') {
    stateLabel = {
      icon: <File className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Asset reference`,
      className: 'text-muted-foreground',
    };
  } else if (target?.kind === 'external') {
    stateLabel = {
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`External link`,
      className: 'text-muted-foreground',
    };
  } else if (target?.kind === 'anchor') {
    stateLabel = {
      icon: <File className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Anchor in this page`,
      className: 'text-muted-foreground',
    };
  } else if (target?.kind === 'doc') {
    const intent = resolveLinkTargetIntent(target.docName, { pages, folderPaths });
    isFolder = intent.kind === 'navigate' && intent.displayState === 'folder';
    isUnresolved = intent.kind === 'create';
    missingCreateSeed =
      intent.kind === 'create'
        ? { initialDir: intent.initialDir, suggestedName: intent.suggestedName }
        : null;
    if (isFolder) {
      stateLabel = {
        icon: <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />,
        text: t`Folder`,
        className: 'text-muted-foreground',
      };
    } else if (isUnresolved) {
      stateLabel = {
        icon: <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />,
        text: t`Page not found`,
        className: 'text-red-700 dark:text-red-300',
      };
    } else {
      stateLabel = {
        icon: <File className="size-3.5 shrink-0" aria-hidden="true" />,
        text: t`Page link`,
        className: 'text-muted-foreground',
      };
    }
  } else {
    stateLabel = {
      icon: <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Unrecognized link`,
      className: 'text-muted-foreground/80',
    };
  }

  const isExternalLink = target?.kind === 'external';
  const linkHref =
    target?.kind === 'doc'
      ? toInternalHashHref({ docName: target.docName, anchor: target.anchor })
      : target?.kind === 'anchor'
        ? toInternalHashHref({ docName: sourceDocName, anchor: target.anchor })
        : target?.kind === 'external' && isSafeNavigationUrl(target.url)
          ? target.url
          : null;
  const navigable =
    !loading &&
    linkHref !== null &&
    (target?.kind === 'anchor' ||
      target?.kind === 'external' ||
      (target?.kind === 'doc' && !isUnresolved && !isFolder));

  const triggerReference = {
    getBoundingClientRect: () => {
      const live = getCurrentMarkInfo(editor.state, nodeId);
      if (!live) return new DOMRect();
      try {
        return posToDOMRect(editor.view, live.from, live.to);
      } catch {
        return new DOMRect();
      }
    },
    contextElement: editor.view.dom,
  };

  async function handleCreatePage() {
    if (!missingCreateSeed || isCreating) return;
    setIsCreating(true);
    try {
      await createPageFromSeedAndUpdate(missingCreateSeed, {
        addPage,
        onCreated(docName) {
          updateMissingLinkHref(docName);
          window.location.hash = `#/${docName}`;
          onClose();
        },
      });
      setIsCreating(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Failed to create page`);
      setIsCreating(false);
    }
  }

  const iconNode = (
    <span className={cn('flex shrink-0', stateLabel.className)}>{stateLabel.icon}</span>
  );
  const iconElement = isUnresolved ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0" data-slot="internal-link-prop-panel-icon-trigger">
          {iconNode}
        </span>
      </TooltipTrigger>
      <TooltipContent>{stateLabel.text}</TooltipContent>
    </Tooltip>
  ) : (
    iconNode
  );

  return (
    <>
      {editDialog}

      <InteractionPropPanel
        kind="internal-link"
        ariaLabel={`${stateLabel.text}: ${displayHref}`}
        onDeactivate={onClose}
        triggerReference={triggerReference}
        className="w-96"
      >
        <div className="flex items-center gap-2">
          {iconElement}
          <div className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                {navigable ? (
                  <a
                    href={linkHref ?? undefined}
                    {...(isExternalLink ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    onClick={(e) => handleChipLinkClick(e, onNavigate, onClose)}
                    data-slot="internal-link-prop-panel-text"
                    className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
                  >
                    {displayHref}
                  </a>
                ) : (
                  <span
                    data-slot="internal-link-prop-panel-text"
                    className={cn(
                      'block truncate text-sm font-medium',
                      isUnresolved ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {displayHref}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent className="max-w-80 break-all">{displayHref}</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {isUnresolved ? (
              <Button
                type="button"
                size="sm"
                variant="link"
                disabled={isCreating}
                onClick={() => void handleCreatePage()}
                data-slot="internal-link-prop-panel-create"
                className="flex items-center text-foreground"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {isCreating ? <Trans>Creating...</Trans> : <Trans>Create page</Trans>}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t`Edit`}
                  onClick={() => setEditDialogOpen(true)}
                  data-slot="internal-link-prop-panel-edit"
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Trans>Edit</Trans>
              </TooltipContent>
            </Tooltip>
            <CopyButton copyContent={href} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t`Remove`}
                  onClick={handleRemove}
                  data-slot="internal-link-prop-panel-remove"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Trans>Remove</Trans>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </InteractionPropPanel>
    </>
  );
}
