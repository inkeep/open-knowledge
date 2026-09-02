import { templateContentDocName } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NewTemplateDialog } from '@/components/NewTemplateDialog';
import { TemplateDeleteDialog } from '@/components/TemplateDeleteDialog';
import { TemplateRow } from '@/components/TemplateRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { type TemplateMenuEntry, useFolderConfig } from '@/hooks/use-folder-config';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import { useSettingsRoute } from '@/lib/use-settings-route';
import type { SettingsScope } from './ScopeBadge';
import { SettingsSectionHeader } from './SettingsSectionHeader';

interface TemplatesManagerConfig {
  scope: TemplateMenuEntry['scope'];
  title: string;
  scopeBadge: SettingsScope;
  description: ReactNode;
  emptyMessage: ReactNode;
  loadErrorTitle: string;
  badge: { label: string; variant: 'primary' | 'gray' };
  settingsId: string;
  testIdPrefix: string;
}

export function TemplatesManagerSection({ config }: { config: TemplatesManagerConfig }) {
  const { state, refresh } = useFolderConfig('');
  const [deleteTarget, setDeleteTarget] = useState<TemplateMenuEntry | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const settingsRoute = useSettingsRoute();

  function openTemplateTab(folder: string, name: string) {
    openManagedArtifactTab(templateContentDocName(folder, name));
    settingsRoute.close();
  }

  const templates: TemplateMenuEntry[] =
    state.status === 'ready'
      ? (state.data.folder.templates_available ?? [])
          .filter((tpl) => tpl.scope === config.scope)
          .sort((a, b) =>
            (a.title ?? a.name).toLowerCase().localeCompare((b.title ?? b.name).toLowerCase()),
          )
      : [];

  if (state.status === 'error') {
    const { loadErrorTitle } = config;
    const { message } = state;
    return (
      <section
        className="space-y-3"
        aria-labelledby={config.settingsId}
        data-testid={`settings-${config.testIdPrefix}-section`}
      >
        <SectionHeader config={config} onNewClick={() => setNewOpen(true)} />
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          <Trans>
            {loadErrorTitle}: {message}
          </Trans>
        </div>
        <NewTemplateDialog
          folderPath=""
          existingNames={new Set()}
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreated={(createdName) => {
            refresh();
            openTemplateTab('', createdName);
          }}
        />
      </section>
    );
  }

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section
        className="space-y-3"
        aria-labelledby={config.settingsId}
        data-testid={`settings-${config.testIdPrefix}-section`}
      >
        <SectionHeader config={config} />
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </section>
    );
  }

  return (
    <section
      className="space-y-3"
      aria-labelledby={config.settingsId}
      data-testid={`settings-${config.testIdPrefix}-section`}
    >
      <SectionHeader config={config} onNewClick={() => setNewOpen(true)} />
      <div className="rounded-lg border bg-card">
        {templates.length === 0 ? (
          <p
            className="px-3 py-4 text-sm text-muted-foreground"
            data-testid={`settings-${config.testIdPrefix}-empty`}
          >
            {config.emptyMessage}
          </p>
        ) : (
          <ul className="space-y-1 p-2" data-testid={`settings-${config.testIdPrefix}-list`}>
            {templates.map((tpl) => (
              <TemplateRow
                key={tpl.name}
                template={tpl}
                onEdit={() => openTemplateTab(tpl.source_folder, tpl.name)}
                onDelete={() => setDeleteTarget(tpl)}
                badge={
                  <Badge variant={config.badge.variant} className="text-2xs">
                    {config.badge.label}
                  </Badge>
                }
              />
            ))}
          </ul>
        )}
      </div>

      <NewTemplateDialog
        folderPath=""
        existingNames={new Set(templates.map((tpl) => tpl.name))}
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(createdName) => {
          refresh();
          openTemplateTab('', createdName);
        }}
      />
      <TemplateDeleteDialog
        template={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={refresh}
      />
    </section>
  );
}

function SectionHeader({
  config,
  onNewClick,
}: {
  config: TemplatesManagerConfig;
  onNewClick?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <SettingsSectionHeader
        titleId={config.settingsId}
        title={config.title}
        scope={config.scopeBadge}
      >
        {config.description}
      </SettingsSectionHeader>
      {onNewClick ? (
        <Button
          variant="outline"
          size="sm"
          className="font-mono uppercase shrink-0"
          onClick={onNewClick}
          data-testid={`settings-${config.testIdPrefix}-new-button`}
        >
          <Plus className="size-3.5" aria-hidden />
          <Trans>New template</Trans>
        </Button>
      ) : null}
    </div>
  );
}
