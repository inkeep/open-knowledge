import { parseManagedArtifactName } from '@inkeep/open-knowledge-core';
import { MoreHorizontalIcon } from 'lucide-react';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { tabParts } from '@/editor/editor-tabs';
import { cn } from '@/lib/utils';

interface EditorBreadcrumbProps {
  docName: string | null;
  /** Optional extra classes for the outer breadcrumb nav (e.g. layout overrides). */
  className?: string;
}

// Deep folder paths collapse to `root › … › parent › leaf` rather than a row
// of equally-squished, individually-truncated segments. The head (root folder,
// for orientation) and the tail (segments nearest the doc, the most relevant)
// stay visible; the middle collapses into one ellipsis. Collapse only kicks in
// once it actually hides more than it costs — below the threshold every
// segment renders.
const LEADING_VISIBLE = 1;
const TRAILING_VISIBLE = 2;
const COLLAPSE_THRESHOLD = 4;

type BreadcrumbNode =
  | { kind: 'segment'; value: string; key: string }
  | { kind: 'ellipsis'; hidden: readonly string[] };

/**
 * Folder-path breadcrumb for the active doc — renders nothing at project root.
 *
 * Pure display: no click / hover navigation behavior. Every segment renders
 * as a non-link `BreadcrumbPage`. Folder segments derive from
 * `tabParts(docName, '').prefix` so the breadcrumb and the tab label parse
 * the path through the same primitive (single source of truth for the path
 * split — keep them on one parser).
 *
 * Deep paths collapse via the middle-ellipsis pattern (see the *_VISIBLE
 * constants). The collapsed segments are NOT dropped from the accessibility
 * tree — they stay in reading order as an `sr-only` span inside the ellipsis
 * item, so a screen reader still announces the full hierarchy while sighted
 * users get the compact `root › … › leaf` form.
 *
 * Mounted in EditorToolbar's left grid cell. The mount point scopes its own
 * `pointer-events-auto` so it doesn't get swallowed by the parent grid's
 * `pointer-events-none` overlay; this component itself does NOT need
 * pointer-events scoping because it is display-only — the mount-side scoping
 * is what surfaces the truncation-tooltip `title` to the pointer.
 *
 * The full `min-w-0` chain (nav → list → item → page) plus `overflow-hidden`
 * on the list is load-bearing: the toolbar mounts this in a `grid-cols-3`
 * track, and without the chain the `<ol>` keeps its intrinsic width and spills
 * out of its column, painting behind the centered mode toggle.
 *
 * Per-segment `title` attribute lands on the rendered `<span>` via shadcn's
 * spread-props (BreadcrumbPage forwards every attr to its inner span), so the
 * native truncation tooltip continues to reveal the full segment on hover.
 */
export function EditorBreadcrumb({ docName, className }: EditorBreadcrumbProps) {
  if (!docName) return null;
  // Managed-artifact tabs derive their breadcrumb from the parsed artifact, not
  // the raw `__skill__`/`__template__` doc-name prefix: a template shows its
  // owning folder path; a skill has no folder hierarchy (its identity lives in
  // the property panel + tab badge), so it renders no breadcrumb.
  const managed = parseManagedArtifactName(docName);
  const segments = managed
    ? managed.kind === 'template'
      ? managed.folder.split('/').filter(Boolean)
      : []
    : tabParts(docName, '').prefix.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Stable per-segment key: full prefix slice up to that segment.
  // Disambiguates identical names at different depths (e.g. `notes/notes`).
  const segmentNode = (value: string, absoluteIndex: number): BreadcrumbNode => ({
    kind: 'segment',
    value,
    key: segments.slice(0, absoluteIndex + 1).join('/'),
  });

  const collapsed = segments.length > COLLAPSE_THRESHOLD;
  const nodes: BreadcrumbNode[] = collapsed
    ? [
        ...segments.slice(0, LEADING_VISIBLE).map((value, i) => segmentNode(value, i)),
        { kind: 'ellipsis', hidden: segments.slice(LEADING_VISIBLE, -TRAILING_VISIBLE) },
        ...segments
          .slice(-TRAILING_VISIBLE)
          .map((value, i) => segmentNode(value, segments.length - TRAILING_VISIBLE + i)),
      ]
    : segments.map((value, i) => segmentNode(value, i));

  return (
    <Breadcrumb className={cn('flex min-w-0 items-center', className)}>
      <BreadcrumbList className="min-w-0 flex-nowrap gap-1 overflow-hidden text-muted-foreground/70 text-xs">
        {nodes.map((node, index) => {
          const key = node.kind === 'segment' ? node.key : 'ellipsis';
          return (
            <Fragment key={key}>
              {/* Separator is a SIBLING of the item — shadcn renders both as
                  <li>, so nesting a separator inside an item would produce
                  invalid <li><li>...</li></li> HTML. shrink-0 keeps the chevron
                  from being squeezed away when segments truncate. */}
              {index > 0 && (
                <BreadcrumbSeparator className="shrink-0 text-muted-foreground/70 [&>svg]:size-3" />
              )}
              {node.kind === 'ellipsis' ? (
                // Custom ellipsis, NOT shadcn's <BreadcrumbEllipsis>: that
                // primitive hardcodes a generic "More" sr-only label inside an
                // aria-hidden parent (so it's unreachable) and sizes at size-5.
                // We need the actual hidden segment names announced and size-4
                // parity with the xs breadcrumb tokens, so the icon is
                // aria-hidden and the real names live in a sibling sr-only span.
                <BreadcrumbItem className="shrink-0">
                  <span
                    aria-hidden="true"
                    title={node.hidden.join(' / ')}
                    className="flex size-4 items-center justify-center text-muted-foreground/70"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </span>
                  {/* Keep the collapsed segments in the a11y reading order. */}
                  <span className="sr-only">{node.hidden.join(' / ')}</span>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage
                    current={false}
                    className="min-w-0 truncate font-normal text-muted-foreground/70"
                    title={node.value}
                  >
                    {node.value}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
