/**
 * Server-independent wiring tests for the `skills` READ tool's bundle-file
 * surface (the list-then-read contract). These exercise the input gating that
 * short-circuits BEFORE any network call — a `file` selector requires a `name`,
 * and a bad bundle-file path is rejected by the shared allowlist — so they run
 * without a Hocuspocus server (like `skill-target.test.ts`). The full
 * round-trip (a project `.md` ref joining the link graph, a script round-trip
 * read) lives in the integration suite.
 */
import { describe, expect, test } from 'bun:test';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { BUNDLE_SKILL_NAME } from '../../skill-bundles.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR, type ServerInstance } from './shared.ts';
import { register as registerSkills, type SkillsToolDeps } from './skills.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureSkills(serverUrl: string | undefined): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  registerSkills(server, {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  } as unknown as SkillsToolDeps);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('skills read tool — bundle-file gating short-circuits before the network', () => {
  // A defined-but-unreachable URL proves the gate fires first: a real fetch
  // would refuse, so reaching the teaching error means no request was made.
  const UNREACHABLE = 'http://127.0.0.1:1';

  test('`file` without `name` returns the teaching error', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ file: 'references/x.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('pass `name` too');
  });

  test('`file` with an escaping path is rejected by the allowlist', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ name: 'trip-log', file: 'references/../../etc/passwd' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('..');
  });

  test('`file` outside references/ or scripts/ is rejected', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ name: 'trip-log', file: 'notes/x.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('references/');
  });
});

describe('skills read tool — server-required', () => {
  test('no server URL returns the not-running error', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'trip-log' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('skills read tool — built-in OK skills short-circuit before the network', () => {
  // No server URL at all: reaching the teaching error proves the built-in guard
  // fires before any cwd/server resolution. This is the exact collision from the
  // field — an agent told to "load the open-knowledge skill" calls
  // skills({ name: "open-knowledge" }) and must be taught, not 404'd.
  test('READ open-knowledge teaches instead of looking it up', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge', scope: 'project' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('built-in agent skills');
    expect(text(r)).toContain('already provided to you in your loaded skill list');
  });

  test('every shipped bundle name short-circuits (not just open-knowledge)', async () => {
    const handler = captureSkills(undefined);
    for (const name of Object.values(BUNDLE_SKILL_NAME)) {
      const r = await handler({ name });
      expect(r.isError, `isError for "${name}"`).toBe(true);
      expect(text(r), `teaching error for "${name}"`).toContain('NOT managed by this tool');
    }
  });

  test('READ-file on a built-in skill is short-circuited too', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge', file: 'references/x.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('built-in agent skills');
  });

  test('a user-authored pack skill is NOT treated as built-in', async () => {
    // `open-knowledge-pack-*` lives under the reserved prefix but is real KB
    // content, so it must fall through to the normal (server-required) path.
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge-pack-fishing' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});
