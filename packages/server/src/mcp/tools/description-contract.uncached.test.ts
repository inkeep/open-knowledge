import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentWriteOutcomeFields,
  LINT_PLUGIN_IDS,
  OPEN_KNOWLEDGE_MCP_TOOLS,
  VALIDATION_SOURCES,
} from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  outcomeOfSavedWrite,
  outcomeOfStoreFailure,
  REFUSAL_OUTCOMES,
} from '../../agent-write-outcome.ts';
import { ConfigSchema } from '../../config/schema.ts';
import {
  OK_DOC_MOVED,
  OK_DOC_REMOVED,
  OK_PATH_UNRESOLVABLE,
  OK_SERVER_STOPPED,
  OK_STORE_DISCARDED,
  OK_STORE_HELD,
  OK_STORE_REFUSED,
  OK_WRITE_DROPPED,
  OK_WRITE_REPLACED,
  type StoreFailure,
} from '../../document-durability-state.ts';
import { installJsonSchemaDialect, JSON_SCHEMA_DIALECT_2020_12 } from '../json-schema-dialect.ts';
import { registerAllTools } from './index.ts';
import { ROUTED_CWD_DESCRIPTION } from './shared.ts';

const client = new Client({ name: 'description-contract', version: '1' });
let tools: Tool[];

beforeAll(async () => {
  const server = new McpServer({ name: 'description-contract', version: '1' });
  registerAllTools(server, {
    config: ConfigSchema.parse({}),
    resolveCwd: async () => process.cwd(),
  });
  installJsonSchemaDialect(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  tools = (await client.listTools()).tools;
});

afterAll(async () => client.close());

function assertBudget(listing: Tool[]): void {
  const failures: string[] = [];
  let total = 0;
  for (const tool of listing) {
    const description = tool.description ?? '';
    const normalized = description.normalize('NFKC').length;
    if (normalized > 2048)
      failures.push(`${tool.name}: ${normalized} NFKC description characters exceeds 2048`);
    total += description.length + JSON.stringify(tool.inputSchema).length;
  }
  if (total > 60_000)
    failures.push(
      `tools/list: ${total} raw description + compact inputSchema characters exceeds 60000`,
    );
  if (failures.length) throw new Error(failures.join('\n'));
}

function description(name: string): string {
  const result = tools.find((tool) => tool.name === name)?.description;
  if (!result) throw new Error(`Missing served description for ${name}`);
  return result;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

const retiredToolAdvice =
  /\bresolve_conflict\b|(?<![\w.])conflicts\s*\(|mcp__[\w-]+__(?:conflicts|resolve_conflict)\b|\b(?:call|use|invoke|run)\s+(?:the\s+)?`conflicts`|`conflicts`(?!\s+(?:outcomes?|arms?)\b)/i;

test('the production registration after dialect conversion meets both budgets', () => {
  expect(tools).toHaveLength(19);
  expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(OPEN_KNOWLEDGE_MCP_TOOLS));
  for (const tool of tools) expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_DIALECT_2020_12);
  assertBudget(tools);
});

test('the per-tool guard measures normalized JavaScript length and names the offender', () => {
  const tool = tools[0];
  if (!tool) throw new Error('Missing tool fixture');
  expect(() => assertBudget([{ ...tool, description: '\uFB03'.repeat(683) }])).toThrow(
    `${tool.name}: 2049 NFKC description characters exceeds 2048`,
  );
});

test('the aggregate guard counts compact schema text and reports the measured total', () => {
  const fixture: Tool = {
    name: 'schema-growth',
    description: '',
    inputSchema: { type: 'object', description: 'x'.repeat(60_000) },
  };
  const measured = JSON.stringify(fixture.inputSchema).length;
  expect(() => assertBudget([fixture])).toThrow(
    `tools/list: ${measured} raw description + compact inputSchema characters exceeds 60000`,
  );
});

test('routed cwd remains transport-qualified while exec keeps its command-directory contract', () => {
  for (const tool of tools.filter((tool) => tool.name !== 'exec')) {
    expect(tool.inputSchema.properties?.cwd, tool.name).toMatchObject({
      description: ROUTED_CWD_DESCRIPTION,
    });
  }
  expect(description('exec')).toContain('cwd: command paths resolve inside explicit absolute cwd');
  expect(description('exec')).toContain('zero/multiple roots');
  expect(description('exec').slice(0, 500)).toContain('STOP');
});

test('validation family and coverage pins survive on the served descriptions', () => {
  const lint = description('lint');
  const audit = description('audit');
  for (const family of LINT_PLUGIN_IDS) expect(lint).toContain(`\`${family}\``);
  for (const family of VALIDATION_SOURCES) expect(audit).toContain(`\`${family}\``);
  for (const text of [lint, audit]) {
    expect(text).toContain('absent from `ran` was not checked');
    expect(text).toContain('project-wide at 10 warnings');
    expect(text).toContain('omittedWarningCount');
    expect(text).not.toContain('scoped to a folder or file to see what was omitted');
  }
  expect(audit).toContain('may still have contributed findings');
  expect(audit).toContain('document and project-tree OKF checks here');
  expect(lint).toContain('Project-tree OKF checks and link validation run only through');
});

test('formerly CI-skipped navigation, validation and summary pins execute against the listing', () => {
  for (const pin of [
    '`backlinks`',
    '`forward`',
    '`dead`',
    '`orphans`',
    '`hubs`',
    '`suggest`',
    'sourceDocuments',
    'mode',
    'limit',
  ])
    expect(description('links')).toContain(pin);
  for (const pin of ['`document`', 'audit', 'severity', '`fix: true`'])
    expect(description('lint')).toContain(pin);
  for (const pin of ['markdownlint', 'broken', '`links`', 'navigation', '`path`'])
    expect(description('audit')).toContain(pin);
  expect(description('checkpoint')).toContain('project-wide');
  expect(description('restore_version')).toContain('version');
  expect(description('restore_version')).toContain('secrets or PII');
  expect(description('config')).toContain('`install`');
  expect(description('config')).not.toMatch(/action:\s*"(link|unlink|add-root)"/);
});

test('share_link retains its path, kind, cwd and publishing preconditions', () => {
  for (const pin of [
    '`path`',
    '`kind`',
    '`cwd`',
    'auto-probe',
    'REQUIRED when `path` is empty',
    'Publishing is a user act',
  ])
    expect(description('share_link')).toContain(pin);
});

test('served descriptions name no single channel CLI command', () => {
  const channelCommand =
    /(^|[\s`'"(])(ok|ok-beta|open-knowledge|open-knowledge-beta) (open|ps|status|start|stop|init|lint|clean|seed|diagnose|auth|config|cowork|bug-report)\b/;
  const offenders = tools
    .filter((tool) => channelCommand.test(tool.description ?? ''))
    .map((tool) => tool.name);
  expect(offenders).toEqual([]);
  expect(description('preview_url')).toContain("the OpenKnowledge CLI's open <doc>");
  expect(description('lint')).toContain("the OpenKnowledge CLI's lint --fix");
});

test('retired conflict tools are neither registered nor suggested as callable tools', () => {
  expect(tools.map((tool) => tool.name)).not.toContain('conflicts');
  expect(tools.map((tool) => tool.name)).not.toContain('resolve_conflict');
  for (const tool of tools)
    expect(tool.description, tool.name).not.toMatch(/\bconflicts\s*\(|\bresolve_conflict\b/);
});

const adviceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function currentAdviceFiles(root: string): string[] {
  const runtime = [
    'packages/server/src',
    'packages/cli/src',
    'packages/app/src',
    'packages/core/src',
  ].flatMap((path) =>
    filesUnder(join(root, path)).filter(
      (file) => /\.[cm]?tsx?$/.test(file) && !/\.(?:test|test-helper|spec)\.[cm]?tsx?$/.test(file),
    ),
  );
  const guidance = ['packages/server/assets/skills', 'docs/content'].flatMap((path) =>
    filesUnder(join(root, path)).filter((file) => /\.mdx?$/.test(file)),
  );
  return [...runtime, ...guidance];
}

test('retired tool guidance cannot return in runtime strings, bundled skills or published docs', () => {
  for (const file of currentAdviceFiles(adviceRoot))
    expect(readFileSync(file, 'utf8'), relative(adviceRoot, file)).not.toMatch(retiredToolAdvice);
});

test('the advice guard covers every production surface without scanning historical evidence', () => {
  const files = currentAdviceFiles(adviceRoot).map((file) => relative(adviceRoot, file));
  for (const directory of [
    'packages/server/src/',
    'packages/cli/src/',
    'packages/app/src/',
    'packages/core/src/',
    'packages/server/assets/skills/',
    'docs/content/',
  ])
    expect(
      files.some((file) => file.startsWith(directory)),
      directory,
    ).toBe(true);
  expect(files.every((file) => !/\.(?:test|test-helper|spec)\.[cm]?tsx?$/.test(file))).toBe(true);
  expect(files.every((file) => !/^(?:reports|specs|tmp)\//.test(file))).toBe(true);
});

test('retired guidance guard distinguishes tool calls from ordinary conflict and HTTP language', () => {
  for (const text of [
    'Call conflicts({})',
    'Use `conflicts` first',
    'Invoke the `conflicts` tool',
    'The `conflicts` MCP tool lists pending conflicts',
    'Available tools: `conflicts`',
    'Call resolve_conflict after editing',
    'mcp__open_knowledge__conflicts',
    'mcp__open_knowledge__resolve_conflict',
  ])
    expect(text).toMatch(retiredToolAdvice);
  for (const text of [
    'Resolve conflicts in the app',
    'The `conflicts` outcome leaves pending changes in place',
    'The `conflicts` arm is counted separately from `merged`',
    'GET /api/sync/conflicts',
    'POST /api/sync/resolve-conflict',
    "new Option('--shared').conflicts('localOnly')",
  ])
    expect(text).not.toMatch(retiredToolAdvice);
});

test('published scope guidance preserves selection, error, empty-scope and truncation contracts', () => {
  const root = new URL('../../../../../', import.meta.url);
  const reference = readFileSync(new URL('docs/content/reference/mcp.mdx', root), 'utf8');
  const overview = readFileSync(
    new URL('docs/content/advanced/content-rules/overview.mdx', root),
    'utf8',
  );
  for (const pin of [
    'existing file or directory first',
    '`.mdx` before `.md`',
    'explicitly supplied document extension must exist as written',
    'unknown scopes exit 1 (before any `--fix` write)',
    'valid zero-document scopes exit 0',
    'zero documents checked and an informational warning',
    'does not lift per-file caps',
    'Project-tree OKF findings in MCP audit results remain capped',
  ])
    expect(reference).toContain(pin);
  for (const pin of [
    'existing file or directory as their scope',
    '`.mdx`, then `.md`',
    'must exist as written',
    'exits with code 1, before `--fix` can change files',
    'zero findings, an informational warning, and exit code 0',
    'RFC 9457 problem response object',
    'project-tree OKF findings remain capped',
  ])
    expect(overview).toContain(pin);
});

test('skill router and published reference names and counts equal the actual serving surface', () => {
  const skill = readFileSync(
    new URL('../../../assets/skills/project/SKILL.md', import.meta.url),
    'utf8',
  );
  const reference = readFileSync(
    new URL('../../../../../docs/content/reference/mcp.mdx', import.meta.url),
    'utf8',
  );
  const router = skill.split('## Tool index')[1]?.split('**Read `ran`')[0];
  expect(router).toBeDefined();
  expect(router).toContain(`${tools.length} tools`);
  const routerNames = [...(router ?? '').matchAll(/^- `([^`]+)` —/gm)].map((match) => match[1]);
  const referenceNames = [...reference.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
  const served = tools.map((tool) => tool.name).sort();
  expect(routerNames.sort()).toEqual(served);
  expect(referenceNames.sort()).toEqual(served);
  expect(reference).toContain(`**${tools.length} tools**`);
  expect(router).not.toMatch(/\bconflicts\s*\(|\bresolve_conflict\b/);
});

const resolveActionNames =
  /\bresolve_conflict\b|\/api\/sync\/(?:resolve-conflict|conflict-content|conflicts)\b|\bresolutionOptions\b|\bKeep my version\b|\bUse their version\b/;
const diskCollisionStateNames =
  /\b(?:refused-too-large|refused-no-base|refused-conflict-markers|merged-with-markers|disk-markers|conflict-resolved)\b|"kind":\s*"reconcile"|`reconcile` conflict/;
const residualDiskConflictStates = /\b(?:stale-external-write|pending-conflict)\b/;
const RESIDUAL_STATES_RETIRED_WITH_THE_CONFLICT_ROUTE: ReadonlySet<string> = new Set([
  'docs/content/reference/mcp.mdx',
  'packages/server/assets/skills/project/references/conflict-resolution.md',
]);

function withoutGitConflictSections(markdown: string): string {
  return markdown.replace(/^## Git conflicts\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
}

function agentFacingGuidance(root: string): Array<{ path: string; text: string }> {
  const docs = [
    'docs/content/reference/mcp.mdx',
    'docs/content/features/agent-activity.mdx',
    ...['docs/content/integrations', 'docs/content/remote-control'].flatMap((dir) =>
      filesUnder(join(root, dir))
        .filter((file) => /\.mdx?$/.test(file))
        .map((file) => relative(root, file)),
    ),
  ];
  const skills = filesUnder(join(root, 'packages/server/assets/skills'))
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => relative(root, file));
  return [...docs, ...skills].map((path) => ({
    path: path.replaceAll('\\', '/'),
    text: withoutGitConflictSections(readFileSync(join(root, path), 'utf8')),
  }));
}

test('no served tool names a resolve action or a disk-collision conflict state', () => {
  for (const tool of tools) {
    const served = JSON.stringify(tool);
    expect(served, tool.name).not.toMatch(resolveActionNames);
    expect(served, tool.name).not.toMatch(diskCollisionStateNames);
    expect(served, tool.name).not.toMatch(residualDiskConflictStates);
  }
});

test('no bundled skill or agent-facing doc names a resolve action or a disk-collision conflict state outside Git conflicts', () => {
  for (const { path, text } of agentFacingGuidance(adviceRoot)) {
    expect(text, path).not.toMatch(resolveActionNames);
    expect(text, path).not.toMatch(diskCollisionStateNames);
    if (!RESIDUAL_STATES_RETIRED_WITH_THE_CONFLICT_ROUTE.has(path)) {
      expect(text, path).not.toMatch(residualDiskConflictStates);
    }
  }
});

test('each page allowed to name a residual disk-side conflict state still needs to', () => {
  const guidance = new Map(agentFacingGuidance(adviceRoot).map(({ path, text }) => [path, text]));
  for (const path of RESIDUAL_STATES_RETIRED_WITH_THE_CONFLICT_ROUTE) {
    expect(guidance.get(path), path).toMatch(residualDiskConflictStates);
  }
});

const RESULT_TABLE_HEADER = '| Result | `outcome` | `saved` | `nextStep` | Your move |';

function guidedResultRows(text: string): Array<{ result: string; cells: string[] }> {
  const start = text.indexOf(RESULT_TABLE_HEADER);
  if (start === -1) return [];
  const rows: Array<{ result: string; cells: string[] }> = [];
  for (const line of text.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push({ result: cells[0] ?? '', cells });
  }
  return rows;
}

function held(reason: StoreFailure extends { held?: infer H } ? NonNullable<H>['reason'] : never) {
  return outcomeOfStoreFailure({ code: OK_STORE_HELD, message: 'm', held: { reason } });
}

const SERVER_FIELDS_FOR_GUIDED_RESULT: Readonly<Record<string, AgentWriteOutcomeFields>> = {
  '`applied` (200) with a `content-divergence` warning': outcomeOfSavedWrite(undefined, null, true),
  '`both-kept` (409)': outcomeOfSavedWrite({ reconciled: true, mergeOutcome: 'both-kept' }, null),
  '`concurrent-overwrite-refused` (409)':
    REFUSAL_OUTCOMES['urn:ok:error:concurrent-overwrite-refused'],
  '`too-many-agent-sessions` (503)': REFUSAL_OUTCOMES['urn:ok:error:too-many-agent-sessions'],
  '`doc-not-found` (404)': REFUSAL_OUTCOMES['urn:ok:error:doc-not-found'],
  '`reserved-doc-name` (400)': REFUSAL_OUTCOMES['urn:ok:error:reserved-doc-name'],
  '`frontmatter-malformed` (400)': REFUSAL_OUTCOMES['urn:ok:error:frontmatter-malformed'],
  '`frontmatter-edit-not-supported` (400)':
    REFUSAL_OUTCOMES['urn:ok:error:frontmatter-edit-not-supported'],
  '`invalid-frontmatter-patch` (400)': REFUSAL_OUTCOMES['urn:ok:error:invalid-frontmatter-patch'],
  '`target-not-found` (404)': REFUSAL_OUTCOMES['urn:ok:error:target-not-found'],
  '`stale-target` (409)': REFUSAL_OUTCOMES['urn:ok:error:stale-target'],
  '`doc-in-conflict` (409)': REFUSAL_OUTCOMES['urn:ok:error:doc-in-conflict'],
  '`stale-external-write` (409)': REFUSAL_OUTCOMES['urn:ok:error:stale-external-write'],
  '`save-held` (503) with `pending-conflict`': held('pending-conflict'),
  '`save-held` (503) on a file with no agreed version': outcomeOfStoreFailure({
    code: OK_STORE_HELD,
    message: 'm',
    held: { reason: 'pending-intake-failed-no-base', noBase: true },
  }),
  '`save-held` (503) with `pending-not-utf8`': held('pending-not-utf8'),
  '`save-held` (503) with any other `reason`': held('pending-unreadable'),
  '`write-dropped` (409) for a name with no file of its own': outcomeOfStoreFailure({
    code: OK_WRITE_DROPPED,
    message: 'm',
    dropped: 'legacy-name',
  }),
  '`write-dropped` (409) while an outside change was being taken in': outcomeOfStoreFailure({
    code: OK_WRITE_DROPPED,
    message: 'm',
    dropped: 'intake-landed',
  }),
  '`write-dropped` (409) for a skill folder that is gone or a path that does not resolve':
    outcomeOfStoreFailure({ code: OK_WRITE_DROPPED, message: 'm', dropped: 'container-gone' }),
  '`doc-moved` (409)': outcomeOfStoreFailure({ code: OK_DOC_MOVED, message: 'm' }),
  '`branch-switched` (409)': outcomeOfStoreFailure({ code: OK_STORE_DISCARDED, message: 'm' }),
  '`doc-removed` (409) after a rename': outcomeOfStoreFailure({
    code: OK_DOC_REMOVED,
    message: 'm',
    removal: { kind: 'renamed', renamedTo: 'b' },
  }),
  '`doc-removed` (409) after a delete': outcomeOfStoreFailure({
    code: OK_DOC_REMOVED,
    message: 'm',
    removal: { kind: 'deleted-outside' },
  }),
  '`server-stopped` (503)': outcomeOfStoreFailure({ code: OK_SERVER_STOPPED, message: 'm' }),
  '`server-stopped` (503) during a move': outcomeOfStoreFailure({
    code: OK_SERVER_STOPPED,
    message: 'm',
    removal: { kind: 'renamed', renamedTo: 'b' },
  }),
  '`path-escape` (400)': outcomeOfStoreFailure({ code: OK_PATH_UNRESOLVABLE, message: 'm' }),
  '`store-refused` (503)': outcomeOfStoreFailure({ code: OK_STORE_REFUSED, message: 'm' }),
  '`write-replaced` (409)': outcomeOfStoreFailure({ code: OK_WRITE_REPLACED, message: 'm' }),
  '`storage-full` (507), `storage-readonly` or `storage-error` (500)': outcomeOfStoreFailure({
    code: 'ENOSPC',
    message: 'm',
  }),
};

test('the per-result guidance in the bundled skill and the reference gives the fields the server sends', () => {
  for (const path of [
    'packages/server/assets/skills/project/references/conflict-resolution.md',
    'docs/content/reference/mcp.mdx',
  ]) {
    const rows = guidedResultRows(readFileSync(join(adviceRoot, path), 'utf8'));
    expect(rows.map((row) => row.result).sort(), path).toEqual(
      Object.keys(SERVER_FIELDS_FOR_GUIDED_RESULT).sort(),
    );
    for (const { result, cells } of rows) {
      const fields = SERVER_FIELDS_FOR_GUIDED_RESULT[result];
      expect(cells.slice(1, 4), `${path}: ${result}`).toEqual([
        `\`${fields?.outcome}\``,
        `\`${fields?.saved}\``,
        `\`${fields?.nextStep}\``,
      ]);
    }
  }
});

test('the move for each guided result is the one its next step asks for', () => {
  const rows = guidedResultRows(
    readFileSync(
      join(adviceRoot, 'packages/server/assets/skills/project/references/conflict-resolution.md'),
      'utf8',
    ),
  );
  for (const { result, cells } of rows) {
    const nextStep = cells[3];
    const move = cells[4] ?? '';
    if (nextStep === '`retry`') expect(move, result).toMatch(/\bsend\b[^.]*\bagain\b/i);
    if (nextStep === '`re-read`') expect(move, result).toMatch(/re-read/i);
    if (nextStep === '`none`') {
      expect(move, result).toMatch(/tell the user/i);
      expect(move, result).not.toMatch(/re-read|\bsend\b[^.]*\bagain\b|re-apply/i);
    }
  }
});
