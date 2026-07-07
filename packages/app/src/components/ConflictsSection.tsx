/**
 * ConflictsSection — pinned section at the top of the left sidebar listing
 * every doc whose `.ok/conflicts.json` entry is currently active.
 *
 * Renders nothing when `conflicts.length === 0` (auto-hide at zero;
 * auto-appears at >0 — no manual collapse / expand state). Rows are
 * informational navigation targets: clicking one focuses the doc (the
 * editor-area DiffViewBoundary mounts as soon as the doc's lifecycle Y.Map
 * status propagates). There are NO inline [Keep mine] / [Keep theirs]
 * quick-action buttons — every resolution requires seeing the DiffView first
 * (informed-consent + byte-equality discipline; the editor-area DiffView is
 * the single UI dispatch surface).
 *
 * Count parity:
 *   - Section count comes from `useConflicts()` → `/api/sync/conflicts`.
 *   - Topbar `SyncStatusBadge`'s `conflictCount` comes from `/api/sync/status`,
 *     which itself derives `conflictCount` from the same `.ok/conflicts.json`.
 *     CC1 `sync-status` invalidates both in lockstep.
 *   - Tab-badge counts come from per-doc Y.Map `lifecycle.status` (live CRDT),
 *     pushed by the server's file-watcher / reconciliation paths on the same
 *     edges that flip `conflicts.json`. They converge in steady state; a
 *     brief mismatch window may exist during the propagation round-trip.
 */
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConflicts } from '@/hooks/use-conflicts';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';

function navigateToConflictedDoc(filePath: string) {
  const docName = filePathToDocName(filePath);
  const nextHash = hashFromDocName(docName);
  if (typeof window === 'undefined') return;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

export function ConflictsSection() {
  const { conflicts, loading, error } = useConflicts();

  // Initial fetch in flight — render nothing rather than flash an empty
  // section that disappears once the fetch resolves.
  if (loading) return null;

  // Server reachable but `/api/sync/conflicts` specifically failed (5xx,
  // schema drift, etc.) — surface a visible error band rather than hiding
  // the section. Hiding here is indistinguishable from "no conflicts" and
  // can mask real tracked conflicts while the rest of the app looks fine,
  // leading users to write into docs that bounce with 409 a moment later.
  //
  // `'network'` errors mean the server is entirely unreachable — the
  // FileTree below already shows "Could not reach server" as the global
  // signal, and nothing is editable in the first place, so the masking
  // concern doesn't apply. A second amber band claiming we couldn't load
  // conflicts specifically is redundant noise that misframes the failure.
  if (error === 'server') {
    return (
      <section
        data-testid="conflicts-section"
        aria-label="Conflicted files"
        className="border-b border-amber-200/60 bg-amber-50/40 px-2 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"
      >
        <p
          data-testid="conflicts-section-error"
          className="px-2 py-1.5 text-[12px] text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle aria-hidden="true" className="mr-1.5 inline size-3" />
          Couldn&apos;t load conflicts — reload to retry.
        </p>
      </section>
    );
  }

  if (conflicts.length === 0) return null;

  return (
    <section
      data-testid="conflicts-section"
      aria-label="Conflicted files"
      className="border-b border-amber-200/60 bg-amber-50/40 px-2 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"
    >
      <header className="flex items-center justify-between px-2 pb-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
          <AlertTriangle aria-hidden="true" className="size-3" />
          Conflicts
        </span>
        <span
          data-testid="conflicts-section-count"
          className="rounded-full bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-white"
        >
          {conflicts.length}
        </span>
      </header>
      <ul className="flex flex-col gap-px">
        {conflicts.map((entry) => (
          <li key={entry.file}>
            <Button
              variant="ghost"
              size="sm"
              data-testid="conflicts-section-row"
              data-file={entry.file}
              title={entry.file}
              className="h-7 w-full justify-start gap-1.5 px-2 font-normal text-[13px] text-amber-800 hover:bg-amber-100/60 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-900/30 dark:hover:text-amber-200"
              onClick={() => navigateToConflictedDoc(entry.file)}
            >
              <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{entry.file}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
