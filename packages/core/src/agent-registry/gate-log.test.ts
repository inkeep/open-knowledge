import { describe, expect, it } from 'vitest';
import {
  READINESS_LOG_SITES,
  REQUIREMENT_LOG_STATUSES,
  summarizeReadinessForLog,
} from './gate-log.ts';
import { AGENT_MODES, ALL_AGENT_IDS } from './ids.ts';
import { assessReadiness, MET_CONFIDENCES, READINESS_VERDICTS } from './readiness.ts';

describe('readiness log fields', () => {
  it('names the registry agent when the gate recognized it', () => {
    const fields = summarizeReadinessForLog(
      'acp-thread',
      assessReadiness({ agentId: 'claude', mode: 'acp' }),
    );
    expect(fields.agent).toBe('claude');
    expect(fields.registered).toBe(true);
    expect(fields.site).toBe('acp-thread');
    expect(fields.mode).toBe('acp');
  });

  it('withholds the id of an agent outside the curated set', () => {
    const fields = summarizeReadinessForLog(
      'acp-thread',
      assessReadiness({ agentId: 'my-secret-side-project-agent', mode: 'acp' }),
    );
    expect(fields.verdict).toBe('not-registered');
    expect(fields.agent).toBeNull();
    expect(fields.registered).toBe(false);
  });

  it('reports both pieces as unassessed when the fold stopped before requirements', () => {
    const fields = summarizeReadinessForLog(
      'deep-link',
      assessReadiness({ agentId: 'unknown-agent', mode: 'external' }),
    );
    expect(fields.mcp).toBe('not-assessed');
    expect(fields.skill).toBe('not-assessed');
    expect(fields.mcpConfidence).toBeNull();
    expect(fields.skillConfidence).toBeNull();
  });

  it('carries the skill requirement beside the verdict, not folded into it', () => {
    const assessment = assessReadiness({ agentId: 'claude', mode: 'acp' });
    const fields = summarizeReadinessForLog('acp-thread', assessment);
    const skill = assessment.requirements.find((requirement) => requirement.piece === 'skill');
    expect(skill).toBeDefined();
    expect(fields.skill).toBe(skill?.status);
  });

  it('emits nothing but closed-set values for every agent and mode', () => {
    for (const agentId of ALL_AGENT_IDS) {
      for (const mode of AGENT_MODES) {
        const fields = summarizeReadinessForLog('terminal', assessReadiness({ agentId, mode }));
        expect(READINESS_VERDICTS).toContain(fields.verdict);
        expect(READINESS_LOG_SITES).toContain(fields.site);
        expect(AGENT_MODES).toContain(fields.mode);
        expect(REQUIREMENT_LOG_STATUSES).toContain(fields.mcp);
        expect(REQUIREMENT_LOG_STATUSES).toContain(fields.skill);
        for (const confidence of [fields.mcpConfidence, fields.skillConfidence]) {
          if (confidence !== null) expect(MET_CONFIDENCES).toContain(confidence);
        }
        expect(fields.agent === null || ALL_AGENT_IDS.includes(fields.agent)).toBe(true);
      }
    }
  });

  it('reports a mode the agent does not have without inventing requirements', () => {
    const fields = summarizeReadinessForLog(
      'deep-link',
      assessReadiness({ agentId: 'gemini', mode: 'external' }),
    );
    expect(fields.verdict).toBe('mode-not-available');
    expect(fields.registered).toBe(true);
    expect(fields.mcp).toBe('not-assessed');
  });
});
