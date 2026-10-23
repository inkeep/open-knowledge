import type { LocalApiDispatch } from '../../http/local-api-dispatch.ts';
import { httpGet } from './shared.ts';

export function checkHttpGetCancellationTargets(local: LocalApiDispatch, signal: AbortSignal) {
  void httpGet('http://localhost', '/api/audit', signal);
  void httpGet({ url: 'http://localhost', local }, '/api/audit');
  // @ts-expect-error Local dispatch does not support caller cancellation.
  void httpGet({ url: 'http://localhost', local }, '/api/audit', signal);
}
