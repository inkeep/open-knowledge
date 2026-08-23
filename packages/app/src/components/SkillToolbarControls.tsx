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

/**
 * The skill-specific toolbar cluster (level + install + add-properties), with a
 * container-query collapse so it degrades gracefully as the editor pane narrows.
 * Above `@xl/toolbar` everything sits inline; below it the Level picker and
 * Add-properties fold into a single overflow menu, leaving only the install pill
 * + overflow + panel toggle in the row so the controls never overlap the
 * centered mode toggle or the provenance line. The install pill stays visible at
 * every width — it's the primary skill affordance.
 *
 * Breakpoint is `@xl/toolbar` (36rem); tune both the visibility class here and
 * the container on `EditorToolbar` together.
 */
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
  /** Schema-required properties the skill doc is missing — badged on the
   *  Add-properties button, the same surface non-skill docs use. */
  problemCount?: number;
  problemMessages?: readonly string[];
}) {
  const { t } = useLingui();
  const move = useSkillScopeMove({ scope, name });

  return (
    <>
      {/* `gap-2` so the two bordered dropdowns don't read as cramped next to the
          ghost icon buttons (whose padding adds visual air). */}
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
      {/* Rendered outside the DropdownMenu so selecting a level (which closes the
          menu) doesn't unmount the confirm dialog before it can open. */}
      {move.dialog}
    </>
  );
}
