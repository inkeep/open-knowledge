import { templateContentDocName } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { InheritedBadge } from '@/components/FrontmatterRow';
import { NewItemDialog } from '@/components/NewItemDialog';
import { NewTemplateDialog } from '@/components/NewTemplateDialog';
import { TemplateDeleteDialog } from '@/components/TemplateDeleteDialog';
import { TemplateRow } from '@/components/TemplateRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  AsyncState,
  FolderConfigHandle,
  FolderConfigSnapshot,
  TemplateMenuEntry,
} from '@/hooks/use-folder-config';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';

interface Props {
  folderPath: string;
  state: AsyncState<FolderConfigSnapshot>;
  onChange: () => void;
  folderConfigHandle?: FolderConfigHandle;
}

export function TemplatesCard({ folderPath, state, onChange, folderConfigHandle }: Props) {
  const [deleteTarget, setDeleteTarget] = useState<TemplateMenuEntry | null>(null);
  const [createFromTemplate, setCreateFromTemplate] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-lg border bg-card px-3 py-2.5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase font-mono tracking-wider text-muted-foreground">
            <Trans>Templates available</Trans>
          </h2>
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </section>
    );
  }

  if (state.status === 'error') {
    const { message } = state;
    return (
      <section
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        role="alert"
      >
        <Trans>Failed to load templates: {message}</Trans>
      </section>
    );
  }

  const templates = state.data.folder.templates_available ?? [];

  return (
    <>
      <section className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase font-mono tracking-wider text-muted-foreground">
              <Trans>Templates available</Trans>
            </h2>
            <Badge className="text-xs" variant="secondary">
              {templates.length}
            </Badge>
          </div>
          <Button
            variant="ghost"
            className="font-mono uppercase"
            size="sm"
            onClick={() => setNewOpen(true)}
          >
            <Plus className="size-3.5" aria-hidden />
            <Trans>New template</Trans>
          </Button>
        </div>
        <div className="px-3 py-2.5">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                No templates yet. Add one to give new docs in this folder a ready-made starting
                point.
              </Trans>
            </p>
          ) : (
            <ul className="space-y-1">
              {templates.map((tpl) => (
                <TemplateRow
                  key={tpl.path}
                  template={tpl}
                  onCreate={() => setCreateFromTemplate(tpl.name)}
                  onEdit={() =>
                    openManagedArtifactTab(templateContentDocName(tpl.source_folder, tpl.name))
                  }
                  onDelete={() => setDeleteTarget(tpl)}
                  badge={
                    tpl.scope === 'inherited' ? (
                      <InheritedBadge
                        source={tpl.source_folder}
                        target={`templates/${tpl.name}.md`}
                      />
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </section>
      <TemplateDeleteDialog
        template={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={onChange}
      />
      <NewTemplateDialog
        folderPath={folderPath}
        existingNames={new Set(templates.map((tpl) => tpl.name))}
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(createdName) => {
          onChange();
          openManagedArtifactTab(templateContentDocName(folderPath, createdName));
        }}
      />
      <NewItemDialog
        open={createFromTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setCreateFromTemplate(null);
        }}
        kind="file"
        initialDir={folderPath}
        initialTemplate={createFromTemplate ?? undefined}
        folderConfig={folderConfigHandle}
      />
    </>
  );
}
