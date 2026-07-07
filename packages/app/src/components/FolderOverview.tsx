import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, ArrowUpDown, File, Folder, FolderOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import { FolderPropertiesCard } from '@/components/FolderPropertiesCard';
import { FolderTimelineCard } from '@/components/FolderTimelineCard';
import {
  buildFolderOverviewData,
  type FolderOverviewEntry,
} from '@/components/folder-overview-data';
import { NewItemDialog } from '@/components/NewItemDialog';
import { usePageList } from '@/components/PageListContext';
import { TemplatesCard } from '@/components/TemplatesCard';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { hashFromDocName } from '@/lib/doc-hash';

type SortKey = 'name' | 'modified';
type SortDir = 'asc' | 'desc';

function formatRelativeDate(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return t`just now`;
  if (diffMin < 60) return t`${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return t`${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return t`${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sortEntries(
  entries: FolderOverviewEntry[],
  key: SortKey,
  dir: SortDir,
): FolderOverviewEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let cmp = 0;
    switch (key) {
      case 'name':
        cmp = a.title.localeCompare(b.title) || a.name.localeCompare(b.name);
        break;
      case 'modified': {
        const aM = a.kind === 'file' ? a.modified : '';
        const bM = b.kind === 'file' ? b.modified : '';
        cmp = aM.localeCompare(bM);
        break;
      }
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  activeDir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const isActive = activeKey === sortKey;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 uppercase font-mono"
      onClick={() => onSort(sortKey)}
    >
      {label}
      {isActive ? (
        activeDir === 'asc' ? (
          <ArrowUp className="ml-1 size-3" />
        ) : (
          <ArrowDown className="ml-1 size-3" />
        )
      ) : (
        <ArrowUpDown className="ml-1 size-3 text-muted-foreground/50" />
      )}
    </Button>
  );
}

export function FolderOverview({ folderPath }: { folderPath: string }) {
  const { t } = useLingui();
  const { folderPaths, loading, pages, pageTitles, pageMeta } = usePageList();
  const folderConfigHandle = useFolderConfig(folderPath);
  const { state: folderConfig, refresh: refreshFolderConfig } = folderConfigHandle;
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  if (loading) {
    return (
      <div
        className="flex min-h-0 flex-1 items-start overflow-y-auto subtle-scrollbar"
        role="status"
        aria-busy="true"
        aria-label={t`Loading folder contents`}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-5 rounded" />
              <Skeleton className="h-7 w-48" />
            </div>
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
          <div className="rounded-lg border">
            <div className="flex items-center gap-4 border-b px-4 py-3">
              <Skeleton className="h-4 w-16" />
              <div className="ml-auto">
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
            {['a', 'b', 'c', 'd'].map((id) => (
              <div key={id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-4 w-40" />
                <div className="ml-auto">
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const data = buildFolderOverviewData(folderPath, { pages, pageTitles, pageMeta, folderPaths });
  const sorted = sortEntries(data.children, sortKey, sortDir);
  // Content-root has no folder leaf to derive a title from
  // (`buildFolderOverviewData` returns ''). Fall back to a generic label so
  // the root overview — reached by in-app root nav and root-folder shares —
  // never renders a blank heading.
  const heading = data.title || (folderPath === '' ? t`All files` : data.title);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 items-start overflow-y-auto subtle-scrollbar">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="size-5 text-muted-foreground" />
                <h1 className="text-2xl font-light tracking-tight">{heading}</h1>
              </div>
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="size-4" />
                <Trans>New</Trans>
              </Button>
            </div>
          </div>
          <FolderPropertiesCard
            folderPath={folderPath}
            state={folderConfig}
            onChange={refreshFolderConfig}
          />
          <TemplatesCard
            folderPath={folderPath}
            state={folderConfig}
            onChange={refreshFolderConfig}
            folderConfigHandle={folderConfigHandle}
          />
          <FolderTimelineCard folderPath={folderPath} />
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    aria-sort={
                      sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <SortableHeader
                      label={t`Name`}
                      sortKey="name"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead
                    className="w-32"
                    aria-sort={
                      sortKey === 'modified'
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <SortableHeader
                      label={t`Modified`}
                      sortKey="modified"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={handleSort}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.length ? (
                  sorted.map((entry) => (
                    <TableRow key={entry.path}>
                      <TableCell>
                        <a
                          href={hashFromDocName(entry.path)}
                          className="flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {entry.kind === 'folder' ? (
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <File className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{entry.title}</span>
                        </a>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.kind === 'file' ? formatRelativeDate(entry.modified) : '—'}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={2} className="h-24 text-center text-muted-foreground">
                      <Trans>This folder is empty.</Trans>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
      <NewItemDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        kind="file"
        initialDir={folderPath}
        folderConfig={folderConfigHandle}
        // Preserve the old dropdown's "Index note" affordance as a low-cost
        // breadcrumb: the dialog opens with the name pre-filled to `index`
        // so creating an `index.md` is one Enter away. Users can still rename
        // before submitting.
        suggestedName="index"
      />
    </>
  );
}
