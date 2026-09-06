// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit
import {
  type BacklinkEntry,
  BacklinksSuccessSchema,
  type ForwardLinkEntry,
  type ForwardLinkLocalTarget,
  type ForwardLinksSuccess,
  ForwardLinksSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Image as ImageIcon,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { resolveLinkTargetIntent } from '@/components/link-target-intent';
import { usePageList } from '@/components/PageListContext';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import { isKnownPageDocName } from '@/components/page-membership';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelError,
  PanelTitle,
} from '@/components/ui/panel';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HttpResponseParseError } from '@/editor/http-client';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { type CreatePageSeed, createPageFromSeedAndUpdate } from '@/lib/create-page';
import { hashFromDocName } from '@/lib/doc-hash';
import { cn } from '@/lib/utils';
import { resolveTargetNavigationIntent } from './target-navigation-intent';

const INITIAL_VISIBLE = 5;

async function fetchBacklinks(docName: string): Promise<BacklinkEntry[]> {
  const res = await fetch(`/api/backlinks?docName=${encodeURIComponent(docName)}`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    const status = res.status;
    if (!problem.success) {
      throw new HttpResponseParseError(
        t`Failed to parse backlinks error response (HTTP ${status})`,
        { status },
      );
    }
    throw new Error(problem.data.title);
  }
  const success = BacklinksSuccessSchema.safeParse(body);
  if (!success.success) {
    throw new HttpResponseParseError(t`Backlinks response did not match expected shape.`, {
      status: res.status,
    });
  }
  return success.data.backlinks;
}

async function fetchForwardLinks(docName: string): Promise<ForwardLinksSuccess> {
  const res = await fetch(`/api/forward-links?docName=${encodeURIComponent(docName)}`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    const status = res.status;
    if (!problem.success) {
      throw new HttpResponseParseError(
        t`Failed to parse forward-links error response (HTTP ${status})`,
        { status },
      );
    }
    throw new Error(problem.data.title);
  }
  const success = ForwardLinksSuccessSchema.safeParse(body);
  if (!success.success) {
    throw new HttpResponseParseError(t`Forward-links response did not match expected shape.`, {
      status: res.status,
    });
  }
  return success.data;
}

function compactDocPath(docName: string): string {
  const segments = docName.split('/');
  if (segments.length <= 2) return docName;
  return `…/${segments.slice(-2).join('/')}`;
}

function navigateToDocHash(docName: string): void {
  window.location.hash = hashFromDocName(docName);
}

function SectionTrigger({
  title,
  count,
  isLoading,
}: {
  title: string;
  count: number | null;
  isLoading: boolean;
}) {
  return (
    <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between px-5 py-3 text-left transition-colors hover:bg-muted/40">
      <span className="flex items-center gap-2.5">
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        <PanelTitle>{title}</PanelTitle>
      </span>
      {!isLoading && count !== null && <PanelCount>{count}</PanelCount>}
    </CollapsibleTrigger>
  );
}

function ShowMoreButton({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= INITIAL_VISIBLE) return null;
  const hidden = total - INITIAL_VISIBLE;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="mt-2 inline-flex cursor-pointer items-center gap-1 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={onToggle}
    >
      {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      {expanded ? <Trans>Show fewer</Trans> : <Trans>Show {hidden} more</Trans>}
    </button>
  );
}

interface LinkRowProps {
  icon: ReactNode;
  iconColorClass?: string;
  rowTooltip?: string;
  title: string;
  path?: string;
  anchor?: string | null;
  snippet?: string | null;
  titleHover?: string;
  ariaLabel?: string;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}

function LinkRow({
  icon,
  iconColorClass,
  rowTooltip,
  title,
  path,
  anchor,
  snippet,
  titleHover,
  ariaLabel,
  href,
  external,
  disabled,
  onClick,
  trailing,
}: LinkRowProps) {
  const showPath = path !== undefined && path !== title;
  const iconNode = (
    <span className={cn('mt-0.5 shrink-0', iconColorClass ?? 'text-muted-foreground')}>{icon}</span>
  );

  const overlayClassName =
    'block w-full truncate text-left font-medium text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring';
  const primaryInteractive = href ? (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      aria-label={ariaLabel}
      title={titleHover}
      onClick={onClick}
      className={overlayClassName}
    >
      {title}
      {external ? (
        <span className="sr-only">
          {' '}
          <Trans>(opens in new tab)</Trans>
        </span>
      ) : null}
    </a>
  ) : (
    <button
      type="button"
      aria-label={ariaLabel}
      title={titleHover}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        overlayClassName,
        'cursor-pointer bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      {title}
    </button>
  );

  const row = (
    <div className="group relative flex items-start gap-2.5 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/80">
      <div className="mt-px flex items-center">{iconNode}</div>
      <div className="min-w-0 flex-1 space-y-0.5 text-1sm">
        {primaryInteractive}
        {showPath ? (
          <div className="truncate font-mono text-xs text-muted-foreground">
            {path}
            {anchor ? <span className="ml-1">· #{anchor}</span> : null}
          </div>
        ) : null}
        {snippet ? <p className="line-clamp-2 text-muted-foreground">{snippet}</p> : null}
      </div>
      {trailing ? <div className="mt-0.5 flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );

  if (rowTooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="top">{rowTooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return row;
}

function BacklinksSection({ docName }: { docName: string }) {
  const { t } = useLingui();
  const {
    folderPaths,
    pages,
    pagesBySlug,
    pagesByBasename,
    loading,
    error: pageListError,
  } = usePageList();
  const { data, isLoading, error } = useQuery({
    queryKey: ['backlinks', docName],
    queryFn: () => fetchBacklinks(docName),
    enabled: !loading && isKnownPageDocName(pages, docName),
  });
  const backlinks = data ?? [];
  const isUnresolvable =
    !loading && pageListError === null && !isKnownPageDocName(pages, docName) && data !== undefined;
  const [expanded, setExpanded] = useState(false);
  const [prevDocName, setPrevDocName] = useState(docName);
  if (prevDocName !== docName) {
    setPrevDocName(docName);
    setExpanded(false);
  }
  const visible = expanded ? backlinks : backlinks.slice(0, INITIAL_VISIBLE);

  return (
    <Collapsible defaultOpen>
      <SectionTrigger
        title={t`Backlinks`}
        count={error !== null || isUnresolvable ? null : backlinks.length}
        isLoading={isLoading}
      />
      <CollapsibleContent>
        <div className="px-2 pb-3" aria-busy={isLoading}>
          {isUnresolvable ? (
            <div className="px-3">
              <PanelEmpty role="status">
                <Trans>This page is no longer at this path.</Trans>
              </PanelEmpty>
            </div>
          ) : error ? (
            <div className="px-3">
              <PanelError>
                {error instanceof Error ? error.message : t`Failed to load backlinks`}
              </PanelError>
            </div>
          ) : backlinks.length === 0 && !isLoading ? (
            <div className="px-3">
              <PanelEmpty>
                <Trans>No pages link here yet.</Trans>
              </PanelEmpty>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                {visible.map((backlink, index) => {
                  const navigationIntent = resolveTargetNavigationIntent(backlink.source, {
                    pages,
                    folderPaths,
                    pagesBySlug,
                    pagesByBasename,
                  });
                  return (
                    <LinkRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: rows are stable per poll; source may repeat if API adds multiple edges per source
                      key={`${backlink.source}-${index}`}
                      icon={<File className="size-3.5" />}
                      title={backlink.title}
                      path={compactDocPath(backlink.source)}
                      titleHover={backlink.source}
                      anchor={backlink.anchor}
                      snippet={backlink.snippet}
                      href={hashFromDocName(navigationIntent.hashDocName, backlink.anchor)}
                    />
                  );
                })}
              </div>
              <ShowMoreButton
                total={backlinks.length}
                expanded={expanded}
                onToggle={() => setExpanded((prev) => !prev)}
              />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ForwardLinksSection({ docName }: { docName: string }) {
  const { t } = useLingui();
  const {
    addPage,
    folderPaths,
    pages,
    pagesBySlug,
    pagesByBasename,
    loading: pagesLoading,
    error: pageListError,
  } = usePageList();
  const { data, isLoading, error } = useQuery({
    queryKey: ['forward-links', docName],
    queryFn: () => fetchForwardLinks(docName),
    enabled: !pagesLoading && isKnownPageDocName(pages, docName),
  });
  const links = data?.forwardLinks ?? [];
  const isUnresolvable =
    !pagesLoading &&
    pageListError === null &&
    !isKnownPageDocName(pages, docName) &&
    data !== undefined;
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [prevDocName, setPrevDocName] = useState(docName);
  if (prevDocName !== docName) {
    setPrevDocName(docName);
    setExpanded(false);
    setCreatingKey(null);
  }
  const visible = expanded ? links : links.slice(0, INITIAL_VISIBLE);

  async function handleCreatePage(seed: CreatePageSeed, key: string) {
    if (creatingKey) return;
    setCreatingKey(key);
    try {
      await createPageFromSeedAndUpdate(seed, {
        addPage,
        onCreated: navigateToDocHash,
      });
      setCreatingKey(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Failed to create page`);
      setCreatingKey(null);
    }
  }

  function renderRow(link: ForwardLinkEntry) {
    const { title: linkTitle } = link;
    if (link.kind === 'external') {
      const titleIsUrl = link.title === link.url;
      return (
        <LinkRow
          key={`ext:${link.url}`}
          icon={<ArrowUpRight className="size-3.5" />}
          rowTooltip={t`Opens in a new tab`}
          title={link.title}
          path={titleIsUrl ? undefined : link.url}
          titleHover={link.url}
          snippet={link.snippet}
          href={link.url}
          external
        />
      );
    }

    const linkIntent = resolveLinkTargetIntent(link.docName, {
      pages,
      folderPaths,
      pagesBySlug,
      pagesByBasename,
    });
    const unresolved = !pagesLoading && linkIntent.kind === 'create';
    const folderTarget =
      !pagesLoading && linkIntent.kind === 'navigate' && linkIntent.displayState === 'folder';
    const path = compactDocPath(link.docName);
    const titleEqualsDocName = link.title === link.docName;
    const displayTitle = titleEqualsDocName ? path : link.title;
    const key = `doc:${link.docName}:${link.anchor ?? ''}`;
    const navigateHashDocName =
      linkIntent.kind === 'navigate' ? linkIntent.hashDocName : link.docName;
    const navigateHref =
      linkIntent.kind === 'navigate' && linkIntent.hash
        ? linkIntent.hash
        : hashFromDocName(navigateHashDocName, link.anchor);

    if (unresolved && linkIntent.kind === 'create') {
      const seed = {
        initialDir: linkIntent.initialDir,
        suggestedName: linkIntent.suggestedName,
      };
      return (
        <LinkRow
          key={key}
          icon={<TriangleAlert className="size-3.5" />}
          iconColorClass="text-amber-600 dark:text-amber-400"
          rowTooltip={creatingKey === key ? t`Creating page` : t`Missing page — click to create`}
          ariaLabel={
            creatingKey === key
              ? t`Creating page: ${linkTitle}.`
              : t`Missing page: ${linkTitle}. Click to create.`
          }
          title={displayTitle}
          path={path}
          titleHover={link.docName}
          anchor={link.anchor}
          snippet={link.snippet}
          disabled={creatingKey !== null}
          onClick={() => void handleCreatePage(seed, key)}
        />
      );
    }

    if (folderTarget && linkIntent.kind === 'navigate') {
      return (
        <LinkRow
          key={key}
          icon={<Folder className="size-3.5" />}
          iconColorClass="text-sky-600 dark:text-sky-400"
          ariaLabel={t`Folder target: ${linkTitle}. Click to open the overview.`}
          title={displayTitle}
          path={path}
          titleHover={link.docName}
          anchor={link.anchor}
          snippet={link.snippet}
          href={navigateHref}
        />
      );
    }

    return (
      <LinkRow
        key={key}
        icon={<File className="size-3.5" />}
        title={displayTitle}
        path={path}
        titleHover={link.docName}
        anchor={link.anchor}
        snippet={link.snippet}
        href={navigateHref}
      />
    );
  }

  return (
    <Collapsible defaultOpen>
      <SectionTrigger
        title={t`Outgoing`}
        count={error !== null || isUnresolvable ? null : links.length}
        isLoading={isLoading}
      />
      <CollapsibleContent>
        <div className="px-2 pb-3" aria-busy={isLoading}>
          {isUnresolvable ? (
            <div className="px-3">
              <PanelEmpty role="status">
                <Trans>This page is no longer at this path.</Trans>
              </PanelEmpty>
            </div>
          ) : error ? (
            <div className="px-3">
              <PanelError>
                {error instanceof Error ? error.message : t`Failed to load outgoing links`}
              </PanelError>
            </div>
          ) : links.length === 0 && !isLoading ? (
            <div className="px-3">
              <PanelEmpty>
                <Trans>This page doesn't link to anything yet.</Trans>
              </PanelEmpty>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">{visible.map(renderRow)}</div>
              <ShowMoreButton
                total={links.length}
                expanded={expanded}
                onToggle={() => setExpanded((prev) => !prev)}
              />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LocalFilesSection({ docName }: { docName: string }) {
  const { t } = useLingui();
  const { pages, loading: pagesLoading, error: pageListError } = usePageList();
  const { data, isLoading, error } = useQuery({
    queryKey: ['forward-links', docName],
    queryFn: () => fetchForwardLinks(docName),
    enabled: !pagesLoading && isKnownPageDocName(pages, docName),
  });
  const isUnresolvable =
    !pagesLoading &&
    pageListError === null &&
    !isKnownPageDocName(pages, docName) &&
    data !== undefined;
  const [expanded, setExpanded] = useState(false);
  const [prevDocName, setPrevDocName] = useState(docName);
  if (prevDocName !== docName) {
    setPrevDocName(docName);
    setExpanded(false);
  }
  const localTargets = data?.localTargets;
  const rows = localTargets ?? [];
  const visible = expanded ? rows : rows.slice(0, INITIAL_VISIBLE);

  function navigateToOccurrence(target: ForwardLinkLocalTarget): void {
    const detail: LintNavDetail = {
      docName,
      line: target.line + 1,
      column: target.column + 1,
      source: 'links',
    };
    rememberPendingSourceNavigation(docName, { kind: 'lint', detail });
    window.dispatchEvent(new CustomEvent(LINT_NAV_EVENT, { detail }));
  }

  function renderLocalTargetRow(target: ForwardLinkLocalTarget) {
    const isImage = target.role === 'image';
    const resolved = target.status === 'exact' || target.status === 'fallback';
    const identity = target.resolvedTarget ?? target.href;
    const statusWord = target.status === 'missing' ? t`Missing` : t`Unresolvable`;
    const ariaLabel = resolved
      ? isImage
        ? t`Image ${identity}. Go to reference.`
        : t`File ${identity}. Go to reference.`
      : target.status === 'missing'
        ? isImage
          ? t`Missing image ${identity}. Go to reference.`
          : t`Missing file ${identity}. Go to reference.`
        : isImage
          ? t`Unresolvable image ${identity}. Go to reference.`
          : t`Unresolvable file ${identity}. Go to reference.`;
    return (
      <LinkRow
        key={`lt:${target.range.start}-${target.range.end}`}
        icon={isImage ? <ImageIcon className="size-3.5" /> : <File className="size-3.5" />}
        iconColorClass={resolved ? undefined : 'text-amber-600 dark:text-amber-400'}
        title={compactDocPath(identity)}
        titleHover={identity}
        ariaLabel={ariaLabel}
        trailing={
          resolved ? undefined : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {statusWord}
            </Badge>
          )
        }
        onClick={() => navigateToOccurrence(target)}
      />
    );
  }

  return (
    <Collapsible defaultOpen>
      <SectionTrigger
        title={t`Local files`}
        count={error !== null || isUnresolvable ? null : rows.length}
        isLoading={isLoading}
      />
      <CollapsibleContent>
        <div className="px-2 pb-3" aria-busy={isLoading}>
          {isUnresolvable ? (
            <div className="px-3">
              <PanelEmpty role="status">
                <Trans>This page is no longer at this path.</Trans>
              </PanelEmpty>
            </div>
          ) : error ? (
            <div className="px-3">
              <PanelError>
                {error instanceof Error ? error.message : t`Failed to load local files`}
              </PanelError>
            </div>
          ) : localTargets === undefined && !isLoading ? (
            <div className="px-3">
              <PanelEmpty>
                <Trans>Local file details aren't available yet.</Trans>
              </PanelEmpty>
            </div>
          ) : rows.length === 0 && !isLoading ? (
            <div className="px-3">
              <PanelEmpty>
                <Trans>This page references no local files or images.</Trans>
              </PanelEmpty>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">{visible.map(renderLocalTargetRow)}</div>
              <ShowMoreButton
                total={rows.length}
                expanded={expanded}
                onToggle={() => setExpanded((prev) => !prev)}
              />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LinksPanel({ docName, className = '' }: { docName: string; className?: string }) {
  return (
    <Panel className={className}>
      <PanelBody className="px-0 py-0">
        <ForwardLinksSection docName={docName} />
        <Separator />
        <LocalFilesSection docName={docName} />
        <Separator />
        <BacklinksSection docName={docName} />
      </PanelBody>
    </Panel>
  );
}
