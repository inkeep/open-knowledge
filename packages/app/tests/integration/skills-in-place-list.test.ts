import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, pollUntil, type TestServer } from './test-harness.ts';
import { createLinkedWorktree } from './worktree-test-harness.ts';

/**
 * In-place editor-dir skills surface as first-class `/api/skills`
 * entries at their REAL paths — deduped to one canonical per skill — and are
 * excluded from `/api/skills/installed` so the same skill never double-lists
 * as a "detected" row.
 */

function writeSkill(root: string, rel: string, body: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${rel.split('/').pop()}\ndescription: test skill\n---\n\n${body}\n`,
  );
}

describe('in-place skills in /api/skills + /api/skills/installed', () => {
  let contentDir: string;
  let server: TestServer;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-list-'));
    writeSkill(contentDir, '.claude/skills/foo', '# Same');
    writeSkill(contentDir, '.codex/skills/foo', '# Same'); // identical copy → deduped
    writeSkill(contentDir, '.codex/skills/qux', '# Qux');
    server = await createTestServer({ contentDir });
  });
  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test('lists each canonical once at its real editor-dir path with all hosts', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as {
      skills: Array<{
        name: string;
        scope: string;
        path: string;
        installed: boolean;
        hosts: string[];
        description?: string;
      }>;
    };

    const foos = skills.filter((s) => s.name === 'foo');
    expect(foos).toHaveLength(1);
    expect(foos[0]?.scope).toBe('project');
    expect(foos[0]?.path).toBe('.claude/skills/foo/SKILL.md');
    expect(foos[0]?.installed).toBe(true);
    expect(foos[0]?.hosts).toEqual(['claude', 'codex']);
    expect(foos[0]?.description).toBe('test skill');

    const qux = skills.find((s) => s.name === 'qux');
    expect(qux?.path).toBe('.codex/skills/qux/SKILL.md');
    expect(qux?.hosts).toEqual(['codex']);
  });

  test('resolve-ref: an installed skill wins (local); unknown + no provenance is none', async () => {
    // `foo` is installed → a `/foo` ref resolves local (no import, no fork).
    const local = await fetch(`${base()}/api/skills/resolve-ref?ref=foo&scope=project&from=qux`);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ kind: 'local', scope: 'project', name: 'foo' });
    // `qux` carries no lockfile origin, so an unknown ref has no trusted signal
    // to follow — none (the caller offers MANUAL Explore, never a fuzzy pick).
    const none = await fetch(
      `${base()}/api/skills/resolve-ref?ref=not-installed-anywhere&scope=project&from=qux`,
    );
    expect(await none.json()).toMatchObject({ kind: 'none' });
    // A malformed ref is rejected, never turned into a filesystem probe.
    const bad = await fetch(
      `${base()}/api/skills/resolve-ref?ref=..%2Fevil&scope=project&from=qux`,
    );
    expect(bad.status).toBe(400);
  });

  test('an in-place imported skill carries origin + Modified off the lockfile (R14)', async () => {
    // Recorded localHash ≠ the bundle's current parseSkillDir hash → Modified.
    // Server was booted in beforeEach; the lockfile is read per list request.
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    mk(join(contentDir, '.ok'), { recursive: true });
    wf(
      join(contentDir, '.ok', 'skills-lock.json'),
      JSON.stringify({
        schema: 1,
        skills: {
          foo: {
            source: 'someone/skill-repo',
            contentHash: 'a'.repeat(64),
            localHash: 'b'.repeat(64), // diverges from on-disk → modified
            importedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const res = await fetch(`${base()}/api/skills`);
    const { skills } = (await res.json()) as {
      skills: Array<{
        name: string;
        scope: string;
        origin?: { source: string };
        modified?: boolean;
        revertable?: boolean;
      }>;
    };
    const foo = skills.find((s) => s.name === 'foo' && s.scope === 'project');
    expect(foo?.origin?.source).toBe('someone/skill-repo');
    expect(foo?.modified).toBe(true);
    expect(foo?.revertable).toBeUndefined(); // no baselineRef recorded
  });

  test("CHOKIDAR backend: a host dir's FIRST skill is admitted without a restart", async () => {
    // The packaged app always runs the chokidar fallback, whose ignored()
    // used to prune excluded dirs wholesale — a host dir with no admitted
    // skill yet emitted no events, so its FIRST skill needed a restart.
    const gContent = mkdtempSync(join(tmpdir(), 'ok-chokidar-first-'));
    process.env.OK_FILE_WATCHER_BACKEND = 'chokidar';
    let chokidarServer: TestServer | undefined;
    try {
      // `.codex/skills` exists but is EMPTY at boot — the caveat setup.
      mkdirSync(join(gContent, '.codex/skills'), { recursive: true });
      writeSkill(gContent, '.claude/skills/seed', '# seed'); // ensures a non-empty scan
      chokidarServer = await createTestServer({ contentDir: gContent });
      const cBase = `http://127.0.0.1:${chokidarServer.port}`;
      writeSkill(gContent, '.codex/skills/first-ever', '# First');
      await pollUntil(async () => {
        const res = await fetch(`${cBase}/api/skills?scope=project`);
        if (!res.ok) return false;
        const body = (await res.json()) as { skills?: Array<{ name: string }> };
        return (body.skills ?? []).some((s) => s.name === 'first-ever');
      }, 20000);
    } finally {
      delete process.env.OK_FILE_WATCHER_BACKEND;
      await chokidarServer?.cleanup();
      rmSync(gContent, { recursive: true, force: true });
    }
  });

  test('a skill created AFTER boot is admitted as content via the live re-scan', async () => {
    // Not in the boot-time allow-list — the raw-batch trigger must re-scan and
    // rebuild the filter, after which the SKILL.md is a real content doc
    // (visible in /api/documents, not just the per-request skills list).
    writeSkill(contentDir, '.claude/skills/live-added', '# Born after boot');
    await pollUntil(async () => {
      const res = await fetch(`${base()}/api/documents`);
      if (!res.ok) return false;
      const body = (await res.json()) as { documents?: Array<{ docName: string }> };
      return (body.documents ?? []).some((d) => d.docName === '.claude/skills/live-added/SKILL');
    }, 15000);
  });

  test('a PRE-EXISTING same-hash copy re-syncs when the canonical is edited (auto-pairing)', async () => {
    // `.codex/skills/foo` existed BEFORE boot (not OK-made) — boot observes the
    // identical pair and records it; a later canonical edit refreshes the copy
    // instead of forking it (the "edited it and it dropped to one editor" bug).
    const canonicalMd = join(contentDir, '.claude/skills/foo/SKILL.md');
    const copyMd = join(contentDir, '.codex/skills/foo/SKILL.md');
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    wf(canonicalMd, rf(canonicalMd, 'utf-8').replace('# Same', '# Same EDITED'));
    await pollUntil(() => rf(copyMd, 'utf-8').includes('# Same EDITED'), 15000);
  });

  test('in-place canonicals do not double-list as detected installed skills', async () => {
    const res = await fetch(`${base()}/api/skills/installed`);
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as {
      skills: Array<{ name: string; provenance: { scope?: string } }>;
    };
    const projectNames = skills.filter((s) => s.provenance.scope === 'project').map((s) => s.name);
    expect(projectNames).not.toContain('foo');
    expect(projectNames).not.toContain('qux');
  });
});

describe('in-place skill install fan-out (R13 inversion)', () => {
  let contentDir: string;
  let server: TestServer;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-install-'));
    writeSkill(contentDir, '.claude/skills/fanout', '# Canonical');
    server = await createTestServer({ contentDir });
  });
  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  const install = (targets: string[]) =>
    fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', targets }),
    });
  // A skill with no other location takes the SYMLINK default; tests about copy
  // behaviour ask for copies explicitly instead of relying on that default.
  const installAsCopies = (targets: string[]) =>
    fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', targets, linkMode: false }),
    });

  test('a bare install neither relocates the source nor strips unnamed locations', async () => {
    const { lstatSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs');
    // Make codex a DETECTED project editor (detection is just "does its config
    // path exist"), so a defaults-driven install resolves a NON-EMPTY target list
    // — and that list can never contain the `agents` hub, which is the whole
    // setup for the bug.
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    writeFileSync(join(contentDir, '.codex/config.toml'), '\n');

    // Put the real folder at the hub, keeping the claude location behind as a link.
    expect((await install(['claude'])).status).toBe(200);
    const promote = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', source: 'agents' }),
    });
    expect(promote.status).toBe(200);
    const hub = join(contentDir, '.agents/skills/fanout');
    const claude = join(contentDir, '.claude/skills/fanout');
    expect(lstatSync(hub).isSymbolicLink()).toBe(false); // the real folder

    // `targets` OMITTED: the caller named no set, so this call is additive. It
    // used to fall through to set-exact reconciliation against the detected
    // editors, read the hub's absence from that list as an uncheck, MOVE the real
    // folder into `.codex/skills`, and delete every location codex didn't name.
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project' }),
    });
    expect(res.status).toBe(200);

    expect(existsSync(hub)).toBe(true);
    expect(lstatSync(hub).isSymbolicLink()).toBe(false); // source did not move
    expect(existsSync(claude)).toBe(true); // location not stripped
  });

  test('ADDITIVE add/remove: stateless location math, source untouchable', async () => {
    const post = (payload: Record<string, unknown>) =>
      fetch(`${base()}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fanout', scope: 'project', ...payload }),
      });

    // add an editor: everything else untouched, source NEVER relocates.
    const addRes = await post({ add: ['codex'] });
    expect(addRes.status).toBe(200);
    const addBody = (await addRes.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(addBody.sourceMovedTo).toBeUndefined();
    expect(addBody.hosts[0]).toBe('claude');
    expect(addBody.hosts).toContain('codex');
    expect(existsSync(join(contentDir, '.codex/skills/fanout/SKILL.md'))).toBe(true);

    // add a CUSTOM root (unified place): bundle lands there, idempotent re-add.
    const rootRes = await post({ add: ['.team/skills'] });
    expect(rootRes.status).toBe(200);
    expect(existsSync(join(contentDir, '.team/skills/fanout/SKILL.md'))).toBe(true);
    expect((await post({ add: ['.team/skills'] })).status).toBe(200);

    // remove them additively — the untouched claude source survives both.
    const rmRes = await post({ remove: ['codex', '.team/skills'] });
    expect(rmRes.status).toBe(200);
    const rmBody = (await rmRes.json()) as { hosts: string[] };
    expect(rmBody.hosts).toEqual(['claude']);
    expect(existsSync(join(contentDir, '.codex/skills/fanout'))).toBe(false);
    expect(existsSync(join(contentDir, '.team/skills/fanout'))).toBe(false);

    // removing the SOURCE is a 400 teaching error — that's `delete`'s job.
    const srcRes = await post({ remove: ['claude'] });
    expect(srcRes.status).toBe(400);
    expect(await srcRes.text()).toContain('SOURCE');

    // set-exact and additive styles never combine (schema-level 400).
    expect((await post({ targets: ['claude'], add: ['codex'] })).status).toBe(400);
  });

  test('remove of an ALIAS-covered viewer unfollows the pool minus this skill (A3 via MCP)', async () => {
    const { symlinkSync, lstatSync, realpathSync } = await import('node:fs');
    // Pool: .agents/skills holds fanout + another skill; codex READS the pool
    // via a folder symlink (no physical codex occurrence).
    mkdirSync(join(contentDir, '.agents/skills'), { recursive: true });
    const fanoutDir = join(contentDir, '.claude/skills/fanout');
    const poolFanout = join(contentDir, '.agents/skills/fanout');
    const { cpSync } = await import('node:fs');
    cpSync(fanoutDir, poolFanout, { recursive: true });
    rmSync(fanoutDir, { recursive: true, force: true });
    writeSkill(contentDir, '.agents/skills/other-skill', '# Other');
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    symlinkSync(join(contentDir, '.agents/skills'), join(contentDir, '.codex/skills'), 'dir');

    // The natural stateless call: "codex shouldn't get fanout".
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', remove: ['codex'] }),
    });
    expect(res.status).toBe(200);
    // codex's folder is now a REAL dir: keeps other-skill (as a link into the
    // pool), does NOT see fanout; the pool keeps fanout for everyone else.
    const codexRoot = join(contentDir, '.codex/skills');
    expect(lstatSync(codexRoot).isSymbolicLink()).toBe(false);
    expect(existsSync(join(codexRoot, 'fanout'))).toBe(false);
    expect(lstatSync(join(codexRoot, 'other-skill')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(codexRoot, 'other-skill'))).toBe(
      realpathSync(join(contentDir, '.agents/skills/other-skill')),
    );
    expect(existsSync(join(contentDir, '.agents/skills/fanout/SKILL.md'))).toBe(true);
  });

  test('add to an ALIAS-covered viewer whose pool LACKS the skill materializes + installs (BUG-5)', async () => {
    const { symlinkSync, lstatSync, realpathSync } = await import('node:fs');
    // The BUG-5 repro shape: codex's folder is a stale alias into a pool that
    // does NOT hold the skill (the legacy-link class). "add codex" must make
    // codex actually get the skill — not silently no-op.
    writeSkill(contentDir, '.ok/skills/legacy-resident', '# Old pool resident');
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    symlinkSync(join(contentDir, '.ok/skills'), join(contentDir, '.codex/skills'), 'dir');

    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', add: ['codex'] }),
    });
    expect(res.status).toBe(200);
    const bodyJson = (await res.json()) as { hosts: string[] };
    expect(bodyJson.hosts).toContain('codex');
    // codex's folder materialized: keeps following the old pool resident (as a
    // per-skill link), AND physically holds the added skill.
    const codexRoot = join(contentDir, '.codex/skills');
    expect(lstatSync(codexRoot).isSymbolicLink()).toBe(false);
    expect(existsSync(join(codexRoot, 'fanout', 'SKILL.md'))).toBe(true);
    expect(realpathSync(join(codexRoot, 'legacy-resident'))).toBe(
      realpathSync(join(contentDir, '.ok/skills/legacy-resident')),
    );
  });

  test('fork resolution: align, make-source, and keep-both-rename', async () => {
    const post = (body: Record<string, unknown>) =>
      fetch(`${base()}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'project', ...body }),
      });

    // ALIGN: codex fork loses; canonical re-projects there; bytes stashed.
    writeSkill(contentDir, '.claude/skills/forky', '# Canonical');
    writeSkill(contentDir, '.codex/skills/forky', '# Codex fork DIFFERENT');
    const align = await post({ name: 'forky', fork: { editor: 'codex', action: 'align' } });
    expect(align.status).toBe(200);
    expect(readFileSync(join(contentDir, '.codex/skills/forky/SKILL.md'), 'utf-8')).toContain(
      '# Canonical',
    );

    // MAKE-SOURCE: cursor fork wins; it becomes the only canonical and the old
    // winner's location re-projects FROM it.
    writeSkill(contentDir, '.claude/skills/champ', '# Old canonical');
    writeSkill(contentDir, '.cursor/skills/champ', '# Cursor version WINS');
    const mk = await post({ name: 'champ', fork: { editor: 'cursor', action: 'make-source' } });
    expect(mk.status).toBe(200);
    expect(readFileSync(join(contentDir, '.claude/skills/champ/SKILL.md'), 'utf-8')).toContain(
      'WINS',
    );
    expect(readFileSync(join(contentDir, '.cursor/skills/champ/SKILL.md'), 'utf-8')).toContain(
      'WINS',
    );

    // RENAME: keep both — the fork becomes an independent skill, frontmatter
    // name rewritten in lock-step.
    writeSkill(contentDir, '.claude/skills/twin', '# Original');
    writeSkill(contentDir, '.codex/skills/twin', '# Divergent twin');
    const rn = await post({
      name: 'twin',
      fork: { editor: 'codex', action: 'rename', toName: 'twin-codex' },
    });
    expect(rn.status).toBe(200);
    expect(existsSync(join(contentDir, '.codex/skills/twin'))).toBe(false);
    const renamed = readFileSync(join(contentDir, '.codex/skills/twin-codex/SKILL.md'), 'utf-8');
    expect(renamed).toContain('# Divergent twin');
    expect(renamed).toMatch(/name: twin-codex/);

    // A same-hash copy is NOT a fork — refused.
    writeSkill(contentDir, '.claude/skills/samey', '# Same');
    writeSkill(contentDir, '.codex/skills/samey', '# Same');
    expect((await post({ name: 'samey', fork: { editor: 'codex', action: 'align' } })).status).toBe(
      400,
    );
  });

  test('DELETE is total: a legacy store resident dies with the native canonical', async () => {
    const gContent = mkdtempSync(join(tmpdir(), 'ok-total-del-gc-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-total-del-home-'));
    // Same skill in a native dir (canonical) AND the legacy global store.
    writeSkill(home, '.claude/skills/zombie', '# Native');
    writeSkill(home, '.ok/skills/zombie', '# Store resident');
    const gServer = await createTestServer({ contentDir: gContent, configHomedirOverride: home });
    try {
      const del = await fetch(
        `http://127.0.0.1:${gServer.port}/api/skill?name=zombie&scope=global`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(200);
      expect(existsSync(join(home, '.claude/skills/zombie'))).toBe(false);
      // The store resident is the SAME skill — it must not survive as a row.
      expect(existsSync(join(home, '.ok/skills/zombie'))).toBe(false);
    } finally {
      await gServer.cleanup();
      rmSync(gContent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ADDITIVE works at GLOBAL scope against the user home', async () => {
    const gContent = mkdtempSync(join(tmpdir(), 'ok-additive-gc-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-additive-ghome-'));
    writeSkill(home, '.claude/skills/globby', '# Native global');
    const gServer = await createTestServer({
      contentDir: gContent,
      configHomedirOverride: home,
    });
    const cleanup = async () => {
      await gServer.cleanup();
      rmSync(gContent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    };
    try {
      const gBase = `http://127.0.0.1:${gServer.port}`;
      const post = (payload: Record<string, unknown>) =>
        fetch(`${gBase}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'globby', scope: 'global', ...payload }),
        });
      const addRes = await post({ add: ['codex'] });
      expect(addRes.status).toBe(200);
      const addBody = (await addRes.json()) as { hosts: string[]; sourceMovedTo?: string };
      expect(addBody.sourceMovedTo).toBeUndefined();
      expect(addBody.hosts[0]).toBe('claude');
      expect(existsSync(join(home, '.codex/skills/globby/SKILL.md'))).toBe(true);
      const rmRes = await post({ remove: ['codex'] });
      expect(rmRes.status).toBe(200);
      expect(existsSync(join(home, '.codex/skills/globby'))).toBe(false);
      expect(existsSync(join(home, '.claude/skills/globby/SKILL.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('global omitted targets project only into host roots that already exist', async () => {
    const gContent = mkdtempSync(join(tmpdir(), 'ok-global-default-targets-content-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-global-default-targets-home-'));
    writeSkill(home, '.codex/skills/globby', '# Native global');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const gServer = await createTestServer({
      contentDir: gContent,
      configHomedirOverride: home,
    });
    try {
      // The harness bootstraps its own Claude platform bundle. Remove that
      // fixture-created root so this request starts from the intended host set.
      rmSync(join(home, '.claude'), { recursive: true, force: true });
      rmSync(join(home, '.agents'), { recursive: true, force: true });
      const res = await fetch(`http://127.0.0.1:${gServer.port}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'globby', scope: 'global' }),
      });

      expect(res.status).toBe(200);
      expect(existsSync(join(home, '.codex/skills/globby/SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.cursor/skills/globby/SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude'))).toBe(false);
      expect(existsSync(join(home, '.agents'))).toBe(false);
    } finally {
      await gServer.cleanup();
      rmSync(gContent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('global explicit targets may create a host root that does not exist yet', async () => {
    const gContent = mkdtempSync(join(tmpdir(), 'ok-global-explicit-target-content-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-global-explicit-target-home-'));
    writeSkill(home, '.codex/skills/globby', '# Native global');
    const gServer = await createTestServer({
      contentDir: gContent,
      configHomedirOverride: home,
    });
    try {
      // Keep the explicit-target precondition honest despite the harness's
      // platform-skill bootstrap.
      rmSync(join(home, '.claude'), { recursive: true, force: true });
      rmSync(join(home, '.agents'), { recursive: true, force: true });
      const res = await fetch(`http://127.0.0.1:${gServer.port}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'globby',
          scope: 'global',
          targets: ['codex', 'agents'],
        }),
      });

      expect(res.status).toBe(200);
      expect(existsSync(join(home, '.agents/skills/globby/SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude'))).toBe(false);
    } finally {
      await gServer.cleanup();
      rmSync(gContent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('install copies the canonical to a new editor; uncheck removes only the copy', async () => {
    // Check codex: canonical (.claude) stays, .codex gets a real copy.
    const res = await install(['claude', 'codex']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[] };
    expect(body.hosts.sort()).toEqual(['claude', 'codex']);

    // A hub-hosted skill keeps its non-editor host in the response — the client
    // diffs before/after hosts, and dropping 'agents' would misreport a removal.
    writeSkill(contentDir, '.agents/skills/hubbed', '# Hub canonical');
    const hubRes = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hubbed', scope: 'project', targets: ['agents', 'claude'] }),
    });
    expect(hubRes.status).toBe(200);
    const hubBody = (await hubRes.json()) as { hosts: string[] };
    expect(hubBody.hosts.sort()).toEqual(['agents', 'claude']);
    expect(existsSync(join(contentDir, '.codex/skills/fanout/SKILL.md'))).toBe(true);
    expect(existsSync(join(contentDir, '.claude/skills/fanout/SKILL.md'))).toBe(true);

    // Uncheck codex: the same-hash copy is removed, canonical survives.
    const res2 = await install(['claude']);
    expect(res2.status).toBe(200);
    expect(existsSync(join(contentDir, '.codex/skills/fanout'))).toBe(false);
    expect(existsSync(join(contentDir, '.claude/skills/fanout/SKILL.md'))).toBe(true);
  });

  test('a bulk add reports an unplaceable root distinctly from a name conflict', async () => {
    // Both used to arrive as `name-conflict`, so a caller could not tell a bad
    // path from a real collision — the single-shot `place` verb 400s on one and
    // 409s on the other.
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name: 'fanout', add: ['.ok/local'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warningCodes: string[] };
    expect(body.warningCodes).toContain('place-path-invalid');
    expect(body.warningCodes).not.toContain('name-conflict');
  });

  test('a same-name FORK in the target editor is never clobbered', async () => {
    writeSkill(contentDir, '.codex/skills/fanout', '# A DIFFERENT skill');
    const res = await install(['claude', 'codex']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[]; warningCodes: string[] };
    expect(body.warningCodes).toContain('name-conflict');
    // The fork's bytes are untouched.
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(join(contentDir, '.codex/skills/fanout/SKILL.md'), 'utf-8')).toContain(
      '# A DIFFERENT skill',
    );
  });

  test('unchecking THE SOURCE relocates it to the next target', async () => {
    // Fan a copy to codex, then uncheck the source (.claude): the bundle MOVES
    // to .codex (its copy becomes the real dir) and .claude is gone.
    expect((await install(['claude', 'codex'])).status).toBe(200);
    const moveRes = await install(['codex']);
    expect(moveRes.status).toBe(200);
    const moved = (await moveRes.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(moved.sourceMovedTo).toBe('.codex/skills/fanout');
    expect(existsSync(join(contentDir, '.codex/skills/fanout/SKILL.md'))).toBe(true);
    expect(existsSync(join(contentDir, '.claude/skills/fanout'))).toBe(false);
  });

  test('setSource is a SWAP: the old source becomes a symlink to the new one', async () => {
    const { lstatSync } = await import('node:fs');
    // .claude is the source, .codex a copy. Promote .codex to source.
    expect((await install(['claude', 'codex'])).status).toBe(200);
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: 'codex' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(body.sourceMovedTo).toBe('.codex/skills/fanout');
    // The new source is the real dir; the OLD source path is downgraded to a
    // SYMLINK pointing at it (the promote/downgrade swap).
    const codex = join(contentDir, '.codex/skills/fanout');
    expect(lstatSync(codex).isDirectory()).toBe(true);
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);
    const claude = join(contentDir, '.claude/skills/fanout');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    const { realpathSync: rp } = await import('node:fs');
    expect(rp(claude)).toBe(rp(codex));
    expect(body.hosts[0]).toBe('codex');
    expect(body.hosts.sort()).toEqual(['claude', 'codex']);
    // Sticky: a fresh list still elects .codex over .claude's precedence.
    const list = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; hosts: string[] }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.hosts[0]).toBe('codex');
    // Promoting the current source is a no-op success.
    const noop = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: 'codex' }),
    });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { sourceMovedTo?: string }).sourceMovedTo).toBeUndefined();
  });

  test('setSource flattens a recorded placement link that chained through the new source', async () => {
    const { dirname, isAbsolute, resolve } = await import('node:path');
    const { readlinkSync } = await import('node:fs');
    // .claude is the source; .codex a copy; a recorded placement LINKS to
    // .claude. Promoting .codex leaves .claude a link to it, so the placement
    // resolves to the real dir only by chaining through .claude.
    expect((await install(['claude', 'codex'])).status).toBe(200);
    const placed = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        place: { dir: '.windsurf/skills', mode: 'link' },
      }),
    });
    expect(placed.status).toBe(200);
    const promoted = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: 'codex' }),
    });
    expect(promoted.status).toBe(200);
    // The ledger sweep claims chains through the new source exactly as the
    // host-slot sweep does: ONE hop to the real dir, not two through .claude.
    const link = join(contentDir, '.windsurf/skills/fanout');
    const oneHop = resolve(dirname(link), readlinkSync(link));
    expect(oneHop).toBe(join(contentDir, '.codex/skills/fanout'));
    // `resolve(dirname, readlink)` normalizes a relative and an absolute target
    // to the same path, so pin the FORM separately: every target this call site
    // can produce is inside the project, which is the relative branch of
    // `skillLinkTarget`. The absolute branch is unreachable from here.
    expect(isAbsolute(readlinkSync(link))).toBe(false);
  });

  test('setSource does not re-point sibling host links the relocation sweep already owns', async () => {
    const { dirname, resolve } = await import('node:path');
    const { readlinkSync, lstatSync } = await import('node:fs');
    // The placement ledger records host slots too, so the ledger sweep's slot
    // list overlaps the relocation sweep's. Excluding the host-owned ones must
    // not leave any sibling stale: after the promote every non-source host link
    // still resolves in ONE hop to the new real dir.
    expect(
      (
        await fetch(`${base()}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'fanout',
            scope: 'project',
            targets: ['claude', 'codex', 'cursor'],
            linkMode: true,
          }),
        })
      ).status,
    ).toBe(200);
    const promoted = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: 'codex' }),
    });
    expect(promoted.status).toBe(200);
    const dest = join(contentDir, '.codex/skills/fanout');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    for (const sib of ['.claude/skills/fanout', '.cursor/skills/fanout']) {
      const abs = join(contentDir, sib);
      expect(lstatSync(abs).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(abs), readlinkSync(abs))).toBe(dest);
    }
  });

  test('placing a skill at the location it already occupies is a no-op success', async () => {
    // Imports land IN-PLACE at the `.agents/skills` hub, so asking to place a
    // freshly imported skill there names its own canonical dir. That used to
    // fail as "Placement path must be a project-relative directory outside
    // .ok/." — an invalid-path error for a skill already exactly where it was
    // asked to be, surfaced as a red toast on an install that had worked.
    const listed = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; path: string }>;
    };
    const entry = listed.skills.find((s) => s.name === 'fanout');
    const ownRoot = entry?.path.replace(/\/fanout\/SKILL\.mdx?$/, '') ?? '';
    expect(ownRoot).not.toBe('');
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        place: { dir: ownRoot, mode: 'copy' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { placedAt?: string };
    expect(body.placedAt).toBe(`${ownRoot}/fanout`);
    // Nothing nested itself inside the skill.
    expect(existsSync(join(contentDir, ownRoot, 'fanout', 'fanout'))).toBe(false);
  });

  test('unplace removes a recorded placement; hand-edited copies are refused', async () => {
    const { writeFileSync: wf } = await import('node:fs');
    const placeRes = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        place: { dir: '.windsurf/skills', mode: 'copy' },
      }),
    });
    expect(placeRes.status).toBe(200);
    const placed = join(contentDir, '.windsurf/skills/fanout');
    expect(existsSync(join(placed, 'SKILL.md'))).toBe(true);
    // Clean unplace: dir removed, record dropped.
    const un = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        unplace: { path: '.windsurf/skills/fanout' },
      }),
    });
    expect(un.status).toBe(200);
    expect(existsSync(placed)).toBe(false);
    // Re-place, hand-edit the copy, then unplace: refused (409), bytes intact.
    expect(
      (
        await fetch(`${base()}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'fanout',
            scope: 'project',
            place: { dir: '.windsurf/skills', mode: 'copy' },
          }),
        })
      ).status,
    ).toBe(200);
    wf(join(placed, 'SKILL.md'), '---\nname: fanout\ndescription: edited.\n---\n# EDITED');
    const refused = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        unplace: { path: '.windsurf/skills/fanout' },
      }),
    });
    expect(refused.status).toBe(409);
    expect(existsSync(join(placed, 'SKILL.md'))).toBe(true);
  });

  test('setSource promotes a STORE-backed skill to the clicked host', async () => {
    const { mkdirSync, writeFileSync: wf, lstatSync } = await import('node:fs');
    const store = join(contentDir, '.ok/skills/storey');
    mkdirSync(store, { recursive: true });
    wf(join(store, 'SKILL.md'), '---\nname: storey\ndescription: Use when testing.\n---\n# S');
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'storey', scope: 'project', setSource: 'claude' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(body.sourceMovedTo).toBe('.claude/skills/storey');
    // The store bundle moved out — the editor dir is the real folder now.
    expect(existsSync(store)).toBe(false);
    const claude = join(contentDir, '.claude/skills/storey');
    expect(lstatSync(claude).isDirectory()).toBe(true);
    expect(lstatSync(claude).isSymbolicLink()).toBe(false);
    expect(body.hosts[0]).toBe('claude');
  });

  test('a CUSTOM root can be promoted to SOURCE (scan tracks custom-root canonicals)', async () => {
    const { lstatSync } = await import('node:fs');
    expect((await install(['claude', 'codex'])).status).toBe(200);
    // Place a copy at the custom .ok/skills root, then promote it to source.
    expect(
      (
        await fetch(`${base()}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'fanout',
            scope: 'project',
            place: { dir: '.ok/skills', mode: 'copy' },
          }),
        })
      ).status,
    ).toBe(200);
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: '.ok/skills' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(body.sourceMovedTo).toBe('.ok/skills/fanout');
    // The custom root holds the real dir; the old source slot is re-placed.
    const okDir = join(contentDir, '.ok/skills/fanout');
    expect(lstatSync(okDir).isDirectory()).toBe(true);
    expect(lstatSync(okDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(contentDir, '.claude/skills/fanout/SKILL.md'))).toBe(true);
    // The registry keeps tracking the skill with the custom root as canonical.
    expect(body.hosts[0]).toBe('.ok/skills');
    const list = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; path: string }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.path).toBe('.ok/skills/fanout/SKILL.md');

    // A MODE FLIP (Copies/Symlinks re-apply) sends set-exact over editor ids
    // only — a vocabulary that cannot express the custom-root source. That
    // absence is NOT an uncheck: the source must stay put, never relocate.
    const flip = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        linkMode: false,
        targets: ['claude', 'codex'],
      }),
    });
    expect(flip.status).toBe(200);
    const flipBody = (await flip.json()) as { hosts: string[]; sourceMovedTo?: string };
    expect(flipBody.sourceMovedTo).toBeUndefined();
    expect(flipBody.hosts[0]).toBe('.ok/skills');
    expect(lstatSync(okDir).isDirectory()).toBe(true);
    expect(lstatSync(okDir).isSymbolicLink()).toBe(false);
  });

  test('drift is PASSIVE disclosure: external rewrites are reported; an explicit re-flip wins', async () => {
    const { lstatSync, rmSync: rm, cpSync } = await import('node:fs');
    // Symlink mode: codex becomes a link, recorded as the EXPECTED form.
    expect((await install(['claude', 'codex'])).status).toBe(200);
    const flip = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        linkMode: true,
        targets: ['claude', 'codex'],
      }),
    });
    expect(flip.status).toBe(200);
    const codex = join(contentDir, '.codex/skills/fanout');
    expect(lstatSync(codex).isSymbolicLink()).toBe(true);

    // An EXTERNAL tool rewrites the link as a real copy (sync-script style).
    rm(codex, { recursive: true, force: true });
    cpSync(join(contentDir, '.claude/skills/fanout'), codex, { recursive: true });
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);

    // The list reports DRIFT for that path — and OK does NOT convert it back
    // on its own (no background self-heal; drift is a passive disclosure).
    const list = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; driftPaths?: string[] }>;
    };
    const entry = list.skills.find((s) => s.name === 'fanout');
    expect(entry?.driftPaths).toEqual(['.codex/skills/fanout']);
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);

    // An EXPLICIT re-flip is user intent and WINS: the drifted copy converts
    // back to a symlink and the drift clears (record matches disk again).
    const reflip = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        linkMode: true,
        targets: ['claude', 'codex'],
      }),
    });
    expect(reflip.status).toBe(200);
    expect(lstatSync(codex).isSymbolicLink()).toBe(true);
    const list2 = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; driftPaths?: string[] }>;
    };
    expect(list2.skills.find((s) => s.name === 'fanout')?.driftPaths).toBeUndefined();
  });

  test('a copy externally rewired as a link TO THE CANONICAL is healthy, not drift', async () => {
    const { lstatSync, rmSync: rm, symlinkSync } = await import('node:fs');
    // Copy mode: codex holds a COPY, recorded as the expected form.
    expect((await installAsCopies(['claude', 'codex'])).status).toBe(200);
    const codex = join(contentDir, '.codex/skills/fanout');
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);

    // Something outside OK (a folder link↔per-skill link conversion, a sync
    // tool) replaces the copy with a symlink RESOLVING TO THE SOURCE — same
    // bytes, healthy known form. That must not read as "changed outside".
    rm(codex, { recursive: true, force: true });
    symlinkSync(join(contentDir, '.claude/skills/fanout'), codex, 'dir');
    const list = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; driftPaths?: string[] }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.driftPaths).toBeUndefined();

    // A link pointing at a DIFFERENT live skill is still drift. (A dangling
    // link disappears from the receipts entirely — the live-path filter in
    // readSkillPlacements — so the negative case needs a resolvable target.)
    writeSkill(contentDir, '.agents/skills/decoy', '# Decoy');
    rm(codex, { recursive: true, force: true });
    symlinkSync(join(contentDir, '.agents/skills/decoy'), codex, 'dir');
    const list2 = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; driftPaths?: string[] }>;
    };
    expect(list2.skills.find((s) => s.name === 'fanout')?.driftPaths).toEqual([
      '.codex/skills/fanout',
    ]);
  });

  test('the swap leave-behind link is drift-tracked (the .agents blind spot)', async () => {
    const { lstatSync, rmSync: rm, cpSync } = await import('node:fs');
    expect((await install(['claude', 'codex'])).status).toBe(200);
    // Promote codex: .claude becomes the left-behind LINK — now recorded.
    expect(
      (
        await fetch(`${base()}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'fanout', scope: 'project', setSource: 'codex' }),
        })
      ).status,
    ).toBe(200);
    const claude = join(contentDir, '.claude/skills/fanout');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    // External tool rewrites the leave-behind link as a real copy.
    rm(claude, { recursive: true, force: true });
    cpSync(join(contentDir, '.codex/skills/fanout'), claude, { recursive: true });
    const list = (await (await fetch(`${base()}/api/skills?scope=project`)).json()) as {
      skills: Array<{ name: string; driftPaths?: string[] }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.driftPaths).toEqual([
      '.claude/skills/fanout',
    ]);
  });

  test('uninstall (targets []) never deletes the canonical', async () => {
    const res = await install([]);
    expect(res.status).toBe(200);
    expect(existsSync(join(contentDir, '.claude/skills/fanout/SKILL.md'))).toBe(true);
  });

  test('the .agents hub is an install target; explicit copy-mode unsymlinks (lossless)', async () => {
    const { lstatSync, realpathSync } = await import('node:fs');
    // Check the hub: canonical (.claude) fans a copy into .agents/skills.
    const res = await installAsCopies(['claude', 'agents']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[] };
    expect(body.hosts.sort()).toEqual(['agents', 'claude']);
    expect(existsSync(join(contentDir, '.agents/skills/fanout/SKILL.md'))).toBe(true);

    // Once the hub holds a copy it becomes THE source (precedence-first), so
    // symlink mode converts the EDITOR copy into the link pointing at the hub.
    const linkRes = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        targets: ['claude', 'agents'],
        linkMode: true,
      }),
    });
    expect(linkRes.status).toBe(200);
    const hub = join(contentDir, '.agents/skills/fanout');
    const claude = join(contentDir, '.claude/skills/fanout');
    expect(lstatSync(hub).isDirectory()).toBe(true);
    expect(lstatSync(hub).isSymbolicLink()).toBe(false); // the source is never linkified
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(realpathSync(claude)).toBe(realpathSync(hub));

    // ...and an EXPLICIT copy choice converts the link back (unsymlink, lossless).
    const copyRes = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        targets: ['claude', 'agents'],
        linkMode: false,
      }),
    });
    expect(copyRes.status).toBe(200);
    expect(lstatSync(claude).isSymbolicLink()).toBe(false);
    expect(lstatSync(claude).isDirectory()).toBe(true);
  });

  test('a skill with no other location takes the symlink default', async () => {
    const { lstatSync, realpathSync } = await import('node:fs');
    expect((await install(['claude', 'codex'])).status).toBe(200);
    const codex = join(contentDir, '.codex/skills/fanout');
    expect(lstatSync(codex).isSymbolicLink()).toBe(true);
    expect(realpathSync(codex)).toBe(realpathSync(join(contentDir, '.claude/skills/fanout')));
  });

  test('a skill whose locations are links keeps linking', async () => {
    const { lstatSync, realpathSync } = await import('node:fs');
    // The one input that separates "derive from the existing forms" from "derive
    // from the location COUNT": two link locations already exist, so a count
    // rule would call the third a copy. Its sibling pair above (0 existing →
    // link, existing copies → copy) both agree under either rule.
    expect((await install(['claude', 'codex'])).status).toBe(200);
    expect((await install(['claude', 'codex', 'cursor'])).status).toBe(200);
    const cursor = join(contentDir, '.cursor/skills/fanout');
    expect(lstatSync(cursor).isSymbolicLink()).toBe(true);
    expect(realpathSync(cursor)).toBe(realpathSync(join(contentDir, '.claude/skills/fanout')));
  });

  test('a skill that already holds copies keeps copying — the default never reprojects', async () => {
    const { lstatSync } = await import('node:fs');
    // Existing copies, recorded as copies (an install that predates the default).
    expect((await installAsCopies(['claude', 'codex'])).status).toBe(200);
    expect(lstatSync(join(contentDir, '.codex/skills/fanout')).isSymbolicLink()).toBe(false);
    // Adding a THIRD location must not convert the existing copy behind the user.
    expect((await install(['claude', 'codex', 'cursor'])).status).toBe(200);
    expect(lstatSync(join(contentDir, '.codex/skills/fanout')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(contentDir, '.cursor/skills/fanout')).isSymbolicLink()).toBe(false);
  });

  test('convert flips ONE location without touching its siblings', async () => {
    const { lstatSync, realpathSync } = await import('node:fs');
    expect((await installAsCopies(['claude', 'codex', 'cursor'])).status).toBe(200);
    const codex = join(contentDir, '.codex/skills/fanout');
    const cursor = join(contentDir, '.cursor/skills/fanout');
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);

    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        convert: { target: 'codex', mode: 'link' },
      }),
    });
    expect(res.status).toBe(200);
    expect(lstatSync(codex).isSymbolicLink()).toBe(true);
    expect(realpathSync(codex)).toBe(realpathSync(join(contentDir, '.claude/skills/fanout')));
    // The sibling copy is untouched — that bulk conversion is what this replaces.
    expect(lstatSync(cursor).isSymbolicLink()).toBe(false);
    // ...and back again.
    const back = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        convert: { target: 'codex', mode: 'copy' },
      }),
    });
    expect(back.status).toBe(200);
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);
    expect(lstatSync(codex).isDirectory()).toBe(true);
  });

  test('convert refuses the source, a hand-edited fork, and an empty location', async () => {
    const { writeFileSync } = await import('node:fs');
    expect((await installAsCopies(['claude', 'codex'])).status).toBe(200);
    const convert = (target: string, mode: string) =>
      fetch(`${base()}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fanout', scope: 'project', convert: { target, mode } }),
      });
    // The source folder IS the skill — moving it is `source`, not a convert.
    expect((await convert('claude', 'link')).status).toBe(400);
    // Nothing installed there.
    expect((await convert('cursor', 'link')).status).toBe(404);
    // A hand-edited copy is a fork: refused, never overwritten.
    writeFileSync(join(contentDir, '.codex/skills/fanout/SKILL.md'), '# Forked\n\nedited\n');
    expect((await convert('codex', 'link')).status).toBe(409);
  });

  test('linkMode install symlinks the fan-out instead of copying', async () => {
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        targets: ['claude', 'codex'],
        linkMode: true,
      }),
    });
    expect(res.status).toBe(200);
    const dest = join(contentDir, '.codex/skills/fanout');
    const { lstatSync, realpathSync } = await import('node:fs');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(realpathSync(dest)).toBe(realpathSync(join(contentDir, '.claude/skills/fanout')));
    // Preference persisted → the list entry reports linkMode.
    const list = (await (await fetch(`${base()}/api/skills`)).json()) as {
      skills: Array<{ name: string; linkMode?: boolean }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.linkMode).toBe(true);
  });

  test('custom placement: copy lands + discloses; never overwrites (409)', async () => {
    const place = (mode: string) =>
      fetch(`${base()}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'fanout',
          scope: 'project',
          place: { dir: '.windsurf/skills', mode },
        }),
      });
    const res = await place('copy');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { placedAt: string };
    expect(body.placedAt).toBe('.windsurf/skills/fanout');
    expect(existsSync(join(contentDir, '.windsurf/skills/fanout/SKILL.md'))).toBe(true);
    // Disclosed on the list entry.
    const list = (await (await fetch(`${base()}/api/skills`)).json()) as {
      skills: Array<{ name: string; customPlacements?: Array<{ path: string; mode: string }> }>;
    };
    expect(list.skills.find((s) => s.name === 'fanout')?.customPlacements).toContainEqual({
      path: '.windsurf/skills/fanout',
      mode: 'copy',
    });
    // Second placement at the same path refuses rather than overwrite.
    expect((await place('copy')).status).toBe(409);
    // Escapes + .ok/ are rejected.
    const bad = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fanout',
        scope: 'project',
        place: { dir: '../outside', mode: 'copy' },
      }),
    });
    expect(bad.status).toBe(400);
  });

  test('editing the canonical re-syncs OK-recorded copies (forward re-sync)', async () => {
    // Fan a COPY out to codex (recorded with its hash), then edit the canonical.
    const res = await install(['claude', 'codex']);
    expect(res.status).toBe(200);
    const canonicalMd = join(contentDir, '.claude/skills/fanout/SKILL.md');
    const copyMd = join(contentDir, '.codex/skills/fanout/SKILL.md');
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    wf(canonicalMd, rf(canonicalMd, 'utf-8').replace('# Canonical', '# Canonical EDITED'));
    // The watcher debounce re-syncs the recorded copy (hash-gated, lossless).
    await pollUntil(() => rf(copyMd, 'utf-8').includes('# Canonical EDITED'), 15000);
  });
});

describe('GLOBAL in-place skills (R12) — native user-dir skills are first-class', () => {
  let contentDir: string;
  let tmpHome: string;
  let server: TestServer;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-glist-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'ok-inplace-ghome-'));
    writeSkill(tmpHome, '.claude/skills/globby', '# Native global');
    server = await createTestServer({ contentDir, configHomedirOverride: tmpHome });
  });
  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test('lists as a global entry at its real ~-relative path, and reads resolve it', async () => {
    const listRes = await fetch(`${base()}/api/skills`);
    expect(listRes.status).toBe(200);
    const { skills } = (await listRes.json()) as {
      skills: Array<{ name: string; scope: string; path: string; hosts: string[] }>;
    };
    const globby = skills.find((s) => s.name === 'globby');
    expect(globby?.scope).toBe('global');
    expect(globby?.path).toBe('.claude/skills/globby/SKILL.md');
    expect(globby?.hosts).toEqual(['claude']);

    // GET /api/skill resolves the native dir (no ~/.ok/skills entry exists).
    const getRes = await fetch(`${base()}/api/skill?name=globby&scope=global`);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { skill: { body: string; path: string } };
    expect(detail.skill.body).toContain('# Native global');

    // And it no longer double-lists as a detected row.
    const installedRes = await fetch(`${base()}/api/skills/installed`);
    const installed = (await installedRes.json()) as {
      skills: Array<{ name: string; provenance: { scope?: string } }>;
    };
    expect(
      installed.skills.filter((s) => s.provenance.scope !== 'project').map((s) => s.name),
    ).not.toContain('globby');
  });
});

describe('GLOBAL provenance + reimport (store retirement, part 2)', () => {
  let contentDir: string;
  let tmpHome: string;
  let upstreamDir: string;
  let server: TestServer;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-greimport-c-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'ok-greimport-h-'));
    upstreamDir = mkdtempSync(join(tmpdir(), 'ok-greimport-up-'));
    // A native global skill + its recorded provenance pointing at a LOCAL
    // upstream dir (hermetic — the reimport path treats it like any source).
    writeSkill(tmpHome, '.claude/skills/glosk', '# Seeded v1');
    writeSkill(upstreamDir, 'glosk', '# Upstream v2 — changed');
    const { mkdirSync: mkd } = await import('node:fs');
    mkd(join(tmpHome, '.ok'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.ok', 'skills-lock.json'),
      JSON.stringify({
        schema: 1,
        skills: {
          glosk: {
            source: join(upstreamDir, 'glosk'),
            contentHash: 'stale-hash-forces-update',
            importedAt: new Date().toISOString(),
          },
        },
      }),
    );
    server = await createTestServer({ contentDir, configHomedirOverride: tmpHome });
  });
  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(upstreamDir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test('global entries surface origin from ~/.ok/skills-lock.json', async () => {
    const list = (await (await fetch(`${base()}/api/skills`)).json()) as {
      skills: Array<{ name: string; scope: string; origin?: { source: string } }>;
    };
    const entry = list.skills.find((s) => s.scope === 'global' && s.name === 'glosk');
    expect(entry?.origin?.source).toContain(upstreamDir);
  });

  test('reimport works at GLOBAL scope: rewrites the native dir in place from the recorded source', async () => {
    const res = await fetch(`${base()}/api/skill/reimport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'glosk', scope: 'global' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean };
    expect(body.updated).toBe(true);
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(join(tmpHome, '.claude/skills/glosk/SKILL.md'), 'utf-8')).toContain(
      'Upstream v2 — changed',
    );
    // Lock refreshed with the new content hash.
    const lock = JSON.parse(rf(join(tmpHome, '.ok', 'skills-lock.json'), 'utf-8')) as {
      skills: Record<string, { contentHash: string }>;
    };
    expect(lock.skills.glosk?.contentHash).not.toBe('stale-hash-forces-update');
  });
});

describe('folder-level verbs via PUT /api/skill-targets (slice 2)', () => {
  let contentDir: string;
  let server: TestServer;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-folder-verbs-'));
    writeSkill(contentDir, '.agents/skills/shared', '# Shared');
    writeSkill(contentDir, '.cursor/skills/own-only', '# Mine');
    server = await createTestServer({ contentDir });
  });
  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  const putFolder = (action: Record<string, unknown>) =>
    fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderAction: action }),
    });

  test('link merges own-only skills into the target and swaps in a symlink; unlink materializes per-skill links', async () => {
    const { lstatSync: lstat, realpathSync: realpath } = await import('node:fs');
    const linkRes = await putFolder({
      scope: 'project',
      root: '.cursor/skills',
      action: 'link',
      target: '.agents/skills',
    });
    expect(linkRes.status).toBe(200);
    const linkBody = (await linkRes.json()) as { folder?: { moved: string[] } };
    expect(linkBody.folder?.moved).toEqual(['own-only']);
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(contentDir, '.agents/skills/own-only/SKILL.md'))).toBe(true);

    // GET reports the linked state (project scope).
    const getRes = await fetch(`${base()}/api/skill-targets`);
    const got = (await getRes.json()) as {
      folders?: Array<{ scope: string; host: string; state: string; target?: string }>;
    };
    const cursorRow = got.folders?.find((f) => f.scope === 'project' && f.host === 'cursor');
    expect(cursorRow?.state).toBe('linked');
    expect(cursorRow?.target).toBe('.agents/skills');

    // Unlink: back to a real dir of per-skill symlinks (lossless).
    const unlinkRes = await putFolder({
      scope: 'project',
      root: '.cursor/skills',
      action: 'unlink',
    });
    expect(unlinkRes.status).toBe(200);
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(false);
    expect(lstat(join(contentDir, '.cursor/skills/shared')).isSymbolicLink()).toBe(true);
    expect(realpath(join(contentDir, '.cursor/skills/shared'))).toBe(
      realpath(join(contentDir, '.agents/skills/shared')),
    );
  });

  test('folder-link receipt vs disk: external rewrite renders passive DRIFT; explicit re-link wins', async () => {
    const { lstatSync: lstat } = await import('node:fs');
    const getFolders = async () => {
      const r = await fetch(`${base()}/api/skill-targets`);
      const g = (await r.json()) as {
        folders?: Array<{
          scope: string;
          host: string;
          state: string;
          drift?: true;
          expected?: string;
        }>;
      };
      return g.folders ?? [];
    };

    // Link records the receipt — no drift while disk matches.
    expect(
      (
        await putFolder({
          scope: 'project',
          root: '.cursor/skills',
          action: 'link',
          target: '.agents/skills',
        })
      ).status,
    ).toBe(200);
    let cursor = (await getFolders()).find((f) => f.scope === 'project' && f.host === 'cursor');
    expect(cursor?.drift).toBeUndefined();

    // An EXTERNAL tool deletes the symlink and writes a real dir (sync-script
    // style). OK does NOT self-heal; the row discloses drift passively.
    rmSync(join(contentDir, '.cursor/skills'), { force: true });
    mkdirSync(join(contentDir, '.cursor/skills'), { recursive: true });
    cursor = (await getFolders()).find((f) => f.scope === 'project' && f.host === 'cursor');
    expect(cursor?.state).toBe('own');
    expect(cursor?.drift).toBe(true);
    expect(cursor?.expected).toBe('link → .agents/skills');

    // The next explicit verb WINS and refreshes the receipt — drift clears.
    expect(
      (
        await putFolder({
          scope: 'project',
          root: '.cursor/skills',
          action: 'link',
          target: '.agents/skills',
        })
      ).status,
    ).toBe(200);
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(true);
    cursor = (await getFolders()).find((f) => f.scope === 'project' && f.host === 'cursor');
    expect(cursor?.drift).toBeUndefined();
  });

  test('a conflicting bundle rejects the link with 409 and leaves both folders untouched', async () => {
    writeSkill(contentDir, '.cursor/skills/shared', '# DIFFERENT bytes');
    const res = await putFolder({
      scope: 'project',
      root: '.cursor/skills',
      action: 'link',
      target: '.agents/skills',
    });
    expect(res.status).toBe(409);
    const { lstatSync: lstat } = await import('node:fs');
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(contentDir, '.cursor/skills/own-only/SKILL.md'))).toBe(true);
  });

  test('ledger-known custom roots are folder rows AND valid link targets', async () => {
    // Record a custom placement so the ledger knows `.tim/skills`.
    const place = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'shared',
        scope: 'project',
        place: { dir: '.tim/skills', mode: 'copy' },
      }),
    });
    expect(place.status).toBe(200);

    const got = (await (await fetch(`${base()}/api/skill-targets`)).json()) as {
      folders?: Array<{ scope: string; host: string; root: string; state: string }>;
    };
    const timRow = got.folders?.find((f) => f.scope === 'project' && f.root === '.tim/skills');
    expect(timRow?.state).toBe('own');

    // A custom root is a first-class LINK target (no root is privileged).
    const res = await putFolder({
      scope: 'project',
      root: '.cursor/skills',
      action: 'link',
      target: '.tim/skills',
    });
    expect(res.status).toBe(200);
    const { lstatSync: lstat, realpathSync: realpath } = await import('node:fs');
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(true);
    expect(realpath(join(contentDir, '.cursor/skills'))).toBe(
      realpath(join(contentDir, '.tim/skills')),
    );
  });

  test('add-root declares an EMPTY custom root that rows and link-targets immediately', async () => {
    const add = await putFolder({ scope: 'project', root: '.myteam/skills', action: 'add-root' });
    expect(add.status).toBe(200);

    const got = (await (await fetch(`${base()}/api/skill-targets`)).json()) as {
      folders?: Array<{ scope: string; root: string; state: string }>;
    };
    const row = got.folders?.find((f) => f.scope === 'project' && f.root === '.myteam/skills');
    expect(row?.state).toBe('absent');

    // Immediately linkable as a target (created on link).
    const res = await putFolder({
      scope: 'project',
      root: '.cursor/skills',
      action: 'link',
      target: '.myteam/skills',
    });
    expect(res.status).toBe(200);
    const { lstatSync: lstat } = await import('node:fs');
    expect(lstat(join(contentDir, '.cursor/skills')).isSymbolicLink()).toBe(true);
  });

  test('add-root rejects traversal/absolute paths', async () => {
    for (const bad of ['../evil', '/abs/skills', '']) {
      const res = await putFolder({ scope: 'project', root: bad, action: 'add-root' });
      expect(res.status).toBe(400);
    }
  });

  test('non-standard roots are rejected', async () => {
    const res = await putFolder({
      scope: 'project',
      root: '.evil/../skills',
      action: 'link',
      target: '.agents/skills',
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The `outsideProject` stamp on `/api/skills/installed`. The pure predicate is
 * unit-tested in `core/skills-catalog/scope.test.ts`; what only a booted server
 * can pin is WHICH directory the handler measures against. Three candidates sit
 * at that call site and two are wrong:
 *   - `identity`   — resolves a linked worktree to its parent, which makes the
 *     comparison vacuous: the enumerated skills are always "inside" it;
 *   - `contentDir` — under `content.dir: docs` this is a SUBDIRECTORY of the
 *     project, so every project skill in the user's OWN checkout reads foreign.
 * Only `projectDir ?? contentDir`, the open project root, is correct, and each
 * test below fails on exactly one of the wrong two.
 *
 * Skills go under `.claude/skills` (an EDITOR project root). `.agents` is the
 * vendor-neutral hub, deliberately not an editor id, so `projectHarnessHomes`
 * does not scan it and a skill placed there is never enumerated at all.
 */
describe('outsideProject stamp on /api/skills/installed', () => {
  let server: TestServer | undefined;
  const trash: string[] = [];

  type Installed = { skills: Array<{ name: string; outsideProject?: boolean }> };
  const fetchInstalled = async (): Promise<Installed> => {
    const res = await fetch(`http://127.0.0.1:${(server as TestServer).port}/api/skills/installed`);
    expect(res.status).toBe(200);
    return (await res.json()) as Installed;
  };

  afterEach(async () => {
    await server?.cleanup();
    server = undefined;
    for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('does NOT flag a project skill in the user own checkout under content.dir', async () => {
    // `content.dir: docs`. The skill sits at <projectRoot>/.claude/skills/x —
    // inside the project the user has open, but OUTSIDE contentDir. Measuring
    // against contentDir flags it; measuring against the project root does not.
    const projectRoot = mkdtempSync(join(tmpdir(), 'ok-outside-proj-'));
    trash.push(projectRoot);
    const docsDir = join(projectRoot, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeSkill(projectRoot, '.claude/skills/homegrown', '# Homegrown');

    server = await createTestServer({ contentDir: docsDir, projectDir: projectRoot });

    const found = (await fetchInstalled()).skills.find((s) => s.name === 'homegrown');
    expect(found).toBeDefined();
    expect(found?.outsideProject).toBeUndefined();
  });

  test('flags a project skill that lives in the parent checkout of a linked worktree', async () => {
    // The shape this feature exists for. A REAL linked worktree is required:
    // `resolveProjectIdentity` only diverges from its input when `.git` is a
    // pointer file, and that divergence is what surfaces the parent's skills here.
    const wt = createLinkedWorktree({ prefix: 'ok-outside-wt', seedOkScaffold: true });
    trash.push(wt.repoRoot, wt.worktreePath);
    writeSkill(wt.repoRoot, '.claude/skills/fromparent', '# From the parent checkout');

    server = await createTestServer({ contentDir: wt.worktreePath });

    const found = (await fetchInstalled()).skills.find((s) => s.name === 'fromparent');
    expect(found).toBeDefined();
    expect(found?.outsideProject).toBe(true);
  });
});
