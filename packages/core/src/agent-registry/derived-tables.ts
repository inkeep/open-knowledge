import { ALL_EDITOR_IDS, type EditorId } from '../constants/editors.ts';
import type { HandoffTarget, TargetData } from '../handoff/types.ts';
import { AGENT_REGISTRY } from './agents.ts';
import type { AcpHarnessCliId, AgentId } from './ids.ts';
import type { AcpFacet, AgentRecord, ExternalFacet, VerifiedPosture } from './schema.ts';
import type { ConsentClass } from './vocabulary.ts';

type AcpAgent = { record: AgentRecord; acp: AcpFacet };

const ACP_AGENTS: readonly AcpAgent[] = Object.values(AGENT_REGISTRY)
  .flatMap((record) => (record.acp === undefined ? [] : [{ record, acp: record.acp }]))
  .sort((a, b) => a.acp.acpAgentId.localeCompare(b.acp.acpAgentId));

export const ACP_FEATURED_AGENT_IDS: readonly string[] = ACP_AGENTS.filter(
  ({ acp }) => acp.featuredOrder !== null,
)
  .sort((a, b) => (a.acp.featuredOrder ?? 0) - (b.acp.featuredOrder ?? 0))
  .map(({ acp }) => acp.acpAgentId);

export const ACP_AGENT_HARNESS_CLI_MAP: Readonly<Record<string, AcpHarnessCliId | undefined>> =
  Object.fromEntries(
    ACP_AGENTS.flatMap(({ acp }) =>
      acp.harnessCli === null ? [] : [[acp.acpAgentId, acp.harnessCli] as const],
    ),
  );

export const ACP_AGENT_EDITOR_ID_MAP: { readonly [agentId: string]: EditorId | undefined } =
  Object.fromEntries(
    ACP_AGENTS.flatMap(({ acp }) =>
      acp.harnessReadsEditorConfig === null
        ? []
        : [[acp.acpAgentId, acp.harnessReadsEditorConfig] as const],
    ),
  );

export function getAcpFacet(acpAgentId: string): AcpFacet | undefined {
  return ACP_AGENTS.find(({ acp }) => acp.acpAgentId === acpAgentId)?.acp;
}

export function agentIdForAcpAgent(acpAgentId: string): AgentId | undefined {
  return ACP_AGENTS.find(({ acp }) => acp.acpAgentId === acpAgentId)?.record.id;
}

export const ACP_VERIFIED_POSTURE_MAP: {
  readonly [agentId: string]: VerifiedPosture | undefined;
} = Object.fromEntries(
  ACP_AGENTS.flatMap(({ acp }) =>
    acp.verifiedPosture === null ? [] : [[acp.acpAgentId, acp.verifiedPosture] as const],
  ),
);

const EXTERNAL_FACETS: readonly ExternalFacet[] = Object.values(AGENT_REGISTRY)
  .flatMap((record) => (record.external === undefined ? [] : [record.external]))
  .sort((a, b) => a.knownOrder - b.knownOrder);

export const KNOWN_HANDOFF_TARGETS: ReadonlyArray<TargetData> = EXTERNAL_FACETS.map(
  ({ targetId, displayName, appBrandName, schemes, installUrl, tagline }) => ({
    id: targetId,
    displayName,
    ...(appBrandName === undefined ? {} : { appBrandName }),
    schemes,
    installUrl,
    ...(tagline === undefined ? {} : { tagline }),
  }),
);

const VISIBLE_TARGET_IDS = new Set(
  EXTERNAL_FACETS.filter((facet) => facet.visible).map((facet) => facet.targetId),
);

export const VISIBLE_HANDOFF_TARGETS: ReadonlyArray<TargetData> = KNOWN_HANDOFF_TARGETS.filter(
  (target) => VISIBLE_TARGET_IDS.has(target.id),
);

export const CONNECTION_ROW_AGENT_IDS: readonly EditorId[] = ALL_EDITOR_IDS.filter(
  (id) => AGENT_REGISTRY[id].offersConnectionRow,
);

const AGENT_ID_BY_TARGET = new Map<string, AgentId>(
  Object.values(AGENT_REGISTRY).flatMap((record) =>
    record.external === undefined ? [] : [[record.external.targetId, record.id] as const],
  ),
);

export function agentIdForHandoffTarget(targetId: HandoffTarget): AgentId | undefined {
  return AGENT_ID_BY_TARGET.get(targetId);
}

const AGENT_ID_BY_TERMINAL_CLI = new Map<string, AgentId>(
  Object.values(AGENT_REGISTRY).flatMap((record) =>
    record.modes.terminal === undefined ? [] : [[record.id, record.id] as const],
  ),
);

export function agentIdForTerminalCli(cliId: string): AgentId | undefined {
  return AGENT_ID_BY_TERMINAL_CLI.get(cliId);
}

export const PROJECT_MCP_CONSENT_CLASS: { readonly [editorId: string]: ConsentClass | undefined } =
  Object.fromEntries(
    Object.values(AGENT_REGISTRY).flatMap((record) => {
      const consentClass = record.satisfiers.find(
        (satisfier) =>
          satisfier.piece === 'mcp' &&
          satisfier.scope === 'project' &&
          satisfier.consentClass !== 'none',
      )?.consentClass;
      return consentClass === undefined ? [] : [[record.id, consentClass] as const];
    }),
  );

export function projectMcpConsentClass(editorId: string): ConsentClass {
  return PROJECT_MCP_CONSENT_CLASS[editorId] ?? 'none';
}
