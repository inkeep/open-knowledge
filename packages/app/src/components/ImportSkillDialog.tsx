import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { ExploreSkills } from '@/components/ExploreSkills';
import { ImportSkillForm } from '@/components/ImportSkillForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** Which way to add a skill the modal opens on. ("New skill" is not a tab — it's a
 *  direct blank-create, so both the sidebar and the Skills home create inline.) */
export type AddSkillTab = 'skills-sh' | 'upload';

interface Props {
  defaultScope: SkillScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which tab to open on. Defaults to the skills.sh directory. */
  defaultTab?: AddSkillTab;
  /** Called after a skill lands (uploaded, imported, or freshly created). */
  onImported: (imported: { scope: SkillScope; name: string }) => void;
}

/**
 * One door for adding a skill to the project, as source tabs: browse the
 * skills.sh directory, Upload one you have (a remote git URL / `owner/repo`, or a
 * local `.zip` / folder), or start Blank (name + description, edit the body
 * after). Skills already present in your other tools are surfaced separately as
 * read-only "Detected" rows in the Skills sidebar, not here. Each pane owns its
 * own work; Radix unmounts inactive tabs, so a source only loads when opened.
 */
export function ImportSkillDialog({
  defaultScope,
  open,
  onOpenChange,
  defaultTab = 'skills-sh',
  onImported,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Content-sized (capped at 85vh), not a fixed 80vh: the skills.sh browse
          pane is a tall list that pins itself to a definite height and scrolls
          internally, while the Upload/Blank form panes are short and size to
          their content so the footer sits right under the form instead of
          floating at the bottom of a fixed-height sheet. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add skill</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Browse or upload a skill for this project.</Trans>
          </DialogDescription>
        </DialogHeader>
        {/* Line-style (underlined) tabs — the trigger's `line` variant pairs with
            the list's `line` variant for the border-b underline strip. */}
        <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList variant="line" className="w-full justify-start gap-4 border-b p-0">
            <TabsTrigger variant="line" value="skills-sh">
              <Trans>Explore</Trans>
            </TabsTrigger>
            <TabsTrigger variant="line" value="upload">
              <Trans>Upload</Trans>
            </TabsTrigger>
          </TabsList>
          {/* Browse pane: definite height (its `h-full` internal scroll region
              needs a concrete parent height) so the long list gets room. */}
          <TabsContent value="skills-sh" className="h-[62vh] min-h-0 flex-none">
            <ExploreSkills scope={defaultScope} onNavigate={() => onOpenChange(false)} />
          </TabsContent>
          {/* Form panes: complete the flex + min-h-0 chain from the max-h
              DialogContent down to each form's DialogBody (`flex-1 min-h-0
              overflow-y-auto`). Because DialogContent is `max-h` (not a fixed
              height), a short form still content-sizes with the footer directly
              under it, while a tall form lets the DialogBody scroll and pins the
              footer at the bottom. `gap-6` stands in for DialogContent's own gap
              so the body↔footer spacing matches the standalone dialogs. */}
          <TabsContent value="upload" className="mt-3 flex min-h-0 flex-1 flex-col gap-6">
            <ImportSkillForm
              defaultScope={defaultScope}
              onOpenChange={onOpenChange}
              onImported={onImported}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
