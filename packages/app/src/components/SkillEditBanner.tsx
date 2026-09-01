import { Trans } from '@lingui/react/macro';
import { SquarePen } from 'lucide-react';
import { SkillModeBanner } from '@/components/SkillModeBanner';
import { skillDisplayName } from '@/lib/skill-scope';

export function SkillEditBanner({ name }: { name: string }) {
  const boldName = (
    <strong className="font-medium text-foreground">{skillDisplayName(name)}</strong>
  );
  return (
    <SkillModeBanner icon={<SquarePen className="size-4" aria-hidden />}>
      <Trans>Editing {boldName} in place. Changes save straight to your editor's copy.</Trans>
    </SkillModeBanner>
  );
}
