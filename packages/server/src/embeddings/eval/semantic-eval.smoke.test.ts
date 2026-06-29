import { describe, expect, test } from 'bun:test';
import { searchWorkspaceCorpus } from '@inkeep/open-knowledge-core';
import { loadEvalEmbedder, loadEvalSet, prepareEval, runHeldOutEval } from './semantic-eval.ts';

const ENABLED = process.env.OK_EMBED_SMOKE === '1';

describe.skipIf(!ENABLED)('FR2 retrieval-quality eval (real embeddings API)', () => {
  test('candidate-source recall: every zero-overlap target is retrievable', async () => {
    const embedder = await loadEvalEmbedder();
    expect(embedder, 'set OK_EMBEDDINGS_API_KEY for the gated eval').not.toBeNull();
    if (!embedder) return;
    const set = loadEvalSet();
    const prep = await prepareEval(embedder, set);
    for (const pair of set.pairs.filter((p) => p.category === 'zero-overlap')) {
      const scores = prep.queryScores.get(pair.query) ?? new Map<string, number>();
      const results = searchWorkspaceCorpus(prep.corpus, pair.query, {
        intent: 'full_text',
        limit: 20,
        semantic: { scores, rrfK: 60 },
      });
      const found = results.some((r) => r.document.path === pair.target);
      expect(found, `zero-overlap "${pair.query}" did not retrieve ${pair.target}`).toBe(true);
    }
  }, 180_000);

  test('held-out FR2 gate (pre-registered; reported, not merge-blocking)', async () => {
    const embedder = await loadEvalEmbedder();
    if (!embedder) return;
    const prep = await prepareEval(embedder, loadEvalSet());
    const report = runHeldOutEval(prep);
    console.log('[FR2] best:', JSON.stringify(report.calibration.best));
    console.log(
      `[FR2] held-out lexical MRR=${report.lexical.mrr.toFixed(4)} semantic MRR=${report.semantic.mrr.toFixed(4)} gain=${report.mrrGain.toFixed(4)}`,
    );
    console.log(
      `[FR2] recall@5 gain=${report.recall5Gain.toFixed(4)} lexical-strong regression=${report.lexicalStrongRegression.toFixed(4)}`,
    );
    console.log(
      `[FR2] GATE ${report.passes ? 'PASS — eligible for flag flip' : 'BELOW THRESHOLD — keep flag off'}`,
    );
    expect(report.semantic.mrr).toBeGreaterThan(0);
  }, 180_000);
});
