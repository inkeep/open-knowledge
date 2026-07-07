import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CONTRACT_VERSION,
  CC1BranchSwitchedPayloadSchema,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  CC1ConfigValidationRejectedPayloadSchema,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  SYSTEM_DOC_NAME,
} from '@inkeep/open-knowledge-core';
import {
  CC1Broadcaster,
  isConfigDoc,
  isLinkIndexExcludedDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

describe('isSystemDoc', () => {
  test('returns true for __system__', () => {
    expect(isSystemDoc('__system__')).toBe(true);
  });

  test('returns false for regular doc names', () => {
    expect(isSystemDoc('foo')).toBe(false);
    expect(isSystemDoc('__system__.md')).toBe(false);
    expect(isSystemDoc('')).toBe(false);
    expect(isSystemDoc('test-doc')).toBe(false);
  });

  test('returns false for config doc names', () => {
    // Predicates are disjoint by design — every callsite ORs them, never trades them.
    expect(isSystemDoc(CONFIG_DOC_NAME_PROJECT)).toBe(false);
    expect(isSystemDoc(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(false);
    expect(isSystemDoc(CONFIG_DOC_NAME_USER)).toBe(false);
    expect(isSystemDoc(CONFIG_DOC_NAME_OKIGNORE)).toBe(false);
  });

  test('SYSTEM_DOC_NAME matches expected value', () => {
    expect(SYSTEM_DOC_NAME).toBe('__system__');
  });

  test('CC1_CONTRACT_VERSION is 1', () => {
    expect(CC1_CONTRACT_VERSION).toBe(1);
  });
});

describe('isConfigDoc', () => {
  test('returns true for the well-known project config doc', () => {
    expect(isConfigDoc('__config__/project')).toBe(true);
    expect(isConfigDoc(CONFIG_DOC_NAME_PROJECT)).toBe(true);
  });

  test('returns true for the well-known user-global config doc', () => {
    expect(isConfigDoc('__user__/config.yml')).toBe(true);
    expect(isConfigDoc(CONFIG_DOC_NAME_USER)).toBe(true);
  });

  test('returns true for the well-known project-local config doc', () => {
    expect(isConfigDoc('__local__/project')).toBe(true);
    expect(isConfigDoc(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(true);
  });

  test('returns true for the well-known okignore config doc', () => {
    expect(isConfigDoc('__config__/okignore')).toBe(true);
    expect(isConfigDoc(CONFIG_DOC_NAME_OKIGNORE)).toBe(true);
  });

  test('returns false for system doc and regular content names', () => {
    expect(isConfigDoc(SYSTEM_DOC_NAME)).toBe(false);
    expect(isConfigDoc('notes/intro')).toBe(false);
    expect(isConfigDoc('')).toBe(false);
  });

  test('membership is exact — lookalikes do NOT match', () => {
    // STOP rule: the admission set is a public contract.
    // Substring matches and prefix variants are deliberately rejected.
    expect(isConfigDoc('__config__/project.md')).toBe(false);
    expect(isConfigDoc('__config__/user')).toBe(false);
    expect(isConfigDoc('__config__/')).toBe(false);
    expect(isConfigDoc('__user__/config.yml.md')).toBe(false);
    expect(isConfigDoc('__user__/auth.yml')).toBe(false);
    expect(isConfigDoc('a__config__/project')).toBe(false);
    expect(isConfigDoc('__local__/project.yml')).toBe(false);
    expect(isConfigDoc('__local__/')).toBe(false);
    expect(isConfigDoc('a__local__/project')).toBe(false);
    expect(isConfigDoc('__config__/okignore.md')).toBe(false);
    expect(isConfigDoc('__config__/okignore/')).toBe(false);
  });

  test('CONFIG_DOC_NAMES contains exactly the four well-known names', () => {
    expect([...CONFIG_DOC_NAMES].sort()).toEqual([
      '__config__/okignore',
      '__config__/project',
      '__local__/project',
      '__user__/config.yml',
    ]);
  });
});

describe('CC1Broadcaster', () => {
  let broadcaster: CC1Broadcaster;
  let broadcasts: string[];
  let mockDoc: { broadcastStateless: (p: string) => void; getConnectionsCount: () => number };
  let mockHocuspocus: { documents: Map<string, typeof mockDoc> };

  beforeEach(() => {
    resetMetrics();
    broadcasts = [];
    mockDoc = {
      broadcastStateless: (payload: string) => {
        broadcasts.push(payload);
      },
      getConnectionsCount: () => 2,
    };
    mockHocuspocus = {
      documents: new Map([[SYSTEM_DOC_NAME, mockDoc]]),
    };
    broadcaster = new CC1Broadcaster(mockHocuspocus as unknown as Hocuspocus);
  });

  afterEach(() => {
    broadcaster.destroy();
  });

  test('debounce collapses 10 rapid signal() calls into 1 broadcast', async () => {
    for (let i = 0; i < 10; i++) {
      broadcaster.signal('files');
    }
    await wait(150);
    expect(broadcasts).toHaveLength(1);
    const payload = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload).toEqual({ v: 1, ch: 'files', seq: 1 });
  });

  test('debounce per-channel independence', async () => {
    broadcaster.signal('files');
    await wait(50);
    broadcaster.signal('backlinks');
    await wait(70);

    // 'files' should have fired at ~100ms, 'backlinks' not yet
    expect(broadcasts).toHaveLength(1);
    const first = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(first.ch).toBe('files');

    await wait(50);
    // 'backlinks' should have fired by now (~120ms after its signal)
    expect(broadcasts).toHaveLength(2);
    const second = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[1]));
    expect(second.ch).toBe('backlinks');
    expect(second.seq).toBe(1);
  });

  test('seq monotonicity per channel', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.signal('files');
    await wait(120);
    broadcaster.signal('files');
    await wait(120);

    expect(broadcasts).toHaveLength(3);
    const seqs = broadcasts.map((b) => CC1DerivedViewPayloadSchema.parse(JSON.parse(b)).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('seq is independent per channel', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.signal('backlinks');
    await wait(120);
    broadcaster.signal('files');
    await wait(120);

    expect(broadcasts).toHaveLength(3);
    const payloads = broadcasts.map((b) => CC1DerivedViewPayloadSchema.parse(JSON.parse(b)));
    expect(payloads[0]).toEqual({ v: 1, ch: 'files', seq: 1 });
    expect(payloads[1]).toEqual({ v: 1, ch: 'backlinks', seq: 1 });
    expect(payloads[2]).toEqual({ v: 1, ch: 'files', seq: 2 });
  });

  test('graceful no-op when Document missing', async () => {
    mockHocuspocus.documents.clear();
    broadcaster.signal('files');
    await wait(150);
    expect(broadcasts).toHaveLength(0);
  });

  test('destroy clears pending timers', async () => {
    broadcaster.signal('files');
    broadcaster.destroy();
    await wait(150);
    expect(broadcasts).toHaveLength(0);
  });

  test('subscriberCount returns connection count', () => {
    expect(broadcaster.subscriberCount).toBe(2);
  });

  test('subscriberCount returns 0 when document missing', () => {
    mockHocuspocus.documents.clear();
    expect(broadcaster.subscriberCount).toBe(0);
  });

  test('metrics updated on broadcast', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.signal('files');
    await wait(120);
    broadcaster.signal('files');
    await wait(120);

    const m = getMetrics();
    expect(m.cc1BroadcastCount).toBe(3);
    expect(m.cc1LastSeq.files).toBe(3);
    expect(m.cc1SubscriberCount).toBe(2);
  });

  test('payload shape matches CC1 contract v1', async () => {
    broadcaster.signal('files');
    await wait(150);
    const payload = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload).toEqual({ v: 1, ch: 'files', seq: 1 });
    expect(Object.keys(payload).sort()).toEqual(['ch', 'seq', 'v']);
  });

  test('CC1_CHANNEL_BRANCH_SWITCHED exported as "branch-switched"', () => {
    expect(CC1_CHANNEL_BRANCH_SWITCHED).toBe('branch-switched');
  });

  test('emitBranchSwitched publishes payload with branch + seq=1 on first call', () => {
    broadcaster.emitBranchSwitched('main');
    expect(broadcasts).toHaveLength(1);
    const payload = CC1BranchSwitchedPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload).toEqual({
      v: 1,
      ch: CC1_CHANNEL_BRANCH_SWITCHED,
      seq: 1,
      branch: 'main',
    });
  });

  test('emitBranchSwitched emits synchronously — no debounce', () => {
    broadcaster.emitBranchSwitched('feature-x');
    // No wait — branch switches are discrete events, emit immediately.
    expect(broadcasts).toHaveLength(1);
  });

  test('emitBranchSwitched seq increments monotonically across calls', () => {
    broadcaster.emitBranchSwitched('main');
    broadcaster.emitBranchSwitched('feature-x');
    broadcaster.emitBranchSwitched('feature-y');
    expect(broadcasts).toHaveLength(3);
    const seqs = broadcasts.map((b) => CC1BranchSwitchedPayloadSchema.parse(JSON.parse(b)).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('emitBranchSwitched carries the supplied branch name', () => {
    broadcaster.emitBranchSwitched('main');
    broadcaster.emitBranchSwitched('detached-abc123');
    broadcaster.emitBranchSwitched('feature/user-auth');
    const branches = broadcasts.map(
      (b) => CC1BranchSwitchedPayloadSchema.parse(JSON.parse(b)).branch,
    );
    expect(branches).toEqual(['main', 'detached-abc123', 'feature/user-auth']);
  });

  test('emitBranchSwitched broadcasts on __system__ doc', () => {
    // Remove __system__ — emit must be a no-op (graceful degradation like signal()).
    mockHocuspocus.documents.clear();
    broadcaster.emitBranchSwitched('main');
    expect(broadcasts).toHaveLength(0);
  });

  test('emitBranchSwitched updates cc1LastSeq metric for branch-switched channel', () => {
    broadcaster.emitBranchSwitched('main');
    broadcaster.emitBranchSwitched('feature-x');
    const m = getMetrics();
    expect(m.cc1LastSeq[CC1_CHANNEL_BRANCH_SWITCHED]).toBe(2);
    expect(m.cc1BroadcastCount).toBe(2);
  });

  test('emitBranchSwitched seq independent from signal()-driven channels', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.emitBranchSwitched('main');
    broadcaster.signal('files');
    await wait(120);

    // First + third broadcasts are derived-view ('files'); second is branch-switched.
    const derived0 = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[0]));
    const branchSwitch = CC1BranchSwitchedPayloadSchema.parse(JSON.parse(broadcasts[1]));
    const derived2 = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[2]));
    expect(derived0).toMatchObject({ ch: 'files', seq: 1 });
    expect(branchSwitch).toMatchObject({ ch: CC1_CHANNEL_BRANCH_SWITCHED, seq: 1, branch: 'main' });
    expect(derived2).toMatchObject({ ch: 'files', seq: 2 });
  });

  test('emitDiskAck publishes payload with docName + base64 sv + seq=1 on first call', () => {
    const sv = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    broadcaster.emitDiskAck('notes/intro', sv);
    expect(broadcasts).toHaveLength(1);
    const payload = CC1DiskAckPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload).toEqual({
      v: 1,
      ch: CC1_CHANNEL_DISK_ACK,
      seq: 1,
      docName: 'notes/intro',
      sv: Buffer.from(sv).toString('base64'),
    });
  });

  test('emitDiskAck round-trips the state vector via base64', () => {
    // Realistic SV: encoded by Y.js, several bytes including high bytes.
    // The wire encoding (base64) must preserve byte-identity so the client's
    // `decodeStateVector(payload.sv)` reproduces the original Uint8Array.
    const sv = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x42, 0x10]);
    broadcaster.emitDiskAck('doc-a', sv);
    const payload = CC1DiskAckPayloadSchema.parse(JSON.parse(broadcasts[0]));
    const decoded = Buffer.from(payload.sv, 'base64');
    expect(new Uint8Array(decoded)).toEqual(sv);
  });

  test('emitDiskAck emits synchronously — no debounce', () => {
    broadcaster.emitDiskAck('doc-a', new Uint8Array([1, 2, 3]));
    // No wait — disk-ack tracks completed disk writes, emit immediately.
    expect(broadcasts).toHaveLength(1);
  });

  test('emitDiskAck seq increments monotonically across docs', () => {
    // Per-document is irrelevant to seq — the seq is per-channel for
    // observability uniformity, not for client-side ordering.
    broadcaster.emitDiskAck('doc-a', new Uint8Array([1]));
    broadcaster.emitDiskAck('doc-b', new Uint8Array([2]));
    broadcaster.emitDiskAck('doc-a', new Uint8Array([3]));
    expect(broadcasts).toHaveLength(3);
    const seqs = broadcasts.map((b) => CC1DiskAckPayloadSchema.parse(JSON.parse(b)).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('emitDiskAck graceful no-op when __system__ document missing', () => {
    mockHocuspocus.documents.clear();
    broadcaster.emitDiskAck('doc-a', new Uint8Array([1, 2, 3]));
    expect(broadcasts).toHaveLength(0);
  });

  test('emitDiskAck updates cc1LastSeq metric for disk-ack channel', () => {
    broadcaster.emitDiskAck('doc-a', new Uint8Array([1]));
    broadcaster.emitDiskAck('doc-b', new Uint8Array([2]));
    const m = getMetrics();
    expect(m.cc1LastSeq[CC1_CHANNEL_DISK_ACK]).toBe(2);
    expect(m.cc1BroadcastCount).toBe(2);
  });

  test('emitDiskAck seq independent from other channels', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.emitBranchSwitched('main');
    broadcaster.emitDiskAck('doc-a', new Uint8Array([1]));
    broadcaster.emitDiskAck('doc-b', new Uint8Array([2]));

    const ack1 = CC1DiskAckPayloadSchema.parse(JSON.parse(broadcasts[2]));
    const ack2 = CC1DiskAckPayloadSchema.parse(JSON.parse(broadcasts[3]));
    expect(ack1.seq).toBe(1);
    expect(ack2.seq).toBe(2);
  });

  test('getLatestDiskAckSVsAsBase64 returns empty object before any flush', () => {
    expect(broadcaster.getLatestDiskAckSVsAsBase64()).toEqual({});
  });

  test('getLatestDiskAckSVsAsBase64 returns the latest SV per docName', () => {
    broadcaster.emitDiskAck('notes/intro', new Uint8Array([0xde, 0xad]));
    broadcaster.emitDiskAck('notes/details', new Uint8Array([0xbe, 0xef]));
    const snapshot = broadcaster.getLatestDiskAckSVsAsBase64();
    expect(Object.keys(snapshot).sort()).toEqual(['notes/details', 'notes/intro']);
    expect(snapshot['notes/intro']).toBe(Buffer.from([0xde, 0xad]).toString('base64'));
    expect(snapshot['notes/details']).toBe(Buffer.from([0xbe, 0xef]).toString('base64'));
  });

  test('getLatestDiskAckSVsAsBase64 reflects the most recent emit per docName', () => {
    broadcaster.emitDiskAck('doc', new Uint8Array([0x01]));
    broadcaster.emitDiskAck('doc', new Uint8Array([0x01, 0x02]));
    broadcaster.emitDiskAck('doc', new Uint8Array([0x01, 0x02, 0x03]));
    const snapshot = broadcaster.getLatestDiskAckSVsAsBase64();
    expect(snapshot.doc).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'));
  });

  // Late-join recovery contract: the snapshot is the source of truth for
  // `__system__`-disconnected clients to refresh `lastDiskAckedSV` on
  // reconnect via `GET /api/server-info`. It MUST advance even when the
  // broadcast itself was dropped (no `__system__` subscribers, document
  // missing). Otherwise a client that reconnects after a brief drop
  // would receive a stale snapshot and the missed-frame bug recurs.
  test('getLatestDiskAckSVsAsBase64 advances even when broadcast is dropped (no __system__ subscribers)', () => {
    mockHocuspocus.documents.clear();
    broadcaster.emitDiskAck('doc', new Uint8Array([0xab, 0xcd]));
    expect(broadcasts).toHaveLength(0);
    const snapshot = broadcaster.getLatestDiskAckSVsAsBase64();
    expect(snapshot.doc).toBe(Buffer.from([0xab, 0xcd]).toString('base64'));
  });

  test('getLatestDiskAckSVsAsBase64 returns a fresh object each call (caller-owned)', () => {
    broadcaster.emitDiskAck('doc', new Uint8Array([0x01]));
    const snapshot1 = broadcaster.getLatestDiskAckSVsAsBase64();
    const snapshot2 = broadcaster.getLatestDiskAckSVsAsBase64();
    expect(snapshot1).not.toBe(snapshot2);
    expect(snapshot1).toEqual(snapshot2);
  });

  test('emitConfigValidationRejected publishes payload with docName, error, seq=1', () => {
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_PROJECT, {
      code: 'YAML_PARSE',
      detail: 'unexpected token at line 5',
    });
    expect(broadcasts).toHaveLength(1);
    const payload = CC1ConfigValidationRejectedPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload.v).toBe(1);
    expect(payload.ch).toBe(CC1_CHANNEL_CONFIG_VALIDATION_REJECTED);
    expect(payload.seq).toBe(1);
    expect(payload.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    expect(payload.error.code).toBe('YAML_PARSE');
  });

  test('emitConfigValidationRejected emits synchronously — no debounce', () => {
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_USER, {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['mcp', 'autoStart'],
          message: 'expected boolean, received string',
          issueCode: 'invalid_type',
        },
      ],
    });
    // No wait — rejections are discrete user-visible events, emit immediately.
    expect(broadcasts).toHaveLength(1);
  });

  test('emitConfigValidationRejected seq increments monotonically', () => {
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_PROJECT, {
      code: 'UNKNOWN',
      message: 'one',
    });
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_USER, {
      code: 'UNKNOWN',
      message: 'two',
    });
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_PROJECT, {
      code: 'UNKNOWN',
      message: 'three',
    });
    expect(broadcasts).toHaveLength(3);
    const seqs = broadcasts.map(
      (b) => CC1ConfigValidationRejectedPayloadSchema.parse(JSON.parse(b)).seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('emitConfigValidationRejected graceful no-op when __system__ document missing', () => {
    mockHocuspocus.documents.clear();
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_PROJECT, {
      code: 'YAML_PARSE',
      detail: 'oops',
    });
    expect(broadcasts).toHaveLength(0);
  });

  test('emitConfigValidationRejected serializes SCHEMA_INVALID issues array intact', () => {
    broadcaster.emitConfigValidationRejected(CONFIG_DOC_NAME_PROJECT, {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['mcp', 'tools', 'grep', 'maxResults'],
          message: 'expected number, received string',
          issueCode: 'invalid_type',
          source: { file: '/abs/config.yml', line: 5, column: 19, snippet: '> 5 |  ...' },
        },
      ],
    });
    const payload = CC1ConfigValidationRejectedPayloadSchema.parse(JSON.parse(broadcasts[0]));
    if (payload.error.code !== 'SCHEMA_INVALID') {
      throw new Error('expected SCHEMA_INVALID');
    }
    expect(payload.error.issues).toHaveLength(1);
    const issue = payload.error.issues[0];
    if (!issue) throw new Error('issue missing');
    expect(issue.path).toEqual(['mcp', 'tools', 'grep', 'maxResults']);
    expect(issue.source?.line).toBe(5);
  });

  test('emitConfigIgnoreNestedError publishes payload with path + error + seq=1', () => {
    broadcaster.emitConfigIgnoreNestedError(
      'subdir/.okignore',
      'failed to read nested ignore file',
    );
    expect(broadcasts).toHaveLength(1);
    const payload = CC1ConfigIgnoreNestedErrorPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload).toEqual({
      v: 1,
      ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
      seq: 1,
      path: 'subdir/.okignore',
      error: 'failed to read nested ignore file',
    });
  });

  test('emitConfigIgnoreNestedError emits synchronously — no debounce', () => {
    broadcaster.emitConfigIgnoreNestedError('a/.okignore', 'oops');
    expect(broadcasts).toHaveLength(1);
  });

  test('emitConfigIgnoreNestedError seq increments monotonically across calls', () => {
    broadcaster.emitConfigIgnoreNestedError('a/.okignore', 'one');
    broadcaster.emitConfigIgnoreNestedError('b/.okignore', 'two');
    broadcaster.emitConfigIgnoreNestedError('c/.okignore', 'three');
    expect(broadcasts).toHaveLength(3);
    const seqs = broadcasts.map(
      (b) => CC1ConfigIgnoreNestedErrorPayloadSchema.parse(JSON.parse(b)).seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('emitConfigIgnoreNestedError graceful no-op when __system__ document missing', () => {
    mockHocuspocus.documents.clear();
    broadcaster.emitConfigIgnoreNestedError('a/.okignore', 'oops');
    expect(broadcasts).toHaveLength(0);
  });

  test('emitConfigIgnoreNestedError seq independent from other channels', async () => {
    broadcaster.signal('files');
    await wait(120);
    broadcaster.emitConfigIgnoreNestedError('a/.okignore', 'first ignore error');
    broadcaster.emitConfigIgnoreNestedError('b/.okignore', 'second ignore error');

    expect(broadcasts).toHaveLength(3);
    // First broadcast is the derived-view 'files' channel; the next two are nested-error.
    const derived = CC1DerivedViewPayloadSchema.parse(JSON.parse(broadcasts[0]));
    const err1 = CC1ConfigIgnoreNestedErrorPayloadSchema.parse(JSON.parse(broadcasts[1]));
    const err2 = CC1ConfigIgnoreNestedErrorPayloadSchema.parse(JSON.parse(broadcasts[2]));
    expect(derived).toMatchObject({ ch: 'files', seq: 1 });
    expect(err1.seq).toBe(1);
    expect(err2.seq).toBe(2);
  });

  test('emitConfigIgnoreNestedError updates cc1LastSeq metric for the nested-error channel', () => {
    broadcaster.emitConfigIgnoreNestedError('a/.okignore', 'one');
    broadcaster.emitConfigIgnoreNestedError('b/.okignore', 'two');
    const m = getMetrics();
    expect(m.cc1LastSeq[CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR]).toBe(2);
    expect(m.cc1BroadcastCount).toBe(2);
  });

  test('emitConfigIgnoreNestedError carries the supplied path and error verbatim', () => {
    const path = 'deeply/nested/folder/.okignore';
    const error = 'EACCES: permission denied';
    broadcaster.emitConfigIgnoreNestedError(path, error);
    const payload = CC1ConfigIgnoreNestedErrorPayloadSchema.parse(JSON.parse(broadcasts[0]));
    expect(payload.path).toBe(path);
    expect(payload.error).toBe(error);
  });

  test('emitConfigIgnoreNestedError does NOT throw when payload is invalid (catches Zod parse errors)', () => {
    // Empty path violates schema's min(1) — emit must not throw, instead
    // logs and increments error metric. This validates the defense-in-depth
    // catch around the broadcast path: a malformed call site should not
    // crash the watcher's debounce-fire callback.
    expect(() => broadcaster.emitConfigIgnoreNestedError('', 'something broke')).not.toThrow();
    // The malformed payload was rejected by the schema, so no broadcast went out.
    expect(broadcasts).toHaveLength(0);
  });
});

describe('isLinkIndexExcludedDoc', () => {
  test('excludes system + config docs (never in the link index)', () => {
    expect(isLinkIndexExcludedDoc(SYSTEM_DOC_NAME)).toBe(true);
    for (const name of CONFIG_DOC_NAMES) {
      expect(isLinkIndexExcludedDoc(name)).toBe(true);
    }
  });

  test('admits managed-artifact docs — they participate in the link index', () => {
    // The two-axis split: isReservedForUserTree keeps skills/templates out of
    // the document TREE, but the link index admits them so their outgoing
    // links, backlinks, and tags resolve like documents.
    expect(isLinkIndexExcludedDoc('__skill__/project/my-skill')).toBe(false);
    expect(isLinkIndexExcludedDoc('__template__/docs/my-template')).toBe(false);
  });

  test('admits ordinary documents', () => {
    expect(isLinkIndexExcludedDoc('docs/getting-started')).toBe(false);
    expect(isLinkIndexExcludedDoc('readme')).toBe(false);
  });
});
