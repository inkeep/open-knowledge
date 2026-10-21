import { z } from 'zod';

export const AGENT_WRITE_OUTCOMES = [
  'applied',
  'merged-first',
  'both-kept',
  'refused',
  'projection-held',
] as const;
export type AgentWriteOutcome = (typeof AGENT_WRITE_OUTCOMES)[number];

export const AGENT_WRITE_NEXT_STEPS = ['retry', 're-read', 'none'] as const;
export type AgentWriteNextStep = (typeof AGENT_WRITE_NEXT_STEPS)[number];

export interface AgentWriteOutcomeFields {
  readonly outcome: AgentWriteOutcome;
  readonly saved: boolean;
  readonly nextStep: AgentWriteNextStep;
}

export const AGENT_WRITE_OUTCOME_MEANINGS: Readonly<Record<AgentWriteOutcome, string>> = {
  applied:
    'the write landed and is saved to the file; carry on, or re-read first when nextStep says re-read (the stored text differs from what was sent)',
  'merged-first':
    'an outside change to the file was handled before the write was saved (merged in, or saved to the document history when it could not be merged); the write landed; re-read before the next edit',
  'both-kept':
    'the write landed and is saved, and for a block changed both here and outside both versions are in the document, this side first; never retry it; re-read and tidy the duplicate with an ordinary edit if the task calls for it',
  refused:
    'not saved; OpenKnowledge saves it only after someone acts: the agent, as nextStep says, or the user; follow nextStep',
  'projection-held':
    'the write is in the document but not yet in its file, and OpenKnowledge saves it on its own (on either runtime: a held local save or a held cloud projection); never retry it; re-read before the next edit',
};

export const AGENT_WRITE_NEXT_STEP_MEANINGS: Readonly<Record<AgentWriteNextStep, string>> = {
  retry:
    'the write did not land; send it again, corrected the way the detail says or after the wait it names',
  're-read': 're-read the document before doing anything further with it',
  none: 'nothing more to do on this document: with applied, carry on; with refused, nothing the agent sends changes it, so tell the user what the detail says',
};

export function isAgentWriteOutcome(value: unknown): value is AgentWriteOutcome {
  return (AGENT_WRITE_OUTCOMES as readonly unknown[]).includes(value);
}

export function isAgentWriteNextStep(value: unknown): value is AgentWriteNextStep {
  return (AGENT_WRITE_NEXT_STEPS as readonly unknown[]).includes(value);
}

export const agentWriteOutcomeWireFields = {
  outcome: z.string().optional(),
  saved: z.boolean().optional(),
  nextStep: z.string().optional(),
} as const;

export interface NormalizedAgentWriteOutcome {
  readonly outcome: AgentWriteOutcome;
  readonly saved?: boolean;
  readonly nextStep?: AgentWriteNextStep;
  readonly unknownOutcome?: string;
  readonly unknownNextStep?: string;
}

function normalizedNextStep(
  raw: unknown,
): Pick<NormalizedAgentWriteOutcome, 'nextStep' | 'unknownNextStep'> {
  if (raw === undefined) return {};
  if (isAgentWriteNextStep(raw)) return { nextStep: raw };
  return { nextStep: 're-read', unknownNextStep: String(raw) };
}

export function normalizeAgentWriteOutcome(raw: {
  readonly outcome?: unknown;
  readonly saved?: unknown;
  readonly nextStep?: unknown;
}): NormalizedAgentWriteOutcome | undefined {
  if (raw.outcome === undefined) return undefined;
  const saved = typeof raw.saved === 'boolean' ? { saved: raw.saved } : {};
  if (!isAgentWriteOutcome(raw.outcome)) {
    return {
      outcome: raw.saved === true ? 'merged-first' : 'refused',
      ...saved,
      ...normalizedNextStep(raw.nextStep),
      nextStep: 're-read',
      unknownOutcome: String(raw.outcome),
    };
  }
  return { outcome: raw.outcome, ...saved, ...normalizedNextStep(raw.nextStep) };
}
