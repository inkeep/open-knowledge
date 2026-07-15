/**
 * InternalDocPreviewCard — the W2 doc-preview card shown inside a link hover
 * panel for a resolved internal target. Purely presentational: it renders
 * whatever fields the {@link InternalDocPreview} reader has resolved and omits
 * the rest, so the card enhances in place as the local reads land and never
 * blocks on a slow or failed field.
 *
 * The card is additive — the hover panel's URL/target pill renders above it and
 * is never removed, so a card that can't render (unresolved target, absent
 * preview) simply leaves today's pill untouched.
 *
 * Field states worth knowing:
 *  - `excerpt === undefined`  → the body read hasn't resolved (or failed): omit
 *    the excerpt line entirely (progressive).
 *  - `excerpt === ''`         → the body read succeeded but the doc is empty:
 *    show the "No excerpt" affordance.
 *  - `tags` / `backlinkCount` undefined → omit that row/field.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { Clock3, FolderOpen, Link2 } from 'lucide-react';
import { useState } from 'react';
import type { InternalDocPreview } from './internal-doc-preview.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Compact, Lingui-routed "time ago" for the edited timestamp. Compact units
 * (`3d`, `2w`, `5mo`) sidestep pluralization and keep the hover footer terse.
 * Returns null for an unparseable timestamp so the caller omits the field.
 */
function formatEditedAgo(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diff = Math.max(0, now - then);
  if (diff < MINUTE_MS) return t`just now`;
  if (diff < HOUR_MS) return t`${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return t`${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < WEEK_MS) return t`${Math.floor(diff / DAY_MS)}d ago`;
  if (diff < MONTH_MS) return t`${Math.floor(diff / WEEK_MS)}w ago`;
  if (diff < YEAR_MS) return t`${Math.floor(diff / MONTH_MS)}mo ago`;
  return t`${Math.floor(diff / YEAR_MS)}y ago`;
}

export function InternalDocPreviewCard({ preview }: { preview: InternalDocPreview }) {
  // `Date.now()` is impure — calling it directly in render violates React
  // Compiler's purity contract. Snapshot it once at mount; a hover card is
  // short-lived, so the relative time needs no re-tick.
  const [now] = useState(() => Date.now());
  const editedAgo = preview.lastEditedAt ? formatEditedAgo(preview.lastEditedAt, now) : null;
  const hasTags = preview.tags !== undefined && preview.tags.length > 0;
  const hasMeta = editedAgo !== null || preview.backlinkCount !== undefined;

  return (
    <div data-slot="internal-doc-preview-card" className="mt-2.5 border-t border-border/70 pt-2.5">
      <div
        data-slot="internal-doc-preview-title"
        className="truncate text-sm font-medium text-foreground"
      >
        {preview.title}
      </div>

      {preview.folderPath ? (
        <div
          data-slot="internal-doc-preview-folder"
          className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
        >
          <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{preview.folderPath}</span>
        </div>
      ) : null}

      {hasTags ? (
        <div data-slot="internal-doc-preview-tags" className="mt-1.5 flex flex-wrap gap-1">
          {preview.tags?.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {preview.excerpt !== undefined ? (
        preview.excerpt ? (
          <p
            data-slot="internal-doc-preview-excerpt"
            className="mt-1.5 line-clamp-3 text-xs text-muted-foreground"
          >
            {preview.excerpt}
          </p>
        ) : (
          <p
            data-slot="internal-doc-preview-empty"
            className="mt-1.5 text-xs italic text-muted-foreground/70"
          >
            <Trans>No excerpt</Trans>
          </p>
        )
      ) : null}

      {hasMeta ? (
        <div
          data-slot="internal-doc-preview-meta"
          className="mt-1.5 flex items-center gap-2.5 text-[11px] text-muted-foreground/80"
        >
          {editedAgo ? (
            <span className="flex items-center gap-1">
              <Clock3 className="size-3 shrink-0" aria-hidden="true" />
              <Trans>Edited {editedAgo}</Trans>
            </span>
          ) : null}
          {preview.backlinkCount !== undefined ? (
            <span className="flex items-center gap-1">
              <Link2 className="size-3 shrink-0" aria-hidden="true" />
              <Plural value={preview.backlinkCount} one="# backlink" other="# backlinks" />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
