import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ListPlus, MoreVertical } from 'lucide-react';
import { AddPropertiesButton } from '@/components/AddPropertiesButton';
import { SkillEditorActions } from '@/components/SkillEditorActions';
import { SkillLevelSelect } from '@/components/SkillLevelSelect';
import { SkillScopeSegment } from '@/components/SkillScopeSegment';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkillScopeMove } from '@/hooks/use-skill-scope-move';

export function SkillToolbarControls({
  scope,
  name,
  showAddPropertyButton,
  onAddProperty,
  problemCount,
  problemMessages,
}: {
  scope: SkillScope;
  name: string;
  showAddPropertyButton: boolean;
  onAddProperty: () => void;
  problemCount?: number;
  problemMessages?: readonly string[];
}) {
  const { t } = useLingui();
  const move = useSkillScopeMove({ scope, name });

  return (
    <>
      {}
      <div className="flex items-center gap-2">
        <SkillLevelSelect
          value={scope}
          onRequestMove={move.requestMove}
          triggerClassName="hidden @xl/toolbar:flex"
        />
        <SkillEditorActions scope={scope} name={name} />
      </div>
      {showAddPropertyButton ? (
        <AddPropertiesButton
          onAddProperty={onAddProperty}
          problemCount={problemCount}
          problemMessages={problemMessages}
          className="hidden @xl/toolbar:inline-flex"
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`More skill actions`}
            data-testid="skill-toolbar-overflow"
            className="@xl/toolbar:hidden"
          >
            <MoreVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <SkillScopeSegment value={scope} onSelect={(next) => move.requestMove(next)} />
          {showAddPropertyButton ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onAddProperty}>
                <ListPlus />
                <Trans>Add properties</Trans>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {}
      {move.dialog}
    </>
  );
}
