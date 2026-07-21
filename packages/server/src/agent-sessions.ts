/**
 * Agent session management — DirectConnection lifecycle.
 *
 * Each agent gets a persistent DirectConnection to the Hocuspocus server.
 * Sessions track awareness (presence bar shows agent).
 *
 * Each session creates its own frozen LocalTransactionOrigin at birth
 * (precedent #1). All agent write paths call
 * `session.dc.document.transact(fn, session.origin)` — never `dc.transact(fn)`
 * or the shared `AGENT_WRITE_ORIGIN` constant (STOP rule).
 *
 * getSession uses an in-flight promise dedup map so concurrent first-calls
 * share one pending openDirectConnection call and produce exactly one session.
 *
 * Each session creates a Y.UndoManager tracking [Y.Text, flashMap]
 * via session.origin. session.undoOrigin is the placeholder origin for the
 * applyAgentUndo path; captureTransaction excludes it from the UM stack
 * to prevent undo-of-undo cycles (defense-in-depth).
 */
import type { DirectConnection, Document, Hocuspocus } from '@hocuspocus/server';
import {
  parseFrontmatterYaml,
  prependFrontmatter,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';

export { colorFromSeed } from '@inkeep/open-knowledge-core';

import * as Y from 'yjs';
import {
  composeAndWriteRawBody,
  deriveFragmentFromYtext,
  replaceRawBody,
} from './bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { DocInConflictError, isDocInConflict } from './conflict-errors.ts';
import {
  type AgentWriteContentDivergence,
  evaluateContentDivergence,
} from './content-divergence-gate.ts';
import { getDocExtension, stripDocExtension } from './doc-extensions.ts';
import { FrontmatterMalformedError } from './frontmatter-malformed-error.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { getLogger } from './logger.ts';
import { incrementAgentSessionEvictions } from './metrics.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import { getMeter, setActiveSpanAttributes, withSpanSync } from './telemetry.ts';

/**
 * The post-write content-divergence signal. Defined in (and produced by) the
 * shared `content-divergence-gate.ts`; re-exported here because the HTTP
 * handlers import it from this module.
 */
export type { AgentWriteContentDivergence };

const log = getLogger('agent-sessions');

/**
 * The DirectConnection class exposes `.document` at runtime but the exported
 * interface only declares `transact()` and `disconnect()`. We extend the
 * interface so we can access `document` (needed for `dc.document.transact()`
 * with a custom origin string and for awareness).
 */
export interface AgentDirectConnection extends DirectConnection {
  document: Document;
}

/**
 * Agent write origin — typed `PairedWriteOrigin` per precedent #1
 * extension; the typed marker carries the `paired: true` field that
 * `isPairedWriteOrigin` reads to gate paired-write transactions.
 *
 * LEGACY EXPORT — kept for unit tests that directly test observer behavior
 * against a paired-write origin. Production agent-write paths MUST use
 * `session.origin` (per-session frozen origin from getSession) instead of
 * this shared constant.
 *
 * `skipStoreHooks: false` — persistence SHOULD fire after agent writes so
 * content reaches disk through the normal debounce pipeline.
 *
 * `paired: true` — the caller atomically writes BOTH Y.XmlFragment and Y.Text
 * inside one `doc.transact(..., AGENT_WRITE_ORIGIN)` block (see
 * `applyAgentMarkdownWrite` below). The `satisfies PairedWriteOrigin`
 * annotation forces the literal to carry the marker; the compile-time gate
 * catches omissions before they reach runtime.
 */
export const AGENT_WRITE_ORIGIN = {
  source: 'local',
  skipStoreHooks: false,
  context: { origin: 'agent-write', paired: true },
} as const satisfies PairedWriteOrigin;

// `iconFromClientName` lives in `@inkeep/open-knowledge-core` so both the
// server (presence bar, api-extension) and the app (TimelinePanel dot-color
// derivation) share the identical mapping — drift between the two is how
// brand colors become inconsistent between surfaces. Re-exported here for
// backwards compat with existing server-side import sites.
export { iconFromClientName } from '@inkeep/open-knowledge-core';

/**
 * Map a `docName` (extension-less, the Y.Doc key) back to the on-disk
 * file path the conflict-error envelope's `file` extension member
 * surfaces. The HTTP boundary speaks paths (with extension); gate throws
 * speak docNames; this is the one-line adapter at the throw site.
 *
 * Uses `getDocExtension(docName)` to recover the on-disk extension when
 * the file watcher has observed the doc — so an `.mdx` source produces
 * a `.mdx` envelope `file` field, not the default `.md`. Inputs that
 * already carry an extension (defensive against legacy callers) pass
 * through unchanged.
 */
function docNameToFile(docName: string): string {
  if (docName.endsWith('.md') || docName.endsWith('.mdx')) return docName;
  return `${stripDocExtension(docName)}${getDocExtension(docName)}`;
}

/**
 * Y.Text-is-truth agent write composition (precedent #38).
 *
 * Composes the agent's delta against the current Y.Text bytes (the source-of-
 * truth for user-intended source bytes), then routes through the sibling
 * primitive matching the caller's INTENT: `replaceRawBody` for `replace`
 * (atomic full overwrite — prior content discarded wholesale);
 * `composeAndWriteRawBody` for `append` / `prepend` / `patch` (DMP-incremental,
 * item-preserving — merging into surrounding content the caller keeps).
 * `patch` is the `edit` find/replace path: it hands a full recomposed
 * body but wants the minimal item-preserving delta, so it deliberately does
 * NOT take the atomic primitive (which would churn the whole doc per surgical
 * edit and widen the concurrent-edit residue surface to the whole document).
 * Y.Text receives the composed bytes verbatim (no
 * canonicalization); XmlFragment derives via `parse(body)` →
 * `updateYFragment` (structural diff preserves user-content Items at matching
 * positions); both writes are atomic inside the caller's outer transact.
 *
 * Atomicity boundary: caller MUST wrap this in
 * `session.dc.document.transact(fn, session.origin)`. The per-session frozen
 * origin (precedent #24) is what makes this work for `Y.UndoManager`
 * attribution + the paired-write origin guard in server-observers.
 *
 * @see PRECEDENTS.md precedent #11(a) (item-preserving cross-CRDT sync)
 * @see PRECEDENTS.md precedent #38 (Y.Text-is-truth contract)
 */
export function applyAgentMarkdownWrite(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  /**
   * Embed-resolver context. When provided, `mdManager.parse`
   * uses `resolveEmbed(target, sourcePath)` to map `![[photo.png]]` → disk
   * path before PM dispatch. Omit in tests that don't exercise the embed
   * path — the handler falls back to literal target.
   */
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
): AgentWriteContentDivergence | undefined {
  // Conflict-aware write gate (precedent #38 + this batch's structural
  // refusal contract). Lives OUTSIDE the transact — the check is static on
  // `lifecycle.status` and the throw must bypass the bridge primitives
  // entirely. Static gate semantics: byte-equality of `markdown` against
  // any merge stage (theirs / base / ours) is irrelevant — the refusal
  // fires on lifecycle state alone. Recovery routes through
  // `resolve_conflict` (the dedicated MCP tool), not silent byte-match.
  if (isDocInConflict(document)) {
    throw new DocInConflictError({ file: docNameToFile(document.name) });
  }
  return withSpanSync(
    'agent.applyAgentMarkdownWrite',
    {
      attributes: {
        'doc.name': document.name,
        'agent.write_position': position,
        'agent.markdown.bytes': markdown.length,
      },
    },
    () => {
      const divergence = applyAgentMarkdownWriteInner(document, markdown, position, embedResolver);
      if (divergence !== undefined) {
        setActiveSpanAttributes({
          'agent.content_divergent': true,
          'agent.intended_bytes': divergence.intendedBytes,
          'agent.actual_bytes': divergence.actualBytes,
          'agent.byte_delta': divergence.byteDelta,
          'agent.divergence_type': divergence.divergenceType,
        });
      }
      return divergence;
    },
  );
}

/**
 * Serialize the doc's top-level blocks — one string per XmlFragment child, in
 * order. Follow mode diffs a before/after pair of these (via
 * `changedBlockRange`) around an agent write to record which blocks changed, so
 * an editor that becomes active only AFTER the write applied can still flash +
 * scroll to the changed section instead of missing the moment. XmlFragment
 * children map 1:1 to PM top-level nodes, so a block index is a PM node index.
 * Call inside the write's transact (after `applyAgentMarkdownWrite` the
 * fragment is already updated — the paired-write primitives run synchronously).
 */
export function snapshotBlocks(document: Document): string[] {
  return document
    .getXmlFragment('default')
    .toArray()
    .map((child) => child.toString());
}

function applyAgentMarkdownWriteInner(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
): AgentWriteContentDivergence | undefined {
  try {
    const ytext = document.getText('source');
    const currentYText = ytext.toString();
    const { frontmatter: existingFm, body: currentBody } = stripFrontmatter(currentYText);

    // Split the agent's payload into frontmatter + body. The agent may send
    // a full document (FM + body) or body-only; we handle both. On 'replace',
    // an FM in the payload supersedes the existing FM. On 'prepend'/'append',
    // the payload's FM (if any) is dropped defensively to avoid producing a
    // document with two FM blocks (double-FM is a CommonMark invalid state).
    // Stripping FM is orthogonal to the byte-faithful contract — body bytes
    // survive verbatim, only the FM-handling logic prevents structural breakage.
    const { frontmatter: payloadFm, body: payloadBody } = stripFrontmatter(markdown);

    // append/prepend with an empty body is a no-op — there is nothing to add,
    // so return before the write and leave the document byte-unchanged.
    // Without this guard the `${payloadBody}\n\n${currentBody}` join below
    // would inject a stray `\n\n` around empty content. A `---`
    // frontmatter-only payload also lands here: append/prepend drop the
    // payload FM, leaving an empty body — genuinely nothing to apply.
    // Deliberate vertical whitespace remains expressible by sending it as
    // body bytes (e.g. "\n"), which survive verbatim.
    if ((position === 'append' || position === 'prepend') && payloadBody === '') {
      return;
    }

    // Compose final FM and body. `replace` keeps the payload verbatim (the
    // byte-faithful primary path is untouched). For append/prepend, the agent's
    // payload CONTENT still survives verbatim — only the join SEAM is normalized
    // to exactly one blank-line separator. A prior payload's trailing newline
    // stored in `currentBody` previously compounded with the `\n\n` separator
    // into a `\n\n\n` double blank line: the existing body ended
    // with `\n`, and the separator added two more. Trim trailing newlines off
    // the leading chunk and leading newlines off the trailing chunk so the seam
    // is always a single blank line, regardless of which side carried stray
    // newlines. Within-payload blank lines and the far (non-seam) edge are
    // untouched; empty-doc detection still uses `currentBody.length > 0`.
    let finalFm: string;
    let newBody: string;
    switch (position) {
      case 'replace':
        finalFm = payloadFm || existingFm;
        newBody = payloadBody;
        break;
      // `patch` (the edit find/replace path) composes identically to
      // `replace` — full recomposed body, same FM supersede — but dispatches to
      // the INCREMENTAL primitive below (composeAndWriteRawBody), not the atomic
      // replaceRawBody, so a surgical edit stays item-preserving instead of
      // churning the whole doc. Same byte result, minimal CRDT delta.
      case 'patch':
        finalFm = payloadFm || existingFm;
        newBody = payloadBody;
        break;
      case 'prepend':
        finalFm = existingFm;
        newBody =
          currentBody.length > 0
            ? `${payloadBody.replace(/\n+$/, '')}\n\n${currentBody.replace(/^\n+/, '')}`
            : payloadBody;
        break;
      case 'append':
        finalFm = existingFm;
        newBody =
          currentBody.length > 0
            ? `${currentBody.replace(/\n+$/, '')}\n\n${payloadBody.replace(/^\n+/, '')}`
            : payloadBody;
        break;
    }

    if (finalFm !== existingFm) {
      // Refuse the write when the agent's payload introduces unparseable
      // YAML into the FM region. Y.Text-is-truth means the bytes
      // we submit reach disk verbatim; if we don't gate here, a payload
      // like `title: The End of 3% Mortgages: Why ...` (unquoted colon)
      // lands as invalid YAML, the property panel renders the malformed-FM
      // banner, and the file's keys are unrecoverable without a hand-edit.
      //
      // Gate is targeted: only fires when the agent CHANGES the FM
      // (`finalFm !== existingFm`). Append/prepend never touch FM (payload
      // FM is dropped earlier in this function), so they skip the gate.
      // Existing docs that already carry malformed FM keep accepting
      // body-only writes — the rejection follows the introducer, not the
      // inheritor.
      //
      // No byte mutation: we parse for validation only. The agent's bytes
      // are preserved verbatim once they pass (Y.Text-is-truth, precedent
      // #38).
      //
      // No empty-string guard on `finalFm`: inside this branch
      // (`finalFm !== existingFm`), `finalFm` came from `payloadFm || existingFm`
      // on the replace path, so a non-empty `payloadFm` is the only way the
      // branch is entered — `finalFm` is structurally non-empty here.
      // `parseFrontmatterYaml` returns `map: null` on yaml@2 parse errors
      // (the unparseable-YAML case), on a non-mapping top-level value, and on
      // residual `FrontmatterMapSchema` rejections (e.g. function/Symbol
      // leaves). The schema is recursive — nested mappings +
      // arrays of objects validate cleanly and no longer hit `map === null`,
      // and Obsidian's empty-list / bare-key `null` shapes are now coerced to
      // empty values at the read boundary rather than rejected. The
      // refusal class rides on the structured log event via
      // `classifyParseError` so the retired nested-rejection bucket can be
      // confirmed at zero without unbounded-cardinality counter labels.
      const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(finalFm));
      if (parsed.map === null) {
        throw new FrontmatterMalformedError({
          file: docNameToFile(document.name),
          parseError: parsed.parseError ?? 'unknown YAML parse error',
        });
      }
      // Telemetry fires only after the gate passes — a refused write isn't
      // an edit (bytes never reached Y.Text), so it must not contribute to
      // `ok.frontmatter.edit_surface_total{source=mcp-write}`. The
      // `frontmatter-malformed-write-refused` structured log already
      // carries the refusal signal.
      recordFrontmatterEditSurface('mcp-write');
    }

    // Hand the composed full bytes (FM + body) to the shared primitive.
    // Y.Text gets the raw bytes; XmlFragment derives via parse. No
    // canonicalize-write-back step (precedent #38).
    //
    // `replace` is an atomic full overwrite (`replaceRawBody`:
    // `ytext.delete(0, len) + ytext.insert(0, raw)`); `append` / `prepend` /
    // `patch` are merge-style (`composeAndWriteRawBody`: DMP-incremental,
    // item-preserving). The dispatch keys on `replace` ALONE — every other
    // position (including `patch`, the edit surgical path) takes the
    // incremental primitive. Two primitives, two intents — see
    // `bridge-intake.ts` file header for the full contrast.
    const newContent = prependFrontmatter(finalFm, newBody);
    if (position === 'replace') {
      replaceRawBody(document, newContent, embedResolver);
    } else {
      composeAndWriteRawBody(document, newContent, 'agent', embedResolver);
    }

    // Site A content-divergence gate (shared predicate). Read Y.Text
    // immediately after the primitive — still inside the caller's outer
    // transact, so no peer ops or observer settlements have run yet. In the
    // single-writer case the primitive's byte-faithful contract guarantees
    // equality; a divergence here signals a primitive regression or an
    // observer-side canonicalization leak. The converged bytes ride back on
    // the warning's `currentState` so the agent recovers without a re-read.
    // Post-transact concurrent-peer residue is out of scope here.
    const actualYText = document.getText('source').toString();
    const divergence = evaluateContentDivergence(actualYText, newContent, position);
    log.debug(
      {
        docName: document.name,
        position,
        markdownBytes: markdown.length,
        divergent: divergence !== undefined,
      },
      '[agent-write] applied agent markdown write',
    );
    return divergence;
  } catch (err) {
    // `FrontmatterMalformedError` is the designed-rejection path: it carries
    // a 400 envelope to the agent and `respondFrontmatterMalformed` already
    // emits a console.warn-level `frontmatter-malformed-write-refused`
    // structured event for ops. Re-logging it here at error severity would
    // double-emit the refusal at a higher severity, polluting alert noise
    // for an expected, documented rejection class. Skip the log for that
    // class only; every other throw stays as error-level (the original
    // 500-class catch contract).
    if (!(err instanceof FrontmatterMalformedError)) {
      log.error(
        { err, docName: document.name, position, markdownLen: markdown.length },
        `[applyAgentMarkdownWrite] failed for '${document.name}'`,
      );
    }
    throw err;
  }
}

/**
 * Y.Text-is-truth agent undo. The only sanctioned server-side undo write
 * surface — every other path is the deleted client-side cross-CRDT
 * anti-pattern.
 *
 * Calls session.um.undo() INSIDE an outer doc.transact(..., session.undoOrigin)
 * so Y.js merges the UM's internal transaction into the outer. The whole
 * operation fires under undoOrigin (paired: true) → Observer A/B short-circuit.
 *
 * After undo, Y.Text holds the user's intended post-undo bytes (precedent
 * #38). XmlFragment derives via `parseWithFallback(body)` →
 * `updateYFragment` so the structural diff preserves user-content Items at
 * matching positions. NO canonicalize-write-back step: re-serializing the
 * fragment and applying that to ytext would defeat the contract by
 * canonicalizing user-typed source-form bytes (e.g. `__foo__` → `**foo**`,
 * `:---:` table widths, ATX trailing hashes). Post-undo bridge invariant
 * divergence (if any) is detected by Observer B's watchdog.
 *
 * scope 'last': undo one UM stack item.
 * scope 'session': undo entire UM stack.
 * scope 'count': undo the `count` newest UM stack items (clamped to depth) —
 *   the scoped "undo to edit N" range. `count` is required for this scope.
 *
 * Returns `true` when at least one UM frame was popped (i.e., the undo had
 * an observable effect), `false` when the stack was already empty. Callers
 * can surface this to the HTTP response so MCP clients know the no-op case.
 *
 * Contract — every requirement is load-bearing; do not relax without re-running
 * the bridge fuzzer + conversion-PBT suite that guards against the bug-A class:
 *
 *   (1) Y.Text-is-truth composition (precedent #38). Y.UndoManager has
 *       already mutated ytext to its desired post-undo state; XmlFragment
 *       derives via parse(ytext). Do NOT re-canonicalize ytext from the
 *       fragment — that defeats the contract.
 *   (2) Fires under per-session `session.undoOrigin`, distinct from
 *       `session.origin`. The UM is constructed with
 *       `captureTransaction: tr => tr.origin !== session.undoOrigin` so
 *       undo-of-undo never lands on the stack.
 *   (3) No client-side cross-CRDT writes. Server-authoritative observer-
 *       bridge is the only mirror path; client observers are baseline-only
 *       (precedent #14).
 *   (4) Single `doc.transact()` block — no defensive mutex. The atomicity
 *       comes from the transact, not from extra serialization.
 *   (5) Every change here ships with fuzzer + conversion-PBT coverage.
 *
 * Cross-deploy transition: undo-stack frames captured BEFORE the
 * Y.Text-is-truth migration contain canonical bytes (post-Phase-2
 * canonicalize-write-back). After deploy, undo through those frames
 * restores canonical bytes, while frames captured under contract restore
 * raw user bytes. Mixed-form undo across the boundary is acceptable
 * transition behavior — the UM stack is per-session and ephemeral.
 *
 * @see PRECEDENTS.md precedent #38 (Y.Text-is-truth contract)
 * @see PRECEDENTS.md precedent #14 (cross-CRDT sync is single-writer, server-side)
 */
export function applyAgentUndo(
  session: SessionRecord,
  scope: 'last' | 'session' | 'count',
  /**
   * Embed-resolver context for `mdManager.parseWithFallback` — same shape
   * `applyAgentMarkdownWrite` accepts. Required for parity: the post-undo
   * body re-parse maps `![[photo.png]]` → resolved disk path so the
   * XmlFragment shape matches what `onLoadDocument` would produce on a
   * fresh load. Omitting it leaves PM image `src` as the literal target,
   * which renders as a broken inline preview until the next round-trip.
   */
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
  /** Frames to pop when `scope === 'count'` (clamped to stack depth). */
  count?: number,
): boolean {
  // Conflict-aware write gate — symmetric with `applyAgentMarkdownWrite`.
  // Undo is also a mutation: it pops a UM frame and rewrites Y.Text. The
  // recovery path during conflict is `resolve_conflict({strategy: 'content', ...})`
  // (the explicit dedicated MCP tool), not a sneak-through via the undo
  // stack.
  const undoDoc = session.dc.document;
  if (isDocInConflict(undoDoc)) {
    throw new DocInConflictError({ file: docNameToFile(undoDoc.name) });
  }
  return withSpanSync(
    'agent.applyAgentUndo',
    {
      attributes: {
        'doc.name': session.dc.document.name,
        'agent.undo_scope': scope,
      },
    },
    () => {
      const undone = applyAgentUndoInner(session, scope, embedResolver, count);
      setActiveSpanAttributes({ 'agent.undo_effective': undone });
      return undone;
    },
  );
}

function applyAgentUndoInner(
  session: SessionRecord,
  scope: 'last' | 'session' | 'count',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
  count?: number,
): boolean {
  const { dc, um, undoOrigin } = session;
  const document = dc.document;

  // 'count' pops the N newest frames — clamp to the live depth so an
  // over-large request (the timeline's list can lag a just-landed burst) is a
  // full drain, not an error. A non-positive count is a no-op.
  const framesToPop =
    scope === 'last'
      ? 1
      : scope === 'count'
        ? Math.min(Math.max(0, count ?? 0), um.undoStack.length)
        : um.undoStack.length;

  let undone = false;
  // Wrap undo + composition in one outer transact under undoOrigin.
  // Y.js merges um.undo()'s nested transact into this outer → fires under undoOrigin.
  // isPairedWriteOrigin(undoOrigin) === true → Observer A/B short-circuit on settle.
  document.transact(() => {
    for (let i = 0; i < framesToPop && um.undoStack.length > 0; i++) {
      um.undo();
      undone = true;
    }
    if (undone) deriveFragmentFromYtext(document, embedResolver);
  }, undoOrigin);

  log.debug(
    { docName: session.docName, agentId: session.agentId, scope, framesToPop, undone },
    '[agent-session] applied agent undo',
  );
  return undone;
}

export interface AgentSessionIdentity {
  displayName: string;
  colorSeed: string;
  clientName?: string;
  principalId?: string;
}

/**
 * Per-session state bundle.
 *
 * Every write path must use `session.dc.document.transact(fn, session.origin)`
 * (STOP rule). Never call `session.dc.transact(fn)` or pass the shared
 * `AGENT_WRITE_ORIGIN` constant to per-session writes.
 *
 * `um` tracks [Y.Text, flashMap] under `session.origin`; writes under
 * `session.undoOrigin` (undo path) are excluded via captureTransaction.
 */
interface SessionRecord {
  dc: AgentDirectConnection;
  /** Per-session frozen PairedWriteOrigin — unique per session. */
  origin: PairedWriteOrigin;
  /** Per-session undo write origin. Paired so Observer A/B short-circuit. */
  undoOrigin: PairedWriteOrigin;
  /** Per-session UndoManager scoped to [Y.Text, flashMap]. */
  um: Y.UndoManager;
  agentId: string;
  docName: string;
  /**
   * Recency stamp (epoch ms), maintained exclusively by AgentSessionManager:
   * refreshed on every `getSession` / `getLiveSession` hit. The manager's
   * sessions map mirrors it in insertion order (a touch re-inserts the
   * entry), so the map's first entry is always the LRU eviction candidate.
   */
  lastUsedAt: number;
}

/**
 * Create a frozen per-session PairedWriteOrigin (precedent #24(b)).
 * Object-identity-unique per call; deep-frozen via Object.freeze on both
 * the context and the outer object. The returned object is the Y.UndoManager
 * trackedOrigins key for this session — a reconstructed object with the same
 * shape is NOT equivalent (Set-identity match, not structural equality).
 */
function createSessionOrigin(
  sessionId: string,
  agentType?: string,
  principalId?: string,
  displayName?: string,
  colorSeed?: string,
): PairedWriteOrigin {
  // precedent #1: typed transaction origin object (not string).
  // Deep-freeze both context and outer object so accidental mutation throws.
  // context.session_id is the RAW connection id (unprefixed) — `resolveWriterFromOrigin`
  // in persistence.ts adds the `agent-` namespace prefix to derive the writerId.
  // Storing a pre-prefixed form here produces `agent-agent-<id>` phantom writers
  // that don't match the handler's `recordContributor(docName, agentId, …)` call
  // and trigger the `onStoreDocument` safety-net stub.
  const context: Record<string, unknown> & { origin: string; paired: true } = {
    origin: 'agent-write',
    paired: true as const,
    session_id: sessionId,
  };
  if (agentType !== undefined) context.agent_type = agentType;
  if (principalId !== undefined) context.principal = principalId;
  // display_name + color_seed are read by agent-activity's listAgentActivity
  // so the Activity Panel shows the same name/color the presence bar does.
  if (displayName !== undefined) context.display_name = displayName;
  if (colorSeed !== undefined) context.color_seed = colorSeed;
  Object.freeze(context);
  const origin: PairedWriteOrigin = {
    source: 'local',
    skipStoreHooks: false,
    context,
  };
  Object.freeze(origin);
  return origin;
}

/**
 * Create a frozen per-session PairedWriteOrigin for agent-undo writes.
 * Object-identity-unique per call; deep-frozen. isPairedWriteOrigin returns true
 * so Observer A/B short-circuit when the undo+composition transact settles.
 * captureTransaction: tr => tr.origin !== session.undoOrigin prevents undo-of-undo stacking.
 */
function createUndoOrigin(sessionId: string, agentType?: string): PairedWriteOrigin {
  // precedent #1: typed transaction origin; paired: true so observers short-circuit.
  // context.session_id is the RAW connection id (unprefixed). See createSessionOrigin above.
  const context: Record<string, unknown> & { origin: string; paired: true } = {
    origin: 'agent-undo',
    paired: true as const,
    session_id: sessionId,
  };
  if (agentType !== undefined) context.agent_type = agentType;
  Object.freeze(context);
  const origin: PairedWriteOrigin = {
    source: 'local',
    skipStoreHooks: false,
    context,
  };
  Object.freeze(origin);
  return origin;
}

/**
 * Hard cap on the number of live `(docName, agentId)` agent sessions a
 * single server instance retains.
 *
 * Each session owns a `DirectConnection`, a `Y.UndoManager`, and a frozen
 * origin object. Without a ceiling, an unbounded distinct-`agentId` flood
 * (HTTP body field is regex-validated but otherwise caller-controlled)
 * grows the sessions map indefinitely — keepalive-WS cleanup does not run
 * for HTTP-only callers, so memory rises until the process is restarted.
 *
 * 256 leaves comfortable headroom for realistic local workflows (a handful
 * of MCP clients across dozens of docs) while keeping the worst-case
 * footprint bounded. At capacity the manager first evicts the
 * least-recently-used idle session (see `MIN_EVICTABLE_IDLE_MS`) so a burst
 * of writes across many distinct docs streams through a bounded working set;
 * only when no session is idle-eligible does the cap surface as a 503 at the
 * HTTP boundary.
 */
export const MAX_AGENT_SESSIONS = 256;

/**
 * Minimum idle age before a live session becomes eviction-eligible under
 * capacity pressure.
 *
 * The floor guards in-flight handlers: every HTTP request re-resolves its
 * session via `getSession` at entry (refreshing recency), so a session
 * younger than the floor may still be inside a request whose transact has
 * not run yet. Evicting it would null the DirectConnection under the
 * handler (`dc.document` becomes null on disconnect) and destroy its
 * UndoManager mid-flight. Past the floor a session is quiescent — agent
 * write handlers flush the doc to disk before responding, so nothing is in
 * flight and nothing is unpersisted.
 *
 * Small by design: a burst that fills the cap ages its LRU session by
 * roughly (cap x per-write latency), and every write awaits its disk flush,
 * so realistic bursts are well past the floor by the time eviction is
 * needed. In-code constant, not user config; tests override via the
 * constructor option.
 */
export const MIN_EVICTABLE_IDLE_MS = 5_000;

/**
 * Thrown by `AgentSessionManager.getSession` when creating a new session
 * would exceed `MAX_AGENT_SESSIONS`. HTTP handlers catch this and translate
 * to 503 so callers can distinguish capacity exhaustion from generic 500s.
 */
export class AgentSessionCapacityError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Maximum agent session count reached (${limit})`);
    this.name = 'AgentSessionCapacityError';
    this.limit = limit;
  }
}

/** Lazy, process-wide eviction counter — instrument is created on first use so
 *  module load stays side-effect-free when OTel is disabled (no-op meter). */
let _evictionCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function evictionCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _evictionCounter ||= getMeter().createCounter('ok.sessions.evictions_total', {
    description:
      'Agent sessions evicted (LRU-idle) under capacity pressure to admit a new session. Sustained growth alongside ok.sessions.active pinned at ok.sessions.limit means the working set exceeds the cap.',
    unit: '{sessions}',
  });
  return _evictionCounter;
}

export class AgentSessionManager {
  /**
   * Live sessions in recency order: every touch re-inserts the entry, so
   * iteration starts at the least-recently-used session. Eviction relies on
   * this — do not add write paths that bypass `touchSession`.
   */
  private sessions = new Map<string, SessionRecord>();
  /** In-flight promise dedup — concurrent first-calls share one pending openDirectConnection. */
  private pendingSessions = new Map<string, Promise<SessionRecord>>();
  private hocuspocus: Hocuspocus;
  /** Hard cap on simultaneous live sessions. Override is for tests only. */
  private readonly maxSessions: number;
  /** Idle floor for eviction eligibility. Override is for tests only. */
  private readonly minEvictableIdleMs: number;
  private evictions = 0;

  constructor(
    hocuspocus: Hocuspocus,
    options: { maxSessions?: number; minEvictableIdleMs?: number } = {},
  ) {
    this.hocuspocus = hocuspocus;
    this.maxSessions = options.maxSessions ?? MAX_AGENT_SESSIONS;
    this.minEvictableIdleMs = options.minEvictableIdleMs ?? MIN_EVICTABLE_IDLE_MS;
  }

  /** Number of live sessions currently retained. Read-only occupancy probe. */
  public get liveSessionCount(): number {
    return this.sessions.size;
  }

  /** The hard cap `getSession` enforces (`MAX_AGENT_SESSIONS` unless overridden). */
  public get sessionLimit(): number {
    return this.maxSessions;
  }

  /** Sessions evicted under capacity pressure since construction. */
  public get evictionCount(): number {
    return this.evictions;
  }

  /**
   * Refresh a session's recency: stamp `lastUsedAt` and re-insert the entry
   * so the map's iteration order stays LRU-first.
   */
  private touchSession(key: string, session: SessionRecord): void {
    session.lastUsedAt = Date.now();
    this.sessions.delete(key);
    this.sessions.set(key, session);
  }

  private sessionKey(docName: string, agentId: string): string {
    return `${docName}\0${agentId}`;
  }

  /**
   * Read-only iterator over live `SessionRecord`s whose session key ends with
   * the `\0${connectionId}` suffix. Returns sessions in insertion order.
   *
   * This is the typed public surface for the Agent Activity Panel's
   * `listAgentActivity`. Reaching
   * into `this.sessions` directly via `(as any)` is discouraged — callers
   * should use this accessor so future refactors (e.g. splitting the
   * (docName, agentId)-keyed map into separate per-agent and per-doc
   * indices) can evolve without silent breakage at consumer call sites.
   */
  public *sessionsForConnection(connectionId: string): IterableIterator<SessionRecord> {
    const suffix = `\0${connectionId}`;
    for (const [key, session] of this.sessions) {
      if (key.endsWith(suffix)) yield session;
    }
  }

  /**
   * Lookup a single session by its (docName, agentId) composite key. Returns
   * `undefined` when no session is live — callers must guard (e.g. the
   * Activity Panel's `GET /api/agent-burst-diff` returns 404 in that case).
   *
   * Equivalent to `hasSession(docName, agentId) ? sessions.get(key) : null`
   * but returns the record directly instead of forcing a separate get after
   * the existence check.
   */
  public getLiveSession(docName: string, agentId: string): SessionRecord | undefined {
    const key = this.sessionKey(docName, agentId);
    const session = this.sessions.get(key);
    // A read is a use: the burst-diff caller walks the session's UM stacks
    // right after this returns, so refreshing recency keeps eviction from
    // tearing the session down under the read.
    if (session) this.touchSession(key, session);
    return session;
  }

  /**
   * Get or create a per-agent SessionRecord (DirectConnection + per-session origin).
   *
   * Each new session creates a frozen LocalTransactionOrigin via
   * `createSessionOrigin`. The returned session.origin is object-identity-unique.
   *
   * Concurrent first-calls for the same (docName, agentId) share one
   * pending openDirectConnection promise — exactly one DirectConnection created.
   *
   * No per-doc awareness publishing: every Hocuspocus `Document` has a single
   * shared `Awareness` clientID, so per-doc writes stomp across N concurrent
   * agents. Presence is published on the `__system__` Y.Doc via
   * `AgentPresenceBroadcaster` instead (precedent #3).
   */
  async getSession(
    docName: string,
    agentId = 'claude-1',
    identity?: AgentSessionIdentity,
  ): Promise<SessionRecord> {
    if (isSystemDoc(docName) || isConfigDoc(docName)) {
      throw new Error(`Cannot create agent session for reserved doc: ${docName}`);
    }
    const key = this.sessionKey(docName, agentId);

    const existing = this.sessions.get(key);
    if (existing) {
      this.touchSession(key, existing);
      return existing;
    }

    // Reuse in-flight promise if a concurrent first-call is already pending
    const inflight = this.pendingSessions.get(key);
    if (inflight) {
      log.debug({ docName, agentId }, '[agent-session] joining in-flight session creation');
      return inflight;
    }

    // Capacity gate — fires only when creating a NEW (docName, agentId)
    // entry. Existing-session lookups returned above. Counts both resolved
    // and pending so a concurrent burst of distinct ids cannot race past
    // the cap before any of them lands in `sessions`.
    //
    // At capacity, evict LRU idle sessions until a slot frees so a burst of
    // writes to many distinct docs streams through a bounded working set
    // instead of stalling at the cap. When nothing is idle-eligible (every
    // session touched within the idle floor), degrade to the capacity
    // refusal — an in-flight handler is never torn down under itself.
    while (this.sessions.size + this.pendingSessions.size >= this.maxSessions) {
      const evictedKey = await this.evictLruIdleSession();
      if (evictedKey === null) {
        log.warn(
          { docName, agentId, limit: this.maxSessions },
          '[agent-session] session capacity reached, refusing new session',
        );
        throw new AgentSessionCapacityError(this.maxSessions);
      }
    }

    const promise = this._createSession(docName, agentId, identity);
    this.pendingSessions.set(key, promise);
    try {
      const session = await promise;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.pendingSessions.delete(key);
    }
  }

  private async _createSession(
    docName: string,
    agentId: string,
    identity: AgentSessionIdentity | undefined,
  ): Promise<SessionRecord> {
    const agentType = identity?.clientName;
    // extractAgentIdentity returns `agent-<raw>` (prefixed) as the sessions-map
    // key / writerId. But `context.session_id` is the RAW connection id — the
    // `agent-` prefix is the writerId namespace, added by
    // `resolveWriterFromOrigin` in persistence.ts. Strip once here so downstream
    // consumers (origin context, dc context, ok-actor agent_session field) all
    // see the unprefixed form; otherwise `resolveWriterFromOrigin` double-prefixes
    // to `agent-agent-<raw>` and the onStoreDocument safety-net books a phantom
    // commit under that mismatched writerId.
    const rawSessionId = agentId.startsWith('agent-') ? agentId.slice('agent-'.length) : agentId;
    // Per-session frozen origin — object-identity-unique
    const origin = createSessionOrigin(
      rawSessionId,
      agentType,
      identity?.principalId,
      identity?.displayName,
      identity?.colorSeed,
    );
    // Per-session undo origin — excluded from UM stack
    const undoOrigin = createUndoOrigin(rawSessionId, agentType);

    // Thread session context to openDirectConnection so Hocuspocus
    // extensions (e.g. onAuthenticate) can resolve the session's identity.
    const sessionContext = {
      session_id: rawSessionId,
      ...(agentType !== undefined ? { agent_type: agentType } : {}),
      ...(identity?.clientName !== undefined ? { client_name: identity.clientName } : {}),
      ...(identity?.principalId !== undefined ? { principalId: identity.principalId } : {}),
    };

    const dc = (await this.hocuspocus.openDirectConnection(
      docName,
      sessionContext,
    )) as AgentDirectConnection;
    log.debug(
      { docName, agentId, sessionId: rawSessionId, agentType },
      '[agent-session] DirectConnection opened',
    );

    // NO per-doc awareness writes here. Every Hocuspocus `Document` has a
    // single shared `Awareness` clientID borrowed from `doc.clientID`, so a per-
    // doc `setLocalState` stomps across N concurrent agents that all share the
    // same Document. Presence is published on the `__system__` Y.Doc via
    // `AgentPresenceBroadcaster` (map-valued, keyed by agentId) instead.

    // Per-session UndoManager scoped to [Y.Text, agent-flash].
    // trackedOrigins uses object identity — only transactions under session.origin are stacked.
    // captureTransaction excludes undoOrigin writes to prevent undo-of-undo cycles.
    // ignoreRemoteMapChanges: true — remote agent map updates do not trigger undo eligibility.
    //
    // Y.Map('agent-flash') is tracked here so that undo of an agent write also
    // reverts the flash entry the same write dropped into the attribution
    // side-channel — otherwise undo leaves a stale "who wrote this" marker
    // pointing at content that no longer exists. The map is included only to
    // keep the flash side-channel in lock-step with source text, not to track
    // cross-session flash updates (those fire under remote origins and are
    // filtered by trackedOrigins + ignoreRemoteMapChanges).
    // FM lives in the YAML region of Y.Text — `Y.Map('metadata')` is no
    // longer a CRDT root for FM data. The UndoManager tracks Y.Text (covers
    // body + FM region) and `agent-flash` (so undo of an agent write also
    // reverts the flash entry).
    const um = new Y.UndoManager(
      [dc.document.getText('source'), dc.document.getMap('agent-flash')],
      {
        trackedOrigins: new Set([origin]),
        captureTimeout: 500,
        captureTransaction: (tr: { origin: unknown }) => tr.origin !== undoOrigin,
        ignoreRemoteMapChanges: true,
      },
    );

    // Stamp wall-clock capture time on each StackItem's meta so the Activity
    // Panel can order bursts chronologically. Y.UndoManager does not
    // auto-populate meta.time — the `stackItemAdded` event is the documented
    // hook (see `node_modules/yjs/src/utils/UndoManager.js`). We also handle
    // `stackItemUpdated` (fired when writes within captureTimeout merge into
    // an existing StackItem) so the latest merged write's ts becomes the
    // burst's `lastTs` signal.
    // Y.StackItem is not exported from yjs public API — use structural type.
    const stampTime = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }): void => {
      stackItem.meta.set('time', Date.now());
    };
    um.on('stack-item-added', stampTime);
    um.on('stack-item-updated', stampTime);

    log.info(
      { docName, agentId, sessionId: rawSessionId },
      `[agent-session] Created session for: ${docName} / ${agentId}`,
    );

    return { dc, origin, undoOrigin, um, agentId, docName, lastUsedAt: Date.now() };
  }

  /**
   * Evict the least-recently-used idle session to relieve capacity pressure.
   * Returns the evicted session key, or `null` when nothing is eligible.
   *
   * The sessions map is kept in recency order (every touch re-inserts), so
   * the first entry IS the LRU candidate — and if it is younger than the
   * idle floor, every other entry is younger still, so the scan is O(1).
   *
   * The entry is removed from the map synchronously BEFORE the async
   * teardown so a concurrent create cannot select the same victim. Teardown
   * IS the existing disconnect spine (`cleanupSession`: um.destroy +
   * dc.disconnect); Hocuspocus's `DirectConnection.disconnect` stores the
   * doc immediately (not debounced) before unloading it, so evicted state
   * reaches disk exactly as it does on keepalive teardown. Because the map
   * delete frees the slot before the teardown settles, concurrent creates
   * can transiently hold more DirectConnections than the cap while
   * evictions drain — bounded by the number of evictable sessions and
   * decaying as each disconnect completes.
   *
   * Eviction destroys the session's UndoManager stack — identical to
   * disconnect teardown, where the stack was only ever reachable while the
   * session lived. A later undo for the evicted (docName, agentId) finds no
   * session (`hasSession` false → the handler's no-active-session
   * refusal); a later write mints a fresh session whose origin carries the
   * same session_id, so the derived writer id (`agent-<id>`) and
   * shadow-repo attribution stay continuous across eviction.
   */
  private async evictLruIdleSession(): Promise<string | null> {
    const first = this.sessions.entries().next();
    if (first.done) return null;
    const [key, session] = first.value;
    const idleMs = Date.now() - session.lastUsedAt;
    if (idleMs < this.minEvictableIdleMs) return null;

    this.sessions.delete(key);
    await this.cleanupSession(key, session, {
      docName: session.docName,
      agentId: session.agentId,
      evicted: true,
    });
    this.evictions++;
    incrementAgentSessionEvictions();
    evictionCounter().add(1);
    log.info(
      { docName: session.docName, agentId: session.agentId, idleMs },
      '[agent-session] Evicted LRU idle session under capacity pressure',
    );
    return key;
  }

  /** Check if a session exists without creating one. */
  hasSession(docName: string, agentId = 'claude-1'): boolean {
    return this.sessions.has(this.sessionKey(docName, agentId));
  }

  /**
   * Single cleanup spine for all session-close paths.
   *
   * Each step runs in its own try so a throw in one doesn't skip the next:
   * a `um.destroy()` throw would otherwise leak the DirectConnection
   * (preventing GC + doc unload, blocking `unloadDocument` because
   * `getConnectionsCount()` stays > 0; during `closeAll` graceful shutdown
   * this manifests as a slow shutdown that gets SIGKILL'd, potentially
   * losing the final persistence flush). A `dc.disconnect()` throw would
   * skip the always-delete-the-entry guarantee — `hasSession()` reflecting
   * "true" after a failed close hands out the broken instance. The outer
   * `finally` ensures the session record is removed regardless.
   *
   * `context` is included in error logs and is purely diagnostic — pass
   * whatever the caller has in scope (docName / agentId / key).
   */
  private async cleanupSession(
    key: string,
    session: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
    log.debug(
      { docName: session.docName, agentId: session.agentId, ...context },
      '[agent-session] closing session',
    );
    try {
      try {
        session.um.destroy();
      } catch (err) {
        log.error({ err, ...context }, '[agent-session] um.destroy() failed');
      }
      try {
        await session.dc.disconnect();
      } catch (err) {
        log.error({ err, ...context }, '[agent-session] dc.disconnect() failed');
      }
    } finally {
      this.sessions.delete(key);
    }
  }

  /**
   * Disconnect and remove a specific agent session.
   *
   * Destroys UM before disconnect: dc.disconnect() is the teardown
   * primitive; explicit um.destroy() releases UM observers eagerly before
   * Hocuspocus unloads the Y.Doc — UM also auto-destroys on doc.on('destroy').
   *
   * Does NOT touch per-doc awareness — presence cleanup is the
   * AgentPresenceBroadcaster's responsibility (keyed by agentId on __system__).
   */
  async closeSession(docName: string, agentId = 'claude-1'): Promise<void> {
    const key = this.sessionKey(docName, agentId);
    const session = this.sessions.get(key);
    if (!session) return;
    await this.cleanupSession(key, session, { docName, agentId });
    log.info({ docName, agentId }, `[agent-session] Closed session for: ${docName} / ${agentId}`);
  }

  /**
   * Close all sessions for a given agent (across all docs).
   *
   * Settles any in-flight `pendingSessions` for this agent first so a
   * concurrent `getSession()` can't land a newly-registered session into
   * `this.sessions` AFTER we've drained it — otherwise a keepalive-grace
   * timer firing during an MCP first-call would leak an orphan session.
   */
  async closeAllForAgent(agentId: string): Promise<void> {
    const suffix = `\0${agentId}`;

    // Settle any in-flight session creations for this agent before draining
    // `this.sessions`. Each pending promise registers itself into `sessions`
    // on resolve; awaiting here ensures the subsequent `keys` scan sees it.
    const pendingKeys = [...this.pendingSessions.keys()].filter((k) => k.endsWith(suffix));
    if (pendingKeys.length > 0) {
      await Promise.allSettled(pendingKeys.map((k) => this.pendingSessions.get(k)));
    }

    // Collect matching keys first — the async disconnect + delete below mutates
    // `this.sessions`, so iterating directly would hit concurrent-modification.
    const keys = [...this.sessions.keys()].filter((k) => k.endsWith(suffix));
    log.debug(
      { agentId, pendingSettled: pendingKeys.length, closing: keys.length },
      '[agent-session] closing all sessions for agent',
    );
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { agentId, key });
    }
  }

  /** Close all sessions for a given document (all agents). */
  async closeAllForDoc(docName: string): Promise<void> {
    const prefix = `${docName}\0`;
    // Collect matching keys first — the async disconnect + delete below mutates
    // `this.sessions`, so iterating directly would hit concurrent-modification.
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(prefix));
    log.debug({ docName, closing: keys.length }, '[agent-session] closing all sessions for doc');
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { docName, key });
    }
  }

  /** Close all sessions (optionally scoped to a single docName for backward compat). */
  async closeAll(docName?: string): Promise<void> {
    if (docName) {
      await this.closeAllForDoc(docName);
      return;
    }
    const keys = [...this.sessions.keys()];
    log.debug({ closing: keys.length }, '[agent-session] closing all sessions');
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { key });
    }
  }
}
