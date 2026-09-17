type CandidateSource = 'acp-session' | 'native-cli' | 'remembered' | 'agent-default';

type CandidateFreshness =
  | { readonly kind: 'live' }
  | { readonly kind: 'cached'; readonly at: number }
  | { readonly kind: 'stale'; readonly at: number }
  | { readonly kind: 'unknown' };

type CandidateSelectability = 'advertised' | 'candidate' | 'rejected' | 'unavailable';

type ContextOrigin = 'native-catalog' | 'session-usage' | 'model-variant' | 'unknown';

interface ContextWindow {
  readonly effectiveTokens: number;
  readonly origin: ContextOrigin;
}

type SetPhase = 'acp-post-create' | 'launch-only';

export interface ScopeFingerprint {
  readonly harness: string;
  readonly cliVersion: string | null;
  readonly adapterVersion: string | null;
  readonly endpoint: string | null;
  readonly account: string | null;
}

export interface ModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly group: string | null;
  readonly source: CandidateSource;
  readonly fingerprint: ScopeFingerprint;
  readonly freshness: CandidateFreshness;
  readonly selectability: CandidateSelectability;
  readonly context: ContextWindow | null;
  readonly contextChoices: readonly number[];
  readonly setPhase: SetPhase;
}

export function sameScope(a: ScopeFingerprint, b: ScopeFingerprint): boolean {
  return (
    a.harness === b.harness &&
    a.cliVersion === b.cliVersion &&
    a.adapterVersion === b.adapterVersion &&
    a.endpoint === b.endpoint &&
    a.account === b.account
  );
}
