import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { AGENT_BROWSER_MCP_PACKAGE } from './browser-mcp.ts';
import { withAcquisitionHome } from './package-acquisition.test-helper.ts';
import type { RegistryBinaryTarget } from './registry.ts';

type HeldArtifact =
  | 'npm-package'
  | 'npm-dependency'
  | 'browser-dependency'
  | 'wheel'
  | 'binary-archive';

export type HeldInstallRegistry = {
  home: string;
  npmPackage: string;
  uvxPackage: string;
  binaryTarget: RegistryBinaryTarget;
  requested: (artifact: HeldArtifact) => number;
  release: (artifact: HeldArtifact) => void;
  rearm: (artifact: HeldArtifact) => void;
  answerNotFound: (artifact: HeldArtifact) => void;
  publishBrowser: (published: boolean) => void;
};

const AGENT_NAME = 'ok-held-install-agent';
const DEPENDENCY_NAME = 'ok-held-install-dependency';
const BROWSER_DEPENDENCY_NAME = 'ok-held-install-browser-dependency';
const VERSION = '1.0.0';
const UNPINNED_BROWSER_VERSION = '0.0.1';
const PUBLISHED = '2020-01-01T00:00:00.000Z';
const WHEEL_FILE = `ok_held_install_agent-${VERSION}-py3-none-any.whl`;

const NODE_ACP_AGENT = `
const { spawn } = require('node:child_process');
const mcpServers = [];
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      for (const server of msg.params.mcpServers ?? []) {
        if (typeof server.command !== 'string') continue;
        const env = { ...process.env };
        for (const entry of server.env ?? []) env[entry.name] = entry.value;
        mcpServers.push(spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'ignore', 'ignore'] }));
      }
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'held-install-session' } });
    } else if (msg.id !== undefined && msg.method !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`;

const PYTHON_ACP_AGENT = `import json
import sys


def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if line.strip() == '':
            continue
        msg = json.loads(line)
        if 'id' not in msg or 'method' not in msg:
            continue
        if msg['method'] == 'initialize':
            result = {'protocolVersion': 1, 'agentCapabilities': {}}
        elif msg['method'] == 'session/new':
            result = {'sessionId': 'held-install-session'}
        else:
            result = {}
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}) + '\\n')
        sys.stdout.flush()
`;

function tarball(root: string, label: string, files: Record<string, string>, top: string): Buffer {
  const tree = join(root, label);
  for (const [path, body] of Object.entries(files)) {
    const target = join(tree, top, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body, { mode: 0o755 });
  }
  const archive = join(root, `${label}.tgz`);
  execFileSync('tar', ['-czf', archive, '-C', tree, top]);
  return readFileSync(archive);
}

async function wheel(): Promise<Buffer> {
  const distInfo = `ok_held_install_agent-${VERSION}.dist-info`;
  const files: Record<string, string> = {
    'ok_held_install_agent/__init__.py': PYTHON_ACP_AGENT,
    [`${distInfo}/METADATA`]: `Metadata-Version: 2.1\nName: ${AGENT_NAME}\nVersion: ${VERSION}\n`,
    [`${distInfo}/WHEEL`]:
      'Wheel-Version: 1.0\nGenerator: ok-held-install\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    [`${distInfo}/entry_points.txt`]: `[console_scripts]\n${AGENT_NAME} = ok_held_install_agent:main\n`,
  };
  const record = Object.entries(files).map(
    ([path, body]) =>
      `${path},sha256=${createHash('sha256').update(body).digest('base64url')},${Buffer.byteLength(body)}`,
  );
  files[`${distInfo}/RECORD`] = `${record.join('\n')}\n${distInfo}/RECORD,,\n`;
  const zip = new ZipFile();
  for (const [path, body] of Object.entries(files)) zip.addBuffer(Buffer.from(body), path);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function tarballPath(name: string, version: string): string {
  return `/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
}

function packument(
  host: string,
  name: string,
  bytes: Buffer,
  manifest: Record<string, unknown>,
  published: string,
  version: string = VERSION,
): string {
  return JSON.stringify({
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name,
        version,
        ...manifest,
        dist: {
          tarball: `http://${host}${tarballPath(name, version)}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      },
    },
    time: { [version]: published },
  });
}

export async function withHeldInstallRegistry(
  run: (registry: HeldInstallRegistry) => Promise<void>,
  {
    dependencyPublished = PUBLISHED,
    dependencyDeprecated,
  }: { dependencyPublished?: string; dependencyDeprecated?: string } = {},
): Promise<void> {
  await withAcquisitionHome(async (home) => {
    const sources = join(home, 'held-install-sources');
    const agentManifest = {
      bin: { [AGENT_NAME]: 'agent.js' },
      dependencies: { [DEPENDENCY_NAME]: VERSION },
    };
    const agentTarball = tarball(
      sources,
      'npm-agent',
      {
        'package.json': JSON.stringify({ name: AGENT_NAME, version: VERSION, ...agentManifest }),
        'agent.js': `#!/usr/bin/env node\n${NODE_ACP_AGENT}`,
      },
      'package',
    );
    const dependencyTarball = tarball(
      sources,
      'npm-dependency',
      {
        'package.json': JSON.stringify({ name: DEPENDENCY_NAME, version: VERSION }),
        'index.js': 'module.exports = 1;\n',
      },
      'package',
    );
    const browserAt = AGENT_BROWSER_MCP_PACKAGE.lastIndexOf('@');
    const browserName = AGENT_BROWSER_MCP_PACKAGE.slice(0, browserAt);
    const browserVersion = AGENT_BROWSER_MCP_PACKAGE.slice(browserAt + 1);
    let browserPublished = true;
    const browserManifest = {
      bin: { [browserName.slice(browserName.lastIndexOf('/') + 1)]: 'browser.js' },
      dependencies: { [BROWSER_DEPENDENCY_NAME]: VERSION },
    };
    const browserTarball = tarball(
      sources,
      'npm-browser',
      {
        'package.json': JSON.stringify({
          name: browserName,
          version: browserVersion,
          ...browserManifest,
        }),
        'browser.js':
          "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'started'), '');\nprocess.stdin.resume();\n",
      },
      'package',
    );
    const browserDependencyTarball = tarball(
      sources,
      'npm-browser-dependency',
      {
        'package.json': JSON.stringify({ name: BROWSER_DEPENDENCY_NAME, version: VERSION }),
        'index.js': 'module.exports = 1;\n',
      },
      'package',
    );
    const binaryArchive = tarball(
      sources,
      'binary',
      { 'bin/agent': `#!/usr/bin/env node\n${NODE_ACP_AGENT}` },
      'agent',
    );
    const wheelBytes = await wheel();

    const openers: Array<() => void> = [];
    const gate = (): { open: () => void; opened: Promise<void> } => {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      openers.push(open);
      return { open, opened };
    };
    const holds = new Map<
      HeldArtifact,
      {
        count: number;
        released: boolean;
        notFound: boolean;
        open: () => void;
        opened: Promise<void>;
      }
    >();
    for (const artifact of [
      'npm-package',
      'npm-dependency',
      'browser-dependency',
      'wheel',
      'binary-archive',
    ] as const) {
      holds.set(artifact, { count: 0, released: false, notFound: false, ...gate() });
    }
    const heldEntry = (artifact: HeldArtifact) => {
      const entry = holds.get(artifact);
      if (entry === undefined) throw new Error(`unknown held artifact ${artifact}`);
      return entry;
    };
    const release = (artifact: HeldArtifact): void => {
      const entry = heldEntry(artifact);
      entry.released = true;
      entry.open();
    };
    release('npm-package');

    const server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '/');
      const host = req.headers.host ?? '127.0.0.1';
      const send = (bytes: Buffer, contentType: string): void => {
        res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      };
      const sendHeld = (artifact: HeldArtifact, bytes: Buffer, contentType: string): void => {
        const entry = heldEntry(artifact);
        entry.count += 1;
        if (entry.notFound) {
          res.writeHead(404);
          res.end();
          return;
        }
        void entry.opened.then(() => send(bytes, contentType));
      };
      if (path === `/${AGENT_NAME}`) {
        send(
          Buffer.from(packument(host, AGENT_NAME, agentTarball, agentManifest, PUBLISHED)),
          'application/json',
        );
      } else if (path === `/${DEPENDENCY_NAME}`) {
        send(
          Buffer.from(
            packument(
              host,
              DEPENDENCY_NAME,
              dependencyTarball,
              dependencyDeprecated === undefined ? {} : { deprecated: dependencyDeprecated },
              dependencyPublished,
            ),
          ),
          'application/json',
        );
      } else if (path === `/${browserName}`) {
        send(
          Buffer.from(
            packument(
              host,
              browserName,
              browserTarball,
              browserManifest,
              PUBLISHED,
              browserPublished ? browserVersion : UNPINNED_BROWSER_VERSION,
            ),
          ),
          'application/json',
        );
      } else if (path === `/${BROWSER_DEPENDENCY_NAME}`) {
        send(
          Buffer.from(
            packument(host, BROWSER_DEPENDENCY_NAME, browserDependencyTarball, {}, PUBLISHED),
          ),
          'application/json',
        );
      } else if (path === tarballPath(browserName, browserVersion)) {
        send(browserTarball, 'application/octet-stream');
      } else if (path === tarballPath(BROWSER_DEPENDENCY_NAME, VERSION)) {
        sendHeld('browser-dependency', browserDependencyTarball, 'application/octet-stream');
      } else if (path === `/${AGENT_NAME}/-/${AGENT_NAME}-${VERSION}.tgz`) {
        sendHeld('npm-package', agentTarball, 'application/octet-stream');
      } else if (path === `/${DEPENDENCY_NAME}/-/${DEPENDENCY_NAME}-${VERSION}.tgz`) {
        sendHeld('npm-dependency', dependencyTarball, 'application/octet-stream');
      } else if (path === `/simple/${AGENT_NAME}/`) {
        send(
          Buffer.from(
            JSON.stringify({
              meta: { 'api-version': '1.1' },
              name: AGENT_NAME,
              versions: [VERSION],
              files: [
                {
                  filename: WHEEL_FILE,
                  url: `/files/${WHEEL_FILE}`,
                  hashes: { sha256: createHash('sha256').update(wheelBytes).digest('hex') },
                  'upload-time': PUBLISHED,
                  size: wheelBytes.length,
                },
              ],
            }),
          ),
          'application/vnd.pypi.simple.v1+json',
        );
      } else if (path === `/files/${WHEEL_FILE}`) {
        sendHeld('wheel', wheelBytes, 'application/octet-stream');
      } else if (path === '/binary/agent.tgz') {
        sendHeld('binary-archive', binaryArchive, 'application/gzip');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing port');
    const origin = `http://127.0.0.1:${address.port}`;
    process.env.npm_config_registry = `${origin}/`;
    process.env.npm_config_fetch_timeout = '120000';
    process.env.UV_OFFLINE = '0';
    process.env.UV_DEFAULT_INDEX = `${origin}/simple`;
    process.env.UV_HTTP_TIMEOUT = '120';

    try {
      await run({
        home,
        npmPackage: `${AGENT_NAME}@${VERSION}`,
        uvxPackage: `${AGENT_NAME}==${VERSION}`,
        binaryTarget: {
          archive: `${origin}/binary/agent.tgz`,
          sha256: createHash('sha256').update(binaryArchive).digest('hex'),
          cmd: './agent/bin/agent',
        },
        requested: (artifact) => heldEntry(artifact).count,
        release,
        rearm: (artifact) => {
          const entry = heldEntry(artifact);
          if (!entry.released) throw new Error(`${artifact} is still held`);
          Object.assign(entry, { released: false, ...gate() });
        },
        answerNotFound: (artifact) => {
          heldEntry(artifact).notFound = true;
        },
        publishBrowser: (published) => {
          browserPublished = published;
        },
      });
    } finally {
      for (const open of openers) open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
