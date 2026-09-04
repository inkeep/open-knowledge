import { diffLinesFast, type MarkdownManager } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';
import { mdManager } from './md-manager.ts';
import { createDiscriminatorRig, type DiscriminatorRig } from './pre-drain-corpus.test-helper.ts';
import {
  type BodySpan,
  classifyPreDrain,
  extractComposeTargetSpan,
  type PreDrainVerdict,
  planPreDrain,
} from './pre-drain-discriminator.ts';

function drainRewriteRange(
  body: string,
  fragmentPmJson: ReturnType<typeof mdManager.parse>,
): BodySpan | null {
  const splice = computeMapDrivenBodySplice(body, fragmentPmJson, mdManager);
  return splice === null ? null : { start: splice.spliceStart, end: splice.spliceEnd };
}

const throwingMdManager = {
  parseToMdast: () => {
    throw new Error('localizer reached: parseToMdast should not run');
  },
  serialize: () => {
    throw new Error('localizer reached: serialize should not run');
  },
} as unknown as MarkdownManager;

const FIVE_PARA = [
  'para one alpha',
  'para two beta',
  'para three gamma',
  'para four delta',
  'para five epsilon',
].join('\n\n');

const canon = (md: string): string => mdManager.serialize(mdManager.parse(md));

interface Scenario {
  readonly id: string;
  readonly harmful: boolean;
  readonly expectedPreDrain: boolean;
  readonly base: string;
  readonly stage: (rig: DiscriminatorRig) => PreDrainVerdict;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'U1 pending new paragraph after an agent append',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite('agent line', 'append');
      rig.stageKeystroke((md) => `${md.trimEnd()}\n\nfresh keystroke`);
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U2 keystroke inside the agent-appended line',
    harmful: true,
    expectedPreDrain: false,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite('agent line', 'append');
      rig.stageKeystroke((md) => md.replace('agent line', 'agent XXline'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U3 typing in the agent-patched paragraph',
    harmful: true,
    expectedPreDrain: false,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(FIVE_PARA.replace('para two beta', 'para two beta agent-suffix')),
        'patch',
      );
      rig.stageKeystroke((md) =>
        md.replace('para two beta agent-suffix', 'para two beta agent-suffix typed'),
      );
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U4 pending edit two blocks away from the patch target',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(FIVE_PARA.replace('para three gamma', 'para three gamma EDIT')),
        'patch',
      );
      rig.stageKeystroke((md) => md.replace('para one alpha', 'para one alpha X'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U5 pending edit in the adjacent block',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(FIVE_PARA.replace('para three gamma', 'para three gamma EDIT')),
        'patch',
      );
      rig.stageKeystroke((md) => md.replace('para two beta', 'para two beta X'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U6 pending edit in the last paragraph, agent appended after',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite('agent line', 'append');
      rig.stageKeystroke((md) => md.replace('para five epsilon', 'para five epsilon X'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U7 non-contiguous pending (first + last), target the middle',
    harmful: true,
    expectedPreDrain: false,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(FIVE_PARA.replace('para three gamma', 'para three gamma EDIT')),
        'patch',
      );
      rig.stageKeystroke((md) =>
        md
          .replace('para one alpha', 'para one alpha X')
          .replace('para five epsilon', 'para five epsilon X'),
      );
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U8a empty doc, keystroke inside the agent first block',
    harmful: true,
    expectedPreDrain: false,
    base: '',
    stage: (rig) => {
      rig.agentWrite('first block', 'append');
      rig.stageKeystroke((md) => md.replace('first block', 'first XXblock'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U8b empty doc, pending new paragraph after the agent first block',
    harmful: false,
    expectedPreDrain: true,
    base: '',
    stage: (rig) => {
      rig.agentWrite('first block', 'append');
      rig.stageKeystroke((md) => `${md.trimEnd()}\n\nfresh keystroke`);
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U9 target spans two blocks, pending in an adjacent block',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(
          FIVE_PARA.replace(
            'para two beta\n\npara three gamma',
            'para two BETA\n\npara three GAMMA',
          ),
        ),
        'patch',
      );
      rig.stageKeystroke((md) => md.replace('para four delta', 'para four delta X'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'U10 pending pure-insert between distant blocks',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite(
        canon(FIVE_PARA.replace('para five epsilon', 'para five epsilon EDIT')),
        'patch',
      );
      rig.stageKeystroke((md) => md.replace('para one alpha', 'para one alpha\n\ninserted para'));
      return rig.discriminateUndo();
    },
  },
  {
    id: 'E1 second agent append, pending appended paragraph',
    harmful: false,
    expectedPreDrain: true,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.agentWrite('agent line', 'append');
      rig.stageKeystroke((md) => `${md.trimEnd()}\n\nfresh keystroke`);
      return rig.discriminateAgentWrite('second agent line', 'append');
    },
  },
  {
    id: 'E2 agent patch of the paragraph the user is typing in',
    harmful: false,
    expectedPreDrain: false,
    base: FIVE_PARA,
    stage: (rig) => {
      rig.stageKeystroke((md) => md.replace('para two beta', 'para two beta typed'));
      return rig.discriminateAgentWrite(
        canon(FIVE_PARA.replace('para two beta', 'para two beta AGENT')),
        'patch',
      );
    },
  },
];

async function runScenario(scenario: Scenario): Promise<PreDrainVerdict> {
  const rig = await createDiscriminatorRig(scenario.base);
  try {
    return scenario.stage(rig);
  } finally {
    await rig.cleanup();
  }
}

describe('cost gate: cheap fail-closed guards short-circuit before the localizer', () => {
  const baseInput = {
    body: 'para one\n\npara two',
    fragmentPmJson: {},
    fmPrefixLen: 0,
    mdManager: throwingMdManager,
    op: { kind: 'agent-write', composedBody: 'x', writeKind: 'prepend' } as const,
  };

  it('skips a clean paired op without touching the localizer', () => {
    const { verdict } = planPreDrain({
      ...baseInput,
      pendingDirty: false,
      witnessMatched: true,
    });
    expect(verdict).toEqual({ preDrain: false, reason: 'skip-no-pending' });
  });

  it('fails closed on a witness mismatch without touching the localizer', () => {
    const { verdict } = planPreDrain({
      ...baseInput,
      pendingDirty: true,
      witnessMatched: false,
    });
    expect(verdict).toEqual({ preDrain: false, reason: 'checkpoint-witness-mismatch' });
  });

  it('fails closed on a missing target without touching the localizer', () => {
    const { verdict } = planPreDrain({
      ...baseInput,
      pendingDirty: true,
      witnessMatched: true,
    });
    expect(verdict).toEqual({ preDrain: false, reason: 'checkpoint-no-target' });
  });
});

describe('same-block discriminator corpus (splice+graze)', () => {
  it.each(SCENARIOS)('$id → classified as measured', async (scenario) => {
    const verdict = await runScenario(scenario);
    expect(verdict.preDrain).toBe(scenario.expectedPreDrain);
  });

  it('zero-harmful-direction bar: no measured-harmful scenario is admitted to pre-drain', async () => {
    const harmful = SCENARIOS.filter((s) => s.harmful);
    for (const scenario of harmful) {
      const verdict = await runScenario(scenario);
      expect(
        verdict.preDrain,
        `harmful scenario admitted to pre-drain: ${scenario.id} (${verdict.reason})`,
      ).toBe(false);
    }
  });
});

describe('classifyPreDrain — pure overlap core', () => {
  const body = 'para one\n\npara two\n\npara three';

  it('admits disjoint splice and target to pre-drain', () => {
    const verdict = classifyPreDrain({ start: 0, end: 8 }, { start: 20, end: 30 }, body);
    expect(verdict).toEqual({ preDrain: true, reason: 'pre-drain-disjoint' });
  });

  it('routes a substantive overlap to checkpoint', () => {
    const verdict = classifyPreDrain({ start: 0, end: 12 }, { start: 8, end: 18 }, body);
    expect(verdict).toEqual({ preDrain: false, reason: 'checkpoint-substantive-overlap' });
  });

  it('admits an all-whitespace intersection via the graze relaxation', () => {
    const verdict = classifyPreDrain({ start: 0, end: 10 }, { start: 8, end: 18 }, body);
    expect(verdict).toEqual({ preDrain: true, reason: 'pre-drain-whitespace-graze' });
  });

  it('fails closed on a null splice', () => {
    expect(classifyPreDrain(null, { start: 0, end: 5 }, body)).toEqual({
      preDrain: false,
      reason: 'checkpoint-null-splice',
    });
  });

  it('fails closed on a null target', () => {
    expect(classifyPreDrain({ start: 0, end: 5 }, null, body)).toEqual({
      preDrain: false,
      reason: 'checkpoint-no-target',
    });
  });

  it('checkpoints a zero-width target strictly inside the rewrite', () => {
    const verdict = classifyPreDrain({ start: 0, end: 12 }, { start: 6, end: 6 }, body);
    expect(verdict).toEqual({ preDrain: false, reason: 'checkpoint-substantive-overlap' });
  });

  it('admits a zero-width target on the rewrite boundary (not strictly inside)', () => {
    const atStart = classifyPreDrain({ start: 6, end: 12 }, { start: 6, end: 6 }, body);
    const atEnd = classifyPreDrain({ start: 0, end: 6 }, { start: 6, end: 6 }, body);
    expect(atStart).toEqual({ preDrain: true, reason: 'pre-drain-disjoint' });
    expect(atEnd).toEqual({ preDrain: true, reason: 'pre-drain-disjoint' });
  });

  it('admits a zero-width splice (pure insertion) against a positive target', () => {
    const verdict = classifyPreDrain({ start: 10, end: 10 }, { start: 0, end: 20 }, body);
    expect(verdict).toEqual({ preDrain: true, reason: 'pre-drain-disjoint' });
  });
});

describe('the drain rewrite range localizes the flush to the changed block', () => {
  it('localizes an appended block to its region, disjoint from an untouched prefix', () => {
    const body = 'para one alpha\n\npara two beta';
    const fragment = mdManager.parse(`${body}\n\npara three gamma`);
    const splice = drainRewriteRange(body, fragment);
    expect(splice).not.toBeNull();
    expect((splice as BodySpan).start).toBeGreaterThanOrEqual(body.indexOf('para two'));
  });

  it('localizes an edited middle block away from the prefix', () => {
    const body = 'para one alpha\n\npara two beta\n\npara three gamma';
    const fragment = mdManager.parse(body.replace('para two beta', 'para two beta EDIT'));
    const splice = drainRewriteRange(body, fragment);
    expect(splice).not.toBeNull();
    const s = splice as BodySpan;
    expect(s.start).toBeGreaterThan(0);
    expect(s.end).toBeLessThanOrEqual(body.length);
  });
});

describe('extractComposeTargetSpan — agent-write target', () => {
  const body = 'para one\n\npara two\n\npara three';

  it('targets the trailing seam for an append', () => {
    const withTrailing = `${body}\n`;
    const span = extractComposeTargetSpan(withTrailing, 'append');
    expect(span).toEqual({ start: body.length, end: withTrailing.length });
  });

  it('fails closed (null) for every non-append position', () => {
    expect(extractComposeTargetSpan(body, 'prepend')).toBeNull();
    expect(extractComposeTargetSpan(body, 'replace')).toBeNull();
    expect(extractComposeTargetSpan(body, 'patch')).toBeNull();
  });
});

describe('full-body-overwrite positions are structurally inert', () => {
  const body = 'alpha one\n\nbeta two\n';
  const pendingFragment = mdManager.parse(`${body}\ngamma three appended\n`);

  for (const position of ['replace', 'patch'] as const) {
    it(`declines a ${position} write outright`, () => {
      const plan = planPreDrain({
        pendingDirty: true,
        body,
        fragmentPmJson: pendingFragment,
        witnessMatched: true,
        fmPrefixLen: 0,
        op: { kind: 'agent-write', writeKind: position },
        mdManager,
      });
      expect(plan.verdict.preDrain).toBe(false);
      expect(plan.verdict.reason).toBe('checkpoint-full-overwrite');
      expect(plan.splice).toBeNull();
    });
  }

  it('still admits the localized append it is meant to serve', () => {
    const plan = planPreDrain({
      pendingDirty: true,
      body,
      fragmentPmJson: pendingFragment,
      witnessMatched: true,
      fmPrefixLen: 0,
      op: { kind: 'agent-write', writeKind: 'append' },
      mdManager,
    });
    expect(plan.verdict.preDrain).toBe(true);
    expect(plan.splice).not.toBeNull();
  });
});

function hunksOnlyAdmitsFlush(body: string, pendingBody: string, target: BodySpan): boolean {
  let offset = 0;
  const removed: BodySpan[] = [];
  for (const change of diffLinesFast(body, pendingBody)) {
    if (change.removed) {
      removed.push({ start: offset, end: offset + change.value.length });
      offset += change.value.length;
    } else if (!change.added) {
      offset += change.value.length;
    }
  }
  const overlaps = (a: BodySpan, b: BodySpan): boolean =>
    Math.max(a.start, b.start) < Math.min(a.end, b.end);
  return !removed.some((h) => overlaps(h, target));
}

describe('hunks-only localizer is refuted (non-contiguous pending leaks)', () => {
  it('the splice model checkpoints a target between two non-contiguous pending edits while hunks admit it', () => {
    const body = 'alpha one\n\nbeta two\n\ngamma three\n\ndelta four\n\nepsilon five';
    const target: BodySpan = (() => {
      const start = body.indexOf('gamma three');
      return { start, end: start + 'gamma three'.length };
    })();
    const pendingBody = body
      .replace('alpha one', 'alpha one EDIT')
      .replace('epsilon five', 'epsilon five EDIT');
    const pendingFragment = mdManager.parse(pendingBody);
    const spliceRange = drainRewriteRange(body, pendingFragment);

    expect(classifyPreDrain(spliceRange, target, body).preDrain).toBe(false);
    expect(hunksOnlyAdmitsFlush(body, pendingBody, target)).toBe(true);
  });
});
