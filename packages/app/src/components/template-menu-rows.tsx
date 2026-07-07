import { Trans } from '@lingui/react/macro';
import type { ComponentType, ReactNode } from 'react';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { sortTemplatesForPicker } from './template-picker-utils';

/**
 * Minimal structural contract shared by shadcn `DropdownMenuItem` and
 * `ContextMenuItem` — the two surfaces this row renderer is dropped into. Both
 * accept the Radix `onSelect` (a DOM `Event`, NOT a React synthetic event) plus
 * `disabled`/`className`/`children`, so a single rows renderer can serve the
 * dropdown-based folder + toolbar menus and the context-menu-based empty-space
 * menu without duplicating the fetch/loading/empty branches three times.
 */
type MenuItemComponent = ComponentType<{
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  className?: string;
  children?: ReactNode;
}>;

interface TemplateMenuRowsProps {
  /** Folder whose resolved template cascade to list (project-root-relative; '' = root). */
  parentDir: string;
  /** Fires with the picked template's `name` (filename without extension). */
  onSelectTemplate: (templateName: string) => void;
  /** `DropdownMenuItem` or `ContextMenuItem`, depending on the host menu family. */
  ItemComponent: MenuItemComponent;
}

/**
 * Template list for the "New from template" menu surfaces. Mounted as a child
 * of an open submenu/dropdown content node, so `useFolderConfig` only fetches
 * once the user actually expands the menu — closed menus don't mount it. The
 * loading/error/empty states render as a single disabled row rather than a
 * spinner so the menu height stays stable as the fetch resolves.
 */
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
        // value-unique key mirrors NewItemDialog's picker: a folder can resolve
        // two templates with the same display title from different scopes.
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
