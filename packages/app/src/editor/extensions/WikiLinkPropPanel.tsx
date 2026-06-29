import {
  classifyWikiLinkTarget,
  getWikiLinkText,
  normalizeNullableString,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/core';
import { posToDOMRect } from '@tiptap/core';
import {
  CircleAlert,
  File,
  FileImage,
  FolderOpen,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
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
import { hashFromAssetPath } from '../../lib/doc-hash';
import { cn } from '../../lib/utils';
import { handleChipLinkClick, toInternalHashHref } from '../internal-link-helpers';
import {
  type LinkPathSuggestion,
  LinkPathSuggestionInput,
  preventLinkPathSuggestionDialogDismiss,
} from '../link-path-suggestions';
import { isSafeNavigationUrl } from '../safe-navigation-url';
import { CopyButton } from './LinkPropPanelCopy';
import { useHeadings } from './use-headings';
import {
  getWikiLinkResolutionCandidates,
  isResolvedWikiLinkTarget,
  resolveWikiLinkAssetTarget,
} from './wiki-link-helpers';

interface EditWikiLinkDialogProps {
  open: boolean;
  target: string;
  alias: string | null;
  anchor: string | null;
  pages: Set<string>;
  assetPaths: Set<string>;
  filePaths: Set<string>;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (target: string, alias: string | null, anchor: string | null) => void;
}

function EditWikiLinkDialog({
  open,
  target,
  alias,
  anchor,
  pages,
  assetPaths,
  filePaths,
  loading,
  onOpenChange,
  onSave,
}: EditWikiLinkDialogProps) {
  const [editTarget, setEditTarget] = useState(target);
  const [editAlias, setEditAlias] = useState(alias ?? '');
  const [editAnchor, setEditAnchor] = useState(anchor ?? '');
  const targetId = useId();
  const anchorId = useId();
  const aliasId = useId();
  const headingListId = useId();
  const { t } = useLingui();

  const editAssetPath = resolveWikiLinkAssetTarget(editTarget, assetPaths, filePaths);
  const isEditTargetResolved = isResolvedWikiLinkTarget(editTarget, pages, assetPaths, filePaths);
  const headings = useHeadings(editTarget, isEditTargetResolved && !editAssetPath && open);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    if (prevOpenRef.current) return;
    prevOpenRef.current = true;
    setEditTarget(target);
    setEditAlias(alias ?? '');
    setEditAnchor(anchor ?? '');
  }, [open, target, alias, anchor]);

  function handleSave() {
    const trimmed = editTarget.trim();
    if (!trimmed) return;
    onSave(trimmed, editAlias.trim() || null, editAnchor.trim() || null);
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
    setEditAnchor('');
  }

  const counts = new Map<string, number>();
  const headingsWithKeys = headings?.map((h) => {
    const count = counts.get(h.slug) ?? 0;
    counts.set(h.slug, count + 1);
    const reactKey = count === 0 ? h.slug : `${h.slug}-${count}`;
    return { ...h, reactKey };
  });
  const showHeadings = !!headingsWithKeys?.length;

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
            <Trans>Edit wiki link</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Modify the link target, anchor, and display label.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-6">
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor={targetId}>
                <Trans>
                  Page <span className="text-red-500">*</span>
                </Trans>
              </label>
              <LinkPathSuggestionInput
                id={targetId}
                value={editTarget}
                pages={pages}
                assetPaths={assetPaths}
                includeAssets
                loading={loading}
                onValueChange={setEditTarget}
                onSuggestionSelect={handlePathSuggestionSelect}
                placeholder={t`page-name`}
                autoFocus
                aria-required="true"
                onKeyDown={handleKeyDown}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor={aliasId}>
                <Trans>
                  Label{' '}
                  <span className="font-normal text-muted-foreground">(optional display text)</span>
                </Trans>
              </label>
              <Input
                id={aliasId}
                value={editAlias}
                onChange={(e) => setEditAlias(e.target.value)}
                placeholder={t`Custom display text`}
                onKeyDown={handleKeyDown}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor={anchorId}>
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
                WAI-ARIA listbox. Native button semantics already match
                the actual click-to-select interaction; the listbox role
                without arrow-key navigation + aria-activedescendant is
                an axe-core conflict.
              */}
              {showHeadings && (
                <div
                  id={headingListId}
                  className="mt-1.5 max-h-36 overflow-y-auto subtle-scrollbar rounded-md border border-border bg-muted/30"
                >
                  {headingsWithKeys.map((h) => (
                    <button
                      key={h.reactKey}
                      type="button"
                      aria-pressed={editAnchor === h.slug}
                      className={cn(
                        'flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                        editAnchor === h.slug && 'bg-accent text-accent-foreground',
                      )}
                      style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                      onClick={() => setEditAnchor(editAnchor === h.slug ? '' : h.slug)}
                    >
                      <span className="w-7 shrink-0 font-mono text-[10px] text-muted-foreground">
                        H{h.level}
                      </span>
                      <span className="truncate">{h.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
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

interface WikiLinkPropPanelProps {
  editor: Editor;
  getPos: () => number | undefined;
  onClose: () => void;
  onNavigate: (newTab: boolean) => boolean;
}

export function WikiLinkPropPanel({ editor, getPos, onClose, onNavigate }: WikiLinkPropPanelProps) {
  const pos = getPos();
  const node = pos != null ? editor.state.doc.nodeAt(pos) : null;
  const target = String(node?.attrs.target ?? '');
  const alias = normalizeNullableString(node?.attrs.alias);
  const anchor = normalizeNullableString(node?.attrs.anchor);
  const label = getWikiLinkText({ target, alias, anchor });

  const {
    addPage,
    assetPaths,
    filePaths,
    folderPaths,
    pages,
    pagesBySlug,
    pagesByBasename,
    loading,
  } = usePageList();
  const classifiedTarget = classifyWikiLinkTarget(target, anchor);
  const externalTarget = classifiedTarget?.kind === 'external' ? classifiedTarget : null;
  const assetPath =
    classifiedTarget?.kind === 'asset'
      ? (resolveWikiLinkAssetTarget(classifiedTarget.url, assetPaths, filePaths) ??
        classifiedTarget.url.replace(/^\//, ''))
      : null;
  const linkIntent = assetPath
    ? null
    : resolveLinkTargetIntent(target, {
        pages,
        folderPaths,
        pagesBySlug,
        pagesByBasename,
        fallbackTargets: getWikiLinkResolutionCandidates(target),
      });

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const { t } = useLingui();

  if (!node) {
    return null;
  }

  function handleSaveEdit(newTarget: string, newAlias: string | null, newAnchor: string | null) {
    const livePos = getPos();
    if (livePos == null) return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(livePos, undefined, {
        ...editor.state.doc.nodeAt(livePos)?.attrs,
        target: newTarget,
        alias: newAlias,
        anchor: newAnchor,
      }),
    );
  }

  function handleRemove() {
    const livePos = getPos();
    if (livePos == null) return;
    const nodeAtPos = editor.state.doc.nodeAt(livePos);
    if (!nodeAtPos) return;
    editor.view.dispatch(editor.state.tr.delete(livePos, livePos + nodeAtPos.nodeSize));
    onClose();
  }

  function updateMissingLinkTarget(docName: string) {
    if (docName !== target) {
      const livePos = getPos();
      if (livePos == null) return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(livePos, undefined, {
          ...editor.state.doc.nodeAt(livePos)?.attrs,
          target: docName,
          alias: alias ?? label,
        }),
      );
    }
  }

  function missingCreateSeed(): CreatePageSeed | null {
    if (linkIntent?.kind !== 'create') return null;
    return {
      initialDir: linkIntent.initialDir,
      suggestedName: linkIntent.suggestedName,
    };
  }

  async function handleCreatePage() {
    const seed = missingCreateSeed();
    if (!seed || isCreating) return;
    setIsCreating(true);
    try {
      await createPageFromSeedAndUpdate(seed, {
        addPage,
        onCreated(docName) {
          updateMissingLinkTarget(docName);
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

  const isAsset = !externalTarget && !loading && assetPath !== null;
  const isResolved =
    !externalTarget &&
    !loading &&
    linkIntent?.kind === 'navigate' &&
    linkIntent.displayState === 'resolved';
  const isFolder =
    !externalTarget &&
    !loading &&
    linkIntent?.kind === 'navigate' &&
    linkIntent.displayState === 'folder';
  const isUnresolved = !externalTarget && !loading && !assetPath && linkIntent?.kind === 'create';

  const isExternalLink = !!externalTarget;
  const linkHref = externalTarget
    ? isSafeNavigationUrl(externalTarget.url)
      ? externalTarget.url
      : null
    : isAsset && assetPath
      ? hashFromAssetPath(assetPath)
      : isResolved && linkIntent?.kind === 'navigate'
        ? toInternalHashHref({ docName: linkIntent.hashDocName, anchor })
        : null;
  const navigable = !loading && linkHref !== null && (isExternalLink || isAsset || isResolved);

  let stateLabel: { icon: React.ReactNode; text: string; className: string };
  if (loading) {
    stateLabel = {
      icon: <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />,
      text: t`Loading`,
      className: 'text-muted-foreground/80',
    };
  } else if (externalTarget) {
    stateLabel = {
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`External wiki link`,
      className: 'text-muted-foreground',
    };
  } else if (isAsset) {
    stateLabel = {
      icon: <FileImage className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Asset`,
      className: 'text-muted-foreground',
    };
  } else if (isFolder) {
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
  } else if (isResolved) {
    stateLabel = {
      icon: <File className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Wiki link`,
      className: 'text-muted-foreground',
    };
  } else {
    stateLabel = {
      icon: <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />,
      text: t`Unrecognized wiki link`,
      className: 'text-muted-foreground/80',
    };
  }

  const triggerReference = {
    getBoundingClientRect: () => {
      const livePos = getPos();
      if (typeof livePos !== 'number') return new DOMRect();
      const liveNode = editor.state.doc.nodeAt(livePos);
      if (!liveNode) return new DOMRect();
      try {
        return posToDOMRect(editor.view, livePos, livePos + liveNode.nodeSize);
      } catch {
        return new DOMRect();
      }
    },
    contextElement: editor.view.dom,
  };

  const displayText =
    assetPath ?? (externalTarget ? externalTarget.url : `${target}${anchor ? `#${anchor}` : ''}`);
  const copyContent = (() => {
    const inner = anchor ? `${target}#${anchor}` : target;
    return alias ? `[[${inner}|${alias}]]` : `[[${inner}]]`;
  })();

  const iconNode = (
    <span className={cn('flex shrink-0', stateLabel.className)}>{stateLabel.icon}</span>
  );
  const iconElement = isUnresolved ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0" data-slot="wiki-link-prop-panel-icon-trigger">
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
      <InteractionPropPanel
        kind="wiki-link"
        ariaLabel={`${stateLabel.text}: ${displayText}`}
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
                    data-slot="wiki-link-prop-panel-text"
                    className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
                  >
                    {displayText}
                  </a>
                ) : (
                  <span
                    data-slot="wiki-link-prop-panel-text"
                    className={cn(
                      'block truncate text-sm font-medium',
                      isUnresolved ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {displayText}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent className="max-w-80 break-all">{displayText}</TooltipContent>
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
                data-slot="wiki-link-prop-panel-create"
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
                  data-slot="wiki-link-prop-panel-edit"
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Trans>Edit</Trans>
              </TooltipContent>
            </Tooltip>
            <CopyButton copyContent={copyContent} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t`Remove`}
                  onClick={handleRemove}
                  data-slot="wiki-link-prop-panel-remove"
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

      <EditWikiLinkDialog
        open={editDialogOpen}
        target={target}
        alias={alias}
        anchor={anchor}
        pages={pages}
        assetPaths={assetPaths}
        filePaths={filePaths}
        loading={loading}
        onOpenChange={setEditDialogOpen}
        onSave={handleSaveEdit}
      />
    </>
  );
}
