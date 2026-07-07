import type { TimelineEntry } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  ArrowLeftRight,
  FilePlus,
  FolderCog,
  History,
  type LucideIcon,
  Pencil,
  Trash2,
  User,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { subscribeToTemplatesChanged } from '@/lib/documents-events';

/**
 * Folder timeline — read-only activity feed over a folder's
 * `.ok/` artifacts (templates + frontmatter): who created / edited / renamed /
 * moved / deleted them, when. Reads `GET /api/history?folder=…` (server
 * `getFolderTimeline`), refreshes on template mutations, and hides itself when
 * there's no activity so folders without `.ok/` history stay uncluttered.
 *
 * Restore is intentionally not wired here — non-doc restore is a tracked
 * follow-up; this surface is provenance-only, mirroring the doc Timeline's
 * read side without its diff/restore machinery.
 */
function formatRelative(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return t`just now`;
  if (diffSec < 3600) return t`${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return t`${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return t`${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Basename of a `.ok/` artifact path, sans `.md`. */
function leafName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/**
 * Map a folder-timeline entry's typed commit subject to a human label + icon.
 * The server only sends recognized artifact-action subjects (it filters via
 * `isFolderArtifactSubject`), so the `default` branch is a defensive fallback,
 * not a legacy-salvage path.
 */
function describeEntry(entry: TimelineEntry): { Icon: LucideIcon; label: string; detail: string } {
  const message = entry.message;
  const idx = message.indexOf(': ');
  const prefix = idx === -1 ? message : message.slice(0, idx);
  const rest = idx === -1 ? '' : message.slice(idx + 2);
  switch (prefix) {
    case 'template-create':
      return { Icon: FilePlus, label: t`created template`, detail: leafName(rest) };
    case 'template-edit':
      return { Icon: Pencil, label: t`edited template`, detail: leafName(rest) };
    case 'template-delete':
      return { Icon: Trash2, label: t`deleted template`, detail: leafName(rest) };
    case 'template-rename':
    case 'template-move': {
      const [from, to] = rest.split(' -> ');
      return {
        Icon: ArrowLeftRight,
        label: t`moved template`,
        detail: `${leafName(from ?? '')} → ${leafName(to ?? rest)}`,
      };
    }
    case 'folder-frontmatter-edit':
      return { Icon: FolderCog, label: t`updated folder properties`, detail: '' };
    case 'folder-frontmatter-delete':
      return { Icon: FolderCog, label: t`cleared folder properties`, detail: '' };
    case 'folder-create':
      return { Icon: FolderCog, label: t`created folder`, detail: '' };
    default:
      return { Icon: History, label: prefix.replace(/-/g, ' '), detail: leafName(rest) };
  }
}

function authorName(entry: TimelineEntry): string {
  if (entry.contributors.length > 0) return entry.contributors[0].name;
  if (entry.author === 'openknowledge-service' || entry.author === 'server') return t`Auto-save`;
  return entry.author || t`Unknown`;
}

export function FolderTimelineCard({ folderPath }: { folderPath: string }) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/history?folder=${encodeURIComponent(folderPath)}&limit=50`);
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { entries?: TimelineEntry[] };
        if (cancelled) return;
        setEntries(data.entries ?? []);
        setError(false);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          // Silent-null in the UI (supplementary card), but leave a browser
          // breadcrumb so a `/api/history` regression isn't indistinguishable
          // from "no history" in devtools.
          console.warn('[FolderTimelineCard] failed to load folder timeline:', err);
          setError(true);
          setLoading(false);
        }
      }
    }
    setLoading(true);
    load();
    // Template/folder mutations change the timeline — refresh on those events.
    const unsubscribe = subscribeToTemplatesChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [folderPath]);

  // Provenance-only: stay invisible until there's something to show, so folders
  // with no `.ok/` history don't carry a permanently-empty card.
  if (error) return null;
  if (!loading && entries.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card" data-testid="folder-timeline-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <h2 className="text-xs font-semibold uppercase font-mono tracking-wider text-muted-foreground">
          <Trans>Activity</Trans>
        </h2>
        {entries.length > 0 ? (
          <Badge className="text-xs" variant="secondary">
            {entries.length}
          </Badge>
        ) : null}
      </div>
      <div className="px-3 py-2.5">
        {loading ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <ul className="space-y-1">
            {entries.map((entry) => {
              const { Icon, label, detail } = describeEntry(entry);
              return (
                <li
                  key={entry.sha}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-foreground">{label}</span>
                    {detail ? (
                      <code className="ml-1.5 font-mono text-xs text-muted-foreground">
                        {detail}
                      </code>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <User className="size-3" aria-hidden />
                    {authorName(entry)}
                  </span>
                  <time
                    className="shrink-0 text-xs text-muted-foreground/80"
                    dateTime={entry.timestamp}
                    title={new Date(entry.timestamp).toLocaleString()}
                  >
                    {formatRelative(entry.timestamp)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
