import { readFileSync } from 'node:fs';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  DEFAULT_RRF_K,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
} from '@inkeep/open-knowledge-core';
import { chunkDocument } from '../chunking.ts';
import { cosineSimilarity, type Embedder, loadOpenAiEmbedder } from '../embedder.ts';

const HELD_OUT_MRR_GAIN_MIN = 0.05;
const HELD_OUT_RECALL5_GAIN_MIN = 0.08;
const LEXICAL_STRONG_REGRESSION_MAX = 0.03;

const RRF_K_GRID = [10, 20, 40, 60, 80, 120];

interface EvalPair {
  query: string;
  target: string;
  category: 'zero-overlap' | 'paraphrase' | 'long-doc' | 'lexical-strong';
  split: 'tune' | 'held';
}
export interface EvalSet {
  corpus: Array<{ path: string; title: string; content: string }>;
  pairs: EvalPair[];
}

export function loadEvalSet(): EvalSet {
  return JSON.parse(readFileSync(new URL('./eval-set.json', import.meta.url), 'utf-8')) as EvalSet;
}

interface Metrics {
  n: number;
  mrr: number;
  recall1: number;
  recall5: number;
}

function rankOfTarget(
  results: ReturnType<typeof searchWorkspaceCorpus>,
  targetPath: string,
): number {
  const idx = results.findIndex((r) => r.document.path === targetPath);
  return idx < 0 ? Number.POSITIVE_INFINITY : idx + 1;
}

function aggregate(ranks: number[]): Metrics {
  const n = ranks.length;
  const mrr = ranks.reduce((s, r) => s + (Number.isFinite(r) ? 1 / r : 0), 0) / Math.max(1, n);
  const recall1 = ranks.filter((r) => r <= 1).length / Math.max(1, n);
  const recall5 = ranks.filter((r) => r <= 5).length / Math.max(1, n);
  return { n, mrr, recall1, recall5 };
}

async function embedCorpusVectors(
  embedder: Embedder,
  docs: readonly WorkspaceSearchDocument[],
): Promise<Map<string, Float32Array[]>> {
  const byDoc = new Map<string, Float32Array[]>();
  for (const doc of docs) {
    const chunks = chunkDocument(doc.content);
    byDoc.set(doc.id, chunks.length ? await embedder.embed(chunks, { role: 'document' }) : []);
  }
  return byDoc;
}

function scoresForQueryVec(
  queryVec: Float32Array,
  docVectors: Map<string, Float32Array[]>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [docId, chunks] of docVectors) {
    let best = Number.NEGATIVE_INFINITY;
    for (const c of chunks) best = Math.max(best, cosineSimilarity(queryVec, c));
    if (best > Number.NEGATIVE_INFINITY) scores.set(docId, best);
  }
  return scores;
}

export interface PreparedEval {
  corpus: WorkspaceSearchCorpus;
  docVectors: Map<string, Float32Array[]>;
  queryScores: Map<string, Map<string, number>>;
  pairs: EvalPair[];
}

export async function prepareEval(embedder: Embedder, set: EvalSet): Promise<PreparedEval> {
  const docs = set.corpus.map((d) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: d.path,
      title: d.title,
      content: d.content,
    }),
  );
  const corpus = createWorkspaceSearchCorpus(docs);
  const docVectors = await embedCorpusVectors(embedder, docs);

  const queryScores = new Map<string, Map<string, number>>();
  for (const pair of set.pairs) {
    if (queryScores.has(pair.query)) continue;
    const [queryVec] = await embedder.embed([pair.query], { role: 'query' });
    queryScores.set(pair.query, scoresForQueryVec(queryVec, docVectors));
  }
  return { corpus, docVectors, queryScores, pairs: set.pairs };
}

interface RunConfig {
  rrfK: number;
  semantic: boolean;
}

function evaluate(prep: PreparedEval, pairs: EvalPair[], cfg: RunConfig): Metrics {
  const ranks = pairs.map((pair) => {
    const sem = cfg.semantic
      ? {
          scores: prep.queryScores.get(pair.query) ?? new Map<string, number>(),
          rrfK: cfg.rrfK,
        }
      : undefined;
    const results = searchWorkspaceCorpus(prep.corpus, pair.query, {
      intent: 'full_text',
      limit: 20,
      semantic: sem,
    });
    return rankOfTarget(results, pair.target);
  });
  return aggregate(ranks);
}

interface CalibrationResult {
  best: { rrfK: number; mrr: number };
  grid: Array<{ rrfK: number; mrr: number }>;
}

function calibrate(prep: PreparedEval): CalibrationResult {
  const tune = prep.pairs.filter((p) => p.split === 'tune');
  const grid = RRF_K_GRID.map((rrfK) => ({
    rrfK,
    mrr: evaluate(prep, tune, { rrfK, semantic: true }).mrr,
  }));
  const best = grid.reduce((a, b) => (b.mrr > a.mrr ? b : a));
  return { best, grid };
}

export interface HeldOutReport {
  calibration: CalibrationResult;
  lexical: Metrics;
  semantic: Metrics;
  mrrGain: number;
  recall5Gain: number;
  lexicalStrongRegression: number;
  passes: boolean;
}

const PRODUCTION_RRF_K = DEFAULT_RRF_K;

export function runHeldOutEval(prep: PreparedEval): HeldOutReport {
  const calibration = calibrate(prep);
  const rrfK = PRODUCTION_RRF_K;
  const held = prep.pairs.filter((p) => p.split === 'held');
  const heldStrong = held.filter((p) => p.category === 'lexical-strong');

  const lexical = evaluate(prep, held, { rrfK, semantic: false });
  const semantic = evaluate(prep, held, { rrfK, semantic: true });
  const lexStrongLex = evaluate(prep, heldStrong, { rrfK, semantic: false });
  const lexStrongSem = evaluate(prep, heldStrong, { rrfK, semantic: true });

  const mrrGain = semantic.mrr - lexical.mrr;
  const recall5Gain = semantic.recall5 - lexical.recall5;
  const lexicalStrongRegression = lexStrongLex.mrr - lexStrongSem.mrr;
  const passes =
    mrrGain >= HELD_OUT_MRR_GAIN_MIN &&
    recall5Gain >= HELD_OUT_RECALL5_GAIN_MIN &&
    lexicalStrongRegression <= LEXICAL_STRONG_REGRESSION_MAX;

  return { calibration, lexical, semantic, mrrGain, recall5Gain, lexicalStrongRegression, passes };
}

export async function loadEvalEmbedder(): Promise<Embedder | null> {
  return loadOpenAiEmbedder({
    keyStore: null, // env (OK_EMBEDDINGS_API_KEY) fallback only — gated runs set it
    config: {
      baseUrl: process.env.OK_EMBEDDINGS_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OK_EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
      dimensions: process.env.OK_EMBEDDINGS_DIMENSIONS
        ? Number(process.env.OK_EMBEDDINGS_DIMENSIONS)
        : undefined,
    },
  });
}

async function main(): Promise<void> {
  const embedder = await loadEvalEmbedder();
  if (!embedder) {
    console.error('No embeddings key — set OK_EMBEDDINGS_API_KEY to run the eval.');
    process.exit(1);
  }
  const prep = await prepareEval(embedder, loadEvalSet());
  const report = runHeldOutEval(prep);

  const f = (x: number) => x.toFixed(4);
  console.log('=== Calibration (TUNE split only) ===');
  for (const g of report.calibration.grid) {
    console.log(`  k=${String(g.rrfK).padStart(3)}  tuneMRR=${f(g.mrr)}`);
  }
  console.log(
    `  BEST: k=${report.calibration.best.rrfK} (tuneMRR=${f(report.calibration.best.mrr)})`,
  );
  console.log('\n=== HELD-OUT (measured once, frozen params) ===');
  console.log(
    `  lexical : MRR=${f(report.lexical.mrr)} recall@1=${f(report.lexical.recall1)} recall@5=${f(report.lexical.recall5)} (n=${report.lexical.n})`,
  );
  console.log(
    `  semantic: MRR=${f(report.semantic.mrr)} recall@1=${f(report.semantic.recall1)} recall@5=${f(report.semantic.recall5)}`,
  );
  console.log(
    `  MRR gain=${f(report.mrrGain)} (≥ ${HELD_OUT_MRR_GAIN_MIN})  recall@5 gain=${f(report.recall5Gain)} (≥ ${HELD_OUT_RECALL5_GAIN_MIN})`,
  );
  console.log(
    `  lexical-strong regression=${f(report.lexicalStrongRegression)} (≤ ${LEXICAL_STRONG_REGRESSION_MAX})`,
  );
  console.log(
    `\n  FR2 GATE: ${report.passes ? 'PASS' : 'BELOW THRESHOLD (feature stays flag-off — does not block merge)'}`,
  );
}

if (import.meta.main) {
  await main();
}
