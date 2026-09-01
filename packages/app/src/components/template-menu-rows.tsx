import { Trans } from '@lingui/react/macro';
import type { ComponentType, ReactNode } from 'react';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { sortTemplatesForPicker } from './template-picker-utils';

type MenuItemComponent = ComponentType<{
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  className?: string;
  children?: ReactNode;
}>;

interface TemplateMenuRowsProps {
  parentDir: string;
  onSelectTemplate: (templateName: string) => void;
  ItemComponent: MenuItemComponent;
}

export function TemplateMenuRows({
  parentDir,
  onSelectTemplate,
  ItemComponent,
}: TemplateMenuRowsProps) {
  const { state } = useFolderConfig(parentDir);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <ItemComponent disabled className="text-muted-foreground">
        <Trans>Loading templates</Trans>
      </ItemComponent>
    );
  }

  if (state.status === 'error') {
    return (
      <ItemComponent disabled className="text-muted-foreground">
        <Trans>Couldn't load templates</Trans>
      </ItemComponent>
    );
  }

  const templates = sortTemplatesForPicker(state.data.folder.templates_available ?? []);
  if (templates.length === 0) {
    return (
      <ItemComponent disabled className="text-muted-foreground">
        <Trans>No templates available</Trans>
      </ItemComponent>
    );
  }

  return (
    <>
      {templates.map((tpl) => (
        <ItemComponent
          key={`${tpl.scope}:${tpl.source_folder}:${tpl.name}`}
          onSelect={() => onSelectTemplate(tpl.name)}
        >
          {tpl.title ?? tpl.name}
        </ItemComponent>
      ))}
    </>
  );
}
