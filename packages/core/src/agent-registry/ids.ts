import { z } from 'zod';
import { ALL_EDITOR_IDS, type EditorId } from '../constants/editors.ts';
import { TERMINAL_CLI_IDS } from '../handoff/terminal-launch.ts';
import type { HandoffTarget } from '../handoff/types.ts';
import { SatisfierKindSchema } from './vocabulary.ts';

export type AgentId = EditorId | 'gemini';

export const ALL_AGENT_IDS = [...ALL_EDITOR_IDS, 'gemini'] as const satisfies readonly AgentId[];

export const AgentIdSchema = z.enum(ALL_AGENT_IDS);

export function isAgentId(value: string): value is AgentId {
  return (ALL_AGENT_IDS as readonly string[]).includes(value);
}

export const AGENT_MODES = ['acp', 'terminal', 'external'] as const;
export const AgentModeSchema = z.enum(AGENT_MODES);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const ACP_HARNESS_CLI_IDS = [...TERMINAL_CLI_IDS, 'gemini'] as const;
export const AcpHarnessCliIdSchema = z.enum(ACP_HARNESS_CLI_IDS);
export type AcpHarnessCliId = z.infer<typeof AcpHarnessCliIdSchema>;

export const HANDOFF_TARGET_IDS = [
  'claude-cowork',
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'pi',
  'antigravity',
  'openclaw',
  'hermes',
] as const satisfies readonly HandoffTarget[];
export const HandoffTargetIdSchema = z.enum(HANDOFF_TARGET_IDS);

export const INTEGRATION_PIECES = ['mcp', 'skill'] as const;
export const IntegrationPieceSchema = z.enum(INTEGRATION_PIECES);
export type IntegrationPiece = z.infer<typeof IntegrationPieceSchema>;

export const SATISFIER_SCOPES = ['project', 'user', 'session'] as const;
export const SatisfierScopeSchema = z.enum(SATISFIER_SCOPES);
export type SatisfierScope = z.infer<typeof SatisfierScopeSchema>;

export type SatisfierId = string & { readonly __brand: 'SatisfierId' };

export type PathId = string & { readonly __brand: 'PathId' };

export type GuidanceId = string & { readonly __brand: 'GuidanceId' };

const SATISFIER_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/;

export const SatisfierIdSchema = z
  .string()
  .regex(SATISFIER_ID_PATTERN)
  .transform((value) => value as SatisfierId);

export const PathIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as PathId);

export const GuidanceIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as GuidanceId);

export function satisfierId(parts: {
  agent: AgentId;
  piece: IntegrationPiece;
  scope: SatisfierScope;
  kind: z.infer<typeof SatisfierKindSchema>;
}): SatisfierId {
  return `${parts.agent}/${parts.piece}/${parts.scope}/${parts.kind}` as SatisfierId;
}

export function parseSatisfierId(id: string): {
  agent: AgentId;
  piece: IntegrationPiece;
  scope: SatisfierScope;
  kind: z.infer<typeof SatisfierKindSchema>;
} | null {
  const [agent, piece, scope, kind] = id.split('/');
  if (agent === undefined || piece === undefined || scope === undefined || kind === undefined) {
    return null;
  }
  if (!isAgentId(agent)) return null;
  const parsedPiece = IntegrationPieceSchema.safeParse(piece);
  const parsedScope = SatisfierScopeSchema.safeParse(scope);
  const parsedKind = SatisfierKindSchema.safeParse(kind);
  if (!parsedPiece.success || !parsedScope.success || !parsedKind.success) return null;
  return { agent, piece: parsedPiece.data, scope: parsedScope.data, kind: parsedKind.data };
}

export function pathId(value: string): PathId {
  return value as PathId;
}

export function guidanceId(value: string): GuidanceId {
  return value as GuidanceId;
}
