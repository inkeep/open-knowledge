import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProblemDetailsSchema, ValidationAuditResponseSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  AUDIT_EMPTY_SCOPE_WARNING,
  auditScopeNotFoundTitle,
} from '../../../server/src/lint/audit-scope.ts';
import { connectMcpTestClient } from '../../../server/src/mcp/client.test-helper.ts';
import * as singleFlight from '../../../server/src/single-flight.ts';
import {
  awaitBacklinkIndexed,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  type TestServer,
} from './test-harness.ts';

let server: TestServer;
let outsideDir: string;
let client: Awaited<ReturnType<typeof connectMcpTestClient>>;
let auditGate: Promise<void> | undefined;
const observedFlights: boolean[] = [];
let executedFlights = 0;
const createSingleFlight = singleFlight.createSingleFlight;
const flightObserver = vi.spyOn(singleFlight, 'createSingleFlight').mockImplementation(<T>() => {
  const flight = createSingleFlight<T>();
  const run = flight.run;
  flight.run = (key, fn) => {
    const gate = auditGate;
    const result = run(key, () => {
      if (gate !== undefined) executedFlights++;
      return gate === undefined ? fn() : gate.then(fn);
    });
    if (gate !== undefined) observedFlights.push(result.coalesced);
    return result;
  };
  return flight;
});

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-scope-http-')));
  const seeds = {
    '.ok/config.yml':
      'contentRules:\n  markdownlint:\n    enabled: true\n  okf:\n    enabled: true\n',
    '.gitignore': 'ignored/\nparity/ignored.txt\n',
    'guides/solo.md': '# Solo\n\nA\ttab.\n\nSee [[scope-solo-ghost]].\n',
    'guides/second.mdx': '# Second\n\nA\ttab.\n\nSee [[scope-second-ghost]].\n',
    'guides/dual.md': '# MD\n\nA\ttab.\n\nSee [[scope-md-ghost]].\n',
    'guides/dual.mdx': '# MDX\n\nA\ttab.\n\nSee [[scope-mdx-ghost]].\n',
    'folder.md/child.md': '# Child\n\nA\ttab.\n\nSee [[scope-child-ghost]].\n',
    'folder.md.mdx': '# Sibling\n\n\tA sibling.\n',
    'choice/child.md': '# Child\n\n\tA child.\n',
    'choice.mdx': '# Sibling\n\n\tA sibling.\n',
    plain: '# Plain\n\n\tA plain file.\n',
    'plain.mdx': '# Sibling\n\n\tA sibling.\n',
    'ignored/document.md': '# Ignored\n\n\tA tab.\n',
    '.hidden.md': '# Hidden\n\n\tA tab.\n',
    'live/dual.md': '# MD\n\nDisk\ttab.\n',
    'live/dual.mdx': '# MDX\n\nCanonical\tdisk tab.\n',
    'clean.md': '---\ntype: article\n---\n\n# Clean\n\nA clean paragraph.\n',
  };
  for (const [path, body] of Object.entries(seeds)) {
    mkdirSync(dirname(join(contentDir, path)), { recursive: true });
    writeFileSync(join(contentDir, path), body);
  }
  mkdirSync(join(contentDir, 'empty'));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-scope-outside-')));
  writeFileSync(join(outsideDir, 'secret.txt'), 'Private fixture.\n');
  symlinkSync(outsideDir, join(contentDir, 'escape'));
  symlinkSync(join(contentDir, 'loop'), join(contentDir, 'loop'));
  const parityBody = [
    '# Parity',
    '',
    '[[target]] [[parity-ghost]]',
    '[doc](./target.md) [missing doc](./missing.md)',
    '[file](./exists.txt) [missing file](./missing.txt)',
    '[ignored file](./ignored.txt) [ignored directory](../ignored/)',
    '[outside](./outside.txt) [folder](./folder/) [anchor](#parity)',
    '[escape](../../outside.txt)',
    '',
  ].join('\n');
  const paritySeeds = {
    'parity/plain.md': parityBody,
    'parity/dual.md': parityBody,
    'parity/dual.mdx': '# Canonical sibling\n',
    'parity/target.md': '# Target\n',
    'parity/exists.txt': 'Existing file.\n',
    'parity/ignored.txt': 'Ignored file.\n',
    'parity/folder/child.md': '# Child\n',
  };
  for (const [path, body] of Object.entries(paritySeeds)) {
    mkdirSync(dirname(join(contentDir, path)), { recursive: true });
    writeFileSync(join(contentDir, path), body);
  }
  symlinkSync(join(outsideDir, 'secret.txt'), join(contentDir, 'parity/outside.txt'));
  symlinkSync(join(contentDir, 'missing'), join(contentDir, 'dangling'));
  server = await createTestServer({ contentDir, debounce: 60_000, maxDebounce: 60_000 });
  client = await connectMcpTestClient(`${server.baseUrl}/mcp`);
  await awaitBacklinkIndexed(server, 'scope-solo-ghost', 'guides/solo', 5_000);
  await awaitBacklinkIndexed(server, 'scope-second-ghost', 'guides/second', 5_000);
  await awaitBacklinkIndexed(server, 'scope-child-ghost', 'folder.md/child', 5_000);
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.close();
  await server?.cleanup();
  flightObserver.mockRestore();
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
});

async function httpAudit(endpoint: string, path: string) {
  const response = await fetch(`${server.baseUrl}${endpoint}?path=${encodeURIComponent(path)}`);
  expect(response.status).toBe(200);
  return ValidationAuditResponseSchema.parse(await response.json());
}

function resultText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

describe('scope parity through HTTP and registered MCP tools', () => {
  test('concurrent physical and extensionless paths share one real audit flight', async () => {
    let release: () => void = () => {};
    auditGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    observedFlights.length = 0;
    executedFlights = 0;
    const requests = [
      httpAudit('/api/audit', 'guides/second.mdx'),
      httpAudit('/api/audit', 'guides/second'),
    ];
    try {
      await expect.poll(() => observedFlights.length).toBe(2);
      expect(executedFlights).toBe(1);
      expect(observedFlights).toEqual([false, true]);
    } finally {
      auditGate = undefined;
      release();
      const [explicit, extensionless] = await Promise.all(requests);
      expect(explicit).toEqual(extensionless);
      expect(explicit.files.map((file) => file.file)).toEqual(['guides/second.mdx']);
    }
  });

  test.each([
    ['guides/solo', 'guides/solo.md'],
    ['guides/second', 'guides/second.mdx'],
    ['guides/dual', 'guides/dual.mdx'],
  ])('resolves %s to %s across all selected validators', async (extensionless, explicit) => {
    for (const [name, endpoint] of [
      ['audit', '/api/audit'],
      ['lint', '/api/lint/audit'],
    ] as const) {
      const [short, full] = await Promise.all([
        httpAudit(endpoint, extensionless),
        httpAudit(endpoint, explicit),
      ]);
      expect(short).toEqual(full);
      expect(full.fileCount).toBe(1);
      if (name === 'audit' && explicit === 'guides/dual.mdx')
        expect(
          full.files[0]?.diagnostics.filter((d) => d.source === 'links').map((d) => d.linkTarget),
        ).toContain('scope-mdx-ghost');
      expect(full.files.map((file) => file.file)).toEqual([explicit]);
      expect(full.ran).toEqual(
        name === 'audit' ? ['markdownlint', 'okf', 'links'] : ['markdownlint', 'okf'],
      );
      expect(full.files[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'MD010')).toBe(
        true,
      );
      if (name === 'audit')
        expect(full.files[0]?.diagnostics.some((diagnostic) => diagnostic.source === 'links')).toBe(
          true,
        );
      for (const path of [extensionless, explicit]) {
        const result = await client.callTool({ name, arguments: { path } });
        expect(result.isError).toBeUndefined();
        expect(
          ValidationAuditResponseSchema.parse({ warnings: [], ...result.structuredContent }),
        ).toEqual(full);
      }
    }
    if (explicit === 'guides/dual.mdx') {
      const md = await httpAudit('/api/audit', 'guides/dual.md');
      expect(md.files.map((file) => file.file)).toEqual(['guides/dual.md']);
      expect(
        md.files[0]?.diagnostics.filter((d) => d.source === 'links').map((d) => d.linkTarget),
      ).toEqual(['scope-md-ghost']);
    }
  });

  test.each(['folder.md', 'choice', 'plain'])(
    'keeps the existing scope %s ahead of suffix candidates',
    async (path) => {
      for (const endpoint of ['/api/audit', '/api/lint/audit']) {
        const result = await httpAudit(endpoint, path);
        expect(result.fileCount).toBe(1);
        expect(result.files.map((file) => file.file)).toEqual([
          path === 'plain' ? path : `${path}/child.md`,
        ]);
        if (endpoint === '/api/audit' && path === 'folder.md') {
          expect(
            result.files[0]?.diagnostics.some((diagnostic) => diagnostic.source === 'links'),
          ).toBe(true);
        }
      }
    },
  );

  test.each(['missing', 'guides/second.md', 'dangling', 'plain/child'])(
    'returns a teaching not-found problem for %s through HTTP and MCP',
    async (path) => {
      for (const [name, endpoint] of [
        ['audit', '/api/audit'],
        ['lint', '/api/lint/audit'],
      ] as const) {
        const response = await fetch(
          `${server.baseUrl}${endpoint}?path=${encodeURIComponent(path)}`,
        );
        expect(response.status).toBe(404);
        expect(ProblemDetailsSchema.parse(await response.json())).toMatchObject({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: auditScopeNotFoundTitle(path),
        });
        const result = await client.callTool({ name, arguments: { path } });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain(auditScopeNotFoundTitle(path));
      }
    },
  );

  test.each(['empty', 'ignored'])(
    'reports informational zero coverage for %s without degradation wording',
    async (path) => {
      for (const [name, endpoint] of [
        ['audit', '/api/audit'],
        ['lint', '/api/lint/audit'],
      ] as const) {
        const body = await httpAudit(endpoint, path);
        expect(body).toMatchObject({
          files: [],
          fileCount: 0,
          errorCount: 0,
          warningCount: 0,
          warnings: [AUDIT_EMPTY_SCOPE_WARNING],
        });
        const result = await client.callTool({ name, arguments: { path } });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject(body);
        expect(resultText(result)).toContain('No documents were checked');
        expect(resultText(result)).not.toContain('could not fully complete');
        expect(resultText(result)).not.toContain('degraded');
      }
    },
  );

  test('preserves hidden, escape, invalid-path admission and the app doc fallback', async () => {
    for (const endpoint of ['/api/audit', '/api/lint/audit']) {
      for (const [path, warning] of [
        ['.hidden', 'hidden path segment'],
        ['.missing', 'hidden path segment'],
        ['.missing/leaf', 'hidden path segment'],
        ['escape', 'symlink-escape'],
        ['escape/secret.txt', 'symlink-escape'],
        ['escape/missing.txt', 'symlink-escape'],
        ['escape/missing/descendant.txt', 'symlink-escape'],
      ]) {
        const body = await httpAudit(endpoint, path);
        expect(body.fileCount).toBe(0);
        expect(body.files).toEqual([]);
        expect(body.errorCount).toBe(0);
        expect(body.warningCount).toBe(0);
        expect(body.ran).toEqual(endpoint === '/api/audit' ? ['links', 'okf'] : []);
        expect(body.warnings).toEqual([expect.stringContaining(warning)]);
      }
      const response = await fetch(`${server.baseUrl}${endpoint}?path=..%2Foutside`);
      expect(response.status).toBe(400);
    }
    const fallback = await fetch(`${server.baseUrl}/api/audit?doc=missing-app-document`);
    expect(fallback.status).toBe(200);
    expect(
      ValidationAuditResponseSchema.parse(await fallback.json()).warnings.length,
    ).toBeGreaterThan(0);
  });

  test.each(['overlong segment', 'symlink loop'])(
    'returns a teaching not-found problem for a %s through HTTP and MCP',
    async (kind) => {
      const path = kind === 'overlong segment' ? 'x'.repeat(300) : 'loop';
      for (const [name, endpoint] of [
        ['audit', '/api/audit'],
        ['lint', '/api/lint/audit'],
      ] as const) {
        const response = await fetch(
          `${server.baseUrl}${endpoint}?path=${encodeURIComponent(path)}`,
        );
        expect(response.status).toBe(404);
        expect(ProblemDetailsSchema.parse(await response.json())).toMatchObject({
          type: 'urn:ok:error:not-found',
          status: 404,
          title: auditScopeNotFoundTitle(path),
        });
        const result = await client.callTool({ name, arguments: { path } });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain(auditScopeNotFoundTitle(path));
      }
    },
  );

  test('checks an explicitly requested ignored file through HTTP and MCP', async () => {
    for (const [name, endpoint] of [
      ['audit', '/api/audit'],
      ['lint', '/api/lint/audit'],
    ] as const) {
      const path = 'ignored/document.md';
      const body = await httpAudit(endpoint, path);
      expect(body.fileCount).toBe(1);
      expect(body.files[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'MD010')).toBe(
        true,
      );
      expect(body.warnings).toEqual([]);
      const result = await client.callTool({ name, arguments: { path } });
      expect(result.isError).toBeUndefined();
      expect(
        ValidationAuditResponseSchema.parse({ warnings: [], ...result.structuredContent }),
      ).toEqual(body);
    }
  });

  test('physical sibling and indexed sources agree on link target admission', async () => {
    await awaitBacklinkIndexed(server, 'parity-ghost', 'parity/plain', 5_000);
    const indexed = await httpAudit('/api/audit', 'parity/plain.md');
    const physical = await httpAudit('/api/audit', 'parity/dual.md');
    const links = (body: typeof indexed) =>
      body.files.flatMap((file) =>
        file.diagnostics.filter((diagnostic) => diagnostic.source === 'links'),
      );
    expect(links(physical)).toEqual(links(indexed));
    const findings = JSON.stringify(links(physical));
    for (const target of ['parity-ghost', 'missing', 'ignored.txt', 'ignored/', 'outside.txt']) {
      expect(findings).toContain(target);
    }
    expect(findings).not.toContain('exists.txt');
    expect(findings).not.toContain('target.md');
    expect(findings).not.toContain('folder/');
  });

  test('lint and audit keep canonical live text separate from the alternate disk sibling', async () => {
    const connection = await server.instance.hocuspocus.openDirectConnection('live/dual');
    const live = '# Live\n\nClean unsaved text.\n';
    const mdPath = join(server.contentDir, 'live/dual.md');
    const mdxPath = join(server.contentDir, 'live/dual.mdx');
    const mdBefore = readFileSync(mdPath, 'utf8');
    const mdxBefore = readFileSync(mdxPath, 'utf8');
    try {
      await connection.transact((doc) => {
        const source = doc.getText('source');
        source.delete(0, source.length);
        source.insert(0, live);
      });
      for (const endpoint of ['/api/audit', '/api/lint/audit']) {
        const canonical = await httpAudit(endpoint, 'live/dual.mdx');
        const alternate = await httpAudit(endpoint, 'live/dual.md');
        expect(canonical.fileCount).toBe(1);
        expect(
          canonical.files.flatMap((file) => file.diagnostics).some((d) => d.code === 'MD010'),
        ).toBe(false);
        expect(alternate.fileCount).toBe(1);
        expect(
          alternate.files
            .find((file) => file.file === 'live/dual.md')
            ?.diagnostics.some((d) => d.code === 'MD010'),
        ).toBe(true);
        expect(readFileSync(mdPath, 'utf8')).toBe(mdBefore);
        expect(readFileSync(mdxPath, 'utf8')).toBe(mdxBefore);
      }
    } finally {
      await connection.disconnect();
    }
  });

  test('keeps clean nonempty scopes distinct from zero coverage', async () => {
    for (const name of ['audit', 'lint']) {
      const result = await client.callTool({ name, arguments: { path: 'clean.md' } });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        files: [],
        fileCount: 1,
        errorCount: 0,
        warningCount: 0,
      });
      expect(resultText(result)).toContain('No problems across 1 document');
      expect(resultText(result)).not.toContain('No documents were checked');
    }
  });
});
