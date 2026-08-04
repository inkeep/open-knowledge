import { getLogger } from '../logger.ts';
import { gcRenameLog, getOrLoadRenameLogIndex } from '../rename-log.ts';
import {
  enumerateWipChains,
  SERVICE_WRITER,
  type ShadowHandle,
  saveVersion,
  type WriterIdentity,
} from '../shadow-repo.ts';

/**
 * Save-version checkpoint policy. The transport validates writer shapes and
 * threads identity; this module owns writer resolution — explicit list >
 * agent-scoped > fold-everything — and the checkpoint + rename-log GC
 * sequencing that follows.
 */

const log = getLogger('history');

export interface VersionOpsDeps {
  getCurrentBranch?: () => string | null;
  contentRoot?: string;
}

export interface VersionOpsService {
  saveCheckpoint(
    shadow: ShadowHandle,
    input: {
      /** Pre-validated explicit writers from the request body; [] when absent. */
      explicitWriters: WriterIdentity[];
      /** Agent-scoped writer (MCP checkpoint tool path), when the body carried an agentId. */
      agentWriter?: WriterIdentity;
      /** Normalized checkpoint summary, when present. */
      summary?: string;
    },
  ): Promise<{ checkpointRef: string }>;
}

export function createVersionOpsService(deps: VersionOpsDeps): VersionOpsService {
  return {
    async saveCheckpoint(shadow, input) {
      let writers = input.explicitWriters;
      // True only on the empty-body button path, where `enumerateWipChains`
      // already surfaces EVERY WIP chain — upstream included. That makes the
      // enumerated set the complete fold list, so saveVersion must not re-append
      // the upstream writer (a second rev-parse + a no-op delete on the
      // already-reset ref). The explicit-writers and explicit-agentId paths do
      // not enumerate upstream and keep the default (fold it).
      let foldEnumeratedAll = false;

      // Active branch: the button consolidates the branch the user
      // is on, not a hardcoded 'main'.
      const branch = deps.getCurrentBranch?.() ?? 'main';

      if (writers.length === 0) {
        if (input.agentWriter) {
          // Explicit agentId path (MCP checkpoint tool) — scoped to that agent.
          writers = [input.agentWriter];
        } else {
          // A true empty-body Save Version (the UI button) consolidates ALL
          // non-park WIP chains on the active branch — agent + principal +
          // classified — so the button matches the user's "group everything I've
          // done into a version" mental model. Park-tipped refs hold
          // branch-switch state and are excluded. Falls back to the service
          // writer when there is no WIP activity at all (an empty checkpoint).
          const chains = await enumerateWipChains(shadow, branch);
          const foldable = chains.filter((c) => !c.isPark);
          writers =
            foldable.length > 0
              ? foldable.map((c) => ({
                  id: c.writerId,
                  name: c.writerId,
                  email: `${c.writerId}@openknowledge.local`,
                }))
              : [SERVICE_WRITER];
          foldEnumeratedAll = true;
        }
      }

      const result = await saveVersion(
        shadow,
        deps.contentRoot ?? '.',
        writers,
        branch,
        input.summary,
        foldEnumeratedAll ? { includeUpstream: false } : undefined,
      );

      log.info({ checkpointRef: result.checkpointRef }, 'checkpoint');

      // Rename-log GC trigger: saveVersion deletes WIP refs, which is the
      // largest entry-death cliff. Run reachability sweep (no rebuild —
      // boot already covered that).
      try {
        await gcRenameLog(shadow, getOrLoadRenameLogIndex(shadow.gitDir));
      } catch (err) {
        log.warn({ err }, '[rename-log] post-saveVersion GC failed');
      }

      return { checkpointRef: result.checkpointRef };
    },
  };
}
