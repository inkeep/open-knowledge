import type { TerminalCli } from '@inkeep/open-knowledge-core';
import type { RegisteredAgent } from '@/lib/acp/registered-agents';

export type NewSessionChoice =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'cli'; readonly cli: TerminalCli }
  | { readonly kind: 'agent'; readonly agent: RegisteredAgent | null };
