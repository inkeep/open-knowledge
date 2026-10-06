import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { devNull } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';

export const GITHUB_HOST = 'github.com';

interface PresentedCredential {
  username: string;
  password: string;
}

interface GitHubStandInRequest {
  method: string;
  path: string;
  credential: PresentedCredential | null;
  status: number;
}

export interface GitHubStandIn {
  proxyUrl: string;
  caFile: string;
  requests: GitHubStandInRequest[];
  requestsTo: (host: string) => GitHubStandInRequest[];
  repositoryDir: (name: string, host?: string) => string;
  close: () => Promise<void>;
}

interface StandInHost {
  acceptedPasswords: string[];
  deniedPasswords: string[];
  repositoriesRoot: string;
  requests: GitHubStandInRequest[];
}

export interface PlainHttpInterceptor {
  proxyUrl: string;
  requests: Array<{ url: string; basicCredential: string | null }>;
  close: () => Promise<void>;
}

export async function startPlainHttpInterceptor(): Promise<PlainHttpInterceptor> {
  const requests: PlainHttpInterceptor['requests'] = [];
  const server = createHttpServer((req, res) => {
    const header = req.headers.authorization;
    requests.push({
      url: req.url ?? '',
      basicCredential:
        typeof header === 'string' && header.startsWith('Basic ')
          ? Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
          : null,
    });
    req.resume();
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => der(0x30, ...items);

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...arcs] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of arcs) {
    const encoded = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      encoded.unshift((rest % 128) | 0x80);
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

const ECDSA_WITH_SHA256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
const VALIDITY = sequence(
  der(0x17, Buffer.from('200101000000Z')),
  der(0x17, Buffer.from('491231235959Z')),
);
const CRITICAL = der(0x01, Buffer.from([0xff]));

function distinguishedName(commonName: string): Buffer {
  return sequence(
    der(0x31, sequence(objectIdentifier('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8')))),
  );
}

function certificateExtension(oid: string, critical: boolean, value: Buffer): Buffer {
  return sequence(objectIdentifier(oid), ...(critical ? [CRITICAL] : []), der(0x04, value));
}

function issueCertificate(options: {
  serial: number;
  issuer: string;
  subject: string;
  subjectKey: KeyObject;
  signingKey: KeyObject;
  extensions: Buffer[];
}): Buffer {
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([options.serial])),
    ECDSA_WITH_SHA256,
    distinguishedName(options.issuer),
    VALIDITY,
    distinguishedName(options.subject),
    options.subjectKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(...options.extensions)),
  );
  const signature = sign('sha256', toBeSigned, options.signingKey);
  return sequence(toBeSigned, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0x00]), signature));
}

function certificatePem(certificate: Buffer): string {
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function throwawayGitHubCertificates(hosts: string[]): {
  caPem: string;
  serverKeyPem: string;
  serverCertPem: string;
} {
  const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const authorityName = 'Open Knowledge publish test authority';
  const authorityCertificate = issueCertificate({
    serial: 1,
    issuer: authorityName,
    subject: authorityName,
    subjectKey: authority.publicKey,
    signingKey: authority.privateKey,
    extensions: [
      certificateExtension('2.5.29.19', true, sequence(CRITICAL)),
      certificateExtension('2.5.29.15', true, der(0x03, Buffer.from([0x01, 0x06]))),
    ],
  });
  const serverCertificate = issueCertificate({
    serial: 2,
    issuer: authorityName,
    subject: GITHUB_HOST,
    subjectKey: server.publicKey,
    signingKey: authority.privateKey,
    extensions: [
      certificateExtension(
        '2.5.29.17',
        false,
        sequence(...hosts.map((host) => der(0x82, Buffer.from(host)))),
      ),
      certificateExtension('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))),
      certificateExtension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
    ],
  });
  return {
    caPem: certificatePem(authorityCertificate),
    serverKeyPem: String(server.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    serverCertPem: certificatePem(serverCertificate),
  };
}

function presentedCredential(header: string | undefined): PresentedCredential | null {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return { username: decoded, password: '' };
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function hermeticGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
  };
}

function serveThroughHttpBackend(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  user: string,
  repositoriesRoot: string,
  settle: (status: number) => void,
  onPhase?: (phase: string) => void,
): void {
  const env: Record<string, string> = {
    ...hermeticGitEnv(repositoriesRoot),
    GIT_PROJECT_ROOT: repositoriesRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    REQUEST_METHOD: req.method ?? 'GET',
    CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
    REMOTE_USER: user,
    REMOTE_ADDR: '127.0.0.1',
  };
  for (const [header, variable] of [
    ['content-length', 'CONTENT_LENGTH'],
    ['content-encoding', 'HTTP_CONTENT_ENCODING'],
    ['git-protocol', 'GIT_PROTOCOL'],
  ] as const) {
    const value = req.headers[header];
    if (typeof value === 'string') env[variable] = value;
  }
  onPhase?.('backend:start');
  const backend = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  backend.stdin.once('finish', () => onPhase?.('backend:stdin-finished'));
  backend.once('exit', () => onPhase?.('backend:exited'));
  backend.stdout.once('end', () => onPhase?.('backend:stdout-ended'));
  req.pipe(backend.stdin);
  let pending = Buffer.alloc(0);
  let headersSent = false;
  backend.stdout.on('data', (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf('\r\n\r\n');
    if (end === -1) return;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of pending.subarray(0, end).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    headersSent = true;
    settle(status);
    const body = pending.subarray(end + 4);
    if (body.length > 0) res.write(body);
  });
  backend.on('close', () => {
    onPhase?.('backend:closed');
    if (!headersSent) {
      settle(500);
      res.writeHead(500);
    }
    res.end();
  });
}

export async function startGitHubStandIn(options: {
  root: string;
  acceptedPassword: string;
  deniedPassword?: string;
  repositories: string[];
  enterpriseHosts?: Record<string, string[]>;
  onPhase?: (phase: string, requestId?: number) => void;
}): Promise<GitHubStandIn> {
  const hosts = new Map<string, StandInHost>();
  for (const [host, acceptedPasswords] of [
    [GITHUB_HOST, [options.acceptedPassword]],
    ...Object.entries(options.enterpriseHosts ?? {}),
  ] as Array<[string, string[]]>) {
    hosts.set(host, {
      acceptedPasswords,
      deniedPasswords:
        host === GITHUB_HOST && options.deniedPassword !== undefined
          ? [options.deniedPassword]
          : [],
      repositoriesRoot: join(options.root, 'repositories', host),
      requests: [],
    });
  }
  const served = (host: string): StandInHost => {
    const standInHost = hosts.get(host);
    if (standInHost === undefined) throw new Error(`the GitHub stand-in does not serve ${host}`);
    return standInHost;
  };
  const gitExecPath = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
    env: hermeticGitEnv(options.root),
  }).trim();
  if (
    !['git-http-backend', 'git-http-backend.exe'].some((name) =>
      existsSync(join(gitExecPath, name)),
    )
  ) {
    throw new Error(
      `git http-backend is not installed in ${gitExecPath}; the GitHub stand-in serves pushes through it`,
    );
  }
  for (const { repositoriesRoot } of hosts.values()) {
    for (const name of options.repositories) {
      const repository = join(repositoriesRoot, name);
      mkdirSync(repository, { recursive: true });
      execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', repository], {
        env: hermeticGitEnv(repositoriesRoot),
      });
      configureTestGitRepository(repository);
    }
  }
  const certificates = throwawayGitHubCertificates([...hosts.keys()]);
  const caFile = join(options.root, 'github-stand-in-ca.pem');
  writeFileSync(caFile, certificates.caPem, 'utf8');

  let requestId = 0;
  const tlsServer = createHttpsServer(
    { key: certificates.serverKeyPem, cert: certificates.serverCertPem },
    (req, res) => {
      const id = ++requestId;
      const phase = (stage: string) => options.onPhase?.(stage, id);
      phase('request:received');
      req.once('end', () => phase('request:ended'));
      res.once('finish', () => phase('response:finished'));
      res.once('close', () => phase('response:closed'));
      const host = String(req.headers.host ?? '')
        .replace(/:\d+$/, '')
        .toLowerCase();
      const standInHost = hosts.get(host);
      if (standInHost === undefined) {
        req.resume();
        res.writeHead(421);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `https://${host}`);
      const credential = presentedCredential(req.headers.authorization);
      const request: GitHubStandInRequest = {
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        credential,
        status: 0,
      };
      standInHost.requests.push(request);
      if (credential !== null && standInHost.deniedPasswords.includes(credential.password)) {
        request.status = 403;
        req.resume();
        res.writeHead(403);
        res.end();
        return;
      }
      if (credential === null || !standInHost.acceptedPasswords.includes(credential.password)) {
        request.status = 401;
        req.resume();
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
        res.end();
        return;
      }
      serveThroughHttpBackend(
        req,
        res,
        url,
        credential.username,
        standInHost.repositoriesRoot,
        (status) => {
          request.status = status;
        },
        phase,
      );
    },
  );
  tlsServer.on('secureConnection', () => options.onPhase?.('tls:ready'));
  const proxy = createHttpServer((req, res) => {
    req.resume();
    res.writeHead(403);
    res.end();
  });
  proxy.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    options.onPhase?.('proxy:connected');
    const target = (req.url ?? '').toLowerCase();
    if (!/:\d+$/.test(target) || !hosts.has(target.replace(/:\d+$/, ''))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    tlsServer.emit('connection', socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    caFile,
    requests: served(GITHUB_HOST).requests,
    requestsTo: (host) => served(host).requests,
    repositoryDir: (name, host = GITHUB_HOST) => join(served(host).repositoriesRoot, name),
    close: () =>
      new Promise<void>((resolve) => {
        tlsServer.closeAllConnections();
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}
