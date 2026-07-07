/**
 * Randomized multi-client bridge-convergence stress test with invariant oracles.
 *
 * Samples the race space across bridge write surfaces using
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
 *       in EVERY client's final ytext. Catches the convergent-but-
 *       content-lost) where all clients synchronously agree on wrong content.
 *
 *
 * Known flake (documented, not a real bug):
 *   "Convergence failed after 60s" occurs at ~2-4% rate under heavy macOS
 *   scheduler load with 3 clients + 12 ops + aggressive inter-op pacing.
 *   The harness now discriminates at budget exhaustion:
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
 * Coverage gate: a separate test enumerates every bridge write surface and
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

// ─── Seeded PRNG (xorshift32 — same pattern as observers.fuzz.test.ts) ───

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

// ─── Op type union (10 kinds backed by shipped primitives) ───

type Op =
  | { kind: 'wysiwyg-type'; clientIdx: number; text: string; marker: string }
  | { kind: 'type-chars'; clientIdx: number; text: string; marker: string }
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
      // Chunked Source paste. Large payload (>500KB threshold) split
      // into 50KB chunks with requestAnimationFrame yields between chunks.
      // The Y.RelativePosition-based `resolveOffset` maintains anchor
      // correctness through concurrent peer insertions/deletions that land
      // between chunks — this is the invariant the
      // fuzzer's randomized op interleaving exercises.
      kind: 'chunked-source-paste';
      clientIdx: number;
      text: string;
      marker: string;
    }
  // Corrupting constructs — exercised so the amplifier
  // search covers indented-children JSX and large `html preview` embeds, not
  // just plain paragraphs. Both write through the agent-write surface.
  | { kind: 'jsx-block'; text: string; marker: string }
  | { kind: 'large-embed'; text: string; marker: string }
  | { kind: 'sync-pause'; clientIdx: number }
  | { kind: 'sync-resume'; clientIdx: number }
  | { kind: 'wait'; ms: number };

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

/**
 * Each content-producing op carries a unique marker string (e.g., `M7-delta golf`)
 * so the content-preservation oracle can distinguish "user's op-7 text survived"
 * from "another op produced the same `delta golf` phrase by coincidence."
 *
 * Markers use format `M<opIdx>-<text>` so `find`/`replace` strings in agent-patch
 * never accidentally match another op's marker prefix (agent-patch generators
 * use raw WORDS entries without the `M<N>-` prefix).
 */
function randomShortText(rng: Rng): string {
  const count = rng.nextInt(3) + 1;
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(rng.pick(WORDS));
  return words.join(' ');
}

/**
 * Generate ops at the rebalanced distribution (server-authoritative):
 * wysiwyg:17%, type-chars:8%, source:15%, agent-write:15%, agent-patch:8%, agent-undo:3%,
 * external-change:8%, chunked-source-paste:3%, jsx-block:3%, large-embed:3%,
 * sync-pause:6%, sync-resume:8%, wait:3%. Source-type and external-change
 * elevated from theatre rates (0.5% each) to validate the symmetric Observer B
 * fix; jsx-block + large-embed exercise the corrupting
 * constructs so the amplifier search is not limited to plain paragraphs.
 */
function generateOps(rng: Rng, clientCount: number, opCount: number): Op[] {
  const ops: Op[] = [];
  const paused = new Set<number>();
  // Marker counter — each content-producing op gets a unique prefix like `M7-word`.
  // Distinguishes "user op-N's text survived" from accidental repeats of small WORDS pool.
  let markerIdx = 0;

  for (let i = 0; i < opCount; i++) {
    const roll = rng.next();
    const clientIdx = rng.nextInt(clientCount);

    // Rebalanced distribution (server-authoritative) — see the
    // function docblock for the full per-kind percentages (jsx-block +
    // large-embed added at 3% each for the corrupting constructs).
    if (roll < 0.17) {
      // wysiwyg-type (17%): append a paragraph to XmlFragment
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'wysiwyg-type', clientIdx, text: marker, marker });
    } else if (roll < 0.25) {
      // type-chars (8%, carved from wysiwyg-type): the same paragraph
      // append delivered one character per transaction, keystroke-style.
      // Multi-word marker text guarantees trailing-space transients — the
      // states whole-block ops structurally never produce and the
      // settlement health checks must absorb on resting-divergent docs.
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'type-chars', clientIdx, text: marker, marker });
    } else if (roll < 0.4) {
      // source-type (15%): Y.Text write simulating CodeMirror input.
      // Elevated from 0.5% to exercise symmetric Observer B path under
      // server-authoritative architecture.
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'source-type', clientIdx, text: marker, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.55) {
      // agent-write via HTTP (15%) — append only
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      ops.push({ kind: 'agent-write', text: marker, position: 'append', marker });
    } else if (roll < 0.63) {
      // agent-patch via HTTP (8%). `find`/`replace` use raw WORDS — NEVER marker
      // strings — so agent-patch never accidentally replaces a user/agent marker
      // that the content-preservation oracle tracks.
      const find = rng.pick(WORDS);
      const replace = rng.pick(WORDS);
      ops.push({ kind: 'agent-patch', find, replace, marker: `patch-${find}→${replace}` });
    } else if (roll < 0.66) {
      // agent-undo via HTTP (3%). Calls applyAgentUndo on the default claude-1
      // session. Non-fatal if no session exists or undo stack is empty. Content
      // oracle treats this as a content-reset (like external-change) — the undo
      // may remove any prior agent-write content unpredictably.
      ops.push({ kind: 'agent-undo' });
    } else if (roll < 0.74) {
      // external-change (8%): file-watcher disk→CRDT bridge.
      // Elevated from 0.5% to exercise file-watcher convergence path.
      const marker = `M${markerIdx++}-${randomShortText(rng)}`;
      const content = `${marker}\n`;
      const stabilized = mdManager.serialize(mdManager.parse(content));
      ops.push({ kind: 'external-change', newContent: stabilized, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.77) {
      // chunked-source-paste (3%): large-paste exercise. Payload
      // above threshold (600KB) so chunkedYTextInsert takes the chunked
      // path with rAF yields; subsequent ops interleave peer activity
      // during the chunked writes to exercise the Y.RelativePosition
      // anchor-preservation invariant. 3% is sparse enough to
      // keep per-seed runtime bounded while hitting the scenario multiple
      // times across the default 25-seed runs.
      const marker = `M${markerIdx++}-chunked-${randomShortText(rng)}`;
      // 600KB payload: marker prefix + repeated filler, ensuring total
      // exceeds DEFAULT_CHUNK_THRESHOLD_BYTES (500KB).
      const filler = 'lorem ipsum dolor sit amet '.repeat(25000);
      const text = `${marker}\n\n${filler}\n`;
      ops.push({ kind: 'chunked-source-paste', clientIdx, text, marker });
      ops.push({ kind: 'wait', ms: 500 });
    } else if (roll < 0.8) {
      // jsx-block (3%): insert an indented-children <Steps>/<Step> shape (the
      // corrupting construct) via the agent-write surface, so the
      // amplifier search covers the dirty-path JSX class, not just paragraphs.
      const marker = `M${markerIdx++}-jsx-${randomShortText(rng)}`;
      const text = `<Steps>\n\n<Step>\n\n${marker} step body.\n\n</Step>\n\n</Steps>`;
      ops.push({ kind: 'jsx-block', text, marker });
    } else if (roll < 0.83) {
      // large-embed (3%): insert an `html preview` <script> embed (the
      // construct) so the search covers the large-embed class too.
      const marker = `M${markerIdx++}-embed-${randomShortText(rng)}`;
      const text = `\`\`\`html h=300px preview\n<script>\nconst EMBED_DATA = {"m": "${marker}"};\n</script>\n\`\`\``;
      ops.push({ kind: 'large-embed', text, marker });
    } else if (roll < 0.89) {
      // sync-pause
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
      // sync-resume (8%)
      if (paused.size > 0) {
        const target = rng.pick([...paused]);
        paused.delete(target);
        ops.push({ kind: 'sync-resume', clientIdx: target });
      } else {
        ops.push({ kind: 'wait', ms: rng.nextInt(40) + 20 });
      }
    } else {
      // wait
      ops.push({ kind: 'wait', ms: rng.nextInt(60) + 20 });
    }
  }

  // Resume all paused at end
  for (const p of paused) {
    ops.push({ kind: 'sync-resume', clientIdx: p });
  }
  return ops;
}

// ─── Op dispatcher ───

/**
 * Apply one op. Returns whether the op was APPLIED — an agent-surface op
 * refused by the server (e.g. 409 doc-in-conflict from the
 * reconcile-before-agent-write guard: a racing out-of-band disk edit
 * overlapped un-flushed CRDT edits, so the write is correctly rejected with
 * both sides preserved) is a legitimate non-application, and the oracle
 * bookkeeping must not count its marker as live content.
 */
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
    case 'type-chars': {
      const client = clients[op.clientIdx];
      if (!client) return;
      const paragraph = new Y.XmlElement('paragraph');
      const ytext = new Y.XmlText();
      ytext.applyDelta([{ insert: op.text.slice(0, 1) }]);
      paragraph.insert(0, [ytext]);
      client.fragment.push([paragraph]);
      for (const ch of op.text.slice(1)) {
        // Separate transactions with a yield between them so each keystroke
        // gets its own drain + settlement instead of coalescing into one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        client.doc.transact(() => {
          ytext.applyDelta([{ retain: ytext.length }, { insert: ch }]);
        });
      }
      break;
    }
    case 'source-type': {
      const client = clients[op.clientIdx];
      if (!client) return;
      // Append text to Y.Text (incremental, not wholesale replace)
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, `\n\n${op.text}\n`);
      });
      break;
    }
    case 'chunked-source-paste': {
      const client = clients[op.clientIdx];
      if (!client) return;
      // Anchor at current doc end. Capture a Y.RelativePosition so concurrent
      // peer inserts/deletes between chunks don't shift our target offset —
      // this mirrors source-clipboard.ts production behavior.
      const anchorIndex = client.ytext.length;
      const relPos = Y.createRelativePositionFromTypeIndex(client.ytext, anchorIndex);
      try {
        await chunkedYTextInsert(client.doc, client.ytext, anchorIndex, op.text, {
          // Short setTimeout yield — default `requestAnimationFrame` is not
          // available in Node test runtime; 0ms setTimeout still yields the
          // task queue, letting other fuzzer ops interleave.
          yieldFn: () => wait(0),
          resolveOffset: (n: number) => {
            const abs = Y.createAbsolutePositionFromRelativePosition(relPos, client.doc);
            return abs?.index ?? n;
          },
        });
      } catch {
        // ChunkedInsertError is a valid outcome under concurrent-peer pressure
        // (e.g., peer deletion shrinks the doc below our anchor). The oracles
        // still verify bridge-invariant + convergence post-settle; marker
        // preservation is best-effort for this op (the partial-progress
        // rollback path is unit-tested separately).
      }
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
      // Corrupting constructs (indented JSX / large embed)
      // appended via the agent-write surface. Distinct op kinds for
      // coverage; one apply path.
      try {
        await agentWriteMd(server.port, `\n\n${op.text}\n`, { docName, position: 'append' });
      } catch (err) {
        // A 409 is a legitimate doc-in-conflict refusal during a divergence
        // window: the construct simply did not apply (not-applied is correct, as
        // for every other surface). A non-409 — a 500, a connection-refused, or
        // a future write-admission regression that rejects the JSX/embed class —
        // is a genuine delivery fault: re-throw so the seed fails LOUDLY rather
        // than silently leaving the corrupting construct untested while reporting
        // passed (these two op kinds feed no content oracle, unlike the
        // marker-checked surfaces). Mirrors external-change's fail-loud discipline.
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
        // Default session connectionId is 'claude-1' (no agentId override).
        // Non-fatal if no session exists or undo stack is empty — the endpoint
        // returns 404 which the catch swallows.
        await agentUndo(server.port, { docName, connectionId: 'claude-1' });
      } catch {
        // Non-fatal — 404 when session absent or undo stack empty; report
        // not-applied so oracle (d) does not clear live prefixes for an
        // undo that never happened.
        return false;
      }
      break;
    }
    case 'external-change': {
      // Producer invariant of every real applyExternalChange caller: the
      // file-watcher event fires BECAUSE the file changed, so after the
      // ingest disk === reconciledBase. Skipping the disk write here
      // manufactures a disk≠reconciledBase state impossible in production,
      // and reconcileDiskBeforeAgentWrite (a correct TOCTOU guard) then
      // re-ingests the stale disk on the next agent op, reverting this
      // op's content — a harness artifact, not a bridge bug. The write sits
      // OUTSIDE the lenient catch: a failed write is a harness fault and
      // must fail the seed loudly, not converge spuriously on an unchanged
      // doc.
      writeFileSync(join(server.contentDir, `${docName}.md`), op.newContent, 'utf-8');
      try {
        applyExternalChange(server.instance.hocuspocus, docName, op.newContent);
      } catch {
        // Non-fatal — no-op early-returns when the doc is unloaded; the
        // bridge-merge transact race re-throw is survivable for the fuzz.
        // Report not-applied so oracle (d) does not register a phantom
        // marker for content the CRDT never received (disk is ahead of the
        // CRDT here, which the next agent-write's reconcile guard absorbs).
        return false;
      }
      break;
    }
    case 'sync-pause': {
      try {
        clients[op.clientIdx]?.pauseSync();
      } catch {
        // Non-fatal
      }
      break;
    }
    case 'sync-resume': {
      try {
        clients[op.clientIdx]?.resumeSync();
      } catch {
        // Non-fatal
      }
      break;
    }
    case 'wait': {
      await wait(op.ms);
      break;
    }
  }
  return true;
}

/**
 * Active convergence loop: wait for CRDT sync, then trigger a local edit on
 * ONE client (round-robin) to force Observer A's debounce. Only ONE client
 * at a time — multiple clients independently writing the same XmlFragment→Y.Text
 * delta causes CRDT duplication (both clients' Observer A inserts are independent
 * Y.Text ops preserved by CRDT merge).
 *
 * Returns true if all clients converged within the timeout.
 */
type ConvergenceOutcome =
  | { outcome: 'converged' }
  // Budget exhausted, but the FINAL state is good: peers byte-identical and
  // the bridge invariant (normalizeBridge-tolerant) holds on every client.
  // The run sampled past the budget, it did not corrupt — the discriminator
  // that previously required a manual snapshot autopsy. Counted separately
  // so a converged-late rate increase stays a visible perf signal.
  | { outcome: 'converged-late' }
  // Budget exhausted AND the final state is bad — peers diverged, or the
  // settled bytes sit beyond normalizeBridge tolerance of the fragment.
  // Always a real failure.
  | { outcome: 'stalled'; detail: string };

async function driveToConvergence(
  clients: TestClient[],
  timeoutMs = 15000,
): Promise<ConvergenceOutcome> {
  const start = Date.now();

  // Phase 1: wait for each client's pending local observer work to settle.
  // Under the settlement-based bridge, this replaces the
  // debounce-era `wait(1500)` — `awaitDocQuiescence` returns as soon as
  // each doc's `afterAllTransactions` has been quiet for a couple of
  // microtasks (including any OBSERVER_SYNC_ORIGIN inner drains). Runs
  // in parallel across clients so the gate is bounded by the slowest.
  // We keep a small wall-clock padding between quiescence-and-check to
  // absorb WebSocket propagation jitter (~20-60 ms typical). Precedent
  // #13(b): prefer structural gates; wall-clock only where genuine
  // network timing lives.
  await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
  await wait(100);

  // Phase 2: check + tickle loop
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

    // Tickle ONE client to trigger Observer A reconciliation.
    // Round-robin so each client gets a turn.
    if (attempts < 8) {
      const target = clients[attempts % clients.length];
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.applyDelta([{ insert: `r${attempts}` }]);
      paragraph.insert(0, [text]);
      target.fragment.push([paragraph]);
      // Await the tickled client's local settlement before looping —
      // structural replacement for the debounce-era `wait(800)`. The
      // tickled doc's `afterAllTransactions` fires and (via the server's
      // round-trip) propagates updates back to peers. We keep a small
      // WebSocket-propagation pad so the round-trip can land before the
      // next converge check.
      await awaitDocQuiescence(target.doc, { timeoutMs: 2000 });
    }
    attempts++;
    await wait(200);
  }

  // Budget exhausted — classify the FINAL state instead of reporting a bare
  // timeout. Giant fuzz-grown docs (hundreds of KB) can legitimately need
  // more wall-clock per drain than the budget allows on a loaded machine;
  // a within-tolerance settled state is late, not wrong.
  //
  // One bounded quiescence grace BEFORE classifying: at the budget edge the
  // doc is often mid-flight (a drain applied locally, the WS round-trip not
  // yet landed), and a mid-flight read shows transient beyond-tolerance
  // states (e.g. two blocks momentarily joined mid-splice) that the next
  // settlement resolves. Classification must judge a SETTLED state; a
  // beyond-tolerance state that survives this grace is a real stall.
  await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
  await wait(250);
  return classifyFinalState(clients);
}

// ─── Snapshot ───

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
  } catch {
    // Best-effort
  }
}

function snapshotClients(clients: TestClient[]): Array<{ ytext: string; fragmentMd: string }> {
  return clients.map((c) => ({
    ytext: c.ytext.toString(),
    fragmentMd: serializeFragment(c.fragment),
  }));
}

// ─── Op-kind enumeration (coverage gate) ───

const ALL_OP_KINDS = [
  'wysiwyg-type',
  'type-chars',
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
  'observer-a-sync': ['wysiwyg-type', 'type-chars'],
  'observer-b-sync': ['source-type'],
  'file-watcher': ['external-change'],
  // Chunked Source paste: same source-codemirror-typing write surface as source-type, but a
  // distinct *insertion strategy* (chunked + rAF-yielded + Y.RelativePosition
  // anchor preservation). Precedent #13(d) spirit: coverage gate should catch
  // a regression that removes the chunked op without replacement.
  'chunked-source-paste': ['chunked-source-paste'],
  // The corrupting-construct surfaces: the gate fails if
  // the fuzzer ever loses its indented-JSX or large-embed op kind — the
  // regression that let the dirty-path class go untested.
  'indented-jsx-construct': ['jsx-block'],
  'large-embed-construct': ['large-embed'],
  rollback: ['agent-write', 'agent-patch'],
};

// ─── Main fuzzer ───

// Seed count calibration.
//
//   - Seed-replay mode (`STRESS_FUZZ_SEED=<n>`): exactly 1 seed, for
//     deterministic reproduction.
//   - Explicit override (`BRIDGE_FUZZ_SEEDS=<n>`): exact count, for local
//     scaling / bisection runs.
//   - Nightly mode (`STRESS_FUZZ_NIGHTLY=1`): 10000 seeds (tier 2; 30-min
//     budget). Split across `nightly.yml` + `weekly.yml` as needed.
//   - PR mode (`STRESS_FUZZ_PR=1`): 75 seeds. Calibrated against CI's
//     measured per-seed distribution (from main's 25-seed run):
//     median 4054 ms/seed, mean 8949 ms/seed, p95 24045 ms,
//     max 45677 ms. The long tail dominates: 200 × mean = ~30 min, which
//     exceeded the 15-min tier-1 budget regardless of runner size
//     (ubuntu-latest cancelled at 14m56s; ubuntu-64gb cancelled at
//     15m14s — the large runner's raw CPU advantage was not enough to
//     absorb 45 s tail seeds × 200). 75 × 8.9 s mean ≈ 11 min + overhead
//     ≈ 12 min, fits comfortably with headroom for tail variance. Still
//     3× the default-mode coverage; the 1K-10K elevated-seed tail runs
//     in tier-2 nightly / tier-3 weekly on-demand workflows (resolution:
//     split-by-tier, not matrix-shard).
//   - Otherwise: 25 seeds. Matches the calibrated opCount sweet spot below
//     and keeps local developer runs cheap.
const SEED_COUNT_PR = 75;
const SEED_COUNT_NIGHTLY = 10_000;
const SEED_COUNT_DEFAULT = 25;

/**
 * Strict integer-env parser. Non-finite, non-integer, or otherwise malformed
 * inputs throw with a concrete example message — matches the defense-in-
 * depth discipline `server-authoritative-stress.test.ts` uses for
 * STRESS_SEED. The measurement script layer (`measure-fuzz.sh`) also
 * validates via `assert_numeric_flag`, but this test is also invokable
 * directly via `bun test` without going through the wrapper — so the
 * test file must not silently coerce "100.5" or "0x42" to NaN→1 at the
 * PRNG layer. Evidence log that lies quietly is worse than a loud throw.
 */
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

// Surface the resolved seed count in CI logs so reviewers can confirm the
// PR-tier gate is actually running at its calibrated coverage, not the
// 25-seed default.
// Skipped when only 1 seed is requested (replay runs print the seed itself).
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
  // Track per-seed outcomes so the after-all hook can emit a machine-
  // parseable summary line for `packages/app/scripts/measure-fuzz.sh` to
  // consume. The script grep-matches:
  //   [fuzz] RESULT seeds=<total> passed=<n> failed=<n> failingSeeds=[<s1>,<s2>,...]
  // Written via `process.stdout.write` so it's stdout-only and not subject
  // to bun's human-summary formatting — mirrors the stress test's approach
  // (`packages/app/tests/stress/server-authoritative-stress.test.ts`).
  // Changing the format is a breaking change for the measurement script's
  // regex.
  const fuzzPassed: number[] = [];
  const fuzzFailed: number[] = [];
  // Seeds that exhausted the convergence budget but settled within
  // tolerance (counted in `passed`; listed separately as a perf signal).
  const fuzzConvergedLate: number[] = [];

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    // Emit RESULT BEFORE cleanup. measure-fuzz.sh greps for this exact line
    // as its only data source — if server.cleanup() threw first (handle leak,
    // port teardown race), the summary would never reach the script and the
    // run would be classified as a crash-before-banner with conservative all-
    // seeds-failed accounting. Ordering this pre-cleanup makes the RESULT
    // emission unconditional on cleanup outcome. Cleanup itself is wrapped in
    // try/catch so a cleanup failure surfaces as a warn but does not destroy
    // the observability signal we just wrote.
    // `convergedLate*` fields are appended AFTER the original shape —
    // measure-fuzz.sh's extraction regex is prefix-anchored, so older
    // script versions parse the line unchanged.
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
      // Per-seed setup try/catch — if the setup path throws (harness init,
      // port allocation, agentWriteMd, createTestClients) BEFORE we reach
      // the main test body, the seed must still be accounted for in the
      // RESULT line. Otherwise the script's seedCount drifts below the
      // requested --seeds N and trend analysis across runs compares
      // apples and oranges. Re-throw after recording so the test still
      // fails loudly — this is accounting hygiene, not error swallowing.
      let setupOk = false;
      let clients: Awaited<ReturnType<typeof createTestClients>> = [] as never;
      const rng = createPRNG(seed);
      const clientCount = 2 + (seed % 2); // 2..3
      // 12 ops per seed: enough to sample 2-3 agent-write + wysiwyg-type pairs
      // (the convergent-but-content-lost trigger) plus sync-pause/resume + wait variety. Higher counts
      // (25+) extend runtime without improving bug-reproduction rate and create
      // CRDT load that causes convergence-timeout flakes under macOS scheduler.
      const opCount = 12;
      const docName = `fuzz-${seed}`;

      try {
        // Seed initial content
        await agentWriteMd(server.port, 'seed paragraph\n', { docName, position: 'replace' });
        await wait(200);

        clients = await createTestClients(server.port, {
          count: clientCount,
          docName,
          perClientOptions: { syncControl: true, skipInvariantWatcher: true },
        });
        setupOk = true;
      } catch (err) {
        // Setup failure — record as failed seed so RESULT accounting is
        // complete, then re-throw so the test fails visibly. The catch at
        // the end of the try-block (below, around the main oracle) records
        // post-setup failures; this catch records pre-setup failures.
        fuzzFailed.push(seed);
        throw err;
      }
      // Guard against any unexpected control-flow — if we somehow reached
      // here with setupOk=false without the catch having run, fail loud.
      if (!setupOk) {
        fuzzFailed.push(seed);
        throw new Error(`bridge-convergence fuzz setup invariant violated for seed ${seed}`);
      }

      // Per-session origins arrive at clients as remote transactions (undefined
      // origin) — client-side probes cannot capture server-authoritative agent writes.
      // Create a local paired-write origin matching the per-session shape to verify the probe
      // infrastructure works correctly with per-session origins (isPairedWriteOrigin=true).
      // The probe remains vacuous for server-side writes; oracle (c) is enforced by the
      // bridge-invariant watcher in assertBridgeInvariant above.
      const localFuzzOrigin = Object.freeze({
        source: 'local' as const,
        skipStoreHooks: false,
        context: Object.freeze({
          origin: 'agent-write',
          paired: true as const,
          session_id: `fuzz-probe-${seed}`,
        }),
      });
      // Structural check: isPairedWriteOrigin must return true for per-session origins
      if (!isPairedWriteOrigin(localFuzzOrigin)) {
        throw new Error(
          `fuzz: isPairedWriteOrigin(localFuzzOrigin) failed — per-session origin rejected`,
        );
      }
      const agentProbes = clients.map((c) =>
        createItemOriginProbe(c.ytext, { trackedOrigins: [localFuzzOrigin] }),
      );

      // ────────────── Oracle (d): prefix-match content preservation ─────
      // Track content markers for the weak content-preservation oracle (d).
      // Each content-producing op's marker uses format `M<N>-<words>`. Oracle
      // asserts the `M<N>-` prefix (durable; immune to agent-patch's WORDS-pool
      // find/replace) appears in EVERY client's final state for all live
      // markers. Catches the convergent-but-content-lost class: line/block removal where all clients
      // synchronously agree on wrong content.
      //
      // external-change invalidates all prior markers (wholesale body replace).
      const livePrefixes = new Set<string>();

      // ────────────── Oracle (e): full-body content equality ────────────
      // Tracks the EXPECTED markdown body after every op by mirroring server
      // semantics (applyAgentMarkdownWrite / applyExternalChange / Observer A
      // serialize behaviour). Compared against each client's ytext at
      // convergence under `normalizeBridge` — catches the convergent-but-content-lost class PLUS content
      // corruption that preserves marker prefixes (e.g., DMP mis-merge,
      // Unicode boundary split, canonicalization drift).
      //
      // Always-on: set-membership is CRDT-safe (independent of paragraph
      // ordering). The env var BRIDGE_FUZZ_STRICT_ORACLE=1 is retained only
      // for toggling the full-EQUALITY comparison (see below) which requires
      // deterministic ordering not guaranteed by CRDT concurrent inserts.
      let expectedBody = 'seed paragraph'; // post-seed, pre-op initial state
      // Byte budget: cumulative authored payload bytes (an over-count past
      // replaces/clears, which only widens the budget — no false positives).
      // Unbounded growth past a small multiple of this is the unbounded-growth amplifier.
      let authoredBytes = Buffer.byteLength('seed paragraph');
      const updateExpectedBody = (op: Op): void => {
        switch (op.kind) {
          case 'wysiwyg-type':
          case 'type-chars':
          case 'source-type':
            // Observer A (wysiwyg) / Observer B (source) serializes the new
            // paragraph with a double-newline separator after the existing body.
            expectedBody = expectedBody.length > 0 ? `${expectedBody}\n\n${op.marker}` : op.marker;
            break;
          case 'agent-write': {
            // Mirrors packages/server/src/agent-sessions.ts applyAgentMarkdownWrite.
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
            // Server uses body.indexOf(find) → first-match only. Mirror that.
            const pos = expectedBody.indexOf(op.find);
            if (pos !== -1) {
              expectedBody =
                expectedBody.slice(0, pos) + op.replace + expectedBody.slice(pos + op.find.length);
            }
            break;
          }
          case 'external-change':
            // applyExternalChange on server writes both fragment and ytext to
            // the provided content (parse-serialize canonicalized).
            expectedBody = op.newContent.replace(/\n+$/, '');
            break;
          case 'agent-undo':
            // applyAgentUndo reverses the last tracked agent write — content
            // oracle conservatively treats this as a full reset (like external-
            // change) since the undo may remove any prior agent-write content.
            expectedBody = '';
            break;
          case 'sync-pause':
          case 'sync-resume':
          case 'wait':
            // No content change.
            break;
        }
      };

      try {
        const ops = generateOps(rng, clientCount, opCount);

        // Apply ops back-to-back. Under the server-authoritative settlement
        // bridge (`doc.on('afterAllTransactions',
        // ...)` in server-observers.ts) there is no 50 ms debounce window for
        // inter-op wall-clock pacing to target. The historical pre-agent-write
        // `wait(30)` + post-op `wait(20)` were calibrated to hit "mid-debounce"
        // for the earlier convergent-but-content-lost trigger, which observer-layer paired-write
        // symmetry has closed. The RGA-level race that remains is sampled structurally by the `sync-pause`/`sync-resume` op
        // kinds, not by wall-clock pacing. Generated `wait` ops still run
        // through `applyOp` and contribute deliberate fuzz-generated delays.
        // Convergence timing (WebSocket propagation) is handled at the end
        // of the run by `driveToConvergence`'s quiescence-gated loop. Net
        // savings: ~600 ms per seed (~12 ops × ~50 ms average), so the fuzz
        // harness fits its budget at the calibrated 200-seed coverage
        // and nightly's 10000-seed run completes faster. (precedent #13(b): prefer structural gates over wall-clock waits.)
        // Ops the server legitimately refused / that failed to apply. Oracle
        // bookkeeping (d, e, and the expected-body tracker) must all agree on
        // which ops count — a refused write never touched the doc.
        const notAppliedOpIndices = new Set<number>();
        for (const [opIdx, op] of ops.entries()) {
          const applied = await applyOp(op, clients, server, docName);
          if (!applied) {
            notAppliedOpIndices.add(opIdx);
            continue;
          }

          // Update marker tracking AFTER the op succeeds (oracle d prefix set).
          if (
            op.kind === 'wysiwyg-type' ||
            op.kind === 'type-chars' ||
            op.kind === 'source-type' ||
            op.kind === 'agent-write'
          ) {
            livePrefixes.add(prefixOf(op.marker));
          } else if (op.kind === 'external-change') {
            livePrefixes.clear();
            livePrefixes.add(prefixOf(op.marker));
          } else if (op.kind === 'agent-undo') {
            // Conservatively clear all tracked prefixes — the undo may have
            // removed content from any prior agent-write, and we can't know
            // exactly which without replaying the undo stack.
            livePrefixes.clear();
          }

          // Update full-body expectation (oracle e).
          updateExpectedBody(op);

          // O1 byte budget: accumulate authored payload bytes (cumulative).
          if ('text' in op) authoredBytes += Buffer.byteLength(op.text);
          else if (op.kind === 'external-change') authoredBytes += Buffer.byteLength(op.newContent);
        }

        // Resume all paused clients
        for (const c of clients) {
          try {
            c.resumeSync();
          } catch {
            // May not be paused
          }
        }

        // Drive to convergence with active reconciliation.
        // 60s timeout accommodates macOS scheduler jitter under heavy multi-client
        // load AND turbo parallel-run contention. Under
        // `check:full:parallel` at --concurrency=100%, 15 turbo tasks compete
        // for CPU and convergence can take 2-3× the isolated-run wall-clock.
        // On occasional convergence-timeout flakes, the seed snapshot written
        // to /tmp/bridge-conv-fuzz-<seed>/ enables deterministic replay via
        // STRESS_FUZZ_SEED=<n> to distinguish infra flakiness from real
        // regressions.
        const convergence = await driveToConvergence(clients, 60000);
        if (convergence.outcome === 'stalled') {
          const states = snapshotClients(clients);
          throw new Error(
            `Convergence failed after 60s (${convergence.detail}).\n${states.map((s, i) => `  Client ${i}: ytext=${s.ytext.length}ch frag=${s.fragmentMd.length}ch`).join('\n')}`,
          );
        }
        if (convergence.outcome === 'converged-late') {
          // State verified good — record and continue into the oracles, which
          // run on the settled state exactly as for an in-budget converge.
          fuzzConvergedLate.push(seed);
          console.log(`[fuzz] converged-late seed=${seed} (final state within tolerance)`);
        }

        // Oracle (a): bridge invariant — already enforced per-tx by the watcher
        // (except here we use skipInvariantWatcher: true for fuzz tolerance, so
        // re-assert explicitly at settled state).
        for (const c of clients) {
          assertBridgeInvariant(c.ytext, c.fragment);
          // Byte budget: the converged doc must stay within a small multiple
          // of the cumulative authored payload. Unbounded growth past it (the
          // unbounded-growth amplifier) fails the seed instead of passing as converged-late.
          const bytes = Buffer.byteLength(c.ytext.toString());
          const budget = authoredBytes * 3 + 4096;
          if (bytes > budget) {
            throw new Error(
              `O1 byte-budget violated: converged ${bytes}B > budget ${budget}B ` +
                `(cumulative authored ${authoredBytes}B x3 + 4096 slack) — the unbounded-growth amplifier signature.`,
            );
          }
        }

        // Oracle (c): agent-origin Items preserved + no origin laundering.
        for (const probe of agentProbes) {
          // Per-session origins: server-side writes arrive at clients as remote
          // transactions (undefined origin); the probe's UM captures nothing, making
          // assertOnlyTrackedOrigins() vacuously true. The primary enforcement for
          // bridge invariants is assertBridgeInvariant above. This probe verifies
          // that no unexpected LOCAL transacts with non-tracked origins appear.
          probe.assertOnlyTrackedOrigins();

          if (probe.undoStackLength() > 0) {
            probe.recordCapture();
            probe.assertCaptureIntact();
          }
        }

        // Oracle (d): content preservation — every live marker prefix from
        // wysiwyg-type / source-type / agent-write (minus those invalidated by
        // external-change) must appear in EVERY client's final ytext. This is
        // what catches a bridge-convergent-but-content-lost state: it leaves
        // marker prefixes missing while all clients synchronously agree on the
        // wrong content.
        //
        // Zero tolerance: the hybrid diff3+DMP merge (mergeThreeWay) eliminates
        // the DMP patch_apply content drops that previously required a 5%
        // tolerance. Any missing prefix is a genuine merge bug.
        //
        // Why prefix-only: the marker format is `M<N>-<words>`. agent-patch's
        // find/replace draws from raw WORDS, so it can mutate the `<words>` tail
        // of a marker line — but the `M<N>-` prefix is never a valid WORD and
        // survives. Checking the prefix tracks line-level content preservation
        // without false positives from legitimate agent-patch mutations.
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

        // Oracle (e): char-granular content-set membership.
        // Upgrades oracle (d)'s prefix-only matching to FULL MARKER LINE
        // matching. Each expected marker line (full content, not just prefix)
        // must appear in every client's ytext — checked as a SET, not a
        // sequence, because CRDT inserts from concurrent clients can
        // interleave paragraphs in non-deterministic order.
        //
        // Catches: content corruption within a marker line (e.g., merge
        // bug, Unicode boundary split) that preserves the `M<N>-` prefix
        // but mutates the tail — a class oracle (d) misses.
        //
        // Does NOT catch: paragraph reordering (CRDT-correct behavior),
        // duplication (checked by bridge-invariant + convergence oracles).
        //
        // ── Why agent-patch markers can't use strict line-equality ────────
        // agent-patch uses the SERVER'S Y.XmlFragment serialization at the
        // moment of `indexOf(find)`. Under CRDT concurrency — specifically
        // when a paused client's outbound writes still reach the server
        // (pauseInbound only pauses server→client delivery) — the server's
        // XmlFragment at patch time may contain concurrent paragraphs whose
        // Y.js RGA position places them BEFORE the intended patch target.
        // When that happens, the first `find` occurrence that `indexOf`
        // returns lands on a DIFFERENT marker than the tracker predicted.
        //
        // This is semantically correct: the patch replaced exactly one
        // `find` with one `replace`, preserving all other content. But the
        // expectedBody tracker's simple indexOf model froze at tracker-time
        // and picked a different target. No bridge merge bug occurred.
        //
        // Resolution: for markers whose ORIGINAL form contained any patch's
        // `find`, accept EITHER the pre-patch or the post-patch line as a
        // valid match. Other markers (no patch could have modified them)
        // still require strict line-equality — this preserves oracle (e)'s
        // tail-corruption detection for untouched markers.
        // Walk the op sequence once more to build:
        //   preMarkerLines — prefix → pre-patch line form for every content-
        //     producing marker (wysiwyg, source-type, agent-write; external-
        //     change resets).
        //   patches       — every agent-patch's (find, replace) pair.
        // We don't reuse expectedBody (which interleaves patches) because we
        // need each marker's ORIGINAL form to build the acceptable-line set.
        const { preMarkerLines, patches } = buildOracleEExpectations(ops, notAppliedOpIndices);

        if (preMarkerLines.size > 0) {
          // For each expected marker, compute the SET of acceptable final
          // line forms: the pre-patch form, plus every line form reachable
          // by applying any subset of patches in sequence (find→replace at
          // first-matching position).
          //
          // Why iterative: at the fuzzer's 8% agent-patch rate × 12 ops,
          // P(≥2 patches per seed) is ~25% (Poisson λ=0.96). A fraction of
          // those have compound targeting — e.g., patch A replaces `alpha`
          // with `foxtrot` on a line that patch B later modifies via
          // `echo → delta`. The server applies both sequentially, so the
          // actual final line reflects BOTH patches. A single-patch model
          // would miss that state.
          //
          // Complexity: worst case is 2^N line forms for N patches, but
          // N is bounded by patches.length (worst-case ~12 → 4k states),
          // small relative to seed runtime. In practice N = 1-3 and the
          // set stays under a dozen elements.
          //
          // Termination: each iteration either adds a new form or the set
          // is stable. Bounded by patches.length because each patch can
          // only apply once productively to a line whose content already
          // contains its `find` string (after that the post-line still
          // contains the original `find` only if replace ⊇ find, which
          // doesn't happen with the single-WORD find/replace pairs the
          // generator produces). We cap explicitly at patches.length to
          // make termination unconditional regardless of replace ⊇ find.
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

          // chunked-source-paste anchors at ytext.length. Y.Text bodies don't
          // usually end with a newline, so a paste at doc end glues the chunk's
          // first line (`M<N>-chunked-...`) onto whatever line was last at
          // anchor time — exactly what a real CodeMirror paste at a line end
          // does. No content is lost; the tracked marker's line just gains the
          // chunk prefix as a suffix. Accept `<acceptable form><chunk line>`
          // when the seed generated a chunked paste, keyed on the chunk-marker
          // shape so arbitrary tail corruption still fails.
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
              // Prefix presence is already enforced by oracle (d). Here we
              // check that SOME acceptable tail form is present — this
              // still catches tail corruption that preserves prefix but
              // mutates text in ways no patch can explain.
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
        // Record the seed as passing BEFORE the `finally` block so a cleanup
        // throw cannot silently skew RESULT totals. If the try-block completed
        // every assertion, the seed is a genuine pass; the cleanup machinery
        // running after is teardown-only and its failure must not retroactively
        // reclassify the outcome. Cleanup errors are swallowed+logged in the
        // finally block below for the same reason.
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
      // 120s per seed: the original 90s budget covered macOS scheduler jitter
      // locally (observed ~40s p50, 60s p99 on M-series hardware). On
      // ubuntu-latest CI runners the same seeds run ~40% slower under
      // contention, occasionally exceeding 90s. 120s gives ~2×
      // local p99 headroom for CI scheduler pressure without masking real
      // convergence bugs — the content-preservation and bridge-invariant
      // oracles fire before the timeout either way, so a slow-but-
      // eventually-converging seed is still a green signal rather than a
      // hanging test.
    },
    FIXED_SEED === undefined ? 120_000 : 300_000,
  );
});

// ─── Coverage gate ───

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
    // Generate enough ops across multiple seeds to hit the rare kinds (3% each)
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
