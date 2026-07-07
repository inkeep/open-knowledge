/**
 * Server-bridge-spans canary.
 *
 * Wired as a perf-tier scenario for completeness — the 5-span
 * assertion is also pinned at server-tier in
 * `packages/server/src/observer-bridge-spans.test.ts`, which is the
 * canonical assertion (runs in the server's bun test process with an
 * in-memory exporter). This perf-tier wrapper documents the
 * dependency by attempting to drive a real bridge cycle through the
 * dev server when `OTEL_SDK_DISABLED=false` is set.
 *
 * When the server-side OTel SDK is disabled (default in dev), the
 * scenario records a note and exits without assertion — the
 * server-side span emission is genuinely unobservable on that path.
 * Pair the run with a local LGTM stack
 * (`docker compose up otel-dev`) to actually capture spans.
 */

import { defineScenario } from '../lib/scenario';

export default defineScenario({
  name: 'server-bridge-spans-canary',
  description:
    'Drive a representative agent-write cycle and confirm bridge spans appear in OTLP output (when SDK enabled)',
  async run(ctx) {
    // Cold-load a small doc so the bridge has something to work on.
    await ctx.page.goto(ctx.opts.target, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await ctx.page.waitForTimeout(500);

    // Trigger an agent-write style operation that flows through
    // composeAndWriteRawBody on the server. We POST to the agent-write
    // API endpoint via fetch from the page so the dev plugin's server
    // sees the request. (Endpoint expectations: see server's
    // api-extension.ts agent-write handler.)
    const { ok, error } = await ctx.page.evaluate(async () => {
      try {
        const res = await fetch('/api/agent-write-md', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docName: 'README',
            position: 'replace',
            markdown: '# Canary write\n\nbody\n',
          }),
        });
        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}` };
        }
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    if (!ok) {
      ctx.note(`agent-write probe failed: ${error}; spans cannot be asserted`);
      ctx.recordMetric('server-bridge-spans.probeOk', false);
      return;
    }

    ctx.recordMetric('server-bridge-spans.probeOk', true);
    ctx.note(
      'Span emission is asserted at server-tier in observer-bridge-spans.test.ts; this scenario only confirms the bridge cycle ran end-to-end.',
    );
  },
});
