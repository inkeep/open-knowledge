import { Sparkles, SquareTerminal } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { EditorPaneIcon } from '@/components/icons/editor-pane';
import type { PaneId } from '@/lib/pane-visibility-store';

export const PANE_ICON = {
  editor: EditorPaneIcon,
  agents: Sparkles,
  terminal: SquareTerminal,
} as const satisfies Record<PaneId, ComponentType<SVGProps<SVGSVGElement>>>;
