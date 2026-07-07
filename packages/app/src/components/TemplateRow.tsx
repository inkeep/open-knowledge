import { Trans, useLingui } from '@lingui/react/macro';
import { FilePlus, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TemplateMenuEntry } from '@/hooks/use-folder-config';

interface TemplateRowProps {
  template: TemplateMenuEntry;
  onEdit: () => void;
  onDelete: () => void;
  /**
   * "Create a document from this template." Omit to hide the action — the
   * Settings manager lists templates without an inline create affordance.
   */
  onCreate?: () => void;
  /** Trailing badge (inherited-source indicator, scope label). Omit for none. */
  badge?: ReactNode;
}

/**
 * One row in a template list. Clicking the row body opens edit; a 3-dot menu
 * carries Edit + Delete; an optional `Create` action instantiates a document.
 * Shared by the folder-overview card and the Settings template manager.
 */
export function TemplateRow({ template, onEdit, onDelete, onCreate, badge }: TemplateRowProps) {
  const { t } = useLingui();
  const label = template.title ?? template.name;
  const showName = Boolean(template.title && template.title !== template.name);

  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
      <Button
        type="button"
        variant="ghost"
        onClick={onEdit}
        className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 px-1.5 py-1 text-left font-normal hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-2">
          <span className="truncate font-medium">{label}</span>
          {showName ? (
            <code className="shrink-0 font-mono text-xs text-muted-foreground">
              {template.name}
            </code>
          ) : null}
          {badge ? <span className="ml-auto shrink-0">{badge}</span> : null}
        </span>
        {template.description ? (
          <span className="w-full truncate text-sm text-muted-foreground">
            {template.description}
          </span>
        ) : null}
      </Button>
      {onCreate ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 font-mono uppercase opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onCreate}
          aria-label={t`Create a document from ${label}`}
        >
          <FilePlus className="size-3.5" aria-hidden />
          <Trans>Create</Trans>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={t`Actions for ${label}`}
          >
            <MoreVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil aria-hidden />
            <Trans>Edit</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 aria-hidden />
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
