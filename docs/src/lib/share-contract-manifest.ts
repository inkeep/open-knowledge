const SHARE_CONTRACT_EPOCH = 2;
export const SHARE_CONTRACT_CORPUS_SHA256 =
  'e4f5bde6115efe82322865d7467de6be9a0eff47bb0dd5dc49f14a7df7dbce82';

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
