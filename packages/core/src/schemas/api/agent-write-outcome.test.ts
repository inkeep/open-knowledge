import { describe, expect, test } from 'vitest';
import {
  AGENT_WRITE_NEXT_STEPS,
  AGENT_WRITE_OUTCOMES,
  AgentWriteBatchResultSchema,
  AgentWriteMdSuccessSchema,
  normalizeAgentWriteOutcome,
  ProblemTypeSchema,
} from './index.ts';

describe('the agent write outcome contract', () => {
  test('the outcome and next-step sets are the owner-directed closed sets', () => {
    expect(AGENT_WRITE_OUTCOMES).toEqual([
      'applied',
      'merged-first',
      'both-kept',
      'refused',
      'projection-held',
    ]);
    expect(AGENT_WRITE_NEXT_STEPS).toEqual(['retry', 're-read', 'none']);
  });

  test('a success body and both batch arms carry the three fields', () => {
    const fields = { outcome: 'merged-first', saved: true, nextStep: 're-read' };
    expect(
      AgentWriteMdSuccessSchema.parse({
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 0,
        brokenLinks: [],
        ...fields,
      }),
    ).toMatchObject(fields);
    expect(
      AgentWriteBatchResultSchema.parse({
        status: 'written',
        docName: 'a',
        brokenLinks: [],
        ...fields,
      }),
    ).toMatchObject(fields);
    expect(
      AgentWriteBatchResultSchema.parse({
        status: 'error',
        docName: 'a',
        error: { type: 'urn:ok:error:save-held', title: 't' },
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
      }),
    ).toMatchObject({ outcome: 'projection-held', saved: false });
  });

  test('a newer server may send values this build does not know without failing the parse', () => {
    expect(
      AgentWriteMdSuccessSchema.safeParse({
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 0,
        brokenLinks: [],
        outcome: 'displaced',
        saved: false,
        nextStep: 'ask',
      }).success,
    ).toBe(true);
  });

  test('the both-kept, write-replaced and write-dropped problem types are registered', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:both-kept').success).toBe(true);
    expect(ProblemTypeSchema.safeParse('urn:ok:error:write-replaced').success).toBe(true);
    expect(ProblemTypeSchema.safeParse('urn:ok:error:write-dropped').success).toBe(true);
  });
});

describe('normalizeAgentWriteOutcome', () => {
  test('known values pass through unchanged', () => {
    expect(
      normalizeAgentWriteOutcome({ outcome: 'both-kept', saved: true, nextStep: 're-read' }),
    ).toEqual({ outcome: 'both-kept', saved: true, nextStep: 're-read' });
    expect(
      normalizeAgentWriteOutcome({ outcome: 'refused', saved: false, nextStep: 'retry' }),
    ).toEqual({ outcome: 'refused', saved: false, nextStep: 'retry' });
  });

  test('an older server that sends no outcome yields nothing, so nothing is invented', () => {
    expect(normalizeAgentWriteOutcome({})).toBeUndefined();
    expect(normalizeAgentWriteOutcome({ nextStep: 're-read' })).toBeUndefined();
    expect(normalizeAgentWriteOutcome({ saved: false, nextStep: 're-read' })).toBeUndefined();
  });

  test('an unknown outcome on a saved write reads as merged-first with a re-read', () => {
    expect(
      normalizeAgentWriteOutcome({ outcome: 'displaced', saved: true, nextStep: 'none' }),
    ).toEqual({
      outcome: 'merged-first',
      saved: true,
      nextStep: 're-read',
      unknownOutcome: 'displaced',
    });
  });

  test('an unknown outcome on an unsaved write reads as refused with a re-read, never a retry', () => {
    expect(
      normalizeAgentWriteOutcome({ outcome: 'held', saved: false, nextStep: 'retry' }),
    ).toEqual({ outcome: 'refused', saved: false, nextStep: 're-read', unknownOutcome: 'held' });
  });

  test('an unknown next step becomes re-read, and a malformed saved flag is left out', () => {
    expect(
      normalizeAgentWriteOutcome({ outcome: 'projection-held', saved: 'yes', nextStep: 'ask' }),
    ).toEqual({
      outcome: 'projection-held',
      nextStep: 're-read',
      unknownNextStep: 'ask',
    });
  });

  test('an absent saved or next step stays absent next to a known outcome', () => {
    expect(normalizeAgentWriteOutcome({ outcome: 'both-kept', nextStep: 're-read' })).toEqual({
      outcome: 'both-kept',
      nextStep: 're-read',
    });
    expect(normalizeAgentWriteOutcome({ outcome: 'both-kept', saved: true })).toEqual({
      outcome: 'both-kept',
      saved: true,
    });
    expect(normalizeAgentWriteOutcome({ outcome: 'applied' })).toEqual({ outcome: 'applied' });
  });

  test('an unknown outcome with no saved flag reads as refused and invents no saved flag', () => {
    expect(normalizeAgentWriteOutcome({ outcome: 'displaced' })).toEqual({
      outcome: 'refused',
      nextStep: 're-read',
      unknownOutcome: 'displaced',
    });
  });
});
