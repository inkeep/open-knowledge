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
  applyPatchToFm,
  detectFmRegion,
  parseFrontmatterYaml,
  prependFrontmatter,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { splitPayloadFrontmatter } from './payload-frontmatter.ts';

export { colorFromSeed } from '@inkeep/open-knowledge-core';

import * as Y from 'yjs';
import type { YjsStackItemShape } from './agent-activity.ts';
import {
  composeAndWriteRawBody,
  deriveFragmentFromYtext,
  type PrecomputedParse,
  replaceRawBody,
} from './bridge-intake.ts';
import {
  type BridgeDeriveLossReporter,
  DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE,
  type DeriveLossDetectOptions,
} from './bridge-loss-detector.ts';
import { shouldRunPairedIntakeDetection } from './bridge-loss-suppression.ts';
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
import { precomputeParse } from './parse-pool.ts';
import { getPreDrainController, type PairedWriteOrigin } from './server-observers.ts';
import { getMeter, setActiveSpanAttributes, withSpanSync } from './telemetry.ts';

export type { AgentWriteContentDivergence };

const log = getLogger('agent-sessions');

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

export { iconFromClientName } from '@inkeep/open-knowledge-core';

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
export async function prepareAgentMarkdownParse(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
): Promise<PrecomputedParse | undefined> {
  if (isDocInConflict(document)) return undefined;
  const composed = composeAgentWrite(document.getText('source').toString(), markdown, position);
  if (composed === undefined) return undefined;
  return precomputeParse(composed.newContent, embedResolver);
}

export async function prepareFrontmatterPatchParse(
  document: Document,
  patch: Parameters<typeof applyPatchToFm>[1],
): Promise<PrecomputedParse | undefined> {
  const snapshot = document.getText('source').toString();
  const { fenced, body } = detectFmRegion(snapshot);
  const result = applyPatchToFm(fenced, patch);
  if (!result.ok || result.nextFenced === fenced) return undefined;
  const needsFenceSeparator = fenced === '' && body !== '' && !body.startsWith('\n');
  return precomputeParse(result.nextFenced + (needsFenceSeparator ? '\n' : '') + body);
}

export interface AgentWriteLossDetect {
  reporter: BridgeDeriveLossReporter;
  writerId: string | null;
}

export function agentWriteLossDetect(session: {
  bridgeLossReporter?: BridgeDeriveLossReporter;
  agentId: string;
}): AgentWriteLossDetect | undefined {
  return session.bridgeLossReporter
    ? { reporter: session.bridgeLossReporter, writerId: session.agentId }
    : undefined;
}

export function agentWritePreDrain(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
): void {
  const controller = getPreDrainController(document as unknown as Y.Doc);
  if (!controller) return;
  if (composeAgentWrite(document.getText('source').toString(), markdown, position) === undefined) {
    return;
  }
  controller.preDrain({ kind: 'agent-write', writeKind: position });
}

export function applyAgentMarkdownWrite(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
  precomputed?: PrecomputedParse,
  lossDetect?: AgentWriteLossDetect,
): AgentWriteContentDivergence | undefined {
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
      const divergence = applyAgentMarkdownWriteInner(
        document,
        markdown,
        position,
        embedResolver,
        precomputed,
        lossDetect,
      );
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

export function snapshotBlocks(document: Document): string[] {
  return document
    .getXmlFragment('default')
    .toArray()
    .map((child) => child.toString());
}

interface ComposedAgentWrite {
  existingFm: string;
  finalFm: string;
  newContent: string;
}

function composeAgentWrite(
  currentYText: string,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
): ComposedAgentWrite | undefined {
  const { frontmatter: existingFm, body: currentBody } = stripFrontmatter(currentYText);
  const { frontmatter: payloadFm, body: payloadBody } =
    position === 'append' || position === 'prepend'
      ? splitPayloadFrontmatter(markdown)
      : stripFrontmatter(markdown);

  if ((position === 'append' || position === 'prepend') && payloadBody === '') {
    return undefined;
  }

  let finalFm: string;
  let newBody: string;
  switch (position) {
    case 'replace':
      finalFm = payloadFm || existingFm;
      newBody = payloadBody;
      break;
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

  return {
    existingFm,
    finalFm,
    newContent: prependFrontmatter(finalFm, newBody),
  };
}

function applyAgentMarkdownWriteInner(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
  precomputed?: PrecomputedParse,
  lossDetect?: AgentWriteLossDetect,
): AgentWriteContentDivergence | undefined {
  try {
    const ytext = document.getText('source');
    const currentYText = ytext.toString();
    const composed = composeAgentWrite(currentYText, markdown, position);
    if (composed === undefined) {
      return;
    }
    const { existingFm, finalFm, newContent } = composed;

    const detect: DeriveLossDetectOptions | undefined =
      lossDetect && shouldRunPairedIntakeDetection(AGENT_WRITE_ORIGIN.context.origin)
        ? {
            report: (obs) =>
              lossDetect.reporter(
                document.name,
                obs,
                lossDetect.writerId,
                DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE,
              ),
            baselineFullMd: currentYText,
          }
        : undefined;

    if (finalFm !== existingFm) {
      const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(finalFm));
      if (parsed.map === null) {
        throw new FrontmatterMalformedError({
          file: docNameToFile(document.name),
          parseError: parsed.parseError ?? 'unknown YAML parse error',
        });
      }
      recordFrontmatterEditSurface('mcp-write');
    } else if (finalFm === '' && stripFrontmatter(newContent).frontmatter !== '') {
      throw new FrontmatterMalformedError({
        file: docNameToFile(document.name),
        parseError:
          "the payload's leading `---` fence pair would land at byte 0, where the composed document re-reads it as the frontmatter region instead of body",
        refusalClass: 'byte-0-promotion',
        hint: 'Start the payload with a blank line so the fence pair cannot open the document, or use `***` / `___` for the thematic break.',
      });
    }

    if (position === 'replace') {
      replaceRawBody(document, newContent, embedResolver, precomputed, detect);
    } else {
      composeAndWriteRawBody(document, newContent, 'agent', embedResolver, precomputed, detect);
    }

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
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
  count?: number,
): boolean {
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

  const framesToPop =
    scope === 'last'
      ? 1
      : scope === 'count'
        ? Math.min(Math.max(0, count ?? 0), um.undoStack.length)
        : um.undoStack.length;

  if (framesToPop === 1 && um.undoStack.length > 0) {
    getPreDrainController(document as unknown as Y.Doc)?.preDrain({
      kind: 'agent-undo',
      stackItem: um.undoStack[um.undoStack.length - 1] as unknown as YjsStackItemShape,
    });
  }

  let undone = false;
  const reporter = session.bridgeLossReporter;
  const detect: DeriveLossDetectOptions | undefined =
    reporter && shouldRunPairedIntakeDetection(undoOrigin.context.origin)
      ? {
          report: (obs) => reporter(session.docName, obs, session.agentId),
          baselineFullMd: document.getText('source').toString(),
        }
      : undefined;
  document.transact(() => {
    for (let i = 0; i < framesToPop && um.undoStack.length > 0; i++) {
      um.undo();
      undone = true;
    }
    if (undone) deriveFragmentFromYtext(document, embedResolver, detect);
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

interface SessionRecord {
  dc: AgentDirectConnection;
  origin: PairedWriteOrigin;
  undoOrigin: PairedWriteOrigin;
  um: Y.UndoManager;
  agentId: string;
  docName: string;
  bridgeLossReporter?: BridgeDeriveLossReporter;
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
  const context: Record<string, unknown> & { origin: string; paired: true } = {
    origin: 'agent-write',
    paired: true as const,
    session_id: sessionId,
  };
  if (agentType !== undefined) context.agent_type = agentType;
  if (principalId !== undefined) context.principal = principalId;
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

function createUndoOrigin(sessionId: string, agentType?: string): PairedWriteOrigin {
  // precedent #1: typed transaction origin; paired: true so observers short-circuit.
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

export const MAX_AGENT_SESSIONS = 256;

export const MIN_EVICTABLE_IDLE_MS = 5_000;

export class AgentSessionCapacityError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Maximum agent session count reached (${limit})`);
    this.name = 'AgentSessionCapacityError';
    this.limit = limit;
  }
}

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
  private sessions = new Map<string, SessionRecord>();
  private pendingSessions = new Map<string, Promise<SessionRecord>>();
  private hocuspocus: Hocuspocus;
  private readonly maxSessions: number;
  private readonly minEvictableIdleMs: number;
  private bridgeLossReporter?: BridgeDeriveLossReporter;
  private evictions = 0;

  constructor(
    hocuspocus: Hocuspocus,
    options: {
      maxSessions?: number;
      minEvictableIdleMs?: number;
      bridgeLossReporter?: BridgeDeriveLossReporter;
    } = {},
  ) {
    this.hocuspocus = hocuspocus;
    this.maxSessions = options.maxSessions ?? MAX_AGENT_SESSIONS;
    this.minEvictableIdleMs = options.minEvictableIdleMs ?? MIN_EVICTABLE_IDLE_MS;
    this.bridgeLossReporter = options.bridgeLossReporter;
  }

  public attachBridgeLossReporter(reporter: BridgeDeriveLossReporter): void {
    this.bridgeLossReporter = reporter;
  }

  public get liveSessionCount(): number {
    return this.sessions.size;
  }

  public get sessionLimit(): number {
    return this.maxSessions;
  }

  public get evictionCount(): number {
    return this.evictions;
  }

  private touchSession(key: string, session: SessionRecord): void {
    session.lastUsedAt = Date.now();
    this.sessions.delete(key);
    this.sessions.set(key, session);
  }

  private sessionKey(docName: string, agentId: string): string {
    return `${docName}\0${agentId}`;
  }

  public *sessionsForConnection(connectionId: string): IterableIterator<SessionRecord> {
    const suffix = `\0${connectionId}`;
    for (const [key, session] of this.sessions) {
      if (key.endsWith(suffix)) yield session;
    }
  }

  public getLiveSession(docName: string, agentId: string): SessionRecord | undefined {
    const key = this.sessionKey(docName, agentId);
    const session = this.sessions.get(key);
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

    const inflight = this.pendingSessions.get(key);
    if (inflight) {
      log.debug({ docName, agentId }, '[agent-session] joining in-flight session creation');
      return inflight;
    }

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
    const rawSessionId = agentId.startsWith('agent-') ? agentId.slice('agent-'.length) : agentId;
    const origin = createSessionOrigin(
      rawSessionId,
      agentType,
      identity?.principalId,
      identity?.displayName,
      identity?.colorSeed,
    );
    const undoOrigin = createUndoOrigin(rawSessionId, agentType);

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

    const um = new Y.UndoManager(
      [dc.document.getText('source'), dc.document.getMap('agent-flash')],
      {
        trackedOrigins: new Set([origin]),
        captureTimeout: 500,
        captureTransaction: (tr: { origin: unknown }) => tr.origin !== undoOrigin,
        ignoreRemoteMapChanges: true,
      },
    );

    const stampTime = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }): void => {
      stackItem.meta.set('time', Date.now());
    };
    um.on('stack-item-added', stampTime);
    um.on('stack-item-updated', stampTime);

    log.info(
      { docName, agentId, sessionId: rawSessionId },
      `[agent-session] Created session for: ${docName} / ${agentId}`,
    );

    return {
      dc,
      origin,
      undoOrigin,
      um,
      agentId,
      docName,
      lastUsedAt: Date.now(),
      bridgeLossReporter: this.bridgeLossReporter,
    };
  }

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

  hasSession(docName: string, agentId = 'claude-1'): boolean {
    return this.sessions.has(this.sessionKey(docName, agentId));
  }

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

  async closeSession(docName: string, agentId = 'claude-1'): Promise<void> {
    const key = this.sessionKey(docName, agentId);
    const session = this.sessions.get(key);
    if (!session) return;
    await this.cleanupSession(key, session, { docName, agentId });
    log.info({ docName, agentId }, `[agent-session] Closed session for: ${docName} / ${agentId}`);
  }

  async closeAllForAgent(agentId: string): Promise<void> {
    const suffix = `\0${agentId}`;

    const pendingKeys = [...this.pendingSessions.keys()].filter((k) => k.endsWith(suffix));
    if (pendingKeys.length > 0) {
      await Promise.allSettled(pendingKeys.map((k) => this.pendingSessions.get(k)));
    }

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

  async closeAllForDoc(docName: string): Promise<void> {
    const prefix = `${docName}\0`;
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(prefix));
    log.debug({ docName, closing: keys.length }, '[agent-session] closing all sessions for doc');
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { docName, key });
    }
  }

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
