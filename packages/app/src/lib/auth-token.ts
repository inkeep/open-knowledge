import type { HocuspocusAuthToken } from '@inkeep/open-knowledge-server';
import { browserClientVersionTokenFields } from './client-version';

export function buildAuthToken(
  tabIdentity: { principalId: string; tabSessionId: string } | null,
  expectedServerInstanceId: string | null,
  expectedBranch: string | null = null,
  expectedDocLineageEpoch: string | null = null,
): string {
  const claim: HocuspocusAuthToken = { ...browserClientVersionTokenFields() };
  if (tabIdentity !== null) {
    claim.principalId = tabIdentity.principalId;
    claim.tabSessionId = tabIdentity.tabSessionId;
  }
  if (expectedServerInstanceId !== null && expectedServerInstanceId.length > 0) {
    claim.expectedServerInstanceId = expectedServerInstanceId;
  }
  if (expectedBranch !== null && expectedBranch.length > 0) {
    claim.expectedBranch = expectedBranch;
  }
  if (expectedDocLineageEpoch !== null && expectedDocLineageEpoch.length > 0) {
    claim.expectedDocLineageEpoch = expectedDocLineageEpoch;
  }
  return JSON.stringify(claim);
}
