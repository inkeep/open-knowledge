import {
  AGENT_WRITE_NEXT_STEP_MEANINGS,
  AGENT_WRITE_NEXT_STEPS,
  AGENT_WRITE_OUTCOME_MEANINGS,
  AGENT_WRITE_OUTCOMES,
  type NormalizedAgentWriteOutcome,
  normalizeAgentWriteOutcome,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { textPlusStructured, textResult } from './shared.ts';

export type WriteOutcome = NormalizedAgentWriteOutcome;

function meaningList(meanings: Readonly<Record<string, string>>): string {
  return Object.entries(meanings)
    .map(([value, meaning]) => `\`${value}\`: ${meaning}`)
    .join('; ');
}

export const writeOutcomeOutputShape = {
  outcome: z
    .enum(AGENT_WRITE_OUTCOMES)
    .optional()
    .describe(
      `What happened to this write, present on every write result the server answered, success or not. ${meaningList(AGENT_WRITE_OUTCOME_MEANINGS)}. A value this tool version does not know is reported as merged-first when saved, else refused, with nextStep re-read.`,
    ),
  saved: z
    .boolean()
    .optional()
    .describe(
      "Whether the write's bytes were in the document's file when the server answered. Not the same as the move result's `committed` (git history).",
    ),
  nextStep: z
    .enum(AGENT_WRITE_NEXT_STEPS)
    .optional()
    .describe(
      `What to do next about this write. ${meaningList(AGENT_WRITE_NEXT_STEP_MEANINGS)}. Never retry a write whose outcome is merged-first, both-kept or projection-held: it landed.`,
    ),
} as const;

export function writeOutcomeOf(result: {
  readonly [key: string]: unknown;
}): WriteOutcome | undefined {
  return normalizeAgentWriteOutcome({
    outcome: result.outcome,
    saved: result.saved,
    nextStep: result.nextStep,
  });
}

export function writeOutcomeFields(outcome: WriteOutcome | undefined): {
  outcome?: string;
  saved?: boolean;
  nextStep?: string;
} {
  if (outcome === undefined) return {};
  return {
    outcome: outcome.outcome,
    ...(outcome.saved === undefined ? {} : { saved: outcome.saved }),
    ...(outcome.nextStep === undefined ? {} : { nextStep: outcome.nextStep }),
  };
}

export function landedWithoutSuccess(outcome: WriteOutcome | undefined): boolean {
  return outcome?.outcome === 'both-kept' || outcome?.outcome === 'projection-held';
}

export function needsAttention(outcome: WriteOutcome | undefined): boolean {
  return (
    outcome?.outcome === 'refused' ||
    outcome?.outcome === 'both-kept' ||
    outcome?.outcome === 'projection-held'
  );
}

export function writeOutcomeLine(outcome: WriteOutcome | undefined): string | null {
  if (outcome === undefined) return null;
  const unknown =
    outcome.unknownOutcome !== undefined
      ? ` The server reported outcome "${outcome.unknownOutcome}", which this tool version does not know; treated as ${outcome.outcome}.`
      : outcome.unknownNextStep !== undefined
        ? ` The server reported next step "${outcome.unknownNextStep}", which this tool version does not know; treated as re-read.`
        : '';
  const parts = [
    `Outcome: ${outcome.outcome}`,
    ...(outcome.saved === undefined ? [] : [`saved: ${outcome.saved ? 'yes' : 'no'}`]),
    ...(outcome.nextStep === undefined ? [] : [`next step: ${outcome.nextStep}`]),
  ];
  return `${parts.join('; ')}.${unknown}`;
}

export function landedLead(outcome: WriteOutcome, done: string): string {
  return outcome.outcome === 'both-kept'
    ? `${done}: both versions of a block changed here and outside were kept. The write landed and is saved; do not retry it. Re-read the document and remove the duplicate with an ordinary edit if your task calls for it.`
    : `${done}: the edit is in the document, but its save to the file is not confirmed yet; OpenKnowledge saves it on its own. Do not retry it. Re-read the document before the next edit.`;
}

export function leadFor(outcome: WriteOutcome | undefined, done: string, lead: string): string {
  return outcome !== undefined && landedWithoutSuccess(outcome) ? landedLead(outcome, done) : lead;
}

export const REFUSED_WITHOUT_ERROR_STATUS =
  'the write was not saved. The server answered without an error status but reported the write as refused.';

const OUTCOME_WEIGHT: Readonly<Record<WriteOutcome['outcome'], number>> = {
  applied: 0,
  'merged-first': 1,
  'both-kept': 2,
  'projection-held': 3,
  refused: 4,
};

export function weightierOutcome(
  first: WriteOutcome | undefined,
  second: WriteOutcome | undefined,
): WriteOutcome | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return OUTCOME_WEIGHT[second.outcome] > OUTCOME_WEIGHT[first.outcome] ? second : first;
}

export function rereadAfterLanding(outcome: WriteOutcome): WriteOutcome {
  return {
    outcome: outcome.outcome,
    ...(outcome.saved === undefined ? {} : { saved: outcome.saved }),
    nextStep: 're-read',
    ...(outcome.unknownOutcome === undefined ? {} : { unknownOutcome: outcome.unknownOutcome }),
  };
}

export function refusedDespiteSuccess(outcome: WriteOutcome | undefined): boolean {
  return outcome?.outcome === 'refused';
}

export function refusedWriteResult(what: string, outcome: WriteOutcome | undefined) {
  return failedWriteResult(
    `Error: ${what} was not saved. The server answered without an error status but reported the write as refused.`,
    outcome,
  );
}

export function failedWriteResult(text: string, outcome: WriteOutcome | undefined) {
  const line = writeOutcomeLine(outcome);
  const full = line === null ? text : `${text}\n${line}`;
  return outcome === undefined
    ? textResult(full, true)
    : textPlusStructured(full, writeOutcomeFields(outcome), true);
}
