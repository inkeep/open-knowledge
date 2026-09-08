import { describe, expect, it } from 'vitest';
import { satisfierId } from './ids.ts';
import {
  AgentRecordSchema,
  AttestationSchema,
  ProbeDeclarationSchema,
  SatisfierRecordSchema,
} from './schema.ts';
import {
  APPLY_ACTIONS,
  ApplyActionSchema,
  DISK_BACKED_SATISFIER_KINDS,
  isKnownSurfaceState,
  KNOWN_SURFACE_STATES,
  SATISFIER_KINDS,
  SatisfierKindSchema,
  SurfaceStateSchema,
} from './vocabulary.ts';

const verifiedAttestation = {
  confidence: 'verified',
  evidence: [{ kind: 'source-read', ref: 'packages/cli/src/commands/editors.ts' }],
} as const;

function satisfierFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: satisfierId({ agent: 'claude', piece: 'mcp', scope: 'project', kind: 'config-entry' }),
    agent: 'claude',
    piece: 'mcp',
    scope: 'project',
    kind: 'config-entry',
    pathId: 'claude-project-mcp-config',
    probe: { mode: 'probeable', strictness: ['pre-approval-exact'] },
    attestation: verifiedAttestation,
    audience: 'this-project',
    ...overrides,
  };
}

describe('satisfier kinds', () => {
  it('has exactly the five kinds a real agent needs', () => {
    expect([...SATISFIER_KINDS]).toEqual([
      'config-entry',
      'managed-file',
      'skill-bundle-copy',
      'central-store-copy',
      'session-injection',
    ]);
  });

  it('rejects a kind the vocabulary does not have', () => {
    expect(SatisfierKindSchema.safeParse('user-mediated-handoff').success).toBe(false);
    expect(SatisfierRecordSchema.safeParse(satisfierFixture({ kind: 'telepathy' })).success).toBe(
      false,
    );
  });

  it('excludes the one kind that leaves nothing on disk from settings cells', () => {
    expect([...DISK_BACKED_SATISFIER_KINDS]).not.toContain('session-injection');
    expect(DISK_BACKED_SATISFIER_KINDS).toHaveLength(SATISFIER_KINDS.length - 1);
  });
});

describe('surface states', () => {
  it('accepts a state this build has never heard of', () => {
    const parsed = SurfaceStateSchema.safeParse('invented-by-a-newer-host');
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe('invented-by-a-newer-host');
  });

  it('still tells a known state from an unknown one', () => {
    for (const state of KNOWN_SURFACE_STATES) expect(isKnownSurfaceState(state)).toBe(true);
    expect(isKnownSurfaceState('invented-by-a-newer-host')).toBe(false);
  });
});

describe('apply actions', () => {
  it('keeps a failed write un-mistakable for an unchanged one', () => {
    expect(ApplyActionSchema.safeParse('failed').success).toBe(true);
    expect(ApplyActionSchema.safeParse('unchanged').success).toBe(true);
    expect(new Set(APPLY_ACTIONS).size).toBe(APPLY_ACTIONS.length);
  });

  it('never lets a write outcome be read as a probe state', () => {
    const writeOutcomes = ['written', 'overwritten', 'declined', 'failed'] as const;
    for (const action of writeOutcomes) {
      expect(ApplyActionSchema.safeParse(action).success).toBe(true);
      expect(isKnownSurfaceState(action)).toBe(false);
    }
  });
});

describe('attestation', () => {
  it('takes a verified claim without a clock', () => {
    expect(AttestationSchema.safeParse(verifiedAttestation).success).toBe(true);
  });

  it('refuses a contested claim with no build to re-check it against', () => {
    expect(
      AttestationSchema.safeParse({
        confidence: 'contested',
        evidence: [{ kind: 'upstream-issue', ref: 'openai/codex#13025' }],
      }).success,
    ).toBe(false);
  });

  it('takes a contested claim that names when and against what it was checked', () => {
    expect(
      AttestationSchema.safeParse({
        confidence: 'contested',
        evidence: [{ kind: 'upstream-issue', ref: 'openai/codex#13025' }],
        verifiedAgainst: { version: '26.707.72221', observedAt: '2026-08-18' },
      }).success,
    ).toBe(true);
  });

  it('demands receipts at every confidence level', () => {
    expect(AttestationSchema.safeParse({ confidence: 'assumed', evidence: [] }).success).toBe(
      false,
    );
  });
});

describe('probe declaration', () => {
  it('makes a probeable satisfier name at least one predicate', () => {
    expect(ProbeDeclarationSchema.safeParse({ mode: 'probeable', strictness: [] }).success).toBe(
      false,
    );
  });

  it('makes an unprobeable satisfier say why', () => {
    expect(ProbeDeclarationSchema.safeParse({ mode: 'unprobeable' }).success).toBe(false);
    expect(
      ProbeDeclarationSchema.safeParse({ mode: 'unprobeable', reason: 'no-readable-state' })
        .success,
    ).toBe(true);
  });
});

describe('agent records', () => {
  const agentFixture = {
    id: 'claude',
    setupDocSlug: 'claude-code',
    satisfiers: [satisfierFixture()],
    modes: {
      terminal: {
        requirements: [
          {
            piece: 'mcp',
            level: 'required',
            satisfiedByAny: [
              satisfierId({
                agent: 'claude',
                piece: 'mcp',
                scope: 'project',
                kind: 'config-entry',
              }),
            ],
          },
        ],
      },
    },
  };

  it('parses a whole record and defaults the optional fields', () => {
    const parsed = AgentRecordSchema.parse(agentFixture);
    expect(parsed.offerOnlyWhenDetected).toBe(false);
    expect(parsed.detectionSources).toEqual([]);
    expect(parsed.satisfiers[0]?.prerequisites).toEqual([]);
    expect(parsed.satisfiers[0]?.consentClass).toBe('none');
    expect(parsed.satisfiers[0]?.preferred).toBe(false);
  });

  it('treats a mode key as the whole signal that the mode exists', () => {
    const parsed = AgentRecordSchema.parse(agentFixture);
    expect(Object.keys(parsed.modes)).toEqual(['terminal']);
    expect(parsed.modes.external).toBeUndefined();
  });

  it('lets a requirement declare no surface at all with an empty OR-set', () => {
    const parsed = AgentRecordSchema.parse({
      ...agentFixture,
      modes: {
        acp: { requirements: [{ piece: 'skill', level: 'recommended', satisfiedByAny: [] }] },
      },
    });
    expect(parsed.modes.acp?.requirements[0]?.satisfiedByAny).toEqual([]);
  });
});
