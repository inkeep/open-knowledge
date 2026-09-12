import {
  ALL_AGENT_IDS,
  buildProbeSnapshot,
  type DetectionSnapshot,
  EMPTY_DETECTION_SNAPSHOT,
  type HostSnapshot,
  type ProbeResolver,
} from '@inkeep/open-knowledge-core';
import { detectedEditorsFromProbes, type EditorPresenceProbes } from './integrations-settings.ts';

export async function detectAgentsForRegistry(
  probeEditorPresence: () => Promise<EditorPresenceProbes>,
): Promise<DetectionSnapshot> {
  let detected: ReadonlySet<string>;
  try {
    detected = detectedEditorsFromProbes(await probeEditorPresence());
  } catch {
    return EMPTY_DETECTION_SNAPSHOT;
  }
  return { detected: ALL_AGENT_IDS.filter((id) => detected.has(id)), probed: true };
}

export interface DesktopHostSnapshotOptions {
  readonly resolve: ProbeResolver;
  readonly probeEditorPresence?: () => Promise<EditorPresenceProbes>;
}

export async function collectDesktopHostSnapshot(
  options: DesktopHostSnapshotOptions,
): Promise<HostSnapshot> {
  return {
    probes: await buildProbeSnapshot({ env: 'desktop', resolve: options.resolve }),
    detection:
      options.probeEditorPresence === undefined
        ? EMPTY_DETECTION_SNAPSHOT
        : await detectAgentsForRegistry(options.probeEditorPresence),
  };
}

export function withoutProjectScope(resolve: ProbeResolver): ProbeResolver {
  return (item) => (item.scope === 'project' ? null : resolve(item));
}
