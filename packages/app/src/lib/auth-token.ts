import type { HocuspocusAuthToken } from '@inkeep/open-knowledge-server';
import { browserClientVersionTokenFields } from './client-version';

/**
 * Build the stringified JSON `token` HocuspocusProvider sends on every connect.
 *
 * Always returns a token: the client's version metadata (the v1 wire contract's
 * WS carrier) is included unconditionally, so even an anonymous tab now sends a
 * token. This is inert on a current (read-blind) server — the `.loose()`,
 * all-optional `HocuspocusAuthTokenSchema` parses it, an absent `principalId`
 * still falls through to SERVICE_WRITER attribution, and the extra version
 * fields are ignored.
 *
 * Lives in `lib/` (a layering leaf) so both the editor provider pool and the
 * lib-side config providers share one token serializer without a lib→editor
 * import. Pure: its only runtime dependency is `browserClientVersionTokenFields`.
 */
export function buildAuthToken(
  tabIdentity: { principalId: string; tabSessionId: string } | null,
  expectedServerInstanceId: string | null,
  expectedBranch: string | null = null,
  expectedDocLineageEpoch: string | null = null,
): string {
  // Type is type-only-imported from the server package — the schema's
  // single source of truth is `HocuspocusAuthTokenSchema`. Adding a field
  // there propagates to the type consumed here with no client-side drift.
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
