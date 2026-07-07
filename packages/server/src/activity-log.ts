/**
 * Activity log ring-buffer.
 *
 * Captures per-transact YTextEvent.delta snapshots into Y.Map('agent-effects')
 * as a bounded 50-entry ring-buffer. Replicates to clients via standard Y.Doc
 * sync — no CC1 broadcast, no REST endpoint, no separate server-side store.
 *
 * Key format: `${sessionId}:${transactIdx}`.
 * Eviction: oldest-by-timestamp within the same paired-write drain as capture.
 * Error handling: structured JSON warn, metrics counter, dev/test throw.
 */

import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { incrementEffectDiffCaptureFailures } from './metrics.ts';

const RING_BUFFER_LIMIT = 50;

/** Module-level counter for unique transactIdx values across all docs. */
let _effectCounter = 0;

/**
 * Typed origin for effect-capture writes to Y.Map('agent-effects') (precedent #1).
 * `paired: false` because this origin mutates only the agent-effects ring-buffer,
 * not the bridge-coupled Y.Text/Y.XmlFragment pair — server observers must NOT
 * short-circuit on this origin (isPairedWriteOrigin returns false).
 */
const EFFECT_CAPTURE_ORIGIN: LocalTransactionOrigin = Object.freeze({
  source: 'local',
  skipStoreHooks: true,
  context: Object.freeze({ origin: 'effect-capture', paired: false }),
}) as LocalTransactionOrigin;

export interface EffectValue {
  sessionId: string;
  timestamp: number;
  delta: Y.YTextEvent['delta'];
  agent_type: string;
  color_seed: string;
}

/**
 * Register a one-shot ytext observer that captures the next YTextEvent.delta
 * into Y.Map('agent-effects'). Must be called BEFORE the agent write transact.
 *
 * @param ytext      The Y.Text('source') instance to observe.
 * @param sessionId  The agent's writer ID (e.g. 'agent-<connectionId>').
 * @param colorSeed  Color seed for UI rendering (defaults to sessionId).
 * @param agentType  Agent type string for UI aggregation (e.g. 'claude', 'cursor').
 */
export function captureEffect(
  ytext: Y.Text,
  sessionId: string,
  colorSeed?: string,
  agentType?: string,
): void {
  const doc = ytext.doc;
  if (!doc) return;

  const transactIdx = ++_effectCounter;
  const effectsMap = doc.getMap<EffectValue>('agent-effects');

  const observer = (event: Y.YTextEvent) => {
    ytext.unobserve(observer);
    doc.off('destroy', onDocDestroy);
    const key = `${sessionId}:${transactIdx}`;
    const value: EffectValue = {
      sessionId,
      timestamp: Date.now(),
      delta: event.delta,
      agent_type: agentType ?? 'agent',
      color_seed: colorSeed ?? sessionId,
    };
    try {
      doc.transact(() => {
        effectsMap.set(key, value);
        if (effectsMap.size > RING_BUFFER_LIMIT) {
          const sorted = ([...effectsMap.entries()] as [string, EffectValue][]).sort(
            (a, b) => a[1].timestamp - b[1].timestamp,
          );
          for (const [k] of sorted.slice(0, effectsMap.size - RING_BUFFER_LIMIT)) {
            effectsMap.delete(k);
          }
        }
      }, EFFECT_CAPTURE_ORIGIN);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(JSON.stringify({ event: 'effect-diff-capture-failed', sessionId, reason }));
      incrementEffectDiffCaptureFailures();
      if (process.env.NODE_ENV !== 'production') throw e;
    }
  };

  const onDocDestroy = () => {
    ytext.unobserve(observer);
  };

  ytext.observe(observer);
  doc.once('destroy', onDocDestroy);
}
