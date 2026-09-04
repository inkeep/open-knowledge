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

export type AddSkillTab = 'skills-sh' | 'upload';

interface Props {
  defaultScope: SkillScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: AddSkillTab;
  onImported: (imported: { scope: SkillScope; name: string }) => void;
}

export function ImportSkillDialog({
  defaultScope,
  open,
  onOpenChange,
  defaultTab = 'skills-sh',
  onImported,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add skill</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Browse or upload a skill for this project.</Trans>
          </DialogDescription>
        </DialogHeader>
        {}
        <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList variant="line" className="w-full justify-start gap-4 border-b p-0">
            <TabsTrigger variant="line" value="skills-sh">
              <Trans>Explore</Trans>
            </TabsTrigger>
            <TabsTrigger variant="line" value="upload">
              <Trans>Upload</Trans>
            </TabsTrigger>
          </TabsList>
          {}
          <TabsContent value="skills-sh" className="h-[62vh] min-h-0 flex-none">
            <ExploreSkills scope={defaultScope} onNavigate={() => onOpenChange(false)} />
          </TabsContent>
          {}
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
