import { getLogger } from '../logger.ts';
import { gcRenameLog, getOrLoadRenameLogIndex } from '../rename-log.ts';
import {
  enumerateWipChains,
  SERVICE_WRITER,
  type ShadowHandle,
  saveVersion,
  type WriterIdentity,
} from '../shadow-repo.ts';

const log = getLogger('history');

export interface VersionOpsDeps {
  getCurrentBranch?: () => string | null;
  contentRoot?: string;
}

export interface VersionOpsService {
  saveCheckpoint(
    shadow: ShadowHandle,
    input: {
      explicitWriters: WriterIdentity[];
      agentWriter?: WriterIdentity;
      summary?: string;
    },
  ): Promise<{ checkpointRef: string }>;
}

export function createVersionOpsService(deps: VersionOpsDeps): VersionOpsService {
  return {
    async saveCheckpoint(shadow, input) {
      let writers = input.explicitWriters;
      let foldEnumeratedAll = false;

      const branch = deps.getCurrentBranch?.() ?? 'main';

      if (writers.length === 0) {
        if (input.agentWriter) {
          writers = [input.agentWriter];
        } else {
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

      try {
        await gcRenameLog(shadow, getOrLoadRenameLogIndex(shadow.gitDir));
      } catch (err) {
        log.warn({ err }, '[rename-log] post-saveVersion GC failed');
      }

      return { checkpointRef: result.checkpointRef };
    },
  };
}
