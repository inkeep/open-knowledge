import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

export async function withFsCopyCompletionObserver<T>(
  matches: (destination: string) => boolean,
  onCopy: (destination: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  let fired = false;
  let callbackError: unknown;
  const observed: string[] = [];
  const provider = new BasicTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          const destination = span.attributes['fs.path'];
          if (fired || span.name !== 'fs.cpSync' || typeof destination !== 'string') return;
          observed.push(destination);
          try {
            if (!matches(destination)) return;
            fired = true;
            onCopy(destination);
          } catch (err) {
            callbackError = err;
          }
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    await provider.shutdown();
    throw new Error(
      'A tracing provider is already registered. This helper unregisters the global provider on teardown instead of restoring the previous one, so it cannot wrap a server booted through initTelemetry.',
    );
  }
  let result: T;
  try {
    result = await run();
  } finally {
    trace.disable();
    await provider.shutdown();
  }
  if (callbackError !== undefined) throw callbackError;
  if (!fired) {
    throw new Error(
      `No fs.cpSync span whose destination the caller's matcher accepted was recorded, so the copy callback never ran. fs-traced.ts normalizes every destination to its final two path segments; the ${observed.length} it recorded during this run were: ${observed.length > 0 ? observed.join(', ') : '(none — check that fs-traced.ts still names the span fs.cpSync and still records the destination under fs.path)'}.`,
    );
  }
  return result;
}
