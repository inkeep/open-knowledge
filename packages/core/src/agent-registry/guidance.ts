import { z } from 'zod';
import { AgentIdSchema } from './ids.ts';
import type { ConsentClass } from './vocabulary.ts';

export interface GuidanceEntry {
  readonly params: z.ZodObject;
}

export type FollowupGuidanceKey = `followup.${Exclude<ConsentClass, 'none'>}`;

const agentParam = { agent: AgentIdSchema };

export const GUIDANCE_IDS = {
  'followup.approve-once': { params: z.strictObject(agentParam) },
  'followup.enable-manually': { params: z.strictObject(agentParam) },
  'followup.trust-gated': { params: z.strictObject(agentParam) },

  'guidance.mcp.user-config': { params: z.strictObject(agentParam) },
  'guidance.mcp.project-config': { params: z.strictObject(agentParam) },
  'guidance.mcp.session-injection': { params: z.strictObject(agentParam) },
  'guidance.mcp.managed-file': { params: z.strictObject(agentParam) },
  'guidance.skill.project': { params: z.strictObject(agentParam) },
  'guidance.skill.user': { params: z.strictObject(agentParam) },
  'guidance.skill.central-store': { params: z.strictObject(agentParam) },

  'troubleshooting.claude.project-entry-not-approved': { params: z.strictObject(agentParam) },
  'troubleshooting.claude-desktop.per-tool-approval': { params: z.strictObject(agentParam) },
  'troubleshooting.cursor.project-entry-not-loaded': { params: z.strictObject(agentParam) },
  'troubleshooting.codex.desktop-project-config': {
    params: z.strictObject({ ...agentParam, honoredByDesktop: z.boolean() }),
  },
  'troubleshooting.copilot.shared-workspace-config': {
    params: z.strictObject({ ...agentParam, sourceAgent: AgentIdSchema }),
  },
  'troubleshooting.openclaw.central-store-missing': { params: z.strictObject(agentParam) },
  'troubleshooting.pi.folder-trust': { params: z.strictObject(agentParam) },
  'troubleshooting.lm-studio.config-path-mismatch': { params: z.strictObject(agentParam) },
} as const satisfies Record<string, GuidanceEntry> & Record<FollowupGuidanceKey, GuidanceEntry>;

export type GuidanceKey = keyof typeof GUIDANCE_IDS;

export const GUIDANCE_KEYS: readonly GuidanceKey[] = (
  Object.keys(GUIDANCE_IDS) as GuidanceKey[]
).sort();

export const GUIDANCE_NAMESPACES = ['guidance', 'followup', 'troubleshooting'] as const;
export type GuidanceNamespace = (typeof GUIDANCE_NAMESPACES)[number];

export function isGuidanceKey(value: string): value is GuidanceKey {
  return Object.hasOwn(GUIDANCE_IDS, value);
}

export function getGuidanceEntry(key: string): GuidanceEntry | undefined {
  return isGuidanceKey(key) ? GUIDANCE_IDS[key] : undefined;
}

export function guidanceNamespaceOf(value: string): GuidanceNamespace | null {
  const head = value.split('.')[0];
  return GUIDANCE_NAMESPACES.find((namespace) => namespace === head) ?? null;
}

export function guidanceParamNames(key: GuidanceKey): readonly string[] {
  return Object.keys(GUIDANCE_IDS[key].params.shape).sort();
}
