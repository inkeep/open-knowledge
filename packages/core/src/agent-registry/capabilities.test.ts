import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY } from './agents.ts';
import { CAPABILITY_IDS, CAPABILITY_RECORDS, getCapabilityRecord } from './capabilities.ts';
import { CapabilityRecordSchema } from './schema.ts';

describe('the capability table', () => {
  it('parses', () => {
    for (const record of CAPABILITY_RECORDS) {
      expect(CapabilityRecordSchema.parse(record)).toMatchObject({ id: record.id });
    }
  });

  it('gives every grant a unique id', () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_RECORDS.length);
  });

  it('looks a grant up by id', () => {
    expect(getCapabilityRecord('mcp-preapproval')?.scope).toBe('project');
    expect(getCapabilityRecord('nope')).toBeUndefined();
  });
});

describe('what each grant is allowed to accept', () => {
  it('pins pre-approval to the exact predicate on the project entry', () => {
    expect(getCapabilityRecord('mcp-preapproval')).toMatchObject({
      piece: 'mcp',
      scope: 'project',
      requiredStrictness: 'pre-approval-exact',
    });
  });

  it('lets tool auto-approve read either scope', () => {
    const record = getCapabilityRecord('tool-autoapprove');
    expect(record?.scope).toBeUndefined();
    expect(record?.requiredStrictness).toBe('pre-approval-exact');
  });

  it('guards every multi-scope grant against a name shadow', () => {
    for (const record of CAPABILITY_RECORDS) {
      if (record.scope === undefined) expect(record.revokedByForeignEntry).toBe(true);
    }
  });

  it('never accepts an answer weaker than the exact predicate', () => {
    for (const record of CAPABILITY_RECORDS) {
      expect(record.requiredStrictness).toBe('pre-approval-exact');
    }
  });
});

describe('reachability from the registry data', () => {
  it('names a strictness some satisfier actually declares', () => {
    const declared = new Set(
      Object.values(AGENT_REGISTRY)
        .flatMap((agent) => agent.satisfiers)
        .flatMap((satisfier) =>
          satisfier.probe.mode === 'probeable' ? satisfier.probe.strictness : [],
        ),
    );
    for (const record of CAPABILITY_RECORDS) {
      expect(declared).toContain(record.requiredStrictness);
    }
  });
});
