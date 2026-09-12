import { toast } from 'sonner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { subscribeToSkillsChanged } from './documents-events';
import {
  deleteSkill,
  moveSkillScope,
  skillMoveRetainedBatchToast,
  skillMoveRetainedCopyToast,
} from './skills-api';

vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const originalFetch = globalThis.fetch;

function countSkillsChanged(): { count: () => number; stop: () => void } {
  let seen = 0;
  const stop = subscribeToSkillsChanged(() => {
    seen += 1;
  });
  return { count: () => seen, stop };
}

describe('moveSkillScope transport', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('carries droppedLocations from a successful move back to the caller', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scope: 'global',
          path: '.ok/skills/example',
          droppedLocations: ['agents', '.team/skills'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const changed = countSkillsChanged();

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });
    changed.stop();

    expect(result).toEqual({
      ok: true,
      scope: 'global',
      path: '.ok/skills/example',
      droppedLocations: ['agents', '.team/skills'],
    });
    expect(changed.count()).toBe(1);
  });

  test('defaults droppedLocations to an empty list when the body omits or malforms it', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ scope: 'global', droppedLocations: ['agents', 7, null] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(result).toEqual({ ok: true, scope: 'global', droppedLocations: ['agents'] });
  });

  test('carries moveState alongside the message when the move fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'urn:ok:error:internal-server-error',
          title: 'The destination copy could not be read back.',
          status: 500,
          moveState: 'destination-unreadable',
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );
    const changed = countSkillsChanged();

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });
    changed.stop();

    expect(result).toEqual({
      ok: false,
      error: 'The destination copy could not be read back.',
      outcome: { kind: 'coherent', moveState: 'destination-unreadable' },
      droppedLocations: [],
    });
    expect(changed.count()).toBe(1);
  });

  test('omits moveState when the failure body carries a code outside the advertised set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ title: 'Move failed.', moveState: 'some-future-state' }), {
        status: 500,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Move failed.',
      outcome: { kind: 'unverified' },
      droppedLocations: [],
    });
    expect(result).not.toHaveProperty('outcome.moveState');
  });

  test('carries sourceState alongside moveState when the server reports the source verdict', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Failed to move skill (source removal failed).',
          moveState: 'destination-retained',
          sourceState: 'intact',
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Failed to move skill (source removal failed).',
      outcome: { kind: 'coherent', moveState: 'destination-retained', sourceState: 'intact' },
      droppedLocations: [],
    });
  });

  test('carries retentionLedger alongside moveState when the destination occupant is unverifiable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'A project skill named "example" already exists.',
          moveState: 'nothing-written',
          retentionLedger: 'occupant-unverifiable',
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'global',
      toScope: 'project',
    });

    expect(result).toEqual({
      ok: false,
      error: 'A project skill named "example" already exists.',
      outcome: {
        kind: 'coherent',
        moveState: 'nothing-written',
        retentionLedger: 'occupant-unverifiable',
      },
      droppedLocations: [],
    });
  });

  test('omits retentionLedger when the failure body carries a code outside the advertised set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Move failed.',
          moveState: 'nothing-written',
          retentionLedger: 'occupant-probably-fine',
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'global',
      toScope: 'project',
    });

    expect(result).not.toHaveProperty('outcome.retentionLedger');
  });

  test('omits sourceState when the failure body carries a verdict outside the advertised set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Move failed.',
          moveState: 'destination-retained',
          sourceState: 'probably-fine',
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(result).not.toHaveProperty('outcome.sourceState');
  });

  test('carries droppedLocations from a failed move back to the caller', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'The source could not be removed.',
          moveState: 'destination-retained',
          droppedLocations: ['lm-studio', 9],
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(result).toEqual({
      ok: false,
      error: 'The source could not be removed.',
      outcome: { kind: 'unverified', moveState: 'destination-retained' },
      droppedLocations: ['lm-studio'],
    });
  });

  test('refreshes the skills list when the response is lost in transport', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const changed = countSkillsChanged();

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'project',
      toScope: 'global',
    });
    changed.stop();

    expect(result).toEqual({
      ok: false,
      error: 'network down',
      outcome: { kind: 'coherent' },
      droppedLocations: [],
    });
    expect(changed.count()).toBe(1);
  });

  test('does not refresh when the source and destination scopes match and no request is sent', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const changed = countSkillsChanged();

    const result = await moveSkillScope({
      name: 'example',
      fromScope: 'global',
      toScope: 'global',
    });
    changed.stop();

    expect(result).toEqual({ ok: true, scope: 'global', droppedLocations: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(changed.count()).toBe(0);
  });
});

describe('skillMoveRetainedCopyToast', () => {
  const base = { name: 'example', toScope: 'project' as const, scopeLabel: 'Project' };

  test.for(['unreadable', 'occupant-unverifiable'] as const)(
    'warns to compare before deleting when the server reports retentionLedger %s',
    (retentionLedger) => {
      const options = skillMoveRetainedCopyToast({
        outcome: { kind: 'coherent', moveState: 'nothing-written', retentionLedger },
        ...base,
      });

      expect(options).toEqual({
        description:
          'Something named "example" is already in Project, and the server couldn\'t confirm what it is. An earlier failed move may have kept it there on purpose: compare it with the original before you delete or replace it.',
        id: 'skill-move-retained:project:example',
        duration: Number.POSITIVE_INFINITY,
      });
    },
  );

  test('stays silent for a nothing-written move the server could fully account for', () => {
    expect(
      skillMoveRetainedCopyToast({
        outcome: { kind: 'coherent', moveState: 'nothing-written' },
        ...base,
      }),
    ).toBeUndefined();
  });

  test('offers removal only when the server verified the source intact', () => {
    expect(
      skillMoveRetainedCopyToast({
        outcome: { kind: 'coherent', moveState: 'destination-retained', sourceState: 'intact' },
        ...base,
      })?.description,
    ).toContain('redundant duplicate');
  });

  test('an unverified report never offers removal, even when it claims an intact source', () => {
    const description = skillMoveRetainedCopyToast({
      outcome: { kind: 'unverified', moveState: 'destination-retained', sourceState: 'intact' },
      ...base,
    })?.description;

    expect(description).toContain("Don't delete anything");
    expect(description).not.toContain('redundant duplicate');
  });

  test('a retained destination with no source verdict stays cautionary', () => {
    const description = skillMoveRetainedCopyToast({
      outcome: { kind: 'unverified', moveState: 'destination-retained-blocking' },
      ...base,
    })?.description;

    expect(description).toContain("Don't delete anything");
    expect(description).not.toContain('redundant duplicate');
  });

  test('a completely unknown peer outcome remains cautionary', () => {
    const options = skillMoveRetainedCopyToast({ outcome: { kind: 'unverified' }, ...base });

    expect(options?.description).toContain('A copy may remain');
    expect(options?.description).toContain("Don't delete anything");
    expect(options?.duration).toBe(Number.POSITIVE_INFINITY);
    expect(options?.description).not.toContain('original was verified unchanged');
  });

  test('gives each skill in a bulk move its own toast id so warnings do not collapse', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'].map(
      (name) =>
        skillMoveRetainedCopyToast({
          outcome: {
            kind: 'coherent',
            moveState: 'nothing-written',
            retentionLedger: 'occupant-unverifiable',
          },
          ...base,
          name,
        })?.id,
    );

    expect(ids).toEqual([
      'skill-move-retained:project:alpha',
      'skill-move-retained:project:beta',
      'skill-move-retained:project:gamma',
      'skill-move-retained:project:delta',
    ]);
  });
});

describe('skillMoveRetainedBatchToast', () => {
  const base = { toScope: 'project' as const, scopeLabel: 'Project' };
  const retainedIntact = {
    kind: 'coherent',
    moveState: 'destination-retained',
    sourceState: 'intact',
  } as const;
  const retainedLossy = {
    kind: 'coherent',
    moveState: 'destination-retained',
    sourceState: 'lossy',
  } as const;
  const ordinary = { kind: 'coherent', moveState: 'destination-removed' } as const;

  test('one summary names every retained skill in a batch that also had a success', () => {
    const summary = skillMoveRetainedBatchToast({
      failures: [
        { name: 'alpha', outcome: retainedIntact },
        { name: 'beta', outcome: retainedLossy },
        { name: 'gamma', outcome: ordinary },
      ],
      moved: 1,
      total: 4,
      ...base,
    });

    expect(summary?.description).toContain('alpha');
    expect(summary?.description).toContain('beta');
    expect(summary?.description).not.toContain('gamma');
    expect(summary?.description).toContain('Project');
    expect(summary?.title).toBe('Moved 1 of 4 skills to Project');
    expect(summary?.duration).toBe(Number.POSITIVE_INFINITY);
    expect(summary?.id).toBe('skill-move-retained-batch:project');
  });

  test('a batch holding one uncertain member never advises removing any copy', () => {
    const summary = skillMoveRetainedBatchToast({
      failures: [
        { name: 'alpha', outcome: retainedIntact },
        { name: 'beta', outcome: retainedLossy },
      ],
      moved: 0,
      total: 2,
      ...base,
    });

    expect(summary?.description).toContain("Don't delete anything there");
    expect(summary?.description).not.toContain('remove those copies');
  });

  test('a batch whose retained copies are all redundant says they can be removed', () => {
    const summary = skillMoveRetainedBatchToast({
      failures: [{ name: 'alpha', outcome: retainedIntact }],
      moved: 2,
      total: 3,
      ...base,
    });

    expect(summary?.description).toContain('remove those copies');
  });

  test('stays silent when nothing was retained, so the batch keeps its plain success', () => {
    expect(
      skillMoveRetainedBatchToast({
        failures: [{ name: 'gamma', outcome: ordinary }],
        moved: 2,
        total: 3,
        ...base,
      }),
    ).toBeUndefined();
  });

  test('caps the names so a large multi-select cannot grow the summary without bound', () => {
    const summary = skillMoveRetainedBatchToast({
      failures: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => ({
        name,
        outcome: retainedIntact,
      })),
      moved: 0,
      total: 5,
      ...base,
    });

    expect(summary?.description).toContain('alpha, beta, gamma and 2 more');
    expect(summary?.description).not.toContain('delta');
    expect(summary?.description).not.toContain('epsilon');
  });
});

describe('the retained batch summary drains through the per-skill success chokepoints', () => {
  const retainedIntact = {
    kind: 'coherent',
    moveState: 'destination-retained',
    sourceState: 'intact',
  } as const;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respondOk(body: object): void {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  function summarize(toScope: 'project' | 'global', names: readonly string[]): void {
    skillMoveRetainedBatchToast({
      failures: names.map((name) => ({ name, outcome: retainedIntact })),
      moved: 0,
      total: names.length,
      toScope,
      scopeLabel: toScope === 'global' ? 'Global' : 'Project',
    });
  }

  function dismissed(): string[] {
    return vi.mocked(toast.dismiss).mock.calls.map((call) => String(call[0]));
  }

  test('a retry that succeeds one at a time holds the summary until the last name resolves', async () => {
    summarize('global', ['alpha', 'beta']);
    respondOk({ scope: 'global' });
    vi.mocked(toast.dismiss).mockClear();

    await moveSkillScope({ name: 'alpha', fromScope: 'project', toScope: 'global' });

    expect(dismissed()).toEqual(['skill-move-retained:global:alpha']);

    await moveSkillScope({ name: 'beta', fromScope: 'project', toScope: 'global' });

    expect(dismissed()).toContain('skill-move-retained-batch:global');
  });

  test('deleting the retained copy resolves that name for the summary as well', async () => {
    summarize('project', ['alpha', 'beta']);
    respondOk({ existed: true });
    vi.mocked(toast.dismiss).mockClear();

    await deleteSkill('project', 'alpha');

    expect(dismissed()).not.toContain('skill-move-retained-batch:project');

    await deleteSkill('project', 'beta');

    expect(dismissed()).toContain('skill-move-retained-batch:project');
  });

  test('a host-qualified delete resolves nothing, so the summary stays up', async () => {
    summarize('project', ['alpha']);
    respondOk({ existed: true });
    vi.mocked(toast.dismiss).mockClear();

    await deleteSkill('project', 'alpha', 'claude');

    expect(dismissed()).toEqual([]);
  });

  test('a name outside the summary never drains it', async () => {
    summarize('global', ['alpha']);
    respondOk({ scope: 'global' });
    vi.mocked(toast.dismiss).mockClear();

    await moveSkillScope({ name: 'unrelated', fromScope: 'project', toScope: 'global' });

    expect(dismissed()).toEqual(['skill-move-retained:global:unrelated']);
  });
});
