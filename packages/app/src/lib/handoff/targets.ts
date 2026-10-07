import {
  type HandoffHostPlatform,
  isHandoffTargetSupportedOn,
} from '@inkeep/open-knowledge-core/agent-registry';
import type { TargetData } from '@inkeep/open-knowledge-core/handoff';

export {
  KNOWN_HANDOFF_TARGETS as KNOWN_TARGETS,
  VISIBLE_HANDOFF_TARGETS as VISIBLE_TARGETS,
} from '@inkeep/open-knowledge-core/agent-registry';

export function isTargetOfferedOnHost(
  target: Pick<TargetData, 'platforms'>,
  host: { platform: HandoffHostPlatform | null | undefined; installed: boolean | null | undefined },
): boolean {
  return host.installed === true || isHandoffTargetSupportedOn(target, host.platform);
}
