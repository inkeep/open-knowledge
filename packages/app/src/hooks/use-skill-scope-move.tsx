import type { SkillScope } from '@inkeep/open-knowledge-core';
import { type ReactNode, useState } from 'react';
import { SkillScopeMoveDialog } from '@/components/SkillScopeMoveDialog';

/**
 * Shared scope-move flow for a skill's level control. Picking a level stages a
 * confirm dialog (moving a skill relocates its files on disk and re-installs it
 * into your editors), and only commits on confirm. The toolbar drives this from
 * two surfaces — a `Select` at comfortable widths and an overflow submenu when
 * narrow — so keeping the move logic here means both share one implementation.
 *
 * Render `dialog` from a node that stays mounted independent of any menu's open
 * state: a menu that unmounts its content on selection would otherwise take the
 * dialog down with it before it can open.
 */
export function useSkillScopeMove({ scope, name }: { scope: SkillScope; name: string }): {
  requestMove: (next: SkillScope) => void;
  dialog: ReactNode;
} {
  // Staged target — the confirm dialog owns the actual move (shared with the
  // three-dot menu via `SkillScopeMoveDialog`); this hook just stages the target.
  const [pendingScope, setPendingScope] = useState<SkillScope | null>(null);
  return {
    requestMove: (next) => {
      if (next !== scope) setPendingScope(next);
    },
    dialog: (
      <SkillScopeMoveDialog
        target={pendingScope ? { scope, name, toScope: pendingScope } : null}
        onOpenChange={(open) => !open && setPendingScope(null)}
      />
    ),
  };
}
