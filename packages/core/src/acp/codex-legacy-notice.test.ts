import type { SessionUpdate } from '@agentclientprotocol/sdk';
import * as fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import fixture from '../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import {
  type CodexLegacyAgentIdentity,
  isCodexLegacyWarningUpdate,
} from './codex-legacy-notice.ts';

const PBT_NUM_RUNS = 200;

const CODEX: CodexLegacyAgentIdentity = fixture.agents.codexRegistry;

/**
 * The fixture is untyped wire JSON on purpose: several negatives are shapes the
 * SDK's own types forbid, which is exactly what the predicate has to survive.
 */
const asUpdate = (value: unknown) => value as SessionUpdate;

const agentNamed = (name: string | undefined): CodexLegacyAgentIdentity =>
  name === undefined ? CODEX : (fixture.agents as Record<string, CodexLegacyAgentIdentity>)[name];

/**
 * Literals restated independently of the implementation. A test that imported
 * the module's own constants would stay green through a typo in them.
 */
const WARNING_PREFIX = 'Warning: ';
const CONFIG_WARNING_PREFIX = 'Config warning: ';
const TERMINATOR = '\n\n';

const candidateFrom = (text: string): SessionUpdate =>
  asUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/**
 * Openings exactly as long as the longer literal, so whatever follows one can
 * never reach back and change whether a prefix matched. Both matching and
 * near-miss members, so a property built on them constrains the rejecting
 * verdict as tightly as the accepting one.
 */
const HEADS = [
  CONFIG_WARNING_PREFIX,
  `${WARNING_PREFIX}abcdefg`,
  `${WARNING_PREFIX}${TERMINATOR}rest!`,
  'warning: abcdefg',
  'Warning:abcdefgh',
  ' Warning: abcdef',
  'config warning: ',
  'Notice: abcdefgh',
];

/** Endings exactly as long as the terminator, for the same reason. */
const TAILS = [TERMINATOR, '\nx', 'x\n', '  ', 'ab'];

describe('isCodexLegacyWarningUpdate — recorded producer envelopes', () => {
  test.each(
    fixture.candidates.map((c) => [c.name, c] as const),
  )('accepts %s', (_name, candidate) => {
    expect(isCodexLegacyWarningUpdate(asUpdate(candidate.update), CODEX)).toBe(true);
  });

  test('a config warning with internal detail paragraphs matches as ONE candidate', () => {
    const configWarning = fixture.candidates.find((c) => c.name === 'config-warning-with-details');
    const text = configWarning?.update.content?.text ?? '';

    expect(text).toContain(`${TERMINATOR}-`);
    expect(isCodexLegacyWarningUpdate(asUpdate(configWarning?.update), CODEX)).toBe(true);
  });

  test('an internal blank line never turns a near miss into a match', () => {
    // The same body with the producer's final terminator removed: still full of
    // blank lines, still not a candidate, and nothing to split on.
    const trimmed = `${WARNING_PREFIX}first paragraph${TERMINATOR}second paragraph`;

    expect(isCodexLegacyWarningUpdate(candidateFrom(trimmed), CODEX)).toBe(false);
  });

  test('a warning whose own message opens with a space still matches', () => {
    // Only the literal prefix is fixed. What the adapter interpolates after it
    // is the agent's message and is never further constrained.
    expect(isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX} spaced\n\n`), CODEX)).toBe(
      true,
    );
  });

  test('a multi-paragraph body is one verdict for the whole event, never a split', () => {
    // The characterized adapter cannot emit chrome and answer in one event, so
    // this shape is hypothetical. If it ever arrived it is classified whole:
    // carving the leading paragraph out would mean reinterpreting arbitrary
    // agent prose, which no producer contract supports.
    const { update, expectCandidate } = fixture.atomicity.multiParagraphWarning;
    const text = update.content.text;

    expect(text.split(TERMINATOR).length).toBeGreaterThan(2);
    expect(isCodexLegacyWarningUpdate(asUpdate(update), CODEX)).toBe(expectCandidate);
  });
});

describe('isCodexLegacyWarningUpdate — fails closed', () => {
  test.each(fixture.negatives.map((n) => [n.name, n] as const))('rejects %s', (_name, negative) => {
    expect(isCodexLegacyWarningUpdate(asUpdate(negative.update), agentNamed(negative.agent))).toBe(
      false,
    );
  });

  test.each(Object.entries(fixture.neighbors))('rejects the %s neighbour event', (_name, event) => {
    expect(isCodexLegacyWarningUpdate(asUpdate(event.update), CODEX)).toBe(false);
  });

  test('rejects an ordinary answer carrying an item id', () => {
    expect(isCodexLegacyWarningUpdate(asUpdate(fixture.ordinaryAnswer.update), CODEX)).toBe(false);
  });

  // The schema types this field `string | null | undefined`, and the SDK's
  // runtime validator rewrites anything else to `undefined` — but the app also
  // folds replayed log bytes and the server bounds events the validator never
  // saw, so the predicate cannot lean on that normalization.
  test.each([
    ['null', null],
    ['an empty string', ''],
    ['a string id', 'msg_01H8XK2Q4V7N3PZ'],
    ['zero', 0],
    ['a number', 42],
    ['false', false],
    ['true', true],
    ['an object', { id: 'msg_1' }],
    ['an array', ['msg_1']],
    ['NaN', Number.NaN],
  ])('rejects an otherwise exact envelope whose messageId is %s', (_label, messageId) => {
    const update = asUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text: `${WARNING_PREFIX}budget exceeded${TERMINATOR}` },
    });

    expect(isCodexLegacyWarningUpdate(update, CODEX)).toBe(false);
  });

  test('an absent messageId and an explicitly undefined one both stay candidates', () => {
    const text = `${WARNING_PREFIX}budget exceeded${TERMINATOR}`;

    expect(isCodexLegacyWarningUpdate(candidateFrom(text), CODEX)).toBe(true);
    expect(
      isCodexLegacyWarningUpdate(
        asUpdate({
          sessionUpdate: 'agent_message_chunk',
          messageId: undefined,
          content: { type: 'text', text },
        }),
        CODEX,
      ),
    ).toBe(true);
  });

  test('rejects every candidate once the agent identity is missing', () => {
    for (const candidate of fixture.candidates) {
      const update = asUpdate(candidate.update);
      expect(isCodexLegacyWarningUpdate(update, null)).toBe(false);
      expect(isCodexLegacyWarningUpdate(update, undefined)).toBe(false);
    }
  });

  test('rejects a missing update', () => {
    expect(isCodexLegacyWarningUpdate(null, CODEX)).toBe(false);
    expect(isCodexLegacyWarningUpdate(undefined, CODEX)).toBe(false);
  });

  test('every gate is independently load-bearing', () => {
    // Each row flips exactly one gate away from a known-good candidate, so a
    // gate that silently stopped being checked shows up as a single failure
    // rather than being masked by the others.
    const body = 'Skill descriptions were shortened.';
    const good = `${WARNING_PREFIX}${body}${TERMINATOR}`;
    expect(isCodexLegacyWarningUpdate(candidateFrom(good), CODEX)).toBe(true);

    expect(
      isCodexLegacyWarningUpdate(candidateFrom(good), { source: 'custom', id: 'codex-acp' }),
    ).toBe(false);
    expect(
      isCodexLegacyWarningUpdate(candidateFrom(good), { source: 'registry', id: 'claude-acp' }),
    ).toBe(false);
    expect(
      isCodexLegacyWarningUpdate(
        asUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: good } }),
        CODEX,
      ),
    ).toBe(false);
    expect(
      isCodexLegacyWarningUpdate(
        asUpdate({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_1',
          content: { type: 'text', text: good },
        }),
        CODEX,
      ),
    ).toBe(false);
    expect(isCodexLegacyWarningUpdate(candidateFrom(` ${good}`), CODEX)).toBe(false);
    expect(isCodexLegacyWarningUpdate(candidateFrom(good.trimEnd()), CODEX)).toBe(false);
  });
});

describe('isCodexLegacyWarningUpdate — properties', () => {
  test('is total over arbitrary inputs', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (update, agent) => {
        const verdict = isCodexLegacyWarningUpdate(
          update as SessionUpdate,
          agent as CodexLegacyAgentIdentity,
        );
        return typeof verdict === 'boolean';
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  test('accepts exactly the recorded grammar over generated bodies', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(WARNING_PREFIX, CONFIG_WARNING_PREFIX),
        fc.string(),
        fc.boolean(),
        (prefix, body, terminated) => {
          const text = `${prefix}${body}${terminated ? TERMINATOR : ''}`;
          const verdict = isCodexLegacyWarningUpdate(candidateFrom(text), CODEX);
          // A generated body can itself end in the terminator, so the oracle is
          // the finished bytes rather than the `terminated` flag.
          return verdict === text.endsWith(TERMINATOR);
        },
      ),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  test('rejects any body whose leading bytes are not one of the two literals', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const text = `${body}${TERMINATOR}`;
        fc.pre(!text.startsWith(WARNING_PREFIX) && !text.startsWith(CONFIG_WARNING_PREFIX));
        return isCodexLegacyWarningUpdate(candidateFrom(text), CODEX) === false;
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  test('does not mutate the update or the agent it is given', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const update = candidateFrom(`${WARNING_PREFIX}${body}${TERMINATOR}`);
        const agent: CodexLegacyAgentIdentity = { ...CODEX };
        const updateBefore = JSON.stringify(update);
        const agentBefore = JSON.stringify(agent);

        isCodexLegacyWarningUpdate(update, agent);

        return JSON.stringify(update) === updateBefore && JSON.stringify(agent) === agentBefore;
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });

  test('no interior content changes the verdict, whatever its shape or size', () => {
    // The verdict must be settled by a bounded window at each end, so splicing
    // anything at all between those windows has to leave it alone. Stated this
    // way the claim is enforceable rather than aspirational: a body-length cap,
    // a corpus or digest lookup, and a rule that re-reads the interior for
    // paragraph structure each move one of these verdicts without moving the
    // empty-interior baseline it is compared against.
    //
    // Every middle is checked against every head/tail pair rather than sampled,
    // so detection does not depend on a generator happening to draw the one
    // combination that discriminates.
    for (const head of HEADS) expect(head).toHaveLength(CONFIG_WARNING_PREFIX.length);
    for (const tail of TAILS) expect(tail).toHaveLength(TERMINATOR.length);

    const middles = [
      'plain body text',
      '\n',
      TERMINATOR,
      `${TERMINATOR}- detail: value${TERMINATOR}`,
      `${TERMINATOR}${WARNING_PREFIX}nested${TERMINATOR}`,
      `${TERMINATOR}${CONFIG_WARNING_PREFIX}nested${TERMINATOR}`,
      'x'.repeat(50_000),
    ];

    for (const head of HEADS) {
      for (const tail of TAILS) {
        const emptyInterior = isCodexLegacyWarningUpdate(candidateFrom(`${head}${tail}`), CODEX);
        for (const middle of middles) {
          expect(isCodexLegacyWarningUpdate(candidateFrom(`${head}${middle}${tail}`), CODEX)).toBe(
            emptyInterior,
          );
        }
      }
    }
  });

  test('a multi-megabyte interior changes nothing on either side of the answer', () => {
    // Kept out of the cross product above so the table stays cheap, and split
    // across an accepting and a rejecting pair so a cap cannot hide behind a
    // verdict that was already false.
    const huge = 'x'.repeat(2_000_000);

    for (const tail of [TERMINATOR, 'ab']) {
      expect(
        isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX}${huge}${tail}`), CODEX),
      ).toBe(isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX}${tail}`), CODEX));
    }
  });

  test('an arbitrary generated interior changes nothing either', () => {
    // Breadth over the shapes the table above cannot enumerate. The empty
    // interior is the baseline here too, so each draw is its own witness.
    fc.assert(
      fc.property(
        fc.constantFrom(...HEADS),
        fc.constantFrom(...TAILS),
        fc.string(),
        (head, tail, body) =>
          isCodexLegacyWarningUpdate(candidateFrom(`${head}${body}${tail}`), CODEX) ===
          isCodexLegacyWarningUpdate(candidateFrom(`${head}${tail}`), CODEX),
      ),
      { numRuns: PBT_NUM_RUNS },
    );
  });
});

describe('isCodexLegacyWarningUpdate — no observability surface', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('performs no network work and writes nothing to the console', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the predicate must not reach the network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    for (const candidate of fixture.candidates) {
      isCodexLegacyWarningUpdate(asUpdate(candidate.update), CODEX);
    }
    for (const negative of fixture.negatives) {
      isCodexLegacyWarningUpdate(asUpdate(negative.update), agentNamed(negative.agent));
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
