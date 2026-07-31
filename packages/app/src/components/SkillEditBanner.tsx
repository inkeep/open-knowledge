import { Trans } from '@lingui/react/macro';
import { SquarePen } from 'lucide-react';
import { SkillModeBanner } from '@/components/SkillModeBanner';
import { skillDisplayName } from '@/lib/skill-scope';

/**
 * The edit-in-place banner for a detected skill buffer (`__extskill__/…`) —
 * the editable counterpart of the read-only preview banner, sharing
 * {@link SkillModeBanner}. States plainly that edits save to the editor's own
 * copy. `name` is the skill (not the open file), so the banner is identical
 * whether the open doc is the SKILL.md or one of its reference files. No
 * manage/move flow — the skill stays where it lives.
 */
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
