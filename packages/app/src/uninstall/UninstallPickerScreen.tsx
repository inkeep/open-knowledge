import type { UninstallProjectRow } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

type ProjectStatus = 'active' | 'recent';

interface UninstallPickerScreenProps {
  projects: readonly UninstallProjectRow[];
  /** Indexes into `projects`, ascending. Main re-resolves them against its own list. */
  onConfirm: (selectedIndexes: number[]) => void;
  onCancel: () => void;
}

/**
 * One status per row. `open` (a live editor window) and `running` (a live server
 * process) both mean the project is in use right now, so they collapse to
 * `active`; the open/server split is an implementation detail the user doesn't
 * act on. A project only in the recents list is `recent`. `active` wins when
 * both hold — it is the distinction that bears on removing the project now.
 */
function projectStatus(project: UninstallProjectRow): ProjectStatus | null {
  if (project.open || project.running) return 'active';
  if (project.recent) return 'recent';
  return null;
}

/**
 * Trailing path segment, the way `node:path`'s `basename` reads it — the
 * renderer has no `node:path`, and this stays macOS-shaped like the rest of the
 * uninstall flow. Falls back to the whole path when there is no segment.
 */
function projectDisplayName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { t } = useLingui();
  const labels: Record<ProjectStatus, string> = {
    active: t`active`,
    recent: t`recent`,
  };
  return (
    <Badge variant="secondary" className="rounded-sm text-muted-foreground">
      {labels[status]}
    </Badge>
  );
}

function ProjectRow({
  project,
  checked,
  onCheckedChange,
}: {
  project: UninstallProjectRow;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useLingui();
  const checkboxId = useId();
  const status = projectStatus(project);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 border-border/60 border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/40 max-sm:grid-cols-[auto_minmax(0,1fr)]">
      <Checkbox
        id={checkboxId}
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        // Overrides the visible label so the row announces what ticking it does,
        // not just which project it is.
        aria-label={t`Remove OpenKnowledge from ${project.path}`}
      />
      <Label htmlFor={checkboxId} className="min-w-0 flex-col items-start gap-0.5 font-normal">
        <span className="w-full truncate font-medium text-sm">
          {projectDisplayName(project.path)}
        </span>
        <span className="w-full select-text break-words text-muted-foreground text-xs">
          {project.path}
        </span>
      </Label>
      {status !== null && (
        <div className="flex justify-end max-sm:col-start-2 max-sm:justify-start">
          <ProjectStatusBadge status={status} />
        </div>
      )}
    </div>
  );
}

/**
 * First screen of the desktop self-uninstall flow: confirm the uninstall, and
 * optionally pick projects to run `ok deinit` against.
 *
 * The rows are whatever main sent down; the only thing that travels back is a
 * set of indexes into that list, so this screen can never name a path main did
 * not already offer.
 */
export function UninstallPickerScreen({
  projects,
  onConfirm,
  onCancel,
}: UninstallPickerScreenProps) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const titleId = useId();
  const descriptionId = useId();
  const selectAllId = useId();

  const allSelected = projects.length > 0 && selected.size === projects.length;
  const selectAllState: boolean | 'indeterminate' = allSelected
    ? true
    : selected.size > 0
      ? 'indeterminate'
      : false;
  const setAllSelected = (next: boolean) =>
    setSelected(next ? new Set(projects.map((_, index) => index)) : new Set());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(new Set(projects.map((_, index) => index)));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onCancel, projects]);

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="flex h-dvh flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="shrink-0 px-6 pt-5 pb-3.5 space-y-4">
        <h1 id={titleId} className="font-medium leading-none text-base">
          <Trans>Uninstall OpenKnowledge?</Trans>
        </h1>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          <Trans>
            This removes OpenKnowledge’s settings and integrations from your Mac and any projects
            you select below, but keeps your markdown content and authored skills.
          </Trans>
        </p>
      </header>

      <section
        aria-label={t`Detected OpenKnowledge projects`}
        className="flex min-h-0 flex-1 flex-col px-6 py-3.5"
      >
        {projects.length === 0 ? (
          <div className="rounded-lg border border-border p-4">
            <p className="text-muted-foreground text-sm">
              <Trans>No active or recent OpenKnowledge projects were found.</Trans>
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
            {/* Fixed select-all header row: a tri-state checkbox (all / some /
                none) plus the total count. Only the rows below it scroll. */}
            <div className="flex shrink-0 items-center gap-2.5 border-border border-b px-3 py-2.5 bg-muted/30">
              <Checkbox
                id={selectAllId}
                checked={selectAllState}
                onCheckedChange={(next) => setAllSelected(next === true)}
              />
              <Label htmlFor={selectAllId} className="flex-1 font-medium text-sm">
                <Trans>Select all</Trans>
              </Label>
              {/* Selected-of-total, announced on change (replaces a separate
                  footer count). Visually a bare fraction; the aria-label spells
                  it out for screen readers. */}
              <span
                role="status"
                aria-label={t`${selected.size} of ${projects.length} projects selected`}
                className="text-muted-foreground text-xs tabular-nums"
              >
                {selected.size} / {projects.length}
              </span>
            </div>
            {/* `overflow-y-scroll` over `auto` keeps the gutter present at every
                list length, so a row's tag column never shifts as rows are added. */}
            <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
              {projects.map((project, index) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  checked={selected.has(index)}
                  onCheckedChange={(next) => {
                    setSelected((prev) => {
                      const updated = new Set(prev);
                      if (next) updated.add(index);
                      else updated.delete(index);
                      return updated;
                    });
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <footer className="flex items-center justify-end gap-2.5 border-border border-t bg-muted/50 px-6 pt-3.5 pb-4">
        {/* Cancel holds initial focus so Return cannot uninstall by accident. */}
        <Button type="button" variant="outline-mono" autoFocus onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => onConfirm([...selected].sort((left, right) => left - right))}
        >
          <Trans>Uninstall OpenKnowledge</Trans>
        </Button>
      </footer>
    </div>
  );
}
