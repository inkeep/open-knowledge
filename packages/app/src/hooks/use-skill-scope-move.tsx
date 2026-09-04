import type { SkillScope } from '@inkeep/open-knowledge-core';
import { type ReactNode, useState } from 'react';
import { SkillScopeMoveDialog } from '@/components/SkillScopeMoveDialog';

export function useSkillScopeMove({ scope, name }: { scope: SkillScope; name: string }): {
  requestMove: (next: SkillScope) => void;
  dialog: ReactNode;
} {
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
