import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createProxyServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveConfigPath, writeConfigPatch } from '../../config/write-config-patch.ts';
import { SkillDestinationPolicyError } from './errors.ts';
import { fetchWellKnownSkill, readWellKnownIndex } from './well-known.ts';

const home = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home.value,
}));

describe('website skill network admission', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const index = {
    basePath: '/.well-known/agent-skills',
    skills: [{ name: 'fixture', description: '', files: ['SKILL.md'] }],
  };

  function trust(origins: string[]): void {
    const file = resolveConfigPath('user', home.value, home.value);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ skills: { trustedPrivateOrigins: origins } }));
  }

  async function listener() {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    return {
      origin: `https://localhost:${address.port}`,
      port: address.port,
      get connections() {
        return connections;
      },
    };
  }

  function fetchFiles(origin: string) {
    return fetchWellKnownSkill(
      { kind: 'well-known', origin, skill: 'fixture' },
      { index, timeoutMs: 5000 },
    );
  }
  beforeEach(() => {
    home.value = mkdtempSync(join(tmpdir(), 'skill-host-policy-'));
  });
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    rmSync(home.value, { recursive: true, force: true });
  });

  test.each([
    '127.0.0.1',
    '2130706433',
    '0x7f000001',
    '[::1]',
    '10.0.0.1',
    '169.254.169.254',
    '[::ffff:127.0.0.1]',
  ])('rejects private IP spellings before fetch: %s', async (host) => {
    await expect(readWellKnownIndex(`https://${host}`, { timeoutMs: 1000 })).rejects.toThrow(
      /require public addresses/,
    );
  });

  test('rejects a hostname resolving to loopback before a TCP connection', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    await expect(
      readWellKnownIndex(`https://localhost:${address.port}`, { timeoutMs: 1000 }),
    ).rejects.toThrow(/require public addresses/);
    expect(connections).toBe(0);
  });

  test('admits only the exact approved origin including its nondefault port', async () => {
    const rig = await listener();
    trust([`https://localhost:${rig.port === 65535 ? 65534 : rig.port + 1}`]);
    await expect(fetchFiles(rig.origin)).rejects.toBeInstanceOf(SkillDestinationPolicyError);
    expect(rig.connections).toBe(0);
    trust([rig.origin]);
    await expect(fetchFiles(rig.origin)).rejects.not.toBeInstanceOf(SkillDestinationPolicyError);
    expect(rig.connections).toBeGreaterThan(0);
  });

  test('revoking trust blocks subsequent index and cached-index file requests without restarting', async () => {
    const rig = await listener();
    trust([rig.origin]);
    await expect(fetchFiles(rig.origin)).rejects.not.toBeInstanceOf(SkillDestinationPolicyError);
    const admitted = rig.connections;
    expect(admitted).toBeGreaterThan(0);
    trust([]);
    await expect(readWellKnownIndex(rig.origin)).rejects.toBeInstanceOf(
      SkillDestinationPolicyError,
    );
    await expect(fetchFiles(rig.origin)).rejects.toBeInstanceOf(SkillDestinationPolicyError);
    expect(rig.connections).toBe(admitted);
  });

  test('admits an exact trusted IP literal and blocks it again after revocation', async () => {
    const rig = await listener();
    const origin = `https://127.0.0.1:${rig.port}`;
    expect(
      (
        await writeConfigPatch({
          cwd: home.value,
          scope: 'user',
          homedirOverride: home.value,
          patch: { skills: { trustedPrivateOrigins: [origin] } },
          firstWriteHeader: null,
        })
      ).ok,
    ).toBe(true);
    await expect(fetchFiles(origin)).rejects.not.toBeInstanceOf(SkillDestinationPolicyError);
    const admitted = rig.connections;
    expect(admitted).toBeGreaterThan(0);
    trust([]);
    await expect(readWellKnownIndex(origin)).rejects.toBeInstanceOf(SkillDestinationPolicyError);
    await expect(fetchFiles(origin)).rejects.toBeInstanceOf(SkillDestinationPolicyError);
    expect(rig.connections).toBe(admitted);
  });

  test('reports the exact origin once and explains an unreadable trust configuration', async () => {
    const rig = await listener();
    const file = resolveConfigPath('user', home.value, home.value);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'skills: [');
    const failure = await readWellKnownIndex(rig.origin).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SkillDestinationPolicyError);
    if (!(failure instanceof Error)) throw new Error('Expected policy failure');
    expect(failure.message.split(rig.origin)).toHaveLength(2);
    expect(failure.message).toMatch(/user configuration.*errors/);
    expect(rig.connections).toBe(0);
  });

  test('keeps the runtime proxy dispatcher for approved origins but never for revoked origins', async () => {
    const previous = getGlobalDispatcher();
    async function proxyListener() {
      let tunnels = 0;
      const server = createProxyServer();
      server.on('connect', (_request, socket) => {
        tunnels++;
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected proxy listener');
      return {
        port: address.port,
        get tunnels() {
          return tunnels;
        },
      };
    }
    const control = await proxyListener();
    const denied = await proxyListener();
    const origin = `https://localhost:${control.port}`;
    const controlProxy = new ProxyAgent(`http://127.0.0.1:${control.port}`);
    const deniedProxy = new ProxyAgent(`http://127.0.0.1:${denied.port}`);
    try {
      setGlobalDispatcher(controlProxy);
      trust([origin]);
      await expect(fetchFiles(origin)).rejects.not.toBeInstanceOf(SkillDestinationPolicyError);
      expect(control.tunnels).toBeGreaterThan(0);
      trust([]);
      setGlobalDispatcher(deniedProxy);
      await expect(fetchFiles(origin)).rejects.toBeInstanceOf(SkillDestinationPolicyError);
      expect(denied.tunnels).toBe(0);
      trust([origin]);
      await expect(fetchFiles(origin)).rejects.not.toBeInstanceOf(SkillDestinationPolicyError);
      expect(denied.tunnels).toBeGreaterThan(0);
    } finally {
      setGlobalDispatcher(previous);
      await Promise.all([controlProxy.destroy(), deniedProxy.destroy()]);
    }
  });
});
