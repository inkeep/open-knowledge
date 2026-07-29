/**
 * Deterministic bridge-race rig — one shared substrate that drives the REAL
 * `setupServerObservers` drain on a bare `Y.Doc`, so drain-race suites assert
 * against the production observer bridge (the `afterAllTransactions`
 * settlement dispatcher, both observer directions, all gates, the
 * map-driven-splice / Path-B merge write paths, and the real Observer B
 * `parseWithFallback → updateYFragment` re-derive) rather than a replica. It is
 * imported by sibling `*.test.ts` files; it is not itself a test.
 *
 * Why per-stimulus grouping. `onDispatch` fires once per drain from inside
 * `afterAllTransactions`, and a single outermost `doc.transact()` can produce
 * several drains: the observer sync writes are themselves nested transactions
 * whose own settlement dispatches fire (self-origin drains report 'none'). yjs
 * runs all of that synchronously before the outermost `transact` returns, so
 * the rig collects every drain's dispatch decision into one trace entry keyed
 * to the stimulus, and snapshots the settled Y.Text bytes once the stimulus
 * completes. A dual-CRDT stimulus therefore reads as e.g.
 * `dispatches: ['a','none','b']` with the post-drain bytes.
 *
 * Deterministic freshness. Observer A's re-derive freshness gate reads
 * `Date.now()` against the last external Y.Text change (a 2s quiescence window
 * that is not injectable). The rig fakes only `Date` (`vi.useFakeTimers({
 * toFake: ['Date'] })`, installed by the consuming test) and advances a
 * mutable clock past that window before each default stimulus, so whether a
 * drain runs freshness-safe or freshness-suppressed is scripted, not
 * wall-clock-dependent. Faking only Date keeps span timing and the settlement
 * dispatcher (which uses no wall clock, precedent #13(b)) untouched.
 *
 * The rig introduces no wall-clock scheduling of its own — it holds no timers
 * and reads the clock only through the faked `Date` the consumer installs.
 */

import { type MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { vi } from 'vitest';
import * as Y from 'yjs';
import { mdManager as productionMdManager } from './md-manager.ts';
import type { ObserverDispatchKind, SetupServerObserversOpts } from './server-observers.ts';
import { setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

/**
 * Clock advance used to cross the server's hardcoded 2s freshness-quiescence
 * window before a default stimulus. 3s leaves a full second of headroom.
 */
const FRESHNESS_ADVANCE_MS = 3_000;

// Non-paired stimulus origins. Plain strings are neither OBSERVER_SYNC_ORIGIN
// (self-skip) nor a frozen PairedWriteOrigin (isPairedWriteOrigin is a
// structural check), so the observer callbacks treat them as external edits
// and flag the corresponding CRDT dirty.
const RIG_EXTERNAL_ORIGIN = 'bridge-race-rig/external';
const RIG_FORCE_ORIGIN = 'bridge-race-rig/force-a-round';

const EMPTY_UPDATE_META = () => ({ mapping: new Map(), isOMark: new Map() });

interface StimulusOpts {
  /**
   * Advance the faked `Date` past the freshness-quiescence window before
   * mutating (default true). Pass false to run the freshness-HOT path, where
   * an external Y.Text change is still recent and Observer A serializes with
   * `skipFreshnessDerive` (the producer guard is skipped as knowingly
   * historical).
   */
  advanceFreshness?: boolean;
}

interface DrainTraceEntry {
  /** Stable label identifying the stimulus that produced this entry. */
  readonly label: string;
  /** Every drain's dispatch decision during the stimulus, in fire order. */
  readonly dispatches: readonly ObserverDispatchKind[];
  /** Settled `Y.Text('source')` bytes after the stimulus completed. */
  readonly bytes: string;
  /** Canonical serialization of the settled XmlFragment (bridge md-side). */
  readonly fragmentMd: string;
  /** True when `bytes` differs from the previous entry's settled bytes. */
  readonly byteChanged: boolean;
}

export interface BridgeRaceRig {
  readonly doc: Y.Doc;
  readonly xmlFragment: Y.XmlFragment;
  readonly ytext: Y.Text;
  /** The MarkdownManager the observers run through (production singleton unless overridden). */
  readonly mdManager: MarkdownManager;
  /** Ordered per-stimulus trace. */
  readonly trace: readonly DrainTraceEntry[];
  /** Every dispatch decision across all stimuli, flattened in fire order. */
  dispatchLog(): ObserverDispatchKind[];
  /** Compact, comparable trace lines for the determinism contract. */
  traceLines(): string[];
  /** Canonical markdown serialization of the current XmlFragment. */
  serializeFragment(): string;
  /** Advance the faked Date clock by `ms`. */
  advanceClock(ms: number): void;
  /** Advance the faked Date clock past the freshness-quiescence window. */
  advancePastFreshness(): void;
  /** Core recorder: run `mutate`, capture the stimulus's drains + settled state. */
  stimulus(label: string, mutate: () => void, opts?: StimulusOpts): DrainTraceEntry;
  /** External source-editor write: replace Y.Text with `md` under a non-paired origin. */
  seedSource(md: string, opts?: StimulusOpts): DrainTraceEntry;
  /** Arbitrary external Y.Text mutation under a non-paired origin. */
  externalYtextEdit(
    label: string,
    mutate: (ytext: Y.Text) => void,
    opts?: StimulusOpts,
  ): DrainTraceEntry;
  /** WYSIWYG-shaped fragment write (parse `md` → updateYFragment). */
  editFragment(md: string, opts?: StimulusOpts): DrainTraceEntry;
  /**
   * WYSIWYG-shaped fragment write with the source-capture attrs stripped from
   * the parsed PM JSON — models a remote client's PM churn dropping the
   * unrendered `source*` / `position` capture attrs, the flow the bridge
   * tolerance classes exist for.
   */
  churnedFragmentEdit(md: string, opts?: StimulusOpts): DrainTraceEntry;
  /**
   * Echo-shaped fragment write: parse `baseMd`, then rewrite the FIRST text leaf
   * matching `from` to `to`, leaving the component `sourceRaw` capture attrs a
   * generation behind the advanced children. Under freshness suppression
   * (`advanceFreshness: false` with a recent external Y.Text write) Observer A
   * serializes the stale `sourceRaw` and settles, leaving the fragment holding
   * `to` while Y.Text still holds `from` — the un-propagated-keystroke shape a
   * later source-editor write would stomp.
   */
  echoFragmentEdit(baseMd: string, from: string, to: string, opts?: StimulusOpts): DrainTraceEntry;
  /** Same-transact fragment (`md`) + Y.Text mutation — the dual-CRDT drain shape. */
  dualMutation(
    md: string,
    ytextEdit: (ytext: Y.Text) => void,
    opts?: StimulusOpts,
  ): DrainTraceEntry;
  /**
   * Byte-neutral forced Observer-A round: push then delete a paragraph element
   * in one transact. Flags the fragment dirty (dispatches 'a') and runs every
   * gate while leaving the serialized bytes unchanged — the settle probe.
   */
  forceARound(opts?: StimulusOpts): DrainTraceEntry;
  /** Run `forceARound` `rounds` times; returns the produced entries. */
  settle(rounds: number): DrainTraceEntry[];
  /**
   * Run a paired-write primitive under a paired origin (e.g.
   * `composeAndWriteRawBody` under `AGENT_WRITE_ORIGIN`). Freshness is not
   * advanced by default — paired vectors control their own timing.
   */
  pairedWrite(label: string, mutate: () => void, origin: unknown): DrainTraceEntry;
  /** Detach observers and the settlement handler. */
  cleanup(): void;
}

export interface CreateRigOpts {
  docName?: string;
  /**
   * Overrides merged into the `setupServerObservers` opts — e.g. a
   * serialize-recording MarkdownManager proxy, or a `shadow` accessor for
   * checkpoint-writing suites.
   */
  setupOverrides?: Partial<SetupServerObserversOpts>;
}

/** Rewrite the first text leaf equal to `from` into `to`, in place. */
function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

/** Recursively drop `source*` / `position` capture attrs from a PM JSON tree. */
function stripCaptureAttrs(node: JSONContent): JSONContent {
  let next = node;
  if (next.attrs && typeof next.attrs === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next.attrs)) {
      if (k.startsWith('source') || k === 'position') continue;
      kept[k] = v;
    }
    next = { ...next, attrs: kept };
  }
  if (Array.isArray(next.content)) {
    next = { ...next, content: next.content.map(stripCaptureAttrs) };
  }
  return next;
}

/**
 * Create a bridge-race rig. The consuming test MUST install
 * `vi.useFakeTimers({ toFake: ['Date'] })` before driving default stimuli:
 * `advanceClock` calls `vi.setSystemTime`, which requires fake timers.
 */
export function createBridgeRaceRig(opts: CreateRigOpts = {}): BridgeRaceRig {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const mdManager = opts.setupOverrides?.mdManager ?? productionMdManager;

  const trace: DrainTraceEntry[] = [];
  const pending: ObserverDispatchKind[] = [];
  let lastBytes = ytext.toString();

  const onDispatch = (kind: ObserverDispatchKind): void => {
    pending.push(kind);
    opts.setupOverrides?.onDispatch?.(kind);
  };

  const cleanup = setupServerObservers({
    doc,
    xmlFragment,
    ytext,
    mdManager,
    schema,
    docName: opts.docName,
    ...opts.setupOverrides,
    onDispatch,
  });

  const serializeFragment = (): string =>
    mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());

  const advanceClock = (ms: number): void => {
    vi.setSystemTime(Date.now() + ms);
  };
  const advancePastFreshness = (): void => advanceClock(FRESHNESS_ADVANCE_MS);

  const record = (label: string): DrainTraceEntry => {
    const bytes = ytext.toString();
    const entry: DrainTraceEntry = {
      label,
      dispatches: pending.slice(),
      bytes,
      fragmentMd: serializeFragment(),
      byteChanged: bytes !== lastBytes,
    };
    lastBytes = bytes;
    pending.length = 0;
    trace.push(entry);
    return entry;
  };

  const stimulus = (label: string, mutate: () => void, sopts?: StimulusOpts): DrainTraceEntry => {
    if (sopts?.advanceFreshness !== false) advancePastFreshness();
    pending.length = 0;
    mutate();
    return record(label);
  };

  const parseNode = (md: string, churn: boolean): ReturnType<typeof schema.nodeFromJSON> => {
    const json = mdManager.parse(md);
    return schema.nodeFromJSON(churn ? stripCaptureAttrs(json) : json);
  };

  const populateFragment = (md: string, churn: boolean): void => {
    updateYFragment(doc, xmlFragment, parseNode(md, churn), EMPTY_UPDATE_META());
  };

  const rig: BridgeRaceRig = {
    doc,
    xmlFragment,
    ytext,
    mdManager,
    trace,
    dispatchLog: () => trace.flatMap((e) => [...e.dispatches]),
    traceLines: () =>
      trace.map(
        (e) => `${e.label} dispatch=[${e.dispatches.join(',')}] byteChanged=${e.byteChanged}`,
      ),
    serializeFragment,
    advanceClock,
    advancePastFreshness,
    stimulus,
    seedSource: (md, sopts) =>
      stimulus(
        'seed-source',
        () => {
          doc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, md);
          }, RIG_EXTERNAL_ORIGIN);
        },
        sopts,
      ),
    externalYtextEdit: (label, mutate, sopts) =>
      stimulus(label, () => doc.transact(() => mutate(ytext), RIG_EXTERNAL_ORIGIN), sopts),
    editFragment: (md, sopts) =>
      stimulus('edit-fragment', () => populateFragment(md, false), sopts),
    churnedFragmentEdit: (md, sopts) =>
      stimulus('churned-fragment', () => populateFragment(md, true), sopts),
    echoFragmentEdit: (baseMd, from, to, sopts) =>
      stimulus(
        'echo-fragment',
        () => {
          const json = mdManager.parse(baseMd);
          if (!mutateFirstText(json, from, to)) {
            throw new Error(`echoFragmentEdit: text leaf '${from}' not found in parse(baseMd)`);
          }
          updateYFragment(doc, xmlFragment, schema.nodeFromJSON(json), EMPTY_UPDATE_META());
        },
        sopts,
      ),
    dualMutation: (md, ytextEdit, sopts) =>
      stimulus(
        'dual-mutation',
        () => {
          doc.transact(() => {
            updateYFragment(doc, xmlFragment, parseNode(md, false), EMPTY_UPDATE_META());
            ytextEdit(ytext);
          }, RIG_EXTERNAL_ORIGIN);
        },
        sopts,
      ),
    forceARound: (sopts) =>
      stimulus(
        'force-a-round',
        () => {
          doc.transact(() => {
            const el = new Y.XmlElement('paragraph');
            xmlFragment.push([el]);
            xmlFragment.delete(xmlFragment.length - 1, 1);
          }, RIG_FORCE_ORIGIN);
        },
        sopts,
      ),
    settle: (rounds) => {
      const out: DrainTraceEntry[] = [];
      for (let i = 0; i < rounds; i++) out.push(rig.forceARound());
      return out;
    },
    pairedWrite: (label, mutate, origin) =>
      stimulus(label, () => doc.transact(mutate, origin), { advanceFreshness: false }),
    cleanup,
  };

  return rig;
}
