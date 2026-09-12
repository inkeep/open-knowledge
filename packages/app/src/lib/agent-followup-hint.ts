import { EDITOR_LABELS, type GuidanceRef } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';

export function followupHintText(ref: GuidanceRef | undefined): string | null {
  if (ref === undefined) return null;
  const agentId = ref.params?.agent;
  if (typeof agentId !== 'string') return null;
  const agent = EDITOR_LABELS[agentId as keyof typeof EDITOR_LABELS] ?? agentId;
  if (ref.id !== 'followup.enable-manually') return null;
  return t({
    id: 'followup.enable-manually',
    message: `${agent} keeps project MCP servers off until you turn them on under Customize → MCPs. OpenKnowledge can't see that setting.`,
  });
}
