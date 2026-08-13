import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * a project→global scope move must re-install the skill into the SAME
 * editors it already occupied — not silently drop them and re-land only on the
 * default hub. The regression was that `/api/skill/move-scope` read the source
 * host set from the install MARKER only; for an in-place skill whose editor
 * copies exist on disk but were never recorded in the marker (created/imported
 * in place, older marker), that read came back empty and the destination lost
 * every editor projection. The fix unions the marker with the SCAN (which editor
 * dirs actually hold a copy), so the scan-only case is preserved.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const EDITORS = ['claude', 'cursor', 'codex'] as const;
const HOST_DOTDIR: Record<(typeof EDITORS)[number], string> = {
  claude: '.claude',
  cursor: '.cursor',
  codex: '.codex',
};

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: Use when logging a trip.\n---\n\n## When\n\nLogging a trip.\n`;

/** Seed an in-place skill directly on disk across editor dirs — NO install
 *  marker written, so only the scan knows its host set (the failing case). */
function seedInPlaceAcrossEditors(root: string, name: string): void {
  for (const e of EDITORS) {
    const dir = join(root, HOST_DOTDIR[e], 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name));
  }
}

const globalProjection = (editor: (typeof EDITORS)[number], name: string) =>
  join(tmpHome, HOST_DOTDIR[editor], 'skills', name);

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-move-hosts-home-'));
  // Adopt a harness in the throwaway home. A caller-supplied
  // `configHomedirOverride` owns its own host set, and skill destinations
  // resolve via `resolveDefaultSkillHomeRel`, which refuses (400
  // `NO_USABLE_SKILL_HOME`) when the home has adopted none — OK never creates
  // one on the user's behalf.
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('scope move preserves the editor host set (PRD-7601)', () => {
  test('project→global re-installs into every editor the scan-only skill occupied', async () => {
    const name = 'trip-logger';
    seedInPlaceAcrossEditors(server.contentDir, name);

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    // The skill lands at global scope AND is re-projected into the SAME editors
    // (claude+cursor+codex) it occupied at project scope — pre-fix it landed only
    // on the default global hub and these were all absent.
    for (const e of EDITORS) {
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }

    // Source project projections are gone (no orphans).
    for (const e of EDITORS) {
      expect(existsSync(join(server.contentDir, HOST_DOTDIR[e], 'skills', name))).toBe(false);
    }
  });

  test('project→global preserves hosts through the REAL install path (marker-backed)', async () => {
    const name = 'trip-logger-installed';
    // The user's actual flow: create the skill, then install it into editors via
    // the real /api/skill/install (writes the marker + projections the same way
    // the UI does), THEN move scope.
    expect(
      (
        await fetch(`${base()}/api/skill`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'project',
            name,
            body: '## When\n\nLogging a trip.',
            frontmatter: { name, description: 'Use when logging a trip.' },
          }),
        })
      ).status,
    ).toBe(200);
    const installed = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name, targets: ['claude', 'cursor'] }),
    });
    expect(installed.status).toBe(200);
    for (const e of ['claude', 'cursor'] as const) {
      expect(existsSync(join(server.contentDir, HOST_DOTDIR[e], 'skills', name, 'SKILL.md'))).toBe(
        true,
      );
    }

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    // The move must re-install into the SAME editors at global scope.
    for (const e of ['claude', 'cursor'] as const) {
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }
  });

  test('project→global materializes the FOLDER-symlink audience as real installs', async () => {
    // Physical copy lives only at the .agents hub; .claude/.cursor skills folders
    // are FOLDER-level symlinks to it (a sync-tool / dotfiles setup). Those editors
    // SEE the skill via the folder link but hold no independent copy. Global scope
    // has no such symlink, so the move must materialize them as REAL installs to
    // preserve reachability (, folder-symlink audience).
    const name = 'trip-logger-linked';
    const agentsSkills = join(server.contentDir, '.agents', 'skills');
    mkdirSync(join(agentsSkills, name), { recursive: true });
    writeFileSync(join(agentsSkills, name, 'SKILL.md'), SKILL_MD(name));
    for (const e of ['claude', 'cursor'] as const) {
      mkdirSync(join(server.contentDir, HOST_DOTDIR[e]), { recursive: true });
      // Prior tests in this shared server may have left a real skills dir here;
      // clear it so we can replace it with a folder-level symlink.
      const link = join(server.contentDir, HOST_DOTDIR[e], 'skills');
      rmSync(link, { recursive: true, force: true });
      // <contentDir>/.claude/skills -> <contentDir>/.agents/skills (folder link)
      symlinkSync(agentsSkills, link, 'dir');
    }

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    // At global (no folder symlink), the audience is materialized as its OWN
    // install in each editor: the editor's skills ROOT is an independent real dir
    // (NOT a folder-symlink alias like the source), and the skill is reachable
    // inside it. The per-skill entry itself may be a symlink projection — that's a
    // real install; what matters is the editor independently carries the skill.
    for (const e of ['claude', 'cursor'] as const) {
      expect(lstatSync(join(tmpHome, HOST_DOTDIR[e], 'skills')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }
  });
});
