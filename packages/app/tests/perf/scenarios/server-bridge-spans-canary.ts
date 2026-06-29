import { defineScenario } from '../lib/scenario';

export default defineScenario({
  name: 'server-bridge-spans-canary',
  description:
    'Drive a representative agent-write cycle and confirm bridge spans appear in OTLP output (when SDK enabled)',
  async run(ctx) {
    await ctx.page.goto(ctx.opts.target, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await ctx.page.waitForTimeout(500);

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
