/**
 * The fold's half of the legacy Codex warning contract: a complete producer
 * envelope becomes runtime-status chrome, and everything else keeps its bytes
 * and its ordinary bubble.
 *
 * Fixtures carry the producer's exact emission rather than hand-typed
 * approximations, and the same file backs the core predicate's tests and the
 * server's boundary guard, so the three cannot drift apart.
 */

import type { SessionUpdate, ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import * as fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import fixture from '../../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import { transcriptItemId } from '../../components/acp/transcript-item-id';
import {
  buildThreadRenderModel,
  type RenderedItem,
  ThreadRenderModelBuilder,
} from './thread-event-model';

const CODEX = fixture.agents.codexRegistry;
const CLAUDE = fixture.agents.claudeRegistry;

type AgentIdentity = typeof fixture.agents.codexRegistry;
const agentNamed = (name: string | undefined): AgentIdentity =>
  name === undefined ? CODEX : (fixture.agents as Record<string, AgentIdentity>)[name];

/**
 * Fixture updates are untyped wire JSON on purpose: several negatives are
 * shapes the SDK's types forbid, which is exactly what has to reach the fold
 * unclassified rather than be excluded by a cast at the test boundary.
 */
const asUpdate = (value: unknown): SessionUpdate => value as SessionUpdate;

let ts = 0;
function su(update: unknown): ThreadEvent {
  ts += 1;
  return { kind: 'session_update', update: asUpdate(structuredClone(update)), ts };
}

function chunk(text: string, messageId?: string): ThreadEvent {
  return su({
    sessionUpdate: 'agent_message_chunk',
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text', text },
  });
}

type AgentNotice = Extract<RenderedItem, { kind: 'agent_notice' }>;
type Message = Extract<RenderedItem, { kind: 'message' }>;

const notices = (items: readonly RenderedItem[]): AgentNotice[] =>
  items.filter((item): item is AgentNotice => item.kind === 'agent_notice');

const agentMessages = (items: readonly RenderedItem[]): Message[] =>
  items.filter((item): item is Message => item.kind === 'message' && item.role === 'agent');

/**
 * Every message bubble regardless of role — a near miss on a thought or user
 * chunk still has to keep its bytes, and it keeps them on its own role's path.
 */
const messageText = (items: readonly RenderedItem[]): string =>
  items
    .filter((item): item is Message => item.kind === 'message')
    .map((item) => item.text)
    .join('');

/** Every agent-authored byte the fold emitted, notice and prose alike, in order. */
const agentText = (items: readonly RenderedItem[]): string =>
  items
    .filter(
      (item): item is AgentNotice | Message =>
        item.kind === 'agent_notice' || (item.kind === 'message' && item.role === 'agent'),
    )
    .map((item) => item.text)
    .join('');

describe('legacy Codex warning classification', () => {
  test('the observed warning envelope becomes one runtime-status row, not agent prose', () => {
    const event = su(fixture.candidates[0].update);

    const model = buildThreadRenderModel([event], CODEX);

    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toEqual({
      kind: 'agent_notice',
      source: 'codex_legacy',
      severity: 'warning',
      text: fixture.candidates[0].update.content.text,
      seq: 0,
    });
  });

  test('the same bytes from another agent stay an ordinary message', () => {
    const event = su(fixture.candidates[0].update);

    const model = buildThreadRenderModel([event], CLAUDE);

    expect(notices(model.items)).toHaveLength(0);
    expect(agentMessages(model.items)).toEqual([
      expect.objectContaining({ role: 'agent', text: fixture.candidates[0].update.content.text }),
    ]);
  });

  test('a thread with no configured agent classifies nothing', () => {
    const model = buildThreadRenderModel([su(fixture.candidates[0].update)], null);

    expect(notices(model.items)).toHaveLength(0);
    expect(agentMessages(model.items)).toHaveLength(1);
  });

  test.each(
    fixture.candidates.map((c) => [c.name, c] as const),
  )('candidate %s folds to a single verbatim notice', (_name, candidate) => {
    const model = buildThreadRenderModel([su(candidate.update)], CODEX);

    expect(notices(model.items)).toEqual([
      {
        kind: 'agent_notice',
        source: 'codex_legacy',
        severity: 'warning',
        text: candidate.update.content.text,
        seq: 0,
      },
    ]);
  });

  test('a config warning keeps its internal blank lines in one row', () => {
    const detailed = fixture.candidates.find((c) => c.name === 'config-warning-with-details');
    if (detailed === undefined) throw new Error('fixture lost its detailed config warning');
    expect(detailed.update.content.text).toContain('\n\n-');

    const model = buildThreadRenderModel([su(detailed.update)], CODEX);

    expect(model.items).toHaveLength(1);
    expect(notices(model.items)[0].text).toBe(detailed.update.content.text);
  });

  test('an event mixing chrome with prose is classified whole, never split at the blank line', () => {
    const mixed = fixture.atomicity.multiParagraphWarning;

    const model = buildThreadRenderModel([su(mixed.update)], CODEX);

    expect(model.items).toHaveLength(1);
    expect(notices(model.items)[0].text).toBe(mixed.update.content.text);
  });

  test.each(
    fixture.negatives.map((n) => [n.name, n] as const),
  )('near miss %s keeps its bytes on the ordinary path', (_name, negative) => {
    // The fixture records the identity a near miss belongs to as a KEY into
    // `agents`, not an inline object — a couple of them are near misses only
    // because of who sent them, so folding under a raw key would reject them
    // for being malformed and prove nothing about the identity gate.
    const agent = agentNamed((negative as { agent?: string }).agent);

    const model = buildThreadRenderModel([su(negative.update)], agent);

    expect(notices(model.items)).toHaveLength(0);
    const content = (negative.update as { content?: { type?: string; text?: string } }).content;
    if (content?.type === 'text' && typeof content.text === 'string') {
      expect(messageText(model.items)).toBe(content.text);
    }
  });

  test('an ordinary answer carrying an item id stays prose', () => {
    const model = buildThreadRenderModel([su(fixture.ordinaryAnswer.update)], CODEX);

    expect(notices(model.items)).toHaveLength(0);
    expect(agentMessages(model.items)[0].text).toBe(fixture.ordinaryAnswer.update.content.text);
  });

  test('two warnings in one turn are two chronological rows', () => {
    const first = fixture.candidates[0].update.content.text;
    const second = fixture.candidates[2].update.content.text;

    const model = buildThreadRenderModel(
      [su(fixture.candidates[0].update), su(fixture.candidates[2].update)],
      CODEX,
    );

    expect(notices(model.items).map((n) => n.text)).toEqual([first, second]);
  });

  test('a warning between no-ID neighbours stays its own row without loss or reordering', () => {
    const before = fixture.neighbors.contextCompacted.update.content.text;
    const warning = fixture.candidates[0].update.content.text;
    const after = fixture.neighbors.turnError.update.content.text;

    const model = buildThreadRenderModel(
      [
        su(fixture.neighbors.contextCompacted.update),
        su(fixture.candidates[0].update),
        su(fixture.neighbors.turnError.update),
      ],
      CODEX,
    );

    expect(model.items.map((item) => item.kind)).toEqual(['message', 'agent_notice', 'message']);
    expect(agentText(model.items)).toBe(before + warning + after);
  });

  test('a warning does not glue the prose around it into one bubble', () => {
    const model = buildThreadRenderModel(
      [chunk('Reading the file'), su(fixture.candidates[0].update), chunk(' and it is fine.')],
      CODEX,
    );

    expect(agentMessages(model.items).map((m) => m.text)).toEqual([
      'Reading the file',
      ' and it is fine.',
    ]);
  });

  test('notice rows get unique ids and leave the rows before them alone', () => {
    const prose = [chunk('Reading the file')];
    const withWarnings = [
      ...prose,
      su(fixture.candidates[0].update),
      su(fixture.candidates[2].update),
    ];

    const proseIds = buildThreadRenderModel(prose, CODEX).items.map(transcriptItemId);
    const allIds = buildThreadRenderModel(withWarnings, CODEX).items.map(transcriptItemId);

    expect(allIds).toHaveLength(3);
    expect(new Set(allIds).size).toBe(3);
    expect(allIds.slice(0, proseIds.length)).toEqual(proseIds);
  });
});

describe('legacy Codex warning fold properties', () => {
  const candidateTexts = fixture.candidates.map((c) => c.update.content.text);
  const proseTexts = [
    fixture.neighbors.contextCompacted.update.content.text,
    fixture.neighbors.turnError.update.content.text,
    'Warning: no terminator here',
    'warning: lowercase\n\n',
    'plain answer text',
  ];

  /** One agent text event: a candidate, a near miss, or prose carrying an id. */
  const eventArb = fc.oneof(
    fc.constantFrom(...candidateTexts).map((text) => ({ text, candidate: true })),
    fc.constantFrom(...proseTexts).map((text) => ({ text, candidate: false })),
    fc
      .tuple(fc.constantFrom(...candidateTexts, ...proseTexts), fc.string({ minLength: 1 }))
      .map(([text, id]) => ({ text, candidate: false, messageId: id })),
  );

  test('agent bytes are conserved across notices and messages', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 25 }), (specs) => {
        const events = specs.map((spec) => chunk(spec.text, spec.messageId));

        const model = buildThreadRenderModel(events, CODEX);

        expect(agentText(model.items)).toBe(specs.map((spec) => spec.text).join(''));
        expect(notices(model.items)).toHaveLength(specs.filter((s) => s.candidate).length);
      }),
      { numRuns: 200 },
    );
  });

  test('a notice never carries a fragment of a larger event', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 25 }), (specs) => {
        const model = buildThreadRenderModel(
          specs.map((spec) => chunk(spec.text, spec.messageId)),
          CODEX,
        );

        for (const notice of notices(model.items)) {
          expect(candidateTexts).toContain(notice.text);
        }
      }),
      { numRuns: 200 },
    );
  });

  test('incremental delivery matches one-shot delivery', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 25 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 25 }),
        (specs, steps) => {
          const events = specs.map((spec) => chunk(spec.text, spec.messageId));
          const expected = buildThreadRenderModel(events, CODEX);

          const builder = new ThreadRenderModelBuilder(CODEX);
          let applied = 0;
          let model = builder.sync([]);
          let step = 0;
          while (applied < events.length) {
            applied = Math.min(applied + steps[step % steps.length], events.length);
            step += 1;
            model = builder.sync(events.slice(0, applied));
          }
          expect(model.items).toEqual(expected.items);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('legacy Codex warning classification observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('classifying emits nothing to the console or the network', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));

    buildThreadRenderModel(
      [
        su(fixture.candidates[0].update),
        su(fixture.candidates[1].update),
        su(fixture.negatives[0].update),
        su(fixture.ordinaryAnswer.update),
      ],
      CODEX,
    );

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
