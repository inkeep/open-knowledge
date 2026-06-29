
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export { wait };

import { HocuspocusProvider } from '@hocuspocus/provider';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import {
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  type InvariantViolation,
  MarkdownManager,
  normalizeBridge,
  prependFrontmatter,
  ServerInfoSuccessSchema,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';

export { type BridgeInvariantViolation, BridgeInvariantViolationError, type InvariantViolation };

import {
  ConfigSchema,
  createMcpHttpHandler,
  createServer,
  ensureProjectGit,
  getLogger,
  isPairedWriteOrigin,
  mountMcpAndApi,
  OBSERVER_SYNC_ORIGIN,
  type ServerInstance,
  type ServerOptions,
} from '@inkeep/open-knowledge-server';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  ORIGIN_TEXT_TO_TREE,
  ORIGIN_TREE_TO_TEXT,
  setupObservers,
} from '../../src/editor/observers';
import type { ProviderPool } from '../../src/editor/provider-pool';
import { dispatchCC1Stateless, SYSTEM_DOC_NAME } from '../../src/lib/cc1';
import { createSyncedReconnectGate, refreshServerInfo } from '../../src/lib/server-info-refresh';
import { ControllableWebSocket } from './network-control';


export const mdManager = new MarkdownManager({ extensions: sharedExtensions });
export const schema = getSchema(sharedExtensions);

export const HARNESS_BOOT_TIMEOUT_MS = 30_000;


async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}


export interface TestServer {
  port: number;
  baseUrl: string;
  wsUrl: string;
  contentDir: string;
  instance: ServerInstance;
  cleanup: () => Promise<void>;
}

export interface CreateTestServerOptions {
  debounce?: ServerOptions['debounce'];
  maxDebounce?: ServerOptions['maxDebounce'];
  /** Reuse an existing content directory (for server-restart tests that need
   *  persistence to load canonical state written by a prior test-server instance).
   *  When provided, the caller owns directory lifecycle — cleanup() will not
   *  rm the directory. Pair with `keepContentDir: true` across all servers
   *  sharing this directory. */
  contentDir?: string;
  /** When true, `cleanup()` skips the `rmSync(contentDir)` so the directory
   *  survives for a subsequent test-server instance. Defaults to false
   *  (random-tmpdir behavior preserved). */
  keepContentDir?: boolean;
  keepaliveGraceMs?: number;
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  localOpCliArgs?: string[];
  configHomedirOverride?: string;
  ephemeral?: boolean;
  projectDir?: string;
  singleDocRelPath?: string;
  mdManager?: MarkdownManager;
}

export async function createTestServer(options: CreateTestServerOptions = {}): Promise<TestServer> {
  const ephemeral = options.ephemeral ?? false;

  const contentDir =
    options.contentDir !== undefined
      ? realpathSync(options.contentDir)
      : realpathSync(mkdtempSync(join(tmpdir(), 'ok-test-')));
  const ownedHomeDir =
    options.configHomedirOverride === undefined
      ? realpathSync(mkdtempSync(join(tmpdir(), 'ok-test-home-')))
      : null;
  const homeOverride = options.configHomedirOverride ?? (ownedHomeDir as string);

  const createdProjectDir = ephemeral && options.projectDir === undefined;
  const projectDir = ephemeral
    ? realpathSync(options.projectDir ?? mkdtempSync(join(tmpdir(), 'ok-ephemeral-test-')))
    : contentDir;

  if (!ephemeral) {
    if (options.contentDir === undefined) {
      writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
    }

    if (options.contentDir === undefined) {
      mkdirSync(join(contentDir, '.ok'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'config.yml'), '', 'utf-8');
    }

    await ensureProjectGit(contentDir);
  }

  const port = await getFreePort();
  const srv = createServer({
    contentDir,
    projectDir,
    quiet: true,
    debounce: options.debounce ?? 200,
    maxDebounce: options.maxDebounce ?? 1000,
    gitEnabled: ephemeral ? false : (options.gitEnabled ?? false),
    commitDebounceMs: options.commitDebounceMs ?? 200,
    contentRoot: options.gitEnabled === true ? '.' : undefined,
    enableTestRoutes: true,
    localOpCliArgs: options.localOpCliArgs,
    configHomedirOverride: homeOverride,
    mdManager: options.mdManager,
    ...(ephemeral ? { ephemeral: true, singleDocRelPath: options.singleDocRelPath } : {}),
    skipStateManifestCheck: true,
  });

  await srv.ready;

  const mcpHttpHandler = ephemeral
    ? undefined
    : createMcpHttpHandler({
        contentDir,
        projectDir: contentDir,
        config: ConfigSchema.parse({}),
        getServerUrl: () => `http://127.0.0.1:${port}`,
      });

  const httpServer = createHttpServer();
  const mount = mountMcpAndApi({
    httpServer,
    hocuspocus: srv.hocuspocus,
    mcpHttpHandler,
    log: getLogger('test-harness'),
    sessionManager: srv.sessionManager,
    agentFocusBroadcaster: srv.agentFocusBroadcaster,
    agentPresenceBroadcaster: srv.agentPresenceBroadcaster,
    keepaliveGraceMs: options.keepaliveGraceMs,
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => {
      httpServer.off('error', onErr);
      reject(err);
    };
    httpServer.once('error', onErr);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', onErr);
      resolve();
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    contentDir,
    instance: srv,
    cleanup: async () => {
      await mount.shutdown();
      await mcpHttpHandler?.close();
      await srv.destroy();
      mount.wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (createdProjectDir) {
        rmSync(projectDir, { recursive: true, force: true });
      }
      if (!options.keepContentDir) {
        rmSync(contentDir, { recursive: true, force: true });
      }
      if (ownedHomeDir !== null) {
        rmSync(ownedHomeDir, { recursive: true, force: true });
      }
    },
  };
}


export interface TestClient {
  doc: Y.Doc;
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  provider: HocuspocusProvider;
  cleanup: () => Promise<void>;
  docName: string;
  pauseSync: () => void;
  resumeSync: () => void;
}

export interface CreateTestClientOptions {
  /** Skip attaching the bridge invariant watcher. Use for tests that
   *  deliberately drive divergence (e.g., Bug-D skip-guarded test). */
  skipInvariantWatcher?: boolean;
  syncControl?: boolean;
}

export async function createTestClient(
  port: number,
  docName?: string,
  options?: CreateTestClientOptions,
): Promise<TestClient> {
  const resolvedDocName = docName ?? `test-${crypto.randomUUID()}`;

  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');

  let controllableWs: ControllableWebSocket | undefined;
  const providerOpts: Record<string, unknown> = {
    url: `ws://127.0.0.1:${port}/collab`,
    name: resolvedDocName,
    document: doc,
    connect: true,
  };
  if (options?.syncControl) {
    providerOpts.WebSocketPolyfill = class extends ControllableWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        controllableWs = this;
      }
    };
  }

  const provider = new HocuspocusProvider(
    providerOpts as ConstructorParameters<typeof HocuspocusProvider>[0],
  );

  await waitForSync(provider);

  const observerCleanup = setupObservers({
    doc,
    xmlFragment: fragment,
    ytext,
    mdManager,
    schema,
  });

  const watcherDetach = options?.skipInvariantWatcher
    ? undefined
    : attachBridgeInvariantWatcher(doc);

  return {
    doc,
    ytext,
    fragment,
    provider,
    docName: resolvedDocName,
    pauseSync: () => {
      if (!controllableWs) throw new Error('pauseSync requires syncControl: true');
      controllableWs.pauseInbound();
    },
    resumeSync: () => {
      if (!controllableWs) throw new Error('resumeSync requires syncControl: true');
      controllableWs.resumeInbound();
    },
    cleanup: async () => {
      watcherDetach?.();
      observerCleanup();
      try {
        await testReset(port, resolvedDocName);
      } catch {
      }
      provider.destroy();
      doc.destroy();
    },
  };
}

export function waitForSync(provider: HocuspocusProvider, timeoutMs = 10_000): Promise<void> {
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

export async function resetFakeIndexedDB(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs.map((info) => {
      if (info.name === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(info.name as string);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }),
  );
}

export async function seedClientPersistenceState(
  docName: string,
  updates: Uint8Array[],
  serverInstanceId: string,
  branch: string = 'main',
): Promise<void> {
  const { createClientPersistence } = await import('../../src/editor/client-persistence');
  const doc = new Y.Doc();
  const persistence = createClientPersistence({ branch, serverInstanceId, docName, doc });
  try {
    await persistence.whenSynced;
    for (const update of updates) {
      Y.applyUpdate(doc, update);
    }
    await wait(0);
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}

export async function assertIDBEmpty(
  docName: string,
  serverInstanceId: string,
  branch: string = 'main',
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
  const dbs = await indexedDB.databases();
  const info = dbs.find((d) => d.name === dbName);
  if (info === undefined) return;

  const count = await new Promise<number>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('updates')) {
        db.close();
        resolve(0);
        return;
      }
      try {
        const tx = db.transaction('updates', 'readonly');
        const store = tx.objectStore('updates');
        const countReq = store.count();
        countReq.onsuccess = () => {
          db.close();
          resolve(countReq.result);
        };
        countReq.onerror = () => {
          db.close();
          reject(countReq.error);
        };
      } catch (err) {
        db.close();
        if ((err as Error)?.name === 'NotFoundError') {
          resolve(0);
          return;
        }
        reject(err);
      }
    };
  });

  if (count !== 0) {
    throw new Error(`assertIDBEmpty: expected ${dbName} to have 0 updates, found ${count}`);
  }
}

export async function awaitDocQuiescence(
  doc: Y.Doc,
  opts?: { timeoutMs?: number; idleTicks?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const idleTicks = Math.max(2, opts?.idleTicks ?? 2);

  let dirty = false;
  const markDirty = (): void => {
    dirty = true;
  };
  doc.on('afterAllTransactions', markDirty);
  try {
    const start = Date.now();
    let consecutiveIdle = 0;
    while (Date.now() - start < timeoutMs) {
      if (dirty) {
        dirty = false;
        consecutiveIdle = 0;
      } else {
        consecutiveIdle++;
        if (consecutiveIdle >= idleTicks) return;
      }
      await wait(0);
    }
    throw new Error(`awaitDocQuiescence: doc did not settle within ${timeoutMs} ms`);
  } finally {
    doc.off('afterAllTransactions', markDirty);
  }
}

export function serializeFragment(fragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

export function stripTrailingWhitespace(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

/** Assert bridge invariant: normalized Y.Text === serialized XmlFragment.
 * Normalization includes NG1: blank-line count between blocks may normalize
 * (ProseMirror schema limitation). Collapse 3+ consecutive newlines to 2. */
export function assertBridgeInvariant(ytext: Y.Text, fragment: Y.XmlFragment): void {
  const textNorm = normalizeBridge(ytext.toString());
  const fragNorm = normalizeBridge(serializeFragment(fragment));
  if (textNorm !== fragNorm) {
    throw new Error(
      `Bridge invariant violated.\n` +
        `  Y.Text (${textNorm.length} chars): ${textNorm.slice(0, 200)}...\n` +
        `  Fragment (${fragNorm.length} chars): ${fragNorm.slice(0, 200)}...`,
    );
  }
}


export type FinalStateOutcome =
  | { outcome: 'converged-late' }
  | { outcome: 'stalled'; detail: string };

export function classifyFinalState(
  clients: ReadonlyArray<Pick<TestClient, 'ytext' | 'fragment'>>,
): FinalStateOutcome {
  const finalYtexts = clients.map((c) => c.ytext.toString());
  const finalFragMds = clients.map((c) => serializeFragment(c.fragment));
  const peersIdentical =
    finalYtexts.every((t) => t === finalYtexts[0]) &&
    finalFragMds.every((m) => m === finalFragMds[0]);
  if (!peersIdentical) {
    return { outcome: 'stalled', detail: 'peers diverged at budget exhaustion' };
  }
  for (const c of clients) {
    try {
      assertBridgeInvariant(c.ytext, c.fragment);
    } catch (err) {
      return {
        outcome: 'stalled',
        detail: `bridge invariant beyond tolerance at budget exhaustion: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      };
    }
  }
  return { outcome: 'converged-late' };
}

export function readTestDoc(contentDir: string, docName = 'test-doc'): string {
  try {
    return readFileSync(join(contentDir, `${docName}.md`), 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

export async function agentWriteMd(
  port: number,
  markdown: string,
  opts?: {
    docName?: string;
    position?: 'append' | 'prepend' | 'replace';
    agentId?: string;
    agentName?: string;
    clientName?: string;
    colorSeed?: string;
  },
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown,
      position: opts?.position ?? 'append',
      docName: opts?.docName,
      agentId: opts?.agentId,
      agentName: opts?.agentName,
      clientName: opts?.clientName,
      colorSeed: opts?.colorSeed,
    }),
  });
  if (!res.ok) {
    const err: Error & { status?: number } = new Error(`agent-write-md failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

/** POST to agent-patch endpoint (find-and-replace).
 *
 * Post-D22 the wire shape is RFC 9457 Problem Details on errors — read
 * `body.title` for the human-readable string. The helper preserves the
 * `error` field name on its return shape so existing callers stay
 * source-stable; the value is sourced from `body.title` (RFC 9457) with
 * a legacy `body.error` fallback for any not-yet-migrated handler.
 */
export async function agentPatch(
  port: number,
  find: string,
  replace: string,
  docName?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ find, replace, docName }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { title?: string; error?: string };
    return { ok: false, status: res.status, error: body.title ?? body.error ?? 'unknown' };
  }
  return { ok: true };
}

export async function agentUndo(
  port: number,
  opts: { docName?: string; connectionId: string; scope?: 'last' | 'session' },
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: opts.docName,
      connectionId: opts.connectionId,
      scope: opts.scope ?? 'last',
    }),
  });
  if (!res.ok) throw new Error(`agent-undo failed: ${res.status}`);
}

export async function testReset(port: number, docName?: string): Promise<void> {
  const url = docName
    ? `http://127.0.0.1:${port}/api/test-reset?docName=${encodeURIComponent(docName)}`
    : `http://127.0.0.1:${port}/api/test-reset`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`test-reset failed: ${res.status}`);
}

export async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await wait(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

export async function awaitFileWatcherIndexed(
  server: TestServer,
  docPath: string,
  timeoutMs = 45_000,
  rescueAfterMs = 2_000,
): Promise<void> {
  const start = Date.now();
  let lastStatus = 0;
  let lastBodyPreview = '';
  let rescueTriggered = false;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch((err) => {
      lastStatus = -1;
      lastBodyPreview = `fetch error: ${String(err).slice(0, 80)}`;
      return null;
    });
    if (res?.ok) {
      lastStatus = res.status;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      lastBodyPreview = `ok, docs=${data.documents?.length ?? 0}`;
      if (data.documents?.some((d) => d.docName === docPath)) {
        return;
      }
    } else if (res) {
      lastStatus = res.status;
      lastBodyPreview = `non-ok status`;
    }
    if (!rescueTriggered && Date.now() - start >= rescueAfterMs) {
      rescueTriggered = true;
      await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`, {
        method: 'POST',
      }).catch(() => null);
    }
    await wait(50);
  }
  throw new Error(
    `awaitFileWatcherIndexed: ${docPath} not indexed within ${timeoutMs}ms (last status=${lastStatus}, ${lastBodyPreview}, rescueTriggered=${rescueTriggered})`,
  );
}

export async function awaitBacklinkIndexed(
  server: TestServer,
  targetDocName: string,
  sourceDocName: string,
  timeoutMs = 30_000,
  rescueAfterMs = 2_000,
): Promise<void> {
  const start = Date.now();
  let lastStatus = 0;
  let rescueTriggered = false;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/backlinks?docName=${encodeURIComponent(targetDocName)}`,
    ).catch(() => null);
    if (res?.ok) {
      lastStatus = res.status;
      const data = (await res.json()) as {
        backlinks?: Array<{ source: string }>;
      };
      if (data.backlinks?.some((b) => b.source === sourceDocName)) return;
    } else if (res) {
      lastStatus = res.status;
    }
    if (!rescueTriggered && Date.now() - start >= rescueAfterMs) {
      rescueTriggered = true;
      await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-backlinks`, {
        method: 'POST',
      }).catch(() => null);
    }
    await wait(50);
  }
  throw new Error(
    `awaitBacklinkIndexed: ${sourceDocName} → ${targetDocName} not indexed within ${timeoutMs}ms (last status=${lastStatus}, rescueTriggered=${rescueTriggered})`,
  );
}

export async function awaitWipCommits(
  server: TestServer,
  docName: string,
  count: number,
  timeoutMs = 20_000,
): Promise<string[]> {
  const intervals = [100, 250, 500, 1000];
  let attempt = 0;
  let lastShas: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const flushRes = await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, {
      method: 'POST',
    }).catch((err: unknown) => {
      console.warn(
        `[awaitWipCommits] test-flush-git fetch threw: ${String(err)} - continuing poll`,
      );
      return null;
    });
    if (flushRes !== null && !flushRes.ok) {
      console.warn(
        `[awaitWipCommits] test-flush-git returned ${flushRes.status} - continuing poll`,
      );
    }
    const r = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=${encodeURIComponent(docName)}`,
    ).catch(() => null);
    if (r?.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        entries?: Array<{ sha?: string; type?: string }>;
      };
      lastShas = (body.entries ?? [])
        .filter((e) => e.type === 'wip' && /^[0-9a-f]{40}$/i.test(e.sha ?? ''))
        .map((e) => e.sha as string);
      if (lastShas.length >= count) return lastShas;
    }
    await wait(intervals[Math.min(attempt++, intervals.length - 1)]);
  }
  throw new Error(
    `awaitWipCommits: doc ${docName} reached ${lastShas.length}/${count} WIP commits within ${timeoutMs}ms`,
  );
}


export type ServerDocState = {
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  md: string;
  fullMd: string;
  frontmatter: string;
  metaMap: Y.Map<unknown>;
  activityMap: Y.Map<unknown>;
  connectionCount: number;
};

export function getServerState(server: TestServer, docName: string): ServerDocState | null {
  const document = server.instance.hocuspocus.documents.get(docName);
  if (!document) return null;

  const ytext = document.getText('source');
  const fragment = document.getXmlFragment('default');
  const metaMap = document.getMap('metadata');
  const activityMap = document.getMap('agent-flash');
  const frontmatter = stripFrontmatter(ytext.toString()).frontmatter;
  const md = mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
  const fullMd = prependFrontmatter(frontmatter, md);
  const connectionCount = document.getConnectionsCount?.() ?? 0;

  return {
    ytext,
    fragment,
    md,
    fullMd,
    frontmatter,
    metaMap,
    activityMap,
    connectionCount,
  };
}


const BRIDGE_ENFORCING_NON_PAIRED_ORIGINS: Set<LocalTransactionOrigin> = new Set([
  ORIGIN_TREE_TO_TEXT,
  ORIGIN_TEXT_TO_TREE,
  OBSERVER_SYNC_ORIGIN,
]);


export function attachBridgeInvariantWatcher(
  doc: Y.Doc,
  opts: {
    onViolation?: (info: InvariantViolation) => void;
    /** Extra non-paired origins to enforce on in addition to the defaults.
     *  Paired origins (context.paired === true) are always covered by the
     *  structural isPairedWriteOrigin check and do not need to be listed. */
    enforcingOrigins?: Set<unknown>;
  } = {},
): () => void {
  const fragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const extraNonPaired = opts.enforcingOrigins;

  const afterAll = (_doc: Y.Doc, transactions: Array<Y.Transaction>): void => {
    let enforcingTx: Y.Transaction | undefined;
    for (const tx of transactions) {
      const shouldEnforce =
        isPairedWriteOrigin(tx.origin) ||
        BRIDGE_ENFORCING_NON_PAIRED_ORIGINS.has(tx.origin as LocalTransactionOrigin) ||
        extraNonPaired?.has(tx.origin);
      if (shouldEnforce) {
        enforcingTx = tx;
        break;
      }
    }
    if (!enforcingTx) return;

    const ytextStr = ytext.toString();
    const fm = stripFrontmatter(ytextStr).frontmatter;
    const fragBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON(),
    );
    const fragMd = prependFrontmatter(fm, fragBody);

    const ytextNorm = normalizeBridge(ytextStr);
    const fragNorm = normalizeBridge(fragMd);

    if (ytextNorm === fragNorm) return;

    const info: InvariantViolation = {
      site: 'test-harness',
      origin: enforcingTx.origin,
      ytextSnapshot: ytextStr,
      fragmentMdSnapshot: fragMd,
      unifiedDiff: `  ytext: ${ytextNorm.slice(0, 300)}\n  frag:  ${fragNorm.slice(0, 300)}`,
      stack: new Error().stack,
    };
    opts.onViolation?.(info);
    throw new BridgeInvariantViolationError(info);
  };

  doc.on('afterAllTransactions', afterAll);
  return () => {
    doc.off('afterAllTransactions', afterAll);
  };
}


export interface ItemOriginProbe {
  recordCapture(label?: string): void;
  assertCaptureIntact(label?: string): void;
  capturedContent(): string;
  undoStackLength(): number;
  /** Origins observed at capture time via `'stack-item-added'` events.
   *  Returns the set of distinct tx.origin values the UM has tracked.
   *  Empty if no items have been captured yet. */
  getCapturedOrigins(): ReadonlySet<unknown>;
  /** Assert that every captured origin is in the `trackedOrigins` set
   *  provided at construction. Throws if a stray origin appears — which
   *  would indicate origin-laundering (a non-tracked origin's Items ended
   *  up in the UM stack, e.g., user content under a different session's origin).
   *
   *  Safe to call when no items have been captured (silently returns).
   *  Call AFTER convergence, not mid-sequence — the UM may legitimately
   *  capture items from a tracked origin that hasn't fully settled yet. */
  assertOnlyTrackedOrigins(): void;
  cleanup(): void;
}

export function createItemOriginProbe(
  ytext: Y.Text,
  opts: { trackedOrigins: Array<LocalTransactionOrigin>; captureTimeout?: number },
): ItemOriginProbe {
  const trackedSet = new Set(opts.trackedOrigins);
  const um = new Y.UndoManager(ytext, {
    trackedOrigins: trackedSet,
    captureTimeout: opts.captureTimeout ?? 0,
  });
  const captures = new Map<string, { stackLength: number; content: string }>();

  const capturedOrigins = new Set<unknown>();
  const onStackItemAdded = (event: { origin: unknown }) => {
    capturedOrigins.add(event.origin);
  };
  um.on('stack-item-added', onStackItemAdded);

  return {
    recordCapture(label = 'default') {
      captures.set(label, {
        stackLength: um.undoStack.length,
        content: ytext.toString(),
      });
    },
    assertCaptureIntact(label = 'default') {
      const cap = captures.get(label);
      if (!cap) throw new Error(`No capture recorded for label: ${label}`);
      if (um.undoStack.length < cap.stackLength) {
        throw new Error(
          `Origin probe: tracked Items disappeared from UM stack. ` +
            `Expected >=${cap.stackLength}, got ${um.undoStack.length}.`,
        );
      }
    },
    capturedContent: () => ytext.toString(),
    undoStackLength: () => um.undoStack.length,
    getCapturedOrigins: () => capturedOrigins,
    assertOnlyTrackedOrigins() {
      for (const origin of capturedOrigins) {
        if (!trackedSet.has(origin as LocalTransactionOrigin)) {
          const originLabel =
            typeof origin === 'object' && origin !== null && 'context' in origin
              ? ((origin as { context?: { origin?: string } }).context?.origin ?? 'unknown-object')
              : String(origin);
          throw new Error(
            `Origin probe: captured a stray origin '${originLabel}' not in trackedOrigins set. ` +
              `This indicates origin-laundering — Items under an untracked origin ended up ` +
              `in the UM stack. trackedOrigins: [${opts.trackedOrigins.map((o) => (o as { context?: { origin?: string } }).context?.origin ?? '?').join(', ')}]`,
          );
        }
      }
    },
    cleanup() {
      um.off('stack-item-added', onStackItemAdded);
      um.destroy();
    },
  };
}


export class ClientConvergenceError extends Error {
  constructor(details: string) {
    super(`Client convergence timed out.\n${details}`);
    this.name = 'ClientConvergenceError';
  }
}

export async function createTestClients(
  port: number,
  opts: { count: number; docName?: string; perClientOptions?: CreateTestClientOptions },
): Promise<TestClient[]> {
  const docName = opts.docName ?? `test-${crypto.randomUUID()}`;
  const clients: TestClient[] = [];
  for (let i = 0; i < opts.count; i++) {
    clients.push(await createTestClient(port, docName, opts.perClientOptions));
  }
  return clients;
}

export async function assertAllConverged(
  clients: TestClient[],
  opts: { timeout?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 2000;
  const pollMs = opts.pollIntervalMs ?? 50;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ytexts = clients.map((c) => c.ytext.toString());
    const fragMds = clients.map((c) => serializeFragment(c.fragment));
    const allYtextSame = ytexts.every((t) => t === ytexts[0]);
    const allFragSame = fragMds.every((m) => m === fragMds[0]);
    if (allYtextSame && allFragSame) {
      for (const c of clients) {
        assertBridgeInvariant(c.ytext, c.fragment);
      }
      return;
    }
    await wait(pollMs);
  }
  const details = clients
    .map(
      (c, i) =>
        `  Client ${i} (${c.docName}):\n` +
        `    ytext (${c.ytext.toString().length}): ${c.ytext.toString().slice(0, 200)}\n` +
        `    frag  (${serializeFragment(c.fragment).length}): ${serializeFragment(c.fragment).slice(0, 200)}`,
    )
    .join('\n');
  throw new ClientConvergenceError(details);
}


export interface RestartableServer {
  port: number;
  contentDir: string;
  instance: ServerInstance;
  killNetwork(): void;
  shutdown(): Promise<void>;
  killAndRestartOnSamePort(opts: { downtimeMs: number }): Promise<RestartableServer>;
}

export interface CreateRestartableServerOptions extends CreateTestServerOptions {
  port?: number;
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  _retired?: RestartableServer[];
}

export async function waitForPortFree(port: number, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once('error', (err) => {
        lastErr = err;
        resolve(false);
      });
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
    if (ok) return;
    await wait(50);
  }
  throw new Error(
    `waitForPortFree: port ${port} still bound after ${timeoutMs}ms; last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export async function createRestartableServer(
  options: CreateRestartableServerOptions = {},
): Promise<RestartableServer> {
  const contentDir =
    options.contentDir !== undefined
      ? realpathSync(options.contentDir)
      : realpathSync(mkdtempSync(join(tmpdir(), 'ok-restartable-')));

  if (options.contentDir === undefined) {
    writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  }

  await ensureProjectGit(contentDir);

  const port = options.port ?? (await getFreePort());
  const srv = createServer({
    contentDir,
    quiet: true,
    debounce: options.debounce ?? 200,
    maxDebounce: options.maxDebounce ?? 1000,
    gitEnabled: options.gitEnabled ?? false,
    enableTestRoutes: true,
    skipStateManifestCheck: true,
    ...(options.commitDebounceMs !== undefined
      ? { commitDebounceMs: options.commitDebounceMs }
      : {}),
  });

  await srv.ready;

  const sockets = new Set<Socket>();
  const httpServer = createHttpServer();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const mount = mountMcpAndApi({
    httpServer,
    hocuspocus: srv.hocuspocus,
    mcpHttpHandler: undefined,
    log: getLogger('restartable-server'),
    sessionManager: srv.sessionManager,
    agentFocusBroadcaster: srv.agentFocusBroadcaster,
    agentPresenceBroadcaster: srv.agentPresenceBroadcaster,
    keepaliveGraceMs: options.keepaliveGraceMs,
  });
  const wss = mount.wss;

  const listenWithRetry = async (): Promise<void> => {
    const deadline = Date.now() + 2500;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (err: Error): void => {
            httpServer.off('error', onErr);
            reject(err);
          };
          httpServer.once('error', onErr);
          httpServer.listen(port, '127.0.0.1', () => {
            httpServer.off('error', onErr);
            resolve();
          });
        });
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE') throw err;
        await wait(100);
      }
    }
    throw new Error(
      `createRestartableServer: could not bind port ${port} within 2500ms; last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  };
  await listenWithRetry();

  const retired: RestartableServer[] = [...(options._retired ?? [])];
  let networkKilled = false;

  const killNetwork = (): void => {
    if (networkKilled) return;
    networkKilled = true;
    void mount.shutdown();
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
      }
    }
    try {
      wss.close();
    } catch {
    }
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
      }
    }
    try {
      httpServer.close();
    } catch {
    }
  };

  const shutdown = async (): Promise<void> => {
    if (!networkKilled) killNetwork();
    await mount.shutdown();
    try {
      await srv.destroy();
    } catch (err) {
      console.warn('[restartable-server] srv.destroy() failed:', err);
    }
    for (const prev of retired) {
      try {
        await prev.shutdown();
      } catch {
      }
    }
    if (!options.keepContentDir) {
      rmSync(contentDir, { recursive: true, force: true });
    }
  };

  const handle: RestartableServer = {
    port,
    contentDir,
    instance: srv,
    killNetwork,
    shutdown,
    killAndRestartOnSamePort: async ({ downtimeMs }) => {
      killNetwork();
      await wait(downtimeMs);
      await waitForPortFree(port, Math.max(2500, downtimeMs + 500));
      return createRestartableServer({
        ...options,
        port,
        contentDir,
        keepContentDir: true, // the NEW handle's shutdown will rm the dir if the original caller wanted
        _retired: [handle, ...retired],
      });
    },
  };

  return handle;
}


interface SystemDocSubscriberHandle {
  dispose: () => Promise<void>;
}

export function attachSystemDocSubscriber(
  pool: ProviderPool,
  port: number,
): SystemDocSubscriberHandle {
  const url = `ws://127.0.0.1:${port}/collab`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url,
    name: SYSTEM_DOC_NAME,
    document: doc,
    onStateless: ({ payload }: { payload: string }) => {
      dispatchCC1Stateless(payload, {
        onServerInfo: (info) => {
          pool.setExpectedServerInstanceId(info.serverInstanceId);
          if (info.currentBranch !== undefined) {
            pool.setObservedBranch(info.currentBranch);
          }
        },
        onBranchSwitched: (p) => {
          pool.setObservedBranch(p.branch);
        },
        onDiskAck: (p) => {
          pool.observeDiskAck(p.docName, p.sv);
        },
      });
    },
  });

  const onReconnectSynced = createSyncedReconnectGate(() => {
    void refreshServerInfo(pool, baseUrl);
  });
  provider.on('synced', () => {
    onReconnectSynced();
  });

  return {
    dispose: async () => {
      provider.destroy();
      doc.destroy();
    },
  };
}


export function clientIdsInDoc(doc: Y.Doc): Set<number> {
  return new Set(doc.store.clients.keys());
}

export function itemCountsByClient(doc: Y.Doc): Map<number, number> {
  const out = new Map<number, number>();
  for (const [clientID, items] of doc.store.clients) {
    out.set(clientID, items.length);
  }
  return out;
}

export function compareClientIds(
  a: Y.Doc,
  b: Y.Doc,
): { both: Set<number>; onlyInA: Set<number>; onlyInB: Set<number> } {
  const aSet = clientIdsInDoc(a);
  const bSet = clientIdsInDoc(b);
  const both = new Set<number>();
  const onlyInA = new Set<number>();
  const onlyInB = new Set<number>();
  for (const id of aSet) (bSet.has(id) ? both : onlyInA).add(id);
  for (const id of bSet) if (!aSet.has(id)) onlyInB.add(id);
  return { both, onlyInA, onlyInB };
}

export function assertSameClientIds(doc: Y.Doc, expected: Set<number>, context?: string): void {
  const actual = clientIdsInDoc(doc);
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const prefix = context ? `[${context}] ` : '';
    throw new Error(
      `${prefix}clientID drift: expected ${[...expected].sort().join(',')} but got ${[...actual]
        .sort()
        .join(',')}. Missing: [${missing.join(',')}], Extra: [${extra.join(',')}]`,
    );
  }
}

export function assertNoClientIdDrift(
  client: TestClient,
  serverDoc: Y.Doc,
  context?: string,
): void {
  const { onlyInA, onlyInB } = compareClientIds(client.doc, serverDoc);
  if (onlyInA.size === 0 && onlyInB.size === 0) return;
  const prefix = context ? `[${context}] ` : '';
  throw new Error(
    `${prefix}clientID drift between client '${client.docName}' and server doc. ` +
      `client-only: [${[...onlyInA].join(',')}] | server-only: [${[...onlyInB].join(',')}]. ` +
      `Client total: ${client.doc.store.clients.size}. Server total: ${serverDoc.store.clients.size}.`,
  );
}


type ProviderPoolCtor = typeof import('../../src/editor/provider-pool').ProviderPool;

export interface MultiClientContext {
  pools: InstanceType<ProviderPoolCtor>[];
  docName: string;
  cleanup(): Promise<void>;
}

export async function createMultiClientContext(opts: {
  server: RestartableServer;
  docName: string;
  clientCount: number;
  recycleDebounceMs?: number;
}): Promise<MultiClientContext> {
  const { ProviderPool } = await import('../../src/editor/provider-pool');
  const wsUrl = `ws://127.0.0.1:${opts.server.port}/collab`;
  const pools: InstanceType<ProviderPoolCtor>[] = [];
  for (let i = 0; i < opts.clientCount; i++) {
    const pool = new ProviderPool(3, wsUrl, { recycleDebounceMs: opts.recycleDebounceMs });
    await seedPoolServerInstanceId(opts.server, pool);
    pool.open(opts.docName);
    pool.setActive(opts.docName);
    pools.push(pool);
  }
  await pollUntil(() => pools.every((p) => p.getActive()?.provider.isSynced === true), 10_000, 50);
  await pollUntil(
    () => pools.every((p) => p.getActive()?.provider.unsyncedChanges === 0),
    10_000,
    50,
  );

  return {
    pools,
    docName: opts.docName,
    cleanup: async () => {
      for (const pool of pools) {
        try {
          pool.dispose();
        } catch {
        }
      }
    },
  };
}

export async function seedPoolServerInstanceId(
  server: { port: number },
  pool: {
    setExpectedServerInstanceId: (id: string | null) => void;
  },
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/server-info`);
  if (!res.ok) {
    throw new Error(`seedPoolServerInstanceId: /api/server-info returned ${res.status}`);
  }
  const body = ServerInfoSuccessSchema.parse(await res.json());
  pool.setExpectedServerInstanceId(body.serverInstanceId);
  return body.serverInstanceId;
}

export async function pollDiskContentStable(
  filePath: string,
  predicate: (content: string) => boolean,
  opts: { timeoutMs?: number; settleMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const settleMs = opts.settleMs ?? 300;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const start = Date.now();
  let lastMatchAt: number | null = null;
  let lastContent = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (predicate(content)) {
        lastContent = content;
        if (lastMatchAt !== null && Date.now() - lastMatchAt >= settleMs) {
          return content;
        }
        if (lastMatchAt === null) lastMatchAt = Date.now();
      } else {
        lastMatchAt = null;
      }
    } catch {
      lastMatchAt = null;
    }
    await wait(pollIntervalMs);
  }
  throw new Error(
    `pollDiskContentStable: predicate never held for ${settleMs}ms within ${timeoutMs}ms budget on ${filePath}. Last content length: ${lastContent.length}`,
  );
}
