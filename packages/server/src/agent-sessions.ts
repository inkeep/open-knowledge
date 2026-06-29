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
import type { PairedWriteOrigin } from './server-observers.ts';
import { setActiveSpanAttributes, withSpanSync } from './telemetry.ts';

export type { AgentWriteContentDivergence };

const log = getLogger('agent-sessions');

export interface AgentDirectConnection extends DirectConnection {
  document: Document;
}

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

export function applyAgentMarkdownWrite(
  document: Document,
  markdown: string,
  position: 'append' | 'prepend' | 'replace' | 'patch',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
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

    const { frontmatter: payloadFm, body: payloadBody } = stripFrontmatter(markdown);

    if ((position === 'append' || position === 'prepend') && payloadBody === '') {
      return;
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

    if (finalFm !== existingFm) {
      const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(finalFm));
      if (parsed.map === null) {
        throw new FrontmatterMalformedError({
          file: docNameToFile(document.name),
          parseError: parsed.parseError ?? 'unknown YAML parse error',
        });
      }
      recordFrontmatterEditSurface('mcp-write');
    }

    const newContent = prependFrontmatter(finalFm, newBody);
    if (position === 'replace') {
      replaceRawBody(document, newContent, embedResolver);
    } else {
      composeAndWriteRawBody(document, newContent, 'agent', embedResolver);
    }

    const actualYText = document.getText('source').toString();
    return evaluateContentDivergence(actualYText, newContent, position);
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

export function applyAgentUndo(
  session: SessionRecord,
  scope: 'last' | 'session',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
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
      const undone = applyAgentUndoInner(session, scope, embedResolver);
      setActiveSpanAttributes({ 'agent.undo_effective': undone });
      return undone;
    },
  );
}

function applyAgentUndoInner(
  session: SessionRecord,
  scope: 'last' | 'session',
  embedResolver?: {
    resolveEmbed: (basename: string, sourcePath: string) => string | null;
    sourcePath: string;
  },
): boolean {
  const { dc, um, undoOrigin } = session;
  const document = dc.document;

  let undone = false;
  document.transact(() => {
    if (scope === 'last') {
      if (um.undoStack.length === 0) return;
      um.undo();
      undone = true;
    } else {
      while (um.undoStack.length > 0) {
        um.undo();
        undone = true;
      }
    }
    deriveFragmentFromYtext(document, embedResolver);
  }, undoOrigin);

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
}

function createSessionOrigin(
  sessionId: string,
  agentType?: string,
  principalId?: string,
  displayName?: string,
  colorSeed?: string,
): PairedWriteOrigin {
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

export class AgentSessionCapacityError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Maximum agent session count reached (${limit})`);
    this.name = 'AgentSessionCapacityError';
    this.limit = limit;
  }
}

export class AgentSessionManager {
  private sessions = new Map<string, SessionRecord>();
  private pendingSessions = new Map<string, Promise<SessionRecord>>();
  private hocuspocus: Hocuspocus;
  private readonly maxSessions: number;

  constructor(hocuspocus: Hocuspocus, options: { maxSessions?: number } = {}) {
    this.hocuspocus = hocuspocus;
    this.maxSessions = options.maxSessions ?? MAX_AGENT_SESSIONS;
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
    return this.sessions.get(this.sessionKey(docName, agentId));
  }

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
    if (existing) return existing;

    const inflight = this.pendingSessions.get(key);
    if (inflight) return inflight;

    if (this.sessions.size + this.pendingSessions.size >= this.maxSessions) {
      throw new AgentSessionCapacityError(this.maxSessions);
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

    log.info({ docName, agentId }, `[agent-session] Created session for: ${docName} / ${agentId}`);

    return { dc, origin, undoOrigin, um, agentId, docName };
  }

  hasSession(docName: string, agentId = 'claude-1'): boolean {
    return this.sessions.has(this.sessionKey(docName, agentId));
  }

  private async cleanupSession(
    key: string,
    session: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
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
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { agentId, key });
    }
  }

  async closeAllForDoc(docName: string): Promise<void> {
    const prefix = `${docName}\0`;
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(prefix));
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
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      await this.cleanupSession(key, session, { key });
    }
  }
}
