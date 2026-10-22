import { useLingui } from '@lingui/react/macro';
import { ArrowLeftRight } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { swapEditorSidebars } from '@/lib/sidebar-side-store';

export function EditorSidebarsContextMenu({ children }: { readonly children: ReactNode }) {
  const { t } = useLingui();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-editor-sidebars-menu-trigger="" className="contents">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem data-swap-editor-sidebars="" onSelect={() => swapEditorSidebars()}>
          <ArrowLeftRight aria-hidden="true" />
          {t`Swap file sidebar and document panel`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
