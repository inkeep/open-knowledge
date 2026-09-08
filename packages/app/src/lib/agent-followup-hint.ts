import { EDITOR_LABELS, type GuidanceRef } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';

export function followupHintText(ref: GuidanceRef | undefined): string | null {
  if (ref === undefined) return null;
  const agentId = ref.params?.agent;
  if (typeof agentId !== 'string') return null;
  const agent = EDITOR_LABELS[agentId as keyof typeof EDITOR_LABELS] ?? agentId;
  switch (ref.id) {
    case 'followup.approve-once':
      return t({
        id: 'followup.approve-once',
        message: `One more step: run ${agent} in this project and approve OpenKnowledge once.`,
      });
    case 'followup.enable-manually':
      return t({
        id: 'followup.enable-manually',
        message: `One more step: enable it in ${agent} → Settings → Tools & MCP (${agent} leaves project servers off until you turn them on).`,
      });
    case 'followup.trust-gated':
      return t({
        id: 'followup.trust-gated',
        message: `Connects automatically the next time you open this project in a trusted ${agent} session.`,
      });
    default:
      return null;
  }
}
