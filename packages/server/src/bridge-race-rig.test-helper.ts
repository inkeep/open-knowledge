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

const FRESHNESS_ADVANCE_MS = 3_000;

const RIG_EXTERNAL_ORIGIN = 'bridge-race-rig/external';
const RIG_FORCE_ORIGIN = 'bridge-race-rig/force-a-round';

const EMPTY_UPDATE_META = () => ({ mapping: new Map(), isOMark: new Map() });

interface StimulusOpts {
  advanceFreshness?: boolean;
}

interface DrainTraceEntry {
  readonly label: string;
  readonly dispatches: readonly ObserverDispatchKind[];
  readonly bytes: string;
  readonly fragmentMd: string;
  readonly byteChanged: boolean;
}

export interface BridgeRaceRig {
  readonly doc: Y.Doc;
  readonly xmlFragment: Y.XmlFragment;
  readonly ytext: Y.Text;
  readonly mdManager: MarkdownManager;
  readonly trace: readonly DrainTraceEntry[];
  dispatchLog(): ObserverDispatchKind[];
  traceLines(): string[];
  serializeFragment(): string;
  advanceClock(ms: number): void;
  advancePastFreshness(): void;
  stimulus(label: string, mutate: () => void, opts?: StimulusOpts): DrainTraceEntry;
  seedSource(md: string, opts?: StimulusOpts): DrainTraceEntry;
  externalYtextEdit(
    label: string,
    mutate: (ytext: Y.Text) => void,
    opts?: StimulusOpts,
  ): DrainTraceEntry;
  editFragment(md: string, opts?: StimulusOpts): DrainTraceEntry;
  churnedFragmentEdit(md: string, opts?: StimulusOpts): DrainTraceEntry;
  echoFragmentEdit(baseMd: string, from: string, to: string, opts?: StimulusOpts): DrainTraceEntry;
  dualMutation(
    md: string,
    ytextEdit: (ytext: Y.Text) => void,
    opts?: StimulusOpts,
  ): DrainTraceEntry;
  forceARound(opts?: StimulusOpts): DrainTraceEntry;
  settle(rounds: number): DrainTraceEntry[];
  pairedWrite(label: string, mutate: () => void, origin: unknown): DrainTraceEntry;
  cleanup(): void;
}

export interface CreateRigOpts {
  docName?: string;
  setupOverrides?: Partial<SetupServerObserversOpts>;
}

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
