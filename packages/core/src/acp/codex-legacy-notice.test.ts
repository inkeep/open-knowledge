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

const asUpdate = (value: unknown) => value as SessionUpdate;

const agentNamed = (name: string | undefined): CodexLegacyAgentIdentity =>
  name === undefined ? CODEX : (fixture.agents as Record<string, CodexLegacyAgentIdentity>)[name];

const WARNING_PREFIX = 'Warning: ';
const CONFIG_WARNING_PREFIX = 'Config warning: ';
const TERMINATOR = '\n\n';

const candidateFrom = (text: string): SessionUpdate =>
  asUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

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
    const trimmed = `${WARNING_PREFIX}first paragraph${TERMINATOR}second paragraph`;

    expect(isCodexLegacyWarningUpdate(candidateFrom(trimmed), CODEX)).toBe(false);
  });

  test('a warning whose own message opens with a space still matches', () => {
    expect(isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX} spaced\n\n`), CODEX)).toBe(
      true,
    );
  });

  test('a multi-paragraph body is one verdict for the whole event, never a split', () => {
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
    const huge = 'x'.repeat(2_000_000);

    for (const tail of [TERMINATOR, 'ab']) {
      expect(
        isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX}${huge}${tail}`), CODEX),
      ).toBe(isCodexLegacyWarningUpdate(candidateFrom(`${WARNING_PREFIX}${tail}`), CODEX));
    }
  });

  test('an arbitrary generated interior changes nothing either', () => {
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
