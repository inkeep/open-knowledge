const SHARE_CONTRACT_EPOCH = 2;
export const SHARE_CONTRACT_CORPUS_SHA256 =
  'e4f5bde6115efe82322865d7467de6be9a0eff47bb0dd5dc49f14a7df7dbce82';

/**
 * Public reader-contract manifest served at
 * `/.well-known/openknowledge-share-contract.json` and polled by the
 * share-contract production monitor (`.github/workflows/share-contract-monitor.yml`).
 *
 * - `epoch` — the reader-contract generation. The monitor fails if production
 *   ever serves an epoch below the one it requires (a backward-incompatible
 *   rollback of the share-URL reader).
 * - `corpusSha256` — SHA-256 of the frozen `share-url-v1-v2.json` fixture the
 *   monitor decodes against, so corpus/reader drift surfaces as a digest
 *   mismatch rather than a silent behavior change.
 * - `deploymentSha` — the commit the live manifest was built from; names the
 *   last-compatible deployment when the monitor alerts.
 */
export interface ShareContractManifest {
  epoch: typeof SHARE_CONTRACT_EPOCH;
  corpusSha256: string;
  deploymentSha: string;
}

export function buildShareContractManifest(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ShareContractManifest {
  return {
    epoch: SHARE_CONTRACT_EPOCH,
    corpusSha256: SHARE_CONTRACT_CORPUS_SHA256,
    deploymentSha: environment.VERCEL_GIT_COMMIT_SHA ?? environment.GITHUB_SHA ?? 'unavailable',
  };
}
