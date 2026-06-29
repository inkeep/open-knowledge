#!/usr/bin/env bun

import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { generateMarkdown } from './synthetic';

const BASE = process.env.STRESS_BASE_URL ?? 'http://localhost:5173';
const WS_URL = `${BASE.replace('http', 'ws')}/collab`;


interface Tier {
  name: string;
  lines: number;
  timeout: number;
}

const TIERS: Tier[] = [
  { name: 'small-realistic', lines: 500, timeout: 15_000 },
  { name: 'medium-realistic', lines: 2000, timeout: 30_000 },
  { name: 'large-realistic', lines: 10000, timeout: 60_000 },
];


async function resetServer(): Promise<void> {
  const res = await fetch(`${BASE}/api/test-reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`test-reset failed: ${res.status}`);
}

async function agentWriteMd(markdown: string, docName = 'test-doc'): Promise<void> {
  const res = await fetch(`${BASE}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, docName }),
  });
  if (!res.ok) throw new Error(`agent-write-md failed: ${res.status}`);
}

async function agentUndo(
  connectionId: string,
  docName = 'test-doc',
  scope: 'last' | 'session' = 'last',
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, docName, scope }),
  });
  return res.ok ? { ok: true } : { ok: false };
}

function createProvider(): { provider: HocuspocusProvider; doc: Y.Doc; destroy: () => void } {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: 'test-doc',
    document: doc,
    connect: true,
  });

  return {
    provider,
    doc,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

async function waitForSync(provider: HocuspocusProvider, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Provider sync timeout')), timeoutMs);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
    if (provider.isSynced) {
      clearTimeout(timer);
      resolve();
    }
  });
}


interface ScenarioResult {
  scenario: string;
  tier: string;
  elapsed: number;
  pass: boolean;
  error?: string;
}

const results: ScenarioResult[] = [];
let failures = 0;

async function runScenario(
  scenario: string,
  tier: Tier,
  fn: (doc: Y.Doc) => Promise<void>,
): Promise<void> {
  const start = performance.now();
  await resetServer();
  await wait(500);

  const { provider, doc, destroy } = createProvider();

  try {
    await waitForSync(provider);
    await fn(doc);
    const elapsed = Math.round(performance.now() - start);
    results.push({ scenario, tier: tier.name, elapsed, pass: true });
    console.log(
      `[stress-api] scenario=${scenario} tier=${tier.name} elapsed=${elapsed}ms result=pass`,
    );
  } catch (e) {
    const elapsed = Math.round(performance.now() - start);
    const error = e instanceof Error ? e.message : String(e);
    results.push({ scenario, tier: tier.name, elapsed, pass: false, error });
    console.error(
      `[stress-api] scenario=${scenario} tier=${tier.name} elapsed=${elapsed}ms result=FAIL: ${error}`,
    );
    failures++;
  } finally {
    destroy();
    await wait(200);
  }
}


async function runS1(tier: Tier, doc: Y.Doc): Promise<void> {
  const content = generateMarkdown(tier.lines);
  await agentWriteMd(content);
  await wait(2000);

  const ytext = doc.getText('source');
  const text = ytext.toString();
  if (!text.includes('Section 1')) {
    throw new Error('Y.Text does not contain expected content after agent write');
  }
  if (text.length < tier.lines * 10) {
    throw new Error(`Y.Text too short: ${text.length} chars (expected >= ${tier.lines * 10})`);
  }
}

async function runS3(tier: Tier, doc: Y.Doc): Promise<void> {
  const N = tier.lines >= 10000 ? 3 : 5;
  const connectionId = 'agent-stress-s3';

  for (let i = 0; i < N; i++) {
    const content = generateMarkdown(tier.lines);
    await agentWriteMd(`${content}\n\n## API Write ${i + 1}\n`);
    await wait(1000);
  }

  for (let i = 0; i < N; i++) {
    await agentUndo(connectionId, 'test-doc', 'last');
    await wait(500);
  }

  const ytext = doc.getText('source');
  const text = ytext.toString();
  if (text.includes('API Write')) {
    throw new Error('Y.Text still contains agent content after full undo chain');
  }
}

async function runS5(tier: Tier, doc: Y.Doc): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const content = generateMarkdown(tier.lines);
    await agentWriteMd(`${content}\n\n## Rapid API Write ${i + 1}\n`);
    await wait(100);
  }

  await wait(3000);

  const ytext = doc.getText('source');
  const text = ytext.toString();
  if (!text.includes('Rapid API Write 5')) {
    throw new Error('Y.Text does not contain last rapid write content');
  }
}

async function runS8(tier: Tier, doc: Y.Doc): Promise<void> {
  const content = generateMarkdown(tier.lines, { unicode: true });
  await agentWriteMd(content);
  await wait(2000);

  const ytext = doc.getText('source');
  const text = ytext.toString();
  if (!text.includes('\u{1F680}')) {
    throw new Error('Y.Text does not contain expected Unicode content');
  }
}


async function main(): Promise<void> {
  console.log(`\n[stress-api] Starting HTTP + server-side CRDT stress tests`);
  console.log(`[stress-api] Base URL: ${BASE}`);
  console.log(`[stress-api] WebSocket URL: ${WS_URL}\n`);

  try {
    await fetch(`${BASE}/api/document`);
  } catch {
    console.error('[stress-api] ERROR: Dev server not reachable. Run `bun run dev` first.');
    process.exit(1);
  }

  for (const tier of TIERS) {
    await runScenario('S1-propagation', tier, (doc) => runS1(tier, doc));
  }

  for (const tier of TIERS) {
    await runScenario('S3-undo-chain', tier, (doc) => runS3(tier, doc));
  }

  for (const tier of TIERS) {
    await runScenario('S5-rapid-writes', tier, (doc) => runS5(tier, doc));
  }

  for (const tier of TIERS) {
    await runScenario('S8-unicode', tier, (doc) => runS8(tier, doc));
  }

  console.log('\n[stress-api] === SUMMARY ===');
  console.log(
    `[stress-api] Total: ${results.length}, Pass: ${results.length - failures}, Fail: ${failures}`,
  );
  for (const r of results) {
    console.log(
      `  ${r.pass ? 'PASS' : 'FAIL'} ${r.scenario} @ ${r.tier} (${r.elapsed}ms)${r.error ? ` — ${r.error}` : ''}`,
    );
  }

  if (failures > 0) {
    console.error(`\n[stress-api] ${failures} scenario(s) FAILED`);
    process.exit(1);
  }

  console.log('\n[stress-api] All scenarios passed.');
}

main().catch((e) => {
  console.error('[stress-api] Fatal:', e);
  process.exit(1);
});
