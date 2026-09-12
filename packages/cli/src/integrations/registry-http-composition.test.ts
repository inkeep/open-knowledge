import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { applyAgentConnectionIntents } from '@inkeep/open-knowledge-app/test-support/agent-connections';
import { type ApplyIntent, SatisfierIdSchema } from '@inkeep/open-knowledge-core';
import { ConfigSchema, MCP_SERVER_NAME, readBundleDecision } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BootedStartServer, bootStartServer } from '../commands/start.ts';

const AMBIENT_PATH_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'COPILOT_HOME',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'PI_CODING_AGENT_DIR',
] as const;

type AmbientPathKey = (typeof AMBIENT_PATH_KEYS)[number];

const CLAUDE_PROJECT_MCP = SatisfierIdSchema.parse('claude/mcp/project/config-entry');
const COPILOT_PROJECT_MCP = SatisfierIdSchema.parse('copilot/mcp/project/config-entry');
const CLAUDE_USER_SKILL = SatisfierIdSchema.parse('claude/skill/user/skill-bundle-copy');
const APPLY_PATH = '/api/agent-integrations/apply';

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

describe('web apply through the CLI registry host', () => {
  let projectDir: string;
  let temporaryHome: string;
  let booted: BootedStartServer | null;
  let previousFetch: typeof globalThis.fetch;
  let previousEnv: ReadonlyArray<readonly [AmbientPathKey, string | undefined]>;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ok-registry-http-project-'));
    temporaryHome = await mkdtemp(join(tmpdir(), 'ok-registry-http-home-'));
    booted = null;
    previousFetch = globalThis.fetch;
    previousEnv = AMBIENT_PATH_KEYS.map((key) => [key, process.env[key]] as const);

    const homePaths = {
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      CODEX_HOME: join(temporaryHome, '.codex'),
      COPILOT_HOME: join(temporaryHome, '.copilot'),
      XDG_CONFIG_HOME: join(temporaryHome, '.config'),
      APPDATA: join(temporaryHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(temporaryHome, 'AppData', 'Local'),
      PI_CODING_AGENT_DIR: join(temporaryHome, '.pi', 'agent'),
    } as const satisfies Record<AmbientPathKey, string>;
    for (const key of AMBIENT_PATH_KEYS) process.env[key] = homePaths[key];

    await mkdir(join(projectDir, '.ok'), { recursive: true });
    await writeFile(join(projectDir, '.ok', 'config.yml'), '');
    await mkdir(join(temporaryHome, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    try {
      if (booted !== null) await booted.destroy();
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await Promise.all([
        rm(projectDir, { recursive: true, force: true }),
        rm(temporaryHome, { recursive: true, force: true }),
      ]);
    }
  });

  async function bootWithAppFetch(): Promise<void> {
    booted = await bootStartServer({
      config: ConfigSchema.parse({}),
      cwd: projectDir,
      host: '127.0.0.1',
      port: 0,
      skipAutoInit: true,
      idleThresholdMs: null,
    });
    await booted.ready;
    const loopbackOrigin = `http://127.0.0.1:${booted.port}`;
    const delegatedFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (input !== APPLY_PATH) throw new TypeError(`Unexpected fetch target: ${String(input)}`);
      return delegatedFetch(`${loopbackOrigin}${input}`, init);
    };
  }

  test('the app helper writes and observes the real project MCP integration', async () => {
    const configPath = join(projectDir, '.mcp.json');
    const unrelatedEntry = { command: 'unrelated-command', args: ['--keep'] };
    await writeFile(
      configPath,
      `${JSON.stringify({ unrelated: { keep: true }, mcpServers: { unrelated: unrelatedEntry } }, null, 2)}\n`,
    );
    await bootWithAppFetch();
    const intent = {
      satisfierId: CLAUDE_PROJECT_MCP,
      desired: 'present',
    } as const satisfies ApplyIntent;

    const result = await applyAgentConnectionIntents([intent]);

    expect(result.ok).toBe(true);
    expect(
      result.report.actions.find((action) => action.satisfierId === CLAUDE_PROJECT_MCP),
    ).toMatchObject({ action: expect.stringMatching(/^(written|overwritten)$/) });
    expect(result.snapshot?.probes.satisfiers[CLAUDE_PROJECT_MCP]?.state).toBe('satisfied');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      unrelated: { keep: true },
      mcpServers: {
        unrelated: unrelatedEntry,
        [MCP_SERVER_NAME]: expect.any(Object),
      },
    });
    const writtenBytes = await readFile(configPath, 'utf8');

    const repeated = await applyAgentConnectionIntents([intent]);

    expect(repeated.ok).toBe(true);
    expect(
      repeated.report.actions.find((action) => action.satisfierId === CLAUDE_PROJECT_MCP),
    ).toMatchObject({ action: expect.stringMatching(/^(unchanged|no-op)$/) });
    expect(await readFile(configPath, 'utf8')).toBe(writtenBytes);

    const removed = await applyAgentConnectionIntents([
      { satisfierId: CLAUDE_PROJECT_MCP, desired: 'absent' },
      { satisfierId: COPILOT_PROJECT_MCP, desired: 'absent' },
    ]);

    expect(removed.ok).toBe(true);
    expect(
      removed.report.actions.find((action) => action.satisfierId === CLAUDE_PROJECT_MCP),
    ).toMatchObject({ action: 'removed' });
    expect(removed.snapshot?.probes.satisfiers[CLAUDE_PROJECT_MCP]?.state).toBe('absent');
    expect(removed.snapshot?.probes.satisfiers[COPILOT_PROJECT_MCP]?.state).toBe('absent');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      unrelated: { keep: true },
      mcpServers: { unrelated: unrelatedEntry },
    });
    expect(isWithin(projectDir, configPath)).toBe(true);
    expect(AMBIENT_PATH_KEYS.every((key) => isWithin(temporaryHome, process.env[key] ?? ''))).toBe(
      true,
    );
  });

  test('the app helper installs the real user skill and records its decision', async () => {
    await bootWithAppFetch();
    const skillPath = join(
      temporaryHome,
      '.claude',
      'skills',
      'open-knowledge-discovery',
      'SKILL.md',
    );
    const decisionPath = join(temporaryHome, '.ok', 'skill-state.yml');

    const result = await applyAgentConnectionIntents([
      { satisfierId: CLAUDE_USER_SKILL, desired: 'present' },
    ]);

    expect(result.ok).toBe(true);
    expect(
      result.report.actions.find((action) => action.satisfierId === CLAUDE_USER_SKILL),
    ).toMatchObject({ action: expect.stringMatching(/^(written|overwritten)$/) });
    expect(result.snapshot?.probes.satisfiers[CLAUDE_USER_SKILL]?.state).toBe('satisfied');
    expect((await readFile(skillPath, 'utf8')).length).toBeGreaterThan(0);
    expect((await readFile(decisionPath, 'utf8')).length).toBeGreaterThan(0);
    expect(await readBundleDecision(temporaryHome, 'open-knowledge-discovery')).toBe(true);
    expect(isWithin(temporaryHome, skillPath)).toBe(true);
    expect(isWithin(temporaryHome, decisionPath)).toBe(true);
  });
});
