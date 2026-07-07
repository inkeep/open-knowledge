// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import {
  type HeadingEntry,
  isManagedArtifactDocName,
  PageHeadingsSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { usePageList } from '@/components/PageListContext';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelError,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { useDocumentContext } from '@/editor/DocumentContext';
import { HttpResponseParseError } from '@/editor/http-client';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { useActiveHeading } from '@/hooks/useActiveHeading';
import { ProfilerBoundary } from '@/lib/perf';
import { cn } from '@/lib/utils';

/**
 * Debounce window for Y.Doc update → page-headings invalidation. Matches the
 * `TYPING_DEFER_MS` convention from precedent #11 — a 300 ms trailing-edge
 * window coalesces bursts of keystrokes into a single fetch while still
 * updating the outline fast enough to feel live.
 */
const OUTLINE_INVALIDATE_DEBOUNCE_MS = 300;

async function fetchHeadings(docName: string): Promise<HeadingEntry[]> {
  const res = await fetch(`/api/page-headings?docName=${encodeURIComponent(docName)}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new HttpResponseParseError(t`Page headings response was not JSON`, {
      cause,
      status: res.status,
    });
  }
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    if (!problem.success) {
      throw new HttpResponseParseError(t`Page headings error response did not match RFC 9457`, {
        status: res.status,
      });
    }
    throw new Error(problem.data.title);
  }
  const success = PageHeadingsSuccessSchema.safeParse(body);
  if (!success.success) {
    throw new HttpResponseParseError(t`Page headings response did not match success schema`, {
      status: res.status,
    });
  }
  return success.data.headings ?? [];
}

// Button height (py-1.5 = 12px + text-sm line-height 20px). Marker is
// vertically centred against this — keep in sync with the button className.
const ITEM_H = 32;
const LEVEL_W = 12;
const MARKER_SIZE = 6;

export interface OutlineNavDetail {
  index: number;
  slug: string;
  mode: 'wysiwyg' | 'source';
}

export const OUTLINE_NAV_EVENT = 'open-knowledge:outline-nav';

export function OutlinePanel(props: {
  docName: string;
  isSourceMode: boolean;
  className?: string;
}) {
  return (
    <ProfilerBoundary name="outline-panel">
      <OutlinePanelInner {...props} />
    </ProfilerBoundary>
  );
}

function OutlinePanelInner({
  docName,
  isSourceMode,
  className = '',
}: {
  docName: string;
  isSourceMode: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const { pages, loading } = usePageList();
  const queryClient = useQueryClient();
  const { activeProvider, activeDocName } = useDocumentContext();
  const {
    data: headings = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['page-headings', docName],
    queryFn: () => fetchHeadings(docName),
    enabled: !loading && (pages.has(docName) || isManagedArtifactDocName(docName)),
    // The Y.Doc `update` subscription below is authoritative for freshness —
    // background refetch on window-focus/reconnect would add wasted fetches
    // for data already guaranteed-current. Per TkDodo (TanStack Query
    // maintainer) guidance for subscription-source-authoritative queries:
    // https://tkdodo.eu/blog/using-web-sockets-with-react-query
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Precise-trigger invalidation. The active doc's Y.Doc `update` event fires
  // on every mutation — local typing, remote peer edits arriving via
  // WebSocket, and agent writes — so the outline stays fresh without
  // polling. We gate on `activeDocName === docName` because
  // `OutlinePanel` may briefly render for a doc that isn't the active one
  // during a navigation transition; in that case the initial query fetch is
  // sufficient and there's no point subscribing to a provider for a different
  // doc. `DocPanel` in practice only mounts one `OutlinePanel` at a time, but
  // the guard keeps this robust under future layout changes.
  useEffect(() => {
    if (!activeProvider || activeDocName !== docName) return;
    const doc = activeProvider.document;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void queryClient.invalidateQueries({ queryKey: ['page-headings', docName] });
      }, OUTLINE_INVALIDATE_DEBOUNCE_MS);
    };
    doc.on('update', onUpdate);
    return () => {
      doc.off('update', onUpdate);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [activeProvider, activeDocName, docName, queryClient]);

  const slugs = headings.map((h) => h.slug);
  const activeSlug = useActiveHeading(slugs, isSourceMode);
  const activeIndex = activeSlug ? headings.findIndex((h) => h.slug === activeSlug) : -1;

  function handleNav(index: number, slug: string) {
    const detail: OutlineNavDetail = {
      index,
      slug,
      mode: isSourceMode ? 'source' : 'wysiwyg',
    };
    if (detail.mode === 'source') {
      rememberPendingSourceNavigation(docName, { kind: 'outline', detail });
    }
    window.dispatchEvent(new CustomEvent(OUTLINE_NAV_EVENT, { detail }));
  }

  const activeLevel = activeIndex >= 0 ? headings[activeIndex].level : 1;
  // Centre marker horizontally on the level column, vertically on the row.
  const markerX = (activeLevel - 1) * LEVEL_W + (LEVEL_W - MARKER_SIZE) / 2;
  const markerY = activeIndex * ITEM_H + (ITEM_H - MARKER_SIZE) / 2;

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>
          <Trans>Outline</Trans>
        </PanelTitle>
        {!isLoading && <PanelCount>{headings.length}</PanelCount>}
      </PanelHeader>
      <PanelBody className="px-3 py-2" aria-busy={isLoading}>
        {error ? (
          <PanelError className="px-2">
            {error instanceof Error ? error.message : t`Failed to load headings`}
          </PanelError>
        ) : headings.length === 0 && !isLoading ? (
          <PanelEmpty className="px-2">
            <Trans>No headings yet.</Trans>
          </PanelEmpty>
        ) : (
          <nav aria-label={t`Document outline`} className="relative">
            {activeIndex >= 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 rounded-full bg-primary motion-safe:[transition:transform_0.25s_var(--ease-out-strong)]"
                style={{
                  width: MARKER_SIZE,
                  height: MARKER_SIZE,
                  transform: `translate(${markerX}px, ${markerY}px)`,
                }}
              />
            )}
            {headings.map((heading, index) => {
              const isActive = heading.slug === activeSlug;
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: headings are positionally stable per load
                  key={index}
                  type="button"
                  aria-current={isActive ? 'location' : undefined}
                  onClick={() => handleNav(index, heading.slug)}
                  className={cn(
                    'w-full cursor-pointer truncate py-1.5 pe-2 text-left text-sm transition-colors',
                    isActive
                      ? 'font-medium text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  style={{ paddingLeft: `${(heading.level - 1) * LEVEL_W + 20}px` }}
                  title={heading.text}
                >
                  {heading.text}
                </button>
              );
            })}
          </nav>
        )}
      </PanelBody>
    </Panel>
  );
}
