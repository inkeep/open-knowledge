/**
 * Unit tests for the `preview_url` MCP tool.
 *
 * `preview_url` is the one tool that hands an agent the browser-reachable
 * preview URL — per-response `previewUrl` fields are route-only. Branches:
 *   - UI running (`ui.lock` bound) → composed full URL.
 *   - No UI + registration has server authority → backend demand-ensure
 *     (auto-spawn via the `serverUrl` resolver), bounded `ui.lock` wait.
 *   - Still no UI → `{ url: null, running: false }` + a state-accurate
 *     recovery hint (`ok start` vs `ok ui` by `server.lock` liveness).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoStartDisabledError } from '../../autostart.ts';
import { resolveLockDir } from '../../config/paths.ts';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import type { OffCwdResolverDeps } from '../../off-cwd-resolver.ts';
import { readArmedPaneTarget } from '../../pane-target.ts';
import { register } from './get-preview-url.ts';
import { bindTestServerLock, bindTestUiLock } from './preview-url-test-helpers.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});
const CONFIG_AUTOOPEN_OFF: Config = ConfigSchema.parse({
  appearance: { preview: { autoOpen: false } },
});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ToolHandler = (args: {
  document?: string;
  folder?: string;
  skill?: { name: string; scope?: 'project' | 'global' };
  file?: string;
  armPaneTarget?: boolean;
  cwd?: string;
}) => Promise<ToolResult>;

interface EnsureDeps {
  serverUrl?: (cwd?: string) => Promise<string | undefined>;
  uiBindWait?: { timeoutMs?: number; pollIntervalMs?: number };
  offCwdResolverDeps?: OffCwdResolverDeps;
  ensureSingleFileSession?: (absFile: string) => Promise<boolean>;
  resolveUserAutoOpen?: () => boolean;
  isDesktopTerminal?: boolean;
}

function captureRegistration(
  cwd: string,
  config: Config = BASE_CONFIG,
  ensure?: EnsureDeps,
): ToolHandler {
  let captured: ToolHandler | null = null;
  const server = {
    registerTool(_name: string, _config: unknown, handler: ToolHandler) {
      captured = handler;
    },
    tool() {
      throw new Error('legacy tool() should not be called by preview_url');
    },
  } as unknown as ServerInstance;
  register(server, {
    config,
    resolveCwd: async () => cwd,
    ...ensure,
  });
  if (!captured) throw new Error('tool not registered');
  return captured;
}

describe('preview_url tool — UI running', () => {
  test('with document: composes baseUrl + the doc route', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.baseUrl).toBe(uiBase);
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/SPEC`);
    expect(result.structuredContent?.autoOpen).toBe(true);
    expect(result.content[0]?.text).toContain(`${uiBase}/#/specs/foo/SPEC`);
  });

  test('with folder: composes the folder route with a trailing slash', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ folder: 'specs/foo' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/`);
  });

  test('folder route tolerates surrounding slashes and per-segment encodes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ folder: '/My Notes/sub/' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/My%20Notes/sub/`);
  });

  test('armPaneTarget writes the doc route as a readable armed target', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    await handler({ document: 'specs/foo/SPEC', armPaneTarget: true });
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBe('#/specs/foo/SPEC');
  });

  test('without armPaneTarget: arms nothing (read-only)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    await handler({ document: 'specs/foo/SPEC' });
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBeNull();
  });

  test('armPaneTarget with no docName/folder: arms nothing + surfaces a note', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ armPaneTarget: true });
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBeNull();
    expect(result.content[0]?.text).toContain('nothing was armed');
  });

  test('armPaneTarget with a folder arms the folder route', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    await handler({ folder: 'specs/foo', armPaneTarget: true });
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBe('#/specs/foo/');
  });

  describe('isDesktopTerminal steer (OK Desktop built-in terminal)', () => {
    test('document: response leads with `ok open <doc>` and tells the agent not to navigate the URL', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ document: 'specs/foo/SPEC' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('ok open specs/foo/SPEC');
      expect(text).toMatch(/Don't navigate the URL|reference only/);
      // The URL is still present (reference); the command is also machine-readable.
      expect(result.structuredContent?.running).toBe(true);
      expect(result.structuredContent?.okOpenCommand).toBe('ok open specs/foo/SPEC');
    });

    test('folder: steers to `ok open <folder>`', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ folder: 'specs/foo' });
      expect(result.content[0]?.text ?? '').toContain('ok open specs/foo');
      expect(result.structuredContent?.okOpenCommand).toBe('ok open specs/foo');
    });

    test('skill default scope (project): steers to `ok open <name> --skill` (no --scope)', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ skill: { name: 'trip-log' } });
      expect(result.content[0]?.text ?? '').toContain('ok open trip-log --skill');
      expect(result.content[0]?.text ?? '').not.toContain('--scope');
      expect(result.structuredContent?.okOpenCommand).toBe('ok open trip-log --skill');
    });

    test('skill --scope global: steers to `ok open <name> --skill --scope global`', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ skill: { name: 'trip-log', scope: 'global' } });
      expect(result.content[0]?.text ?? '').toContain('ok open trip-log --skill --scope global');
      expect(result.structuredContent?.okOpenCommand).toBe(
        'ok open trip-log --skill --scope global',
      );
    });

    test('no target (root): no steer — nothing to `ok open`', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({});
      expect(result.content[0]?.text ?? '').not.toContain('ok open');
    });

    test('NOT a desktop terminal (default): no steer — plain Preview URL', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd);
      const result = await handler({ document: 'specs/foo/SPEC' });
      expect(result.content[0]?.text ?? '').not.toContain('ok open');
      // No steer command in structured output either.
      expect(result.structuredContent?.okOpenCommand ?? null).toBeNull();
    });

    test('desktop terminal + no UI running: steer + okOpenCommand still fire (ok open does not need the UI)', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      // No bindTestUiLock / bindTestServerLock — nothing is running.
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ document: 'specs/foo/SPEC' });
      expect(result.structuredContent?.running).toBe(false);
      expect(result.structuredContent?.okOpenCommand).toBe('ok open specs/foo/SPEC');
      expect(result.content[0]?.text ?? '').toContain('ok open specs/foo/SPEC');
    });

    test('document with a space: okOpenCommand shell-quotes the path', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ document: 'notes/My Doc' });
      expect(result.structuredContent?.okOpenCommand).toBe("ok open 'notes/My Doc'");
    });

    test('document with an embedded single quote: okOpenCommand POSIX-escapes it', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      bindTestUiLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ document: "Q&A/what's new" });
      // POSIX single-quote escape: close-quote, escaped-quote, reopen → '\''
      expect(result.structuredContent?.okOpenCommand).toBe("ok open 'Q&A/what'\\''s new'");
    });

    test('desktop terminal + no UI + folder: okOpenCommand still fires', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
      // No bindTestUiLock — nothing running.
      const handler = captureRegistration(cwd, BASE_CONFIG, { isDesktopTerminal: true });
      const result = await handler({ folder: 'specs/foo' });
      expect(result.structuredContent?.running).toBe(false);
      expect(result.structuredContent?.okOpenCommand).toBe('ok open specs/foo');
    });
  });

  test('docName + folder together is rejected (mutually exclusive)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC', folder: 'specs/foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('mutually exclusive');
    // Nothing armed even if both + arm were passed.
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBeNull();
  });

  test('without docName: returns the UI root URL', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(uiBase);
    expect(result.structuredContent?.baseUrl).toBe(uiBase);
    expect(result.structuredContent?.autoOpen).toBe(true);
  });

  test('per-segment encodes docName when composing the URL', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'notes/My Doc' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/notes/My%20Doc`);
  });
});

describe('preview_url tool — skill target', () => {
  test('with skill: composes the __skill__ route (default project scope)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ skill: { name: 'trip-log' } });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/__skill__/project/trip-log`);
  });

  test('with skill + explicit global scope and a spaced name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ skill: { name: 'run tests', scope: 'global' } });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/__skill__/global/run%20tests`);
  });

  test('armPaneTarget with a skill arms the skill route', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    await handler({ skill: { name: 'trip-log' }, armPaneTarget: true });
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBe('#/__skill__/project/trip-log');
  });

  test('skill + document together is rejected (mutually exclusive)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ skill: { name: 'trip-log' }, document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('mutually exclusive');
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBeNull();
  });
});

describe('preview_url tool — no UI running', () => {
  test('returns running:false + the ok-start hint when nothing is running', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.structuredContent?.baseUrl).toBeNull();
    expect(result.structuredContent?.autoOpen).toBe(true);
    expect(result.content[0]?.text).toContain('No OpenKnowledge server is running');
    expect(result.content[0]?.text).toContain('`ok start`');
    // `ok ui` alone would produce a backend-less UI shell in this state.
    expect(result.content[0]?.text).not.toContain('`ok ui`');
  });

  test('no-UI branch is the same regardless of docName', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd);
    const result = await handler({});
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.structuredContent?.autoOpen).toBe(true);
  });

  test('server alive but no UI: advises ok ui, not ok start', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('OK server is running');
    expect(result.content[0]?.text).toContain('`ok ui`');
    expect(result.content[0]?.text).not.toContain('`ok start`');
  });
});

describe('preview_url tool — backend demand-ensure', () => {
  test('cold project: ensure spawns the backend and the call returns a live URL once ui.lock binds', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    let resolverCalls = 0;
    let uiBase = '';
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        resolverCalls += 1;
        bindTestServerLock(cwd);
        // The real spawn's `ok ui` sibling binds asynchronously — model the
        // lag so the test exercises the bounded wait, not a lucky fast path.
        setTimeout(() => {
          uiBase = bindTestUiLock(cwd);
        }, 30);
        return 'http://localhost:4321';
      },
      uiBindWait: { timeoutMs: 1500, pollIntervalMs: 10 },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(resolverCalls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/SPEC`);
  });

  test('resolver runs on every call, even with a live UI (orphan-heal contract)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const uiBase = bindTestUiLock(cwd);
    let resolverCalls = 0;
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        resolverCalls += 1;
        return 'http://localhost:4321';
      },
    });
    const result = await handler({});
    expect(resolverCalls).toBe(1);
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(uiBase);
  });

  test('auto-start opt-out: soft not-running payload naming the knob', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new AutoStartDisabledError(
          'OpenKnowledge server is not running and OK_MCP_AUTOSTART=0 disables auto-start.',
        );
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.content[0]?.text).toContain('`ok start`');
    expect(result.content[0]?.text).toContain('OK_MCP_AUTOSTART=0');
    // `ok ui` alone would produce a backend-less UI shell in this state — same
    // wrong-state guard as the no-server and bind-timeout branches.
    expect(result.content[0]?.text).not.toContain('`ok ui`');
  });

  test('spawn failure surfaces as a tool error carrying the resolver message', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new Error('server did not start within 5000ms stderr:\nboom');
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('did not start within');
  });

  test('fresh spawn whose UI never binds: server-running hint after the bounded wait', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        bindTestServerLock(cwd);
        return 'http://localhost:4321';
      },
      uiBindWait: { timeoutMs: 60, pollIntervalMs: 10 },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('OK server is running');
    expect(result.content[0]?.text).toContain('`ok ui`');
    // Symmetric with the no-server branch: a hint-selector regression that
    // emitted the wrong-state message would advise `ok start` here.
    expect(result.content[0]?.text).not.toContain('`ok start`');
  });

  test('ensure failure does not lose a requested pane-target arm', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new Error('spawn failed: ENOENT');
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC', armPaneTarget: true });
    expect(result.isError).toBe(true);
    expect(readArmedPaneTarget(resolveLockDir(cwd))).toBe('#/specs/foo/SPEC');
  });
});

describe('preview_url tool — autoOpen field', () => {
  test('echoes resolved autoOpen=false when the user has disabled it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    const handler = captureRegistration(cwd, CONFIG_AUTOOPEN_OFF);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.autoOpen).toBe(false);
  });

  test('echoes autoOpen=false when no UI is running', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    const handler = captureRegistration(cwd, CONFIG_AUTOOPEN_OFF);
    const result = await handler({});
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.autoOpen).toBe(false);
  });

  test('reads config fresh per call (resolver invoked on every invocation)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-preview-url-'));
    bindTestUiLock(cwd);
    let currentAutoOpen = true;
    const configResolver = async (): Promise<Config> =>
      ConfigSchema.parse({ appearance: { preview: { autoOpen: currentAutoOpen } } });
    let captured: ToolHandler | null = null;
    const server = {
      registerTool(_name: string, _config: unknown, handler: ToolHandler) {
        captured = handler;
      },
      tool() {
        throw new Error('legacy tool() should not be called by preview_url');
      },
    } as unknown as ServerInstance;
    register(server, {
      config: configResolver,
      resolveCwd: async () => cwd,
    });
    if (!captured) throw new Error('tool not registered');
    const handler = captured as ToolHandler;

    const first = await handler({ document: 'foo' });
    expect(first.structuredContent?.autoOpen).toBe(true);

    currentAutoOpen = false;
    const second = await handler({ document: 'foo' });
    expect(second.structuredContent?.autoOpen).toBe(false);
  });
});

describe('preview_url tool — error path', () => {
  test('returns isError when resolveCwd rejects', async () => {
    let captured: ToolHandler | undefined;
    const server = {
      registerTool(_name: string, _config: unknown, handler: ToolHandler) {
        captured = handler;
      },
      tool() {
        throw new Error('legacy tool() should not be called by preview_url');
      },
    } as unknown as ServerInstance;
    register(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => {
        throw new Error('no roots configured');
      },
    });
    if (!captured) throw new Error('tool not registered');
    const result = await captured({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no roots configured');
  });
});

function mockOffCwdDeps(
  candidates: Array<{ contentDir: string; baseUrl: string; alive?: boolean }>,
): OffCwdResolverDeps {
  const cands = candidates.map((c) => ({
    lockDir: `${c.contentDir}/.ok/local`,
    contentDir: c.contentDir,
    baseUrl: c.baseUrl,
    alive: c.alive ?? true,
  }));
  return {
    discover: async () => cands.map((c) => c.lockDir),
    inspect: async (d) => cands.find((c) => c.lockDir === d) ?? null,
    realpath: async (p) => p,
  };
}

describe('preview_url tool — file branch (out-of-project)', () => {
  test('resolves a loose file to the session whose contentDir contains it', async () => {
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: mockOffCwdDeps([
        { contentDir: '/loose', baseUrl: 'http://localhost:6001' },
      ]),
    });
    const result = await handler({ file: '/loose/notes.md' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.baseUrl).toBe('http://localhost:6001');
    expect(result.structuredContent?.url).toBe('http://localhost:6001/#/notes');
    expect(result.structuredContent?.autoOpen).toBe(true);
  });

  test('no session for the file → running:false with an ok-open hint', async () => {
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: mockOffCwdDeps([]),
    });
    const result = await handler({ file: '/loose/notes.md' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.content[0]?.text).toContain('ok open /loose/notes.md');
  });

  test('file is mutually exclusive with document', async () => {
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: mockOffCwdDeps([]),
    });
    const result = await handler({ file: '/loose/notes.md', document: 'specs/foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('mutually exclusive');
  });
});

describe('preview_url tool — file branch boot-on-demand', () => {
  test('boots a session when none serves the file yet, then resolves its URL', async () => {
    let candidate: { contentDir: string; baseUrl: string } | null = null;
    const liveDeps: OffCwdResolverDeps = {
      discover: async () => (candidate ? [`${candidate.contentDir}/.ok/local`] : []),
      inspect: async () =>
        candidate
          ? {
              lockDir: `${candidate.contentDir}/.ok/local`,
              contentDir: candidate.contentDir,
              baseUrl: candidate.baseUrl,
              alive: true,
            }
          : null,
      realpath: async (p) => p,
    };
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: liveDeps,
      ensureSingleFileSession: async () => {
        candidate = { contentDir: '/loose', baseUrl: 'http://localhost:6010' };
        return true;
      },
    });
    const result = await handler({ file: '/loose/new.md' });
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe('http://localhost:6010/#/new');
  });

  test('boot-on-demand that never registers → running:false + ok-open hint', async () => {
    const empty: OffCwdResolverDeps = {
      discover: async () => [],
      inspect: async () => null,
      realpath: async (p) => p,
    };
    let called = false;
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: empty,
      ensureSingleFileSession: async () => {
        called = true;
        return false;
      },
    });
    const result = await handler({ file: '/loose/x.md' });
    expect(called).toBe(true);
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('ok open');
  });

  test('no ensureSingleFileSession dep (no spawn authority) → hint, no boot', async () => {
    const empty: OffCwdResolverDeps = {
      discover: async () => [],
      inspect: async () => null,
      realpath: async (p) => p,
    };
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: empty,
    });
    const result = await handler({ file: '/loose/y.md' });
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('ok open');
  });
  test('ensureSingleFileSession rejection → running:false + hint (not a tool error)', async () => {
    const empty: OffCwdResolverDeps = {
      discover: async () => [],
      inspect: async () => null,
      realpath: async (p) => p,
    };
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: empty,
      ensureSingleFileSession: async () => {
        throw new Error('spawn boom');
      },
    });
    const result = await handler({ file: '/loose/z.md' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('ok open');
  });
  test('relative file path is rejected (must be absolute)', async () => {
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG);
    const result = await handler({ file: 'notes.md' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('absolute');
  });
  test('boot reports success but the session is not discoverable → falls back to the hint', async () => {
    // ensure claims it booted, but discovery never sees the session (it vanished
    // or never registered) — the second resolve still misses, so we hint.
    const empty: OffCwdResolverDeps = {
      discover: async () => [],
      inspect: async () => null,
      realpath: async (p) => p,
    };
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: empty,
      ensureSingleFileSession: async () => true,
    });
    const result = await handler({ file: '/loose/gone.md' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('ok open');
  });
  test('file branch honors a user-scoped autoOpen=false preference', async () => {
    const handler = captureRegistration(mkdtempSync(join(tmpdir(), 'ok-pv-')), BASE_CONFIG, {
      offCwdResolverDeps: mockOffCwdDeps([
        { contentDir: '/loose', baseUrl: 'http://127.0.0.1:6020' },
      ]),
      resolveUserAutoOpen: () => false,
    });
    const result = await handler({ file: '/loose/notes.md' });
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.autoOpen).toBe(false);
  });
});
