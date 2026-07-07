import { describe, expect, test } from 'bun:test';
import {
  ConflictEntrySchema,
  InstallSkillSuccessSchema,
  ProblemTypeSchema,
  SeedApplyRequestSchema,
  SeedApplySuccessSchema,
  SeedPlanSuccessSchema,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncRemoteSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStateSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
} from './index.ts';

describe('Cluster H URN tokens (US-013)', () => {
  test('parses urn:ok:error:sync-not-active', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:sync-not-active').success).toBe(true);
  });
  test('parses urn:ok:error:project-repo-not-configured', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:project-repo-not-configured').success).toBe(
      true,
    );
  });
  test('parses urn:ok:error:seed-prerequisite-missing', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:seed-prerequisite-missing').success).toBe(
      true,
    );
  });
  test('parses urn:ok:error:seed-invalid-root', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:seed-invalid-root').success).toBe(true);
  });
});

describe('SyncStateSchema', () => {
  test('accepts every documented state', () => {
    for (const s of [
      'dormant',
      'idle',
      'fetching',
      'pulling',
      'pushing',
      'conflict',
      'offline',
      'auth-error',
      'disabled',
    ]) {
      expect(SyncStateSchema.safeParse(s).success).toBe(true);
    }
  });
  test('rejects unknown state', () => {
    expect(SyncStateSchema.safeParse('exploding').success).toBe(false);
  });
});

describe('SyncStatusSchema', () => {
  const validStatus = {
    state: 'idle' as const,
    lastSyncUtc: null,
    lastFetchUtc: null,
    lastPushedSha: null,
    ahead: 0,
    behind: 0,
    consecutiveFailures: 0,
    conflictCount: 0,
    hasRemote: false,
    syncEnabled: false,
    identityUnresolved: false,
  };
  test('parses minimal status (no error/pausedReason)', () => {
    expect(SyncStatusSchema.safeParse(validStatus).success).toBe(true);
  });
  test('parses status with optional fields populated', () => {
    expect(
      SyncStatusSchema.safeParse({
        ...validStatus,
        lastSyncUtc: '2026-04-30T10:00:00.000Z',
        lastFetchUtc: '2026-04-30T09:50:00.000Z',
        lastPushedSha: 'abc1234',
        ahead: 3,
        behind: 1,
        error: 'Network unavailable',
        pausedReason: 'manual',
      }).success,
    ).toBe(true);
  });
  test('rejects negative ahead/behind/conflictCount', () => {
    expect(SyncStatusSchema.safeParse({ ...validStatus, ahead: -1 }).success).toBe(false);
    expect(SyncStatusSchema.safeParse({ ...validStatus, behind: -1 }).success).toBe(false);
    expect(SyncStatusSchema.safeParse({ ...validStatus, conflictCount: -1 }).success).toBe(false);
  });
  test('rejects missing required field', () => {
    const { state: _state, ...incomplete } = validStatus;
    expect(SyncStatusSchema.safeParse(incomplete).success).toBe(false);
  });
  test('accepts a null remote (no remote configured)', () => {
    expect(SyncStatusSchema.safeParse({ ...validStatus, remote: null }).success).toBe(true);
  });
  test('accepts a populated remote with a github webUrl', () => {
    expect(
      SyncStatusSchema.safeParse({
        ...validStatus,
        hasRemote: true,
        remote: {
          label: 'inkeep/open-knowledge',
          webUrl: 'https://github.com/inkeep/open-knowledge',
        },
      }).success,
    ).toBe(true);
  });
  test('accepts a remote with a null webUrl (non-github, name only)', () => {
    expect(
      SyncStatusSchema.safeParse({
        ...validStatus,
        hasRemote: true,
        remote: { label: 'gitlab.com/team/notes', webUrl: null },
      }).success,
    ).toBe(true);
  });
});

describe('SyncRemoteSchema', () => {
  test('accepts a github remote with label + https webUrl', () => {
    expect(
      SyncRemoteSchema.safeParse({
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      }).success,
    ).toBe(true);
  });
  test('accepts a null webUrl', () => {
    expect(SyncRemoteSchema.safeParse({ label: 'gitlab.com/x/y', webUrl: null }).success).toBe(
      true,
    );
  });
  test('rejects an empty label', () => {
    expect(SyncRemoteSchema.safeParse({ label: '', webUrl: null }).success).toBe(false);
  });
  test('rejects a non-url webUrl string', () => {
    expect(SyncRemoteSchema.safeParse({ label: 'x/y', webUrl: 'not-a-url' }).success).toBe(false);
  });
});

describe('SyncTriggerRequestSchema', () => {
  test('parses empty body (op defaults server-side)', () => {
    expect(SyncTriggerRequestSchema.safeParse({}).success).toBe(true);
  });
  test('parses op:sync', () => {
    expect(SyncTriggerRequestSchema.safeParse({ op: 'sync' }).success).toBe(true);
  });
  test('parses op:push and op:pull', () => {
    expect(SyncTriggerRequestSchema.safeParse({ op: 'push' }).success).toBe(true);
    expect(SyncTriggerRequestSchema.safeParse({ op: 'pull' }).success).toBe(true);
  });
  test('rejects unknown op (stricter than legacy silent fallthrough)', () => {
    expect(SyncTriggerRequestSchema.safeParse({ op: 'gibberish' }).success).toBe(false);
  });
});

describe('SyncTriggerSuccessSchema', () => {
  test('parses op echo', () => {
    expect(SyncTriggerSuccessSchema.safeParse({ op: 'sync' }).success).toBe(true);
  });
  test('rejects missing op', () => {
    expect(SyncTriggerSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('ConflictEntrySchema', () => {
  test('parses minimal entry', () => {
    expect(
      ConflictEntrySchema.safeParse({
        file: 'docs/foo.md',
        detectedAt: '2026-04-30T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });
  test('parses entry with optional SHAs', () => {
    expect(
      ConflictEntrySchema.safeParse({
        file: 'docs/foo.md',
        detectedAt: '2026-04-30T10:00:00.000Z',
        oursSha: 'abc1234',
        theirsSha: 'def5678',
        baseSha: '0000000',
      }).success,
    ).toBe(true);
  });
  test('rejects empty file', () => {
    expect(
      ConflictEntrySchema.safeParse({ file: '', detectedAt: '2026-04-30T10:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('SyncConflictsSuccessSchema', () => {
  test('parses empty conflicts list', () => {
    expect(SyncConflictsSuccessSchema.safeParse({ conflicts: [] }).success).toBe(true);
  });
  test('parses populated list', () => {
    expect(
      SyncConflictsSuccessSchema.safeParse({
        conflicts: [{ file: 'a.md', detectedAt: '2026-04-30T10:00:00.000Z' }],
      }).success,
    ).toBe(true);
  });
  test('rejects missing conflicts field', () => {
    expect(SyncConflictsSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('SyncResolveConflictRequestSchema', () => {
  test('parses {file, strategy:mine}', () => {
    expect(
      SyncResolveConflictRequestSchema.safeParse({ file: 'a.md', strategy: 'mine' }).success,
    ).toBe(true);
  });
  test('parses {file, strategy:content, content}', () => {
    expect(
      SyncResolveConflictRequestSchema.safeParse({
        file: 'a.md',
        strategy: 'content',
        content: 'merged body',
      }).success,
    ).toBe(true);
  });
  test('rejects missing file', () => {
    expect(SyncResolveConflictRequestSchema.safeParse({ strategy: 'mine' }).success).toBe(false);
  });
  test('rejects empty file', () => {
    expect(SyncResolveConflictRequestSchema.safeParse({ file: '', strategy: 'mine' }).success).toBe(
      false,
    );
  });
  test('rejects unknown strategy', () => {
    expect(
      SyncResolveConflictRequestSchema.safeParse({ file: 'a.md', strategy: 'magic' }).success,
    ).toBe(false);
  });
});

describe('SyncConflictContentSuccessSchema', () => {
  // The server contract is "always-present-nullable" for `lifecycleStatus`
  // (matches read_document.lifecycle convention — SDK
  // type stability). Every parse below includes `lifecycleStatus` so the
  // schema can reject responses that drop the field.
  test('parses populated stages with lifecycleStatus: null (default branch)', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: 'before',
        ours: 'mine',
        theirs: 'theirs',
        kind: 'both-modified',
        lifecycleStatus: null,
      }).success,
    ).toBe(true);
  });
  test('parses empty stages (delete/edit conflict)', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: '',
        ours: '',
        theirs: '',
        kind: 'delete-modify',
        lifecycleStatus: null,
      }).success,
    ).toBe(true);
  });
  test('rejects missing file', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        base: '',
        ours: '',
        theirs: '',
        lifecycleStatus: null,
      }).success,
    ).toBe(false);
  });
  test('rejects missing lifecycleStatus (always-present-nullable contract)', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: '',
        ours: '',
        theirs: '',
      }).success,
    ).toBe(false);
  });
  test('parses populated stages with lifecycleStatus: "conflict"', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: 'b',
        ours: 'o',
        theirs: 't',
        kind: 'both-modified',
        lifecycleStatus: 'conflict',
      }).success,
    ).toBe(true);
  });
  test('rejects missing kind (always-required discriminator)', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: 'b',
        ours: 'o',
        theirs: 't',
        lifecycleStatus: null,
      }).success,
    ).toBe(false);
  });
  test('rejects unknown kind value', () => {
    expect(
      SyncConflictContentSuccessSchema.safeParse({
        file: 'a.md',
        base: 'b',
        ours: 'o',
        theirs: 't',
        kind: 'made-up-shape',
        lifecycleStatus: null,
      }).success,
    ).toBe(false);
  });
});

describe('SyncResolveConflictSuccessSchema', () => {
  test('parses empty body', () => {
    expect(SyncResolveConflictSuccessSchema.safeParse({}).success).toBe(true);
  });
});

describe('SeedPlanSuccessSchema', () => {
  test('parses {plan: ...} (plan is z.unknown — opaque)', () => {
    expect(
      SeedPlanSuccessSchema.safeParse({
        plan: { created: [], skipped: [], configEdits: [], warnings: [] },
      }).success,
    ).toBe(true);
  });
  test('parses {plan: anything}', () => {
    expect(SeedPlanSuccessSchema.safeParse({ plan: null }).success).toBe(true);
    expect(SeedPlanSuccessSchema.safeParse({ plan: 'string' }).success).toBe(true);
  });
  test('rejects missing plan field', () => {
    expect(SeedPlanSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('SeedApplyRequestSchema', () => {
  test('parses {plan: ...}', () => {
    expect(
      SeedApplyRequestSchema.safeParse({
        plan: { created: [], skipped: [], configEdits: [], warnings: [] },
      }).success,
    ).toBe(true);
  });
  test('rejects missing plan field', () => {
    expect(SeedApplyRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('SeedApplySuccessSchema', () => {
  test('parses {result: ...}', () => {
    expect(
      SeedApplySuccessSchema.safeParse({
        result: { applied: 3, errors: [], durationMs: 42 },
      }).success,
    ).toBe(true);
  });
  test('rejects missing result field', () => {
    expect(SeedApplySuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('InstallSkillSuccessSchema (discriminated union)', () => {
  test('parses installed variant — all artifact fields required', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'installed',
        outputPath: '/tmp/skill.zip',
        size: 1024,
        sha256: 'a'.repeat(64),
        skillVersion: '1.0.0',
      }).success,
    ).toBe(true);
  });
  test('parses built variant with optional handoffError absent', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'built',
        outputPath: '/tmp/skill.zip',
        size: 1024,
        sha256: 'a'.repeat(64),
        skillVersion: '1.0.0',
      }).success,
    ).toBe(true);
  });
  test('parses built variant with handoffError present', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'built',
        outputPath: '/tmp/skill.zip',
        size: 1024,
        sha256: 'a'.repeat(64),
        skillVersion: '1.0.0',
        handoffError: { reason: 'unsupported-platform', message: 'linux not supported' },
      }).success,
    ).toBe(true);
  });
  test('parses failed variant — buildError required', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'failed',
        buildError: 'esbuild exit 1',
      }).success,
    ).toBe(true);
  });
  test('parses skip-current with skillVersion + recordedAt', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'skip-current',
        skillVersion: '1.0.0',
        recordedAt: '2026-05-07T12:00:00Z',
      }).success,
    ).toBe(true);
  });
  test('parses skip-current with skillVersion only (recordedAt optional)', () => {
    // Regression guard: server emits recordedAt conditionally
    // (skill-install.ts — `...(recordedAt !== null ? { recordedAt } : {})`).
    // The discriminatedUnion's skip-current variant must accept the
    // recordedAt-absent case, otherwise successResponse's safeParse falls
    // back to a 500 on every legitimate skip-current emit. This test pins
    // the regression so a future edit can't re-introduce it.
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'skip-current',
        skillVersion: '1.0.0',
      }).success,
    ).toBe(true);
  });
  test('rejects skip-current without required skillVersion', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'skip-current',
        recordedAt: '2026-05-07T12:00:00Z',
      }).success,
    ).toBe(false);
  });
  test('accepts forward-compat extra fields per .loose() variants', () => {
    // Each discriminated-union variant declares `.loose()` for forward-
    // compat: a future server adding e.g. `installedAt` to `installed`
    // must not break older clients. The DU enforces variant-specific
    // REQUIRED fields (status discriminant + per-variant mandatory shape),
    // not blanket rejection of unknown extras. A test asserting
    // `{ status: 'failed', outputPath: 'x' }` is rejected would falsely
    // imply `.strict()` semantics. The actual contract: status routes to
    // the right variant, required fields are checked, forward-compat
    // extras pass through.
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'failed',
        buildError: 'x',
        futureField: 42,
      }).success,
    ).toBe(true);
  });
  test('rejects unknown status discriminant', () => {
    expect(
      InstallSkillSuccessSchema.safeParse({
        status: 'unknown-status',
        skillVersion: '1.0.0',
      }).success,
    ).toBe(false);
  });
});
