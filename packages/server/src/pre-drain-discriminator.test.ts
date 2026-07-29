/**
 * Pre-drain discriminator — pure decision core, span extractors, and the
 * same-block scenario corpus.
 *
 * The corpus stages each scenario through the real `AgentSessionManager` /
 * `applyAgentMarkdownWrite` paths against a real UndoManager, then runs the
 * read-only discriminator on the staged pre-propagation state. Its measured
 * harm labels are the pinned ground truth: any scenario labelled harmful that
 * the discriminator would admit to pre-drain fails the suite. The line-hunk
 * localizer is refuted on the one non-contiguous shape it leaks (the splice
 * model routes it to checkpoint; hunks admit it).
 */
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

/** The drain's rewrite RANGE — the classifier's input, from the shared localizer. */
function drainRewriteRange(
  body: string,
  fragmentPmJson: ReturnType<typeof mdManager.parse>,
): BodySpan | null {
  const splice = computeMapDrivenBodySplice(body, fragmentPmJson, mdManager);
  return splice === null ? null : { start: splice.spliceStart, end: splice.spliceEnd };
}

/** A MarkdownManager stand-in that throws if the expensive localizer is reached. */
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

/** The canonical settled form an agent's full-body payload is composed against. */
const canon = (md: string): string => mdManager.serialize(mdManager.parse(md));

interface Scenario {
  readonly id: string;
  /** The spike's measured Outcome label. */
  readonly harmful: boolean;
  /** The spike's `splice+graze` classification (true = admitted to pre-drain). */
  readonly expectedPreDrain: boolean;
  readonly base: string;
  /** Stage the scenario on the rig and return the discriminator verdict. */
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
    // A prepend has no measured target span → checkpoint before the parse.
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
    // Body bytes 8..10 are the "\n\n" block separator — whitespace only.
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
    // The rewrite starts at or after the end of "para two beta" — the appended
    // block, never the untouched prefix.
    expect((splice as BodySpan).start).toBeGreaterThanOrEqual(body.indexOf('para two'));
  });

  it('localizes an edited middle block away from the prefix', () => {
    const body = 'para one alpha\n\npara two beta\n\npara three gamma';
    const fragment = mdManager.parse(body.replace('para two beta', 'para two beta EDIT'));
    const splice = drainRewriteRange(body, fragment);
    expect(splice).not.toBeNull();
    const s = splice as BodySpan;
    // The rewrite covers the middle block, not "para one alpha".
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
    // `replace` / `patch` are full-body overwrites the plan declines before any
    // target extraction; `prepend` is unmeasured. None of them may produce a
    // span the classifier could reason a flush against.
    expect(extractComposeTargetSpan(body, 'prepend')).toBeNull();
    expect(extractComposeTargetSpan(body, 'replace')).toBeNull();
    expect(extractComposeTargetSpan(body, 'patch')).toBeNull();
  });
});

describe('full-body-overwrite positions are structurally inert', () => {
  // A pure block insertion: the drain's splice collapses to the trailing region
  // and its intersection with a whole-body target is whitespace-only — exactly
  // the shape the classifier's graze relaxation admits. The position gate has to
  // decline it BEFORE that arithmetic runs, or the overwrite silently reverts a
  // keystroke the flush already moved into the write's own loss baseline.
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

/**
 * A test-local line-hunk localizer — the REFUTED substrate. It reports the
 * removed hunks of the pending content as SEPARATE body ranges, then admits the
 * flush when none overlaps the target. It exists only to pin the leak below; the
 * production discriminator never uses it.
 */
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
    // Agent patched the middle block; the target is "gamma three".
    const target: BodySpan = (() => {
      const start = body.indexOf('gamma three');
      return { start, end: start + 'gamma three'.length };
    })();
    // Pending edits in the FIRST and LAST blocks (non-contiguous), so the drain's
    // block splice collapses over-wide across the whole doc.
    const pendingBody = body
      .replace('alpha one', 'alpha one EDIT')
      .replace('epsilon five', 'epsilon five EDIT');
    const pendingFragment = mdManager.parse(pendingBody);
    const spliceRange = drainRewriteRange(body, pendingFragment);

    // Splice model: the over-wide rewrite covers "gamma three" → checkpoint.
    expect(classifyPreDrain(spliceRange, target, body).preDrain).toBe(false);
    // Hunks-only: the two separate removed hunks miss "gamma three" → admits the
    // flush — the measured harmful-direction leak the ban exists to prevent.
    expect(hunksOnlyAdmitsFlush(body, pendingBody, target)).toBe(true);
  });
});
