import type { AwarenessUser } from '@inkeep/open-knowledge-core/types/awareness';
import type { Identity } from '@inkeep/open-knowledge-core/types/identity';
import type { Principal } from '@inkeep/open-knowledge-core/types/principal';
import {
  colorFromSeed,
  formatPresenceLabel,
  HUMAN_COLORS,
} from '@inkeep/open-knowledge-core/utils/identity';

type AwarenessUserPayload = AwarenessUser & { type: 'human' };

interface BuildAwarenessUserInput {
  principal: Principal | null;
  identity: Identity;
}

export function buildAwarenessUser({
  principal,
  identity,
}: BuildAwarenessUserInput): AwarenessUserPayload {
  if (principal && principal.source === 'git-config') {
    return {
      type: 'human' as const,
      name: formatPresenceLabel(principal.display_name),
      color: colorFromSeed(principal.id, HUMAN_COLORS),
      coeditor: identity.coeditor,
      tabId: identity.tabId,
      principalId: principal.id,
    };
  }
  if (principal && principal.source === 'synthesized') {
    return {
      type: 'human' as const,
      name: identity.name,
      color: colorFromSeed(principal.id, HUMAN_COLORS),
      coeditor: identity.coeditor,
      tabId: identity.tabId,
    };
  }
  return {
    type: 'human' as const,
    name: identity.name,
    color: identity.color,
    coeditor: identity.coeditor,
    tabId: identity.tabId,
  };
}
