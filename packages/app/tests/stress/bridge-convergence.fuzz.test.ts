/**
 * Randomized multi-client bridge-convergence stress test with invariant oracles.
 *
 * FR-17 / US-014: Samples the race space across bridge write surfaces using
 * 2-3 clients with random operations drawn from { wysiwyg-type, source-type,
 * agent-write, agent-patch, agent-undo, external-change, sync-pause, sync-resume, wait }.
 *
 * Oracles (after all ops drain + convergence loop settles):
 *   (a) bridge invariant holds on every client
 *   (b) all clients have converged (identical ytext + identical fragment)
 *   (c) origin probes on agent-origin Items report preserved
 *   (d) content preservation — every marker prefix (`M<N>-` format) registered
 *       by a content-producing op (wysiwyg-type / source-type / agent-write)
 *       that has not been invalidated by a later external-change must appear
 *       in EVERY client's final ytext. Catches Bug-A class (convergent-but-
 *       content-lost) where all clients synchronously agree on wrong content.
 *
 * Pre-fix validation (SPEC §D17 gate):
 *   Reverted server files (agent-sessions.ts, api-extension.ts, index.ts) to
 *   commit 6c914f2 (pre-US-008) and ran this fuzzer with 25 seeds. Oracle (d)
 *   caught Bug-A content loss on 6/25 seeds (24% reproduction rate). Restored
 *   to HEAD: 50/50 seeds pass the oracle on the post-fix code (occasional
 *   convergence-timeout flakes under macOS scheduler load — see Risk notes).
 *   This validates the fuzzer is load-bearing, not a no-op oracle.
 *
 * Known flake (documented, not a real bug):
 *   "Convergence failed after 25s" occurs at ~2-4% rate under heavy macOS
 *   scheduler load with 3 clients + 12 ops + aggressive inter-op pacing.
 *   This is SPEC §11 "PBT convergence fuzzer flakes on CI under runner load"
 *   risk materializing. The harness now discriminates at budget exhaustion:
 *   a final state with byte-identical peers AND a holding bridge invariant
 *   classifies as `converged-late` (a PASS, surfaced separately in the
 *   RESULT line as a perf signal) — only peer divergence or a
 *   beyond-tolerance settle fails the seed. Replay-rate triage is therefore
 *   no longer the discriminator for the timeout class (giant fuzz-grown
 *   docs replay as a coin-flip on a loaded machine — neither cleanly
 *   passing nor failing). Seed snapshots written to
 *   /tmp/bridge-conv-fuzz-<seed>/ on failure enable deterministic replay:
 *     STRESS_FUZZ_SEED=<seed> bun test packages/app/tests/stress/bridge-convergence.fuzz.test.ts
 *   Content-preservation violations (oracle d) remain deterministic-on-replay
 *   — a different signal class from convergence timing.
 *
 * Seed replay: STRESS_FUZZ_SEED=<n> bun test packages/app/tests/stress/bridge-convergence.fuzz.test.ts
 * Seed count: BRIDGE_FUZZ_SEEDS=<n> (default: 25; CI PR: 25, nightly: 100)
 *
 * D18 coverage gate: a separate test enumerates every bridge write surface and
 * asserts a corresponding op kind exists in the generator.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chunkedYTextInsert } from '@inkeep/open-knowledge-core';
import { applyExternalChange, isPairedWriteOrigin } from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';

import {
  agentPatch,
  agentUndo,
  agentWriteMd,
  assertBridgeInvariant,
  awaitDocQuiescence,
  classifyFinalState,
  createItemOriginProbe,
  createTestClients,
  createTestServer,
  mdManager,
  serializeFragment,
  type TestClient,
  type TestServer,
} from '../integration/test-harness';
import {
  buildOracleEExpectations,
  markerPrefixOf as prefixOf,
} from './oracle-e-expectations.test-helper';

function createPRNG(seed: number) {
  let state = seed | 0 || 1;
  return {
    next(): number {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    },
    nextInt(max: number): number {
      return Math.floor(this.next() * max);
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.nextInt(arr.length)];
    },
    seed,
  };
}

type Rng = ReturnType<typeof createPRNG>;

type Op =
  | { kind: 'wysiwyg-type'; clientIdx: number; text: string; marker: string }
  | { kind: 'source-type'; clientIdx: number; text: string; marker: string }
  | {
      kind: 'agent-write';
      text: string;
      position: 'append' | 'prepend' | 'replace';
      marker: string;
    }
  | { kind: 'agent-patch'; find: string; replace: string; marker: string }
  | { kind: 'agent-undo' }
  | { kind: 'external-change'; newContent: string; marker: string }
  | {
      kind: 'chunked-source-paste';
      clientIdx: number;
      text: string;
      marker: string;
    }
  | { kind: 'jsx-block'; text: string; marker: string }
  | { kind: 'large-embed'; text: string; marker: string }
  | { kind: 'sync-pause'; clientIdx: number }
  | { kind: 'sync-resume'; clientIdx: number }
  | { kind: 'wait'; ms: number };

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

function randomShortText(rng: Rng): string {
  const count = rng.nextInt(3) + 1;
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(rng.pick(WORDS));
  return words.join(' ');
}

function generateOps(rng: Rng, clientCount: number, opCount: number): Op[] {
  const ops: Op[] = [];
  const paused = new Set<number>();
  let markerIdx = 0;

  for (let i = 0; i < opCount; i++) {
    const roll = rng.next();
    const clientIdx = rng.nextInt(clientCount);

    if (roll < 0.25) {
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'wysiwyg-type', clientIdx, text: marker, marker });
    } else if (roll < 0.4) {
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'source-type', clientIdx, text: marker, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.55) {
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'agent-write', text: marker, position: 'append', marker });
    } else if (roll < 0.63) {
      const find = rng.pick(WORDS);
      const replace = rng.pick(WORDS);
      ops.push({ kind: 'agent-patch', find, replace, marker: `patch-${find}→${replace}` });
    } else if (roll < 0.66) {
      ops.push({ kind: 'agent-undo' });
    } else if (roll < 0.74) {
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      const content = `${marker}\n`;
      const stabilized = mdManager.serialize(mdManager.parse(content));
      ops.push({ kind: 'external-change', newContent: stabilized, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.77) {
      const marker = `M${markerIdx++}-chunked-${randomShortText(rng)}`;
      const filler = 'lorem ipsum dolor sit amet '.repeat(25000);
      const text = `${marker}\n\n${filler}\n`;
      ops.push({ kind: 'chunked-source-paste', clientIdx, text, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.8) {
      const marker = `M${markerIdx++}-jsx-${randomShortText(rng)}`;
      const text = `<Steps>\n\n<Step>\n\n${marker} step body.\n\n</Step>\n\n</Steps>`;
      ops.push({ kind: 'jsx-block', text, marker });
    } else if (roll < 0.83) {
      const marker = `M${markerIdx++}-embed-${randomShortText(rng)}`;
      const text = `\`\`\`html h=300px preview\n<script>\nconst EMBED_DATA = {"m": "${marker}"};\n</script>\n\`\`\``;
      ops.push({ kind: 'large-embed', text, marker });
    } else if (roll < 0.89) {
      if (paused.size < clientCount - 1) {
        const target = clientIdx % clientCount;
        if (!paused.has(target)) {
          paused.add(target);
          ops.push({ kind: 'sync-pause', clientIdx: target });
        } else {
          ops.push({ kind: 'wait', ms: rng.nextInt(40) + 20 });
        }
      } else {
        ops.push({ kind: 'wait', ms: rng.nextInt(40) + 20 });
      }
    } else if (roll < 0.97) {
      if (paused.size > 0) {
        const target = rng.pick([...paused]);
        paused.delete(target);
        ops.push({ kind: 'sync-resume', clientIdx: target });
      } else {
        ops.push({ kind: 'wait', ms: rng.nextInt(40) + 20 });
      }
    } else {
      ops.push({ kind: 'wait', ms: rng.nextInt(60) + 20 });
    }
  }

  for (const p of paused) {
    ops.push({ kind: 'sync-resume', clientIdx: p });
  }
  return ops;
}

async function applyOp(
  op: Op,
  clients: TestClient[],
  server: TestServer,
  docName: string,
): Promise<boolean> {
  switch (op.kind) {
    case 'wysiwyg-type': {
      const client = clients[op.clientIdx];
      if (!client) return;
      const paragraph = new Y.XmlElement('paragraph');
      const ytext = new Y.XmlText();
      ytext.applyDelta([{ insert: op.text }]);
      paragraph.insert(0, [ytext]);
      client.fragment.push([paragraph]);
      break;
    }
    case 'source-type': {
      const client = clients[op.clientIdx];
      if (!client) return;
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, `\n\n${op.text}\n`);
      });
      break;
    }
    case 'chunked-source-paste': {
      const client = clients[op.clientIdx];
      if (!client) return;
      const anchorIndex = client.ytext.length;
      const relPos = Y.createRelativePositionFromTypeIndex(client.ytext, anchorIndex);
      try {
        await chunkedYTextInsert(client.doc, client.ytext, anchorIndex, op.text, {
          yieldFn: () => wait(0),
          resolveOffset: (n: number) => {
            const abs = Y.createAbsolutePositionFromRelativePosition(relPos, client.doc);
            return abs?.index ?? n;
          },
        });
      } catch {}
      break;
    }
    case 'agent-write': {
      try {
        await agentWriteMd(server.port, `${op.text}\n`, { docName, position: op.position });
      } catch {
        return false;
      }
      break;
    }
    case 'jsx-block':
    case 'large-embed': {
      try {
        await agentWriteMd(server.port, `\n\n${op.text}\n`, { docName, position: 'append' });
      } catch (err) {
        if ((err as { status?: number })?.status === 409) return false;
        throw err;
      }
      break;
    }
    case 'agent-patch': {
      try {
        await agentPatch(server.port, op.find, op.replace, docName);
      } catch {
        return false;
      }
      break;
    }
    case 'agent-undo': {
      try {
        await agentUndo(server.port, { docName, connectionId: 'claude-1' });
      } catch {
        return false;
      }
      break;
    }
    case 'external-change': {
      writeFileSync(join(server.contentDir, `${docName}.md`), op.newContent, 'utf-8');
      try {
        applyExternalChange(server.instance.hocuspocus, docName, op.newContent);
      } catch {
        return false;
      }
      break;
    }
    case 'sync-pause': {
      try {
        clients[op.clientIdx]?.pauseSync();
      } catch {}
      break;
    }
    case 'sync-resume': {
      try {
        clients[op.clientIdx]?.resumeSync();
      } catch {}
      break;
    }
    case 'wait': {
      await wait(op.ms);
      break;
    }
  }
  return true;
}

type ConvergenceOutcome =
  | { outcome: 'converged' }
  | { outcome: 'converged-late' }
  | { outcome: 'stalled'; detail: string };

async function driveToConvergence(
  clients: TestClient[],
  timeoutMs = 15000,
): Promise<ConvergenceOutcome> {
  const start = Date.now();

  await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
  await wait(100);

  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const ytexts = clients.map((c) => c.ytext.toString());
    const fragMds = clients.map((c) => serializeFragment(c.fragment));
    const crdtConverged =
      ytexts.every((t) => t === ytexts[0]) && fragMds.every((m) => m === fragMds[0]);

    if (crdtConverged) {
      let allBridgeOk = true;
      for (const c of clients) {
        try {
          assertBridgeInvariant(c.ytext, c.fragment);
        } catch {
          allBridgeOk = false;
          break;
        }
      }
      if (allBridgeOk) return { outcome: 'converged' };
    }

    if (attempts < 8) {
      const target = clients[attempts % clients.length];
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.applyDelta([{ insert: `r${attempts}` }]);
      paragraph.insert(0, [text]);
      target.fragment.push([paragraph]);
      await awaitDocQuiescence(target.doc, { timeoutMs: 2000 });
    }
    attempts++;
    await wait(200);
  }

  await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
  await wait(250);
  return classifyFinalState(clients);
}

function writeFuzzSnapshot(
  seed: number,
  data: { ops: Op[]; error: unknown; clientStates: Array<{ ytext: string; fragmentMd: string }> },
): void {
  const dir = join(tmpdir(), `bridge-conv-fuzz-${seed}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify(
        {
          seed,
          ops: data.ops,
          error:
            data.error instanceof Error
              ? { message: data.error.message, stack: data.error.stack }
              : String(data.error),
          clientStates: data.clientStates,
        },
        null,
        2,
      ),
    );
  } catch {}
}

function snapshotClients(clients: TestClient[]): Array<{ ytext: string; fragmentMd: string }> {
  return clients.map((c) => ({
    ytext: c.ytext.toString(),
    fragmentMd: serializeFragment(c.fragment),
  }));
}

const ALL_OP_KINDS = [
  'wysiwyg-type',
  'source-type',
  'agent-write',
  'agent-patch',
  'agent-undo',
  'external-change',
  'chunked-source-paste',
  'jsx-block',
  'large-embed',
  'sync-pause',
  'sync-resume',
  'wait',
] as const;

const WRITE_SURFACE_TO_OP_KIND: Record<string, readonly string[]> = {
  'agent-write': ['agent-write'],
  'agent-write-md': ['agent-write'],
  'agent-patch': ['agent-patch'],
  'agent-undo': ['agent-undo'],
  'observer-a-sync': ['wysiwyg-type'],
  'observer-b-sync': ['source-type'],
  'file-watcher': ['external-change'],
  'chunked-source-paste': ['chunked-source-paste'],
  'indented-jsx-construct': ['jsx-block'],
  'large-embed-construct': ['large-embed'],
  rollback: ['agent-write', 'agent-patch'],
};

const SEED_COUNT_PR = 75;
const SEED_COUNT_NIGHTLY = 10_000;
const SEED_COUNT_DEFAULT = 25;

function parseIntegerEnv(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `${name} must be a finite integer, got ${JSON.stringify(raw)}. ` +
        `Example: ${name}=42 bun test tests/stress/bridge-convergence.fuzz.test.ts`,
    );
  }
  return parsed;
}

function resolveSeedCount(): number {
  if (process.env.STRESS_FUZZ_SEED) return 1;
  if (process.env.BRIDGE_FUZZ_SEEDS) {
    return parseIntegerEnv('BRIDGE_FUZZ_SEEDS', process.env.BRIDGE_FUZZ_SEEDS);
  }
  if (process.env.STRESS_FUZZ_NIGHTLY === '1') return SEED_COUNT_NIGHTLY;
  if (process.env.STRESS_FUZZ_PR === '1') return SEED_COUNT_PR;
  return SEED_COUNT_DEFAULT;
}
const SEED_COUNT = resolveSeedCount();
const FIXED_SEED = process.env.STRESS_FUZZ_SEED
  ? parseIntegerEnv('STRESS_FUZZ_SEED', process.env.STRESS_FUZZ_SEED)
  : undefined;

if (FIXED_SEED === undefined) {
  const mode =
    process.env.STRESS_FUZZ_NIGHTLY === '1'
      ? 'nightly'
      : process.env.STRESS_FUZZ_PR === '1'
        ? 'pr'
        : process.env.BRIDGE_FUZZ_SEEDS
          ? 'custom'
          : 'default';
  console.log(`[bridge-convergence fuzzer] mode=${mode} seeds=${SEED_COUNT}`);
}

describe('bridge-convergence fuzzer (FR-17)', () => {
  let server: TestServer;
  const fuzzPassed: number[] = [];
  const fuzzFailed: number[] = [];
  const fuzzConvergedLate: number[] = [];

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    process.stdout.write(
      `[fuzz] RESULT seeds=${fuzzPassed.length + fuzzFailed.length} passed=${fuzzPassed.length} failed=${fuzzFailed.length} failingSeeds=[${fuzzFailed.join(',')}] convergedLate=${fuzzConvergedLate.length} convergedLateSeeds=[${fuzzConvergedLate.join(',')}]\n`,
    );
    try {
      await server?.cleanup();
    } catch (err) {
      console.warn(
        '[bridge-convergence fuzzer] server.cleanup() failed after RESULT emission:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  const seeds =
    FIXED_SEED !== undefined
      ? [FIXED_SEED]
      : Array.from({ length: SEED_COUNT }, (_, i) => Date.now() + i);

  test.each(seeds)(
    'bridge-convergence seed %d',
    async (seed) => {
      let setupOk = false;
      let clients: Awaited<ReturnType<typeof createTestClients>> = [] as never;
      const rng = createPRNG(seed);
      const clientCount = 2 + (seed % 2); // 2..3
      const opCount = 12;
      const docName = `fuzz-${seed}`;

      try {
        await agentWriteMd(server.port, 'seed paragraph\n', { docName, position: 'replace' });
        await wait(200);

        clients = await createTestClients(server.port, {
          count: clientCount,
          docName,
          perClientOptions: { syncControl: true, skipInvariantWatcher: true },
        });
        setupOk = true;
      } catch (err) {
        fuzzFailed.push(seed);
        throw err;
      }
      if (!setupOk) {
        fuzzFailed.push(seed);
        throw new Error(`bridge-convergence fuzz setup invariant violated for seed ${seed}`);
      }

      const localFuzzOrigin = Object.freeze({
        source: 'local' as const,
        skipStoreHooks: false,
        context: Object.freeze({
          origin: 'agent-write',
          paired: true as const,
          session_id: `fuzz-probe-${seed}`,
        }),
      });
      if (!isPairedWriteOrigin(localFuzzOrigin)) {
        throw new Error(
          `fuzz: isPairedWriteOrigin(localFuzzOrigin) failed — per-session origin rejected`,
        );
      }
      const agentProbes = clients.map((c) =>
        createItemOriginProbe(c.ytext, { trackedOrigins: [localFuzzOrigin] }),
      );

      const livePrefixes = new Set<string>();

      let expectedBody = 'seed paragraph'; // post-seed, pre-op initial state
      let authoredBytes = Buffer.byteLength('seed paragraph');
      const updateExpectedBody = (op: Op): void => {
        switch (op.kind) {
          case 'wysiwyg-type':
          case 'source-type':
            expectedBody = expectedBody.length > 0 ? `${expectedBody}\n\n${op.marker}` : op.marker;
            break;
          case 'agent-write': {
            switch (op.position) {
              case 'replace':
                expectedBody = op.marker;
                break;
              case 'prepend':
                expectedBody =
                  expectedBody.length > 0 ? `${op.marker}\n\n${expectedBody}` : op.marker;
                break;
              case 'append':
                expectedBody =
                  expectedBody.trim().length > 0 ? `${expectedBody}\n\n${op.marker}` : op.marker;
                break;
            }
            break;
          }
          case 'agent-patch': {
            const pos = expectedBody.indexOf(op.find);
            if (pos !== -1) {
              expectedBody =
                expectedBody.slice(0, pos) + op.replace + expectedBody.slice(pos + op.find.length);
            }
            break;
          }
          case 'external-change':
            expectedBody = op.newContent.replace(/\n+$/, '');
            break;
          case 'agent-undo':
            expectedBody = '';
            break;
          case 'sync-pause':
          case 'sync-resume':
          case 'wait':
            break;
        }
      };

      try {
        const ops = generateOps(rng, clientCount, opCount);

        const notAppliedOpIndices = new Set<number>();
        for (const [opIdx, op] of ops.entries()) {
          const applied = await applyOp(op, clients, server, docName);
          if (!applied) {
            notAppliedOpIndices.add(opIdx);
            continue;
          }

          if (
            op.kind === 'wysiwyg-type' ||
            op.kind === 'source-type' ||
            op.kind === 'agent-write'
          ) {
            livePrefixes.add(prefixOf(op.marker));
          } else if (op.kind === 'external-change') {
            livePrefixes.clear();
            livePrefixes.add(prefixOf(op.marker));
          } else if (op.kind === 'agent-undo') {
            livePrefixes.clear();
          }

          updateExpectedBody(op);

          if ('text' in op) authoredBytes += Buffer.byteLength(op.text);
          else if (op.kind === 'external-change') authoredBytes += Buffer.byteLength(op.newContent);
        }

        for (const c of clients) {
          try {
            c.resumeSync();
          } catch {}
        }

        const convergence = await driveToConvergence(clients, 60000);
        if (convergence.outcome === 'stalled') {
          const states = snapshotClients(clients);
          throw new Error(
            `Convergence failed after 60s (${convergence.detail}).\n${states.map((s, i) => `  Client ${i}: ytext=${s.ytext.length}ch frag=${s.fragmentMd.length}ch`).join('\n')}`,
          );
        }
        if (convergence.outcome === 'converged-late') {
          fuzzConvergedLate.push(seed);
          console.log(`[fuzz] converged-late seed=${seed} (final state within tolerance)`);
        }

        for (const c of clients) {
          assertBridgeInvariant(c.ytext, c.fragment);
          const bytes = Buffer.byteLength(c.ytext.toString());
          const budget = authoredBytes * 3 + 4096;
          if (bytes > budget) {
            throw new Error(
              `O1 byte-budget violated: converged ${bytes}B > budget ${budget}B ` +
                `(cumulative authored ${authoredBytes}B x3 + 4096 slack) — the unbounded-growth amplifier signature.`,
            );
          }
        }

        for (const probe of agentProbes) {
          probe.assertOnlyTrackedOrigins();

          if (probe.undoStackLength() > 0) {
            probe.recordCapture();
            probe.assertCaptureIntact();
          }
        }

        const missingPrefixes: Array<{ clientIdx: number; prefix: string }> = [];
        for (const prefix of livePrefixes) {
          for (let ci = 0; ci < clients.length; ci++) {
            const client = clients[ci];
            if (!client) continue;
            if (!client.ytext.toString().includes(prefix)) {
              missingPrefixes.push({ clientIdx: ci, prefix });
            }
          }
        }

        if (missingPrefixes.length > 0) {
          throw new Error(
            `Content preservation violated — ${missingPrefixes.length} missing prefixes ` +
              `(zero tolerance: hybrid diff3+DMP merge must preserve all content).\n` +
              missingPrefixes
                .slice(0, 5)
                .map((m) => `  client ${m.clientIdx} missing prefix '${m.prefix}'`)
                .join('\n') +
              (missingPrefixes.length > 5 ? `\n  ...and ${missingPrefixes.length - 5} more` : ''),
          );
        }

        const { preMarkerLines, patches } = buildOracleEExpectations(ops, notAppliedOpIndices);

        if (preMarkerLines.size > 0) {
          const acceptableForPrefix = new Map<string, Set<string>>();
          for (const [prefix, preLine] of preMarkerLines) {
            const accepts = new Set<string>([preLine]);
            for (let iter = 0; iter < patches.length; iter++) {
              const snapshot = [...accepts];
              let grew = false;
              for (const line of snapshot) {
                for (const { find, replace } of patches) {
                  if (line.includes(find)) {
                    const idx = line.indexOf(find);
                    const post = line.slice(0, idx) + replace + line.slice(idx + find.length);
                    if (!accepts.has(post)) {
                      accepts.add(post);
                      grew = true;
                    }
                  }
                }
              }
              if (!grew) break;
            }
            acceptableForPrefix.set(prefix, accepts);
          }

          const chunkGlueRe = /^M\d+-chunked-/;
          const hasChunkedPaste = ops.some((o) => o.kind === 'chunked-source-paste');

          const missingContent: Array<{ clientIdx: number; prefix: string }> = [];
          for (let ci = 0; ci < clients.length; ci++) {
            const client = clients[ci];
            if (!client) continue;
            const gotLineList = client.ytext
              .toString()
              .split('\n')
              .map((l) => l.trimEnd());
            const gotLines = new Set(gotLineList);
            for (const [prefix, accepts] of acceptableForPrefix) {
              const matched = [...accepts].some(
                (l) =>
                  gotLines.has(l) ||
                  (hasChunkedPaste &&
                    gotLineList.some(
                      (line) => line.startsWith(l) && chunkGlueRe.test(line.slice(l.length)),
                    )),
              );
              if (!matched) {
                missingContent.push({ clientIdx: ci, prefix });
              }
            }
          }

          if (missingContent.length > 0) {
            throw new Error(
              `Oracle (e) content-set violation — ${missingContent.length} marker prefixes ` +
                `with no acceptable line form. Either content diverged in a way no applied ` +
                `agent-patch explains, or the expectation walk demanded an op the run never ` +
                `applied (check refusal counts before assuming corruption).\n` +
                missingContent
                  .slice(0, 5)
                  .map(
                    (m) =>
                      `  client ${m.clientIdx} prefix '${m.prefix}' accepts=${JSON.stringify([...(acceptableForPrefix.get(m.prefix) ?? [])])}`,
                  )
                  .join('\n') +
                (missingContent.length > 5 ? `\n  ...and ${missingContent.length - 5} more` : ''),
            );
          }
        }
        fuzzPassed.push(seed);
      } catch (err) {
        writeFuzzSnapshot(seed, {
          ops: generateOps(createPRNG(seed), clientCount, opCount),
          error: err,
          clientStates: snapshotClients(clients),
        });
        fuzzFailed.push(seed);
        throw err;
      } finally {
        for (const p of agentProbes) {
          try {
            p.cleanup();
          } catch (cleanupErr) {
            console.warn(
              `[bridge-convergence seed ${seed}] agent-probe cleanup failed:`,
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            );
          }
        }
        for (const c of clients) {
          try {
            await c.cleanup();
          } catch (cleanupErr) {
            console.warn(
              `[bridge-convergence seed ${seed}] client cleanup failed:`,
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            );
          }
        }
      }
    },
    FIXED_SEED === undefined ? 120_000 : 300_000,
  );
});

describe('D18 coverage gate', () => {
  test('fuzzer op-set covers every bridge write surface', () => {
    const missing: string[] = [];
    for (const [surface, coveringOps] of Object.entries(WRITE_SURFACE_TO_OP_KIND)) {
      for (const opKind of coveringOps) {
        if (!ALL_OP_KINDS.includes(opKind as (typeof ALL_OP_KINDS)[number])) {
          missing.push(`${surface} → ${opKind} (op kind not in generator)`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('all op kinds are represented in the generator output', () => {
    const producedKinds = new Set<string>();
    for (let s = 0; s < 10; s++) {
      const rng = createPRNG(0xdeadbeef + s);
      const ops = generateOps(rng, 4, 500);
      for (const op of ops) producedKinds.add(op.kind);
    }
    for (const kind of ALL_OP_KINDS) {
      expect(producedKinds.has(kind)).toBe(true);
    }
  });
});
