import {
  buildProbeSnapshot,
  EMPTY_DETECTION_SNAPSHOT,
  type EnvTier,
  type HostSnapshot,
  type ProbeResolver,
} from '@inkeep/open-knowledge-core';

export interface ServerProbeOptions {
  readonly env: EnvTier;
  readonly resolve?: ProbeResolver;
}

export function createServerProbeResolver(options: ServerProbeOptions): ProbeResolver {
  const { env, resolve } = options;
  return (item) => {
    if (resolve === undefined) return null;
    if (env === 'remote-web' && item.scope === 'user') return { state: 'unprobed' };
    return resolve(item);
  };
}

export async function collectServerHostSnapshot(
  options: ServerProbeOptions,
): Promise<HostSnapshot> {
  return {
    probes: await buildProbeSnapshot({
      env: options.env,
      resolve: createServerProbeResolver(options),
    }),
    detection: EMPTY_DETECTION_SNAPSHOT,
  };
}
