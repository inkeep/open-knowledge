
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { incrementEffectDiffCaptureFailures } from './metrics.ts';

const RING_BUFFER_LIMIT = 50;

let _effectCounter = 0;

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
