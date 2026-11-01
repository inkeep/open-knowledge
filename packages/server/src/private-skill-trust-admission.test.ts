import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { MessageType } from '@hocuspocus/server';
import { CONFIG_DOC_NAME_USER, okUserHomeDisplayPath } from '@inkeep/open-knowledge-core';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { parse } from 'yaml';
import * as Y from 'yjs';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import * as configFileWatcher from './config-file-watcher.ts';
import { getLogger } from './logger.ts';

const origin = 'https://skills.intranet.example:8443';
let root: string;
let file: string;
let server: BootedServer | undefined;
const sockets: WebSocket[] = [];
const docs: Y.Doc[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-trust-admission-'));
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.destroy();
  server = undefined;
  for (const doc of docs.splice(0)) doc.destroy();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function start(source = 'skills: {trustedPrivateOrigins: []}\nappearance: {theme: light}\n') {
  const home = join(root, 'home');
  file = resolveConfigPath('user', root, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  server = await bootCompositionRig(root, {
    configHomedirOverride: home,
    debounce: 1,
    maxDebounce: 2,
    serverRuntime: {
      port: undefined,
      bind: ['127.0.0.1'],
      externalUrl: 'http://remote.example',
      allowExternal: true,
      openBrowser: false,
      idleShutdown: 'off',
      loopbackOnly: true,
    },
  });
  return server;
}

async function client(headers: Record<string, string>) {
  if (!server) throw new Error('Expected composed server');
  const doc = new Y.Doc();
  docs.push(doc);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab`, { headers });
  sockets.push(ws);
  const ready = Promise.withResolvers<void>();
  let closed: { code?: number; reason: string } | undefined;
  const acknowledgements: boolean[] = [];
  function send(update: Uint8Array, type = 2) {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, CONFIG_DOC_NAME_USER);
    encoding.writeVarUint(encoder, MessageType.Sync);
    encoding.writeVarUint(encoder, type);
    encoding.writeVarUint8Array(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  }
  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
  });
  ws.on('message', (bytes) => {
    const decoder = decoding.createDecoder(new Uint8Array(bytes as Buffer));
    decoding.readVarString(decoder);
    const kind = decoding.readVarUint(decoder);
    if (kind === MessageType.Auth) {
      const status = decoding.readVarUint(decoder);
      if (status !== 2) {
        ready.reject(new Error('Expected authentication success'));
        return;
      }
      send(Y.encodeStateVector(doc), 0);
    } else if (kind === MessageType.Sync || kind === MessageType.SyncReply) {
      const type = decoding.readVarUint(decoder);
      const update = decoding.readVarUint8Array(decoder);
      if (type === 0) send(Y.encodeStateAsUpdate(doc, update), 1);
      else {
        Y.applyUpdate(doc, update);
        ready.resolve();
      }
    } else if (kind === MessageType.SyncStatus) {
      acknowledgements.push(decoding.readVarUint(decoder) === 1);
    } else if (kind === MessageType.CLOSE) {
      closed = { reason: decoding.readVarString(decoder) };
      ready.reject(new Error(closed.reason));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('error', ready.reject);
  const auth = encoding.createEncoder();
  encoding.writeVarString(auth, CONFIG_DOC_NAME_USER);
  encoding.writeVarUint(auth, MessageType.Auth);
  encoding.writeVarUint(auth, 0);
  encoding.writeVarString(auth, '');
  ws.send(encoding.toUint8Array(auth));
  await ready.promise;
  await viWait(() => expect(acknowledgements.length).toBeGreaterThan(0));
  return {
    doc,
    send,
    get closed() {
      return closed;
    },
    get acknowledgements() {
      return acknowledgements;
    },
    change(fn: (text: Y.Text) => void) {
      const vector = Y.encodeStateVector(doc);
      doc.transact(() => fn(doc.getText('source')));
      return Y.encodeStateAsUpdate(doc, vector);
    },
  };
}

async function viWait(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 10_000 });
}

const remoteHeaders = { Host: 'remote.example', Origin: 'http://remote.example' };
const localHeaders = { Host: 'localhost', Origin: 'http://localhost' };

test.each([1, 2])(
  'refuses new private approvals over the actual remote sync type %s',
  async (type) => {
    await start();
    const peer = await client(remoteHeaders);
    const update = peer.change((text) => {
      const start = text.toString().indexOf('[]');
      text.delete(start, 2);
      text.insert(start, `[${origin}]`);
    });
    const previous = peer.acknowledgements.length;
    peer.send(update, type);
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    if (peer.closed === undefined) {
      await viWait(() =>
        expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]),
      );
    }
    expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([]);
    expect(peer.closed?.reason).toContain('computer');
    expect(peer.closed?.reason).toContain(okUserHomeDisplayPath('global.yml'));
  },
);

test.each([1, 2])(
  'refuses collab approvals even for a local-looking client over sync type %s',
  async (type) => {
    await start();
    const peer = await client(localHeaders);
    const previous = peer.acknowledgements.length;
    peer.send(
      peer.change((text) => {
        const at = text.toString().indexOf('[]');
        text.delete(at, 2);
        text.insert(at, `[${origin}]`);
      }),
      type,
    );
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    if (peer.closed === undefined)
      await viWait(() =>
        expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]),
      );
    expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([]);
    expect(peer.closed?.reason).toContain('global.yml');
  },
);

test('native user-file approval wins over a stale collaboration settings save', async () => {
  let holdWatcher = false;
  const delayed: (() => void)[] = [];
  const original = configFileWatcher.startConfigFileWatcher;
  vi.spyOn(configFileWatcher, 'startConfigFileWatcher').mockImplementation((path, onChange) =>
    original(path, (content) => {
      if (path === file && holdWatcher) delayed.push(() => onChange(content));
      else onChange(content);
    }),
  );
  const booted = await start();
  const peer = await client(remoteHeaders);
  expect(peer.doc.getText('source').toString()).not.toContain(origin);
  const update = peer.change((text) => {
    const at = text.toString().indexOf('light');
    text.delete(at, 5);
    text.insert(at, 'dark');
  });
  const stored = Promise.withResolvers<void>();
  booted.serverInstance.hocuspocus.configuration.extensions.push({
    async afterStoreDocument({ documentName }) {
      if (documentName === CONFIG_DOC_NAME_USER) stored.resolve();
    },
  });
  holdWatcher = true;
  try {
    const result = await writeConfigPatch({
      cwd: root,
      scope: 'user',
      homedirOverride: join(root, 'home'),
      patch: { skills: { trustedPrivateOrigins: [origin] } },
    });
    expect(result.ok).toBe(true);
    expect(peer.doc.getText('source').toString()).not.toContain(origin);
    const previous = peer.acknowledgements.length;
    peer.send(update);
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    expect(peer.closed).toBeUndefined();
    expect(peer.acknowledgements.at(-1)).toBe(true);
    await stored.promise;
    expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]);
    expect(parse(readFileSync(file, 'utf8')).appearance.theme).toBe('light');
    await viWait(() => expect(peer.doc.getText('source').toString()).toContain(origin));
  } finally {
    holdWatcher = false;
    for (const apply of delayed) apply();
  }
});

test.each(['skills: [', 'skills: {'])(
  'allows unchanged malformed user-file handshakes and a repair without new trust: %s',
  async (source) => {
    await start(source);
    const warn = vi.spyOn(getLogger('server'), 'warn');
    const peer = await client(localHeaders);
    expect(peer.doc.getText('source').toString()).toBe(source);
    expect(peer.closed).toBeUndefined();
    const previous = peer.acknowledgements.length;
    peer.send(Y.encodeStateAsUpdate(peer.doc));
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    expect(peer.closed).toBeUndefined();
    expect(peer.acknowledgements.at(-1)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(
      warn.mock.calls.filter(
        ([event]) =>
          typeof event === 'object' &&
          event !== null &&
          'check' in event &&
          event.check === 'private-skill-trust',
      ),
    ).toHaveLength(0);
    peer.send(
      peer.change((text) => {
        text.delete(0, text.length);
        text.insert(0, 'skills: {trustedPrivateOrigins: []}\nappearance: {theme: dark}\n');
      }),
    );
    await viWait(() => expect(parse(readFileSync(file, 'utf8')).appearance.theme).toBe('dark'));
    expect(peer.closed).toBeUndefined();
  },
);

test.each(['skills: [', 'skills: {'])(
  'a malformed base cannot be repaired with a new private grant: %s',
  async (source) => {
    await start(source);
    const peer = await client(remoteHeaders);
    const previous = peer.acknowledgements.length;
    peer.send(
      peer.change((text) => {
        text.delete(0, text.length);
        text.insert(0, `skills: {trustedPrivateOrigins: [${origin}]}\n`);
      }),
    );
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    if (peer.closed === undefined) {
      await viWait(() =>
        expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]),
      );
    }
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(peer.closed?.reason).toContain(okUserHomeDisplayPath('global.yml'));
  },
);

test('a malformed base does not authorize a different malformed source', async () => {
  const source = 'skills: [';
  await start(source);
  const peer = await client(remoteHeaders);
  const previous = peer.acknowledgements.length;
  peer.send(
    peer.change((text) => {
      text.delete(0, text.length);
      text.insert(0, 'skills: {');
    }),
  );
  await viWait(() =>
    expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
  );
  expect(readFileSync(file, 'utf8')).toBe(source);
  expect(peer.closed?.reason).toContain('valid YAML');
});

test('grant refusals resolve the user-file display path at the time of refusal', async () => {
  await start();
  const peer = await client(remoteHeaders);
  vi.stubEnv('OK_CHANNEL', 'beta');
  peer.send(
    peer.change((text) => {
      const at = text.toString().indexOf('[]');
      text.delete(at, 2);
      text.insert(at, `[${origin}]`);
    }),
  );
  await viWait(() => expect(peer.closed).toBeDefined());
  expect(peer.closed?.reason).toContain('~/.ok-beta/global.yml');
});

test.each([{ Host: 'localhost' }, { ...localHeaders, Origin: 'file://' }])(
  'local-looking or desktop headers do not grant filesystem approval authority: %j',
  async (headers) => {
    await start();
    const peer = await client(headers),
      previous = peer.acknowledgements.length;
    peer.send(
      peer.change((text) => {
        const at = text.toString().indexOf('[]');
        text.delete(at, 2);
        text.insert(at, `[${origin}]`);
      }),
    );
    await viWait(() =>
      expect(peer.closed !== undefined || peer.acknowledgements.length > previous).toBe(true),
    );
    if (peer.closed === undefined)
      await viWait(() =>
        expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]),
      );
    expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([]);
  },
);

test('preserves remote revocation and unrelated settings edits', async () => {
  await start(`skills: {trustedPrivateOrigins: [${origin}]}\nappearance: {theme: light}\n`);
  const peer = await client(remoteHeaders);
  peer.send(
    peer.change((text) => {
      const at = text.toString().indexOf('light');
      text.delete(at, 5);
      text.insert(at, 'dark');
    }),
  );
  await viWait(() => expect(parse(readFileSync(file, 'utf8')).appearance.theme).toBe('dark'));
  peer.send(
    peer.change((text) => {
      const at = text.toString().indexOf(origin);
      text.delete(at, origin.length);
    }),
  );
  await viWait(() =>
    expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([]),
  );
  expect(peer.closed).toBeUndefined();
});

test('drains an owning connection queue and releases it after a rejected peer', async () => {
  await start();
  const remote = await client(remoteHeaders);
  const denied = remote.change((text) => {
    const at = text.toString().indexOf('[]');
    text.delete(at, 2);
    text.insert(at, `[${origin}]`);
  });
  remote.send(denied);
  remote.send(denied);
  await viWait(() => expect(remote.closed).toBeDefined());
  const local = await client(localHeaders);
  const theme = local.change((text) => {
    const at = text.toString().indexOf('light');
    text.delete(at, 5);
    text.insert(at, 'dark');
  });
  const following = local.change((text) => {
    text.insert(text.length, 'unrelated: fixture\n');
  });
  local.send(theme);
  local.send(following);
  await viWait(() =>
    expect(parse(readFileSync(file, 'utf8'))).toMatchObject({
      skills: { trustedPrivateOrigins: [] },
      appearance: { theme: 'dark' },
      unrelated: 'fixture',
    }),
  );
  expect(local.closed).toBeUndefined();
});

test('refuses a remote update whose missing dependencies could be completed later', async () => {
  await start();
  const remote = await client(remoteHeaders);
  const before = readFileSync(file, 'utf8');
  remote.change((text) => text.insert(text.length, 'unrelated: "'));
  const delayed = remote.change((text) => text.insert(text.length, 'fixture"\n'));
  remote.send(delayed);
  await viWait(() => expect(remote.closed).toBeDefined());
  expect(remote.closed?.reason).toContain('synchronized');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test.each(['grant', 'invalid-update'] as const)(
  'logs a bounded refusal class and a matching client reason for %s',
  async (mode) => {
    await start();
    const peer = await client(remoteHeaders);
    const warn = vi.spyOn(getLogger('server'), 'warn');
    const before = readFileSync(file, 'utf8');
    peer.send(
      mode === 'grant'
        ? peer.change((text) => {
            const at = text.toString().indexOf('[]');
            text.delete(at, 2);
            text.insert(at, `[${origin}]`);
          })
        : new Uint8Array([255, 255]),
    );
    await viWait(() => expect(peer.closed).toBeDefined());
    const records = warn.mock.calls.filter(
      ([event]) =>
        typeof event === 'object' &&
        event !== null &&
        'check' in event &&
        event.check === 'private-skill-trust',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual([
      expect.objectContaining({
        reason: 'config-doc-admission-denied',
        docName: CONFIG_DOC_NAME_USER,
        rejectionClass: mode === 'grant' ? 'new-private-origin' : 'invalid-update',
      }),
      '[auth-rejection] config-doc-admission-denied',
    ]);
    expect(peer.closed?.reason).toContain(mode === 'grant' ? 'global.yml' : 'serialized');
    expect(JSON.stringify(records)).not.toContain(origin);
    expect(readFileSync(file, 'utf8')).toBe(before);
  },
);

test.each(['skills: [', 'skills: *missing\n', '- fixture\n'])(
  'refuses invalid remote configuration without granting trust: %s',
  async (invalid) => {
    await start();
    const remote = await client(remoteHeaders);
    const before = readFileSync(file, 'utf8');
    remote.send(
      remote.change((text) => {
        text.delete(0, text.length);
        text.insert(0, invalid);
      }),
    );
    await viWait(() => expect(remote.closed).toBeDefined());
    expect(remote.closed?.reason).toContain('valid YAML');
    expect(readFileSync(file, 'utf8')).toBe(before);
  },
);

test.each([
  { Host: 'localhost', Origin: 'http://remote.example' },
  { ...localHeaders, 'X-Forwarded-For': '203.0.113.8' },
])('rejects new approvals with remote-origin or forwarded headers: %j', async (headers) => {
  await start();
  const peer = await client(headers);
  peer.send(
    peer.change((text) => {
      const at = text.toString().indexOf('[]');
      text.delete(at, 2);
      text.insert(at, `[${origin}]`);
    }),
  );
  await viWait(() => expect(peer.closed).toBeDefined());
  expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([]);
});

test('serializes concurrent remote YAML-alias edits before admission', async () => {
  const booted = await start('policy: &policy {trustedPrivateOrigins: []}\nskills: {}\n');
  const a = await client(remoteHeaders),
    b = await client(remoteHeaders);
  const updateA = a.change((text) => {
    const at = text.toString().indexOf('[]');
    text.delete(at, 2);
    text.insert(at, `[${origin}]`);
  });
  const updateB = b.change((text) => {
    const at = text.toString().indexOf('skills: {}') + 8;
    text.delete(at, 2);
    text.insert(at, '*policy');
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>();
  let messages = 0,
    passed = 0;
  const previousA = a.acknowledgements.length,
    previousB = b.acknowledgements.length;
  booted.serverInstance.hocuspocus.configuration.extensions.unshift({
    async beforeHandleMessage() {
      if (++messages === 2) second.resolve();
    },
  });
  booted.serverInstance.hocuspocus.configuration.extensions.push({
    async beforeSync({ type }) {
      if (type !== 2) return;
      if (++passed === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    a.send(updateA);
    await entered.promise;
    b.send(updateB);
    await second.promise;
    await setImmediate();
  } finally {
    release.resolve();
  }
  await viWait(() => {
    expect(a.closed !== undefined || a.acknowledgements.length > previousA).toBe(true);
    expect(b.closed !== undefined || b.acknowledgements.length > previousB).toBe(true);
  });
  if (a.closed === undefined && b.closed === undefined) {
    await viWait(() =>
      expect(parse(readFileSync(file, 'utf8')).skills.trustedPrivateOrigins).toEqual([origin]),
    );
  }
  expect(parse(readFileSync(file, 'utf8')).skills?.trustedPrivateOrigins ?? []).toEqual([]);
}, 30_000);
