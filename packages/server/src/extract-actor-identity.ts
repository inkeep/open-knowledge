import type { Principal } from '@inkeep/open-knowledge-core';
import { parseAgentBodyFields, resolveAgentType } from './agent-id.ts';
import { type NormalizedSummary, normalizeSummary } from './agent-write-summary.ts';

interface ActorMetadata {
  principalId?: string;
  agentType?: string;
  clientName?: string;
  clientVersion?: string;
  label?: string;
}

type ActorIdentity =
  | {
      kind: 'agent';
      writerId: string;
      displayName: string;
      colorSeed: string;
      clientName: string | undefined;
      clientVersion: string | undefined;
      label: string | undefined;
      actor: ActorMetadata;
      summary: NormalizedSummary;
    }
  | {
      kind: 'principal';
      writerId: string;
      displayName: string;
      colorSeed: string;
      actor: ActorMetadata;
      summary: NormalizedSummary;
    }
  | {
      kind: 'anonymous';
      summary: NormalizedSummary;
    }
  | { kind: 'invalid-summary' };

/**
 * Identity boundary for rename + rollback handlers.
 *
 * Routing:
 *   body.agentId valid + non-empty → 'agent'    (writerId = agent-<id>)
 *   no agentId, getPrincipal() → principal     → 'principal' (writerId = principal-<uuid>)
 *   no agentId, getPrincipal() → null         → 'anonymous' (no contributor recorded)
 *
 * The 'agent' branch ALSO populates `actor.principalId` from getPrincipal() so the
 * agent-on-behalf-of-principal audit trail mirrors `buildAgentActor` for non-rename
 * writes. Body-supplied `principalId` is intentionally never read — server's
 * getPrincipal() is the only source of principal identity (HTTP body is unauthenticated).
 */
export function extractActorIdentity(
  body: Record<string, unknown>,
  getPrincipal: (() => Principal | null) | undefined,
): ActorIdentity {
  const summary = normalizeSummary(body.summary);
  if (summary.kind === 'invalid') {
    return { kind: 'invalid-summary' };
  }

  const fields = parseAgentBodyFields(body);
  const principal = getPrincipal?.() ?? null;

  if (fields.rawAgentId !== undefined && fields.writerId !== undefined) {
    return {
      kind: 'agent',
      writerId: fields.writerId,
      displayName: fields.displayName,
      colorSeed: fields.colorSeed ?? fields.rawAgentId,
      clientName: fields.clientName,
      clientVersion: fields.clientVersion,
      label: fields.label,
      actor: {
        principalId: principal?.id,
        agentType: resolveAgentType(fields.clientName),
        clientName: fields.clientName,
        clientVersion: fields.clientVersion,
        label: fields.label,
      },
      summary,
    };
  }

  if (principal) {
    return {
      kind: 'principal',
      writerId: principal.id,
      displayName: principal.display_name,
      colorSeed: principal.id,
      actor: { principalId: principal.id },
      summary,
    };
  }

  return { kind: 'anonymous', summary };
}
