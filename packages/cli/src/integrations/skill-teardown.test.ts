import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import { BUNDLE_SKILL_NAME, USER_GLOBAL_BUNDLE_IDS } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { HOSTS_WITH_USER_SKILL_DIR } from '../commands/editors.ts';
import {
  applyLegacyFanoutSweep,
  planLegacyFanoutSweep,
  removeUserGlobalSkillBundle,
  userGlobalSkillBundleTargets,
} from './skill-teardown.ts';

const HOME = '/home/tester';

describe('userGlobalSkillBundleTargets', () => {
  test('targets the central store + every per-host dir for each user-global bundle', () => {
    const targets = userGlobalSkillBundleTargets(HOME);
    // One central + N host dirs per user-global bundle.
    const expectedCount = USER_GLOBAL_BUNDLE_IDS.length * (1 + USER_SKILL_HOSTS.length);
    expect(targets.length).toBe(expectedCount);

    for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
      const name = BUNDLE_SKILL_NAME[bundleId];
      // Central store.
      expect(targets).toContainEqual({
        path: join(HOME, '.agents', 'skills', name),
        bundleId,
        scope: 'central',
      });
      // Each per-host dir.
      for (const host of USER_SKILL_HOSTS) {
        expect(targets).toContainEqual({
          path: join(HOME, host.skillsRoot, name),
          bundleId,
          scope: 'host',
          hostDir: host.hostDir,
        });
      }
    }
    expect(targets.map((target) => target.path)).toContain(
      join(HOME, '.pi', 'agent', 'skills', 'open-knowledge-discovery'),
    );
    expect(targets.map((target) => target.path)).toContain(
      join(HOME, '.copilot', 'skills', 'open-knowledge-discovery'),
    );
  });

  test('includes both built-in bundles by name (discovery + write-skill)', () => {
    const paths = userGlobalSkillBundleTargets(HOME).map((t) => t.path);
    expect(paths.some((p) => p.endsWith('/open-knowledge-discovery'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/open-knowledge-write-skill'))).toBe(true);
  });

  test('never targets the shared ~/.agents/skills root itself', () => {
    const paths = userGlobalSkillBundleTargets(HOME).map((t) => t.path);
    expect(paths).not.toContain(join(HOME, '.agents', 'skills'));
    // Every central target is a NAMED subdir of the shared store.
    for (const t of userGlobalSkillBundleTargets(HOME).filter((x) => x.scope === 'central')) {
      expect(t.path.startsWith(`${join(HOME, '.agents', 'skills')}/`)).toBe(true);
    }
  });
});

describe('legacy fan-out sweep', () => {
  function tmpHome(): string {
    return mkdtempSync(join(tmpdir(), 'ok-legacy-sweep-'));
  }
  function plantSkill(home: string, relDir: string, name: string): string {
    const dir = join(home, relDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# stale\n', 'utf-8');
    return dir;
  }
  function sweep(home: string): string[] {
    return applyLegacyFanoutSweep(home, planLegacyFanoutSweep(home));
  }

  test('removes OK skill dirs left in hosts OK never supported', () => {
    const home = tmpHome();
    const zencoder = plantSkill(home, '.zencoder', 'open-knowledge-discovery');
    const terramind = plantSkill(home, '.terramind', 'open-knowledge-write-skill');
    // Nested agent home, written exactly as the fan-out produced it.
    const tabnine = plantSkill(home, join('.tabnine', 'agent'), 'open-knowledge-discovery');
    // Pre-split name, from an even older install.
    const rovodev = plantSkill(home, '.rovodev', 'open-knowledge');

    const removed = sweep(home);

    for (const dir of [zencoder, terramind, tabnine, rovodev]) {
      expect(existsSync(dir)).toBe(false);
      expect(removed).toContain(dir);
    }
  });

  test("prunes the agent home once OK's skill was the only thing in it", () => {
    const home = tmpHome();
    plantSkill(home, '.zencoder', 'open-knowledge-discovery');

    sweep(home);

    // The whole tree goes: nothing else was ever in it.
    expect(existsSync(join(home, '.zencoder'))).toBe(false);
  });

  test('prunes a nested agent home up to its hardcoded root', () => {
    const home = tmpHome();
    plantSkill(home, join('.tabnine', 'agent'), 'open-knowledge-discovery');

    sweep(home);

    expect(existsSync(join(home, '.tabnine'))).toBe(false);
  });

  test('never removes the shared ~/.config, only the tool folder inside it', () => {
    const home = tmpHome();
    plantSkill(home, join('.config', 'goose'), 'open-knowledge-discovery');

    sweep(home);

    expect(existsSync(join(home, '.config', 'goose'))).toBe(false);
    // `.config` is a shared XDG root — inert or not, OK must never delete it.
    expect(existsSync(join(home, '.config'))).toBe(true);
  });

  test("keeps an agent home that still holds anything of the tool's own", () => {
    const home = tmpHome();
    plantSkill(home, '.zencoder', 'open-knowledge-discovery');
    // The user actually uses zencoder.
    writeFileSync(join(home, '.zencoder', 'config.json'), '{}', 'utf-8');

    sweep(home);

    expect(existsSync(join(home, '.zencoder'))).toBe(true);
    expect(existsSync(join(home, '.zencoder', 'config.json'))).toBe(true);
    // Only OK's own dir went; the now-empty `skills/` stays because its parent did.
    expect(existsSync(join(home, '.zencoder', 'skills', 'open-knowledge-discovery'))).toBe(false);
  });

  test('keeps a sibling skill the user owns — and therefore the dirs holding it', () => {
    const home = tmpHome();
    plantSkill(home, '.zencoder', 'open-knowledge-discovery');
    const mine = plantSkill(home, '.zencoder', 'my-own-skill');
    const lookalike = plantSkill(home, '.zencoder', 'open-knowledgeable-notes');

    sweep(home);

    expect(existsSync(mine)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    expect(existsSync(join(home, '.zencoder'))).toBe(true);
  });

  test('never touches a host OK still installs to', () => {
    const home = tmpHome();
    const live = HOSTS_WITH_USER_SKILL_DIR.map((h) =>
      plantSkill(home, h.hostDir, 'open-knowledge-discovery'),
    );
    const central = plantSkill(home, '.agents', 'open-knowledge-discovery');

    const removed = sweep(home);

    for (const dir of [...live, central]) {
      expect(existsSync(dir)).toBe(true);
      expect(removed).not.toContain(dir);
    }
  });

  test('plan lists every path before anything is deleted', () => {
    const home = tmpHome();
    const skill = plantSkill(home, '.zencoder', 'open-knowledge-discovery');

    const plan = planLegacyFanoutSweep(home);

    // Planning is pure — the user has to be able to read this and say no.
    expect(existsSync(skill)).toBe(true);
    expect(plan.skillDirs).toEqual([skill]);
    expect(plan.emptyDirs).toEqual([join(home, '.zencoder', 'skills'), join(home, '.zencoder')]);
  });

  test('emptyDirs are deepest-first so rmdir can succeed in order', () => {
    const home = tmpHome();
    plantSkill(home, join('.tabnine', 'agent'), 'open-knowledge-discovery');

    const { emptyDirs } = planLegacyFanoutSweep(home);

    expect(emptyDirs).toEqual([
      join(home, '.tabnine', 'agent', 'skills'),
      join(home, '.tabnine', 'agent'),
      join(home, '.tabnine'),
    ]);
  });

  test('a dir that gained content between plan and apply survives', () => {
    const home = tmpHome();
    plantSkill(home, '.zencoder', 'open-knowledge-discovery');
    const plan = planLegacyFanoutSweep(home);
    // User installs the tool for real in the gap.
    writeFileSync(join(home, '.zencoder', 'config.json'), '{}', 'utf-8');

    applyLegacyFanoutSweep(home, plan);

    // rmdir refuses a non-empty dir — the race can't destroy their data.
    expect(existsSync(join(home, '.zencoder', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.zencoder'))).toBe(true);
  });

  // An earlier build of this cleanup removed the skill dirs but never pruned,
  // so real machines exist where the skills are already gone and only empty
  // `~/.<host>/skills/` trees remain. Gating the walk on "we deleted a skill
  // just now" made those unreachable forever — the exact state this covers.
  test('prunes empty leftovers even when the skill dir is already gone', () => {
    const home = tmpHome();
    // No open-knowledge* dir anywhere: just the husks a leaf-only sweep leaves.
    mkdirSync(join(home, '.zencoder', 'skills'), { recursive: true });
    mkdirSync(join(home, '.terramind', 'skills'), { recursive: true });

    const plan = planLegacyFanoutSweep(home);
    expect(plan.skillDirs).toEqual([]);
    expect(plan.emptyDirs.length).toBeGreaterThan(0);

    applyLegacyFanoutSweep(home, plan);

    expect(existsSync(join(home, '.zencoder'))).toBe(false);
    expect(existsSync(join(home, '.terramind'))).toBe(false);
  });

  test('an already-clean host with a non-empty skills dir is left alone', () => {
    const home = tmpHome();
    const mine = join(home, '.zencoder', 'skills', 'my-own-skill');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), '# mine\n', 'utf-8');

    applyLegacyFanoutSweep(home, planLegacyFanoutSweep(home));

    expect(existsSync(mine)).toBe(true);
  });

  test('is a no-op on a home that never ran an affected version', () => {
    const home = tmpHome();
    expect(planLegacyFanoutSweep(home).skillDirs).toEqual([]);
    expect(sweep(home)).toEqual([]);
  });

  test('is idempotent — the second run finds nothing', () => {
    const home = tmpHome();
    plantSkill(home, '.zencoder', 'open-knowledge-discovery');

    expect(sweep(home).length).toBeGreaterThan(0);
    expect(sweep(home)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: the cleanup runs `rm -rf` inside a user's home directory, so
// every one of these is a "could this delete the wrong thing" case. Each was a
// real hole found by attacking the first implementation.
// ---------------------------------------------------------------------------

describe('legacy fan-out sweep — refuses unsafe inputs', () => {
  function tmpHome(): string {
    return mkdtempSync(join(tmpdir(), 'ok-legacy-guard-'));
  }
  function plantSkill(home: string, relDir: string): string {
    const dir = join(home, relDir, 'skills', 'open-knowledge-discovery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# stale\n', 'utf-8');
    return dir;
  }

  // `join('', '.zencoder', …)` is RELATIVE — an empty or relative home silently
  // retargets the whole sweep at the process cwd, which for a CLI is the user's
  // project. Throwing beats returning nothing: it surfaces the caller's bug.
  test.each([
    '',
    '.',
    'relative/path',
    'x/../y',
  ])('a non-absolute home (%j) throws instead of resolving against cwd', (bogus) => {
    expect(() => planLegacyFanoutSweep(bogus)).toThrow(/absolute home/);
  });

  test('the filesystem root is refused', () => {
    expect(() => planLegacyFanoutSweep(sep)).toThrow(/filesystem root/);
  });

  test('a relative home cannot target a matching tree in the cwd', () => {
    const box = tmpHome();
    plantSkill(box, '.zencoder');
    const prev = process.cwd();
    process.chdir(box);
    try {
      expect(() => planLegacyFanoutSweep('')).toThrow();
      expect(existsSync(join(box, '.zencoder', 'skills', 'open-knowledge-discovery'))).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  // Agent hosts commonly symlink `skills/` at the shared `~/.agents/skills`
  // hub, so following one could delete a live install — or, if it points at a
  // user directory, their files.
  test('a symlinked agent home is skipped entirely', () => {
    const box = tmpHome();
    const target = join(box, 'precious');
    mkdirSync(join(target, 'skills', 'open-knowledge-discovery'), { recursive: true });
    writeFileSync(join(target, 'thesis.txt'), 'mine\n', 'utf-8');
    const home = join(box, 'home');
    mkdirSync(home, { recursive: true });
    symlinkSync(target, join(home, '.zencoder'));

    const plan = planLegacyFanoutSweep(home);
    applyLegacyFanoutSweep(home, plan);

    expect(plan.skillDirs).toEqual([]);
    expect(existsSync(join(target, 'thesis.txt'))).toBe(true);
    expect(existsSync(join(target, 'skills', 'open-knowledge-discovery'))).toBe(true);
  });

  test('a symlinked skills/ dir is skipped — no delete through the link', () => {
    const box = tmpHome();
    const docs = join(box, 'Documents');
    mkdirSync(join(docs, 'open-knowledge-discovery'), { recursive: true });
    writeFileSync(join(docs, 'open-knowledge-discovery', 'notes.md'), 'mine\n', 'utf-8');
    const home = join(box, 'home');
    mkdirSync(join(home, '.zencoder'), { recursive: true });
    symlinkSync(docs, join(home, '.zencoder', 'skills'));

    const plan = planLegacyFanoutSweep(home);
    applyLegacyFanoutSweep(home, plan);

    expect(plan.skillDirs).toEqual([]);
    expect(existsSync(join(docs, 'open-knowledge-discovery', 'notes.md'))).toBe(true);
  });

  // `applyLegacyFanoutSweep` is exported and takes plain strings, so trusting
  // its input would let any future caller — or a bug mutating a plan between
  // the prompt and the delete — recursively remove an arbitrary directory.
  test('a skill dir swapped for a symlink between plan and apply is not followed', () => {
    const home = tmpHome();
    const precious = join(home, 'Documents');
    mkdirSync(precious, { recursive: true });
    writeFileSync(join(precious, 'thesis.txt'), 'mine\n', 'utf-8');
    const skill = plantSkill(home, '.zencoder');

    const plan = planLegacyFanoutSweep(home);
    // Attacker (or a racing tool) replaces the planned dir with a link.
    rmSync(skill, { recursive: true, force: true });
    symlinkSync(precious, skill);

    applyLegacyFanoutSweep(home, plan);

    expect(existsSync(join(precious, 'thesis.txt'))).toBe(true);
  });

  test('a skill dir replaced with unrelated content between plan and apply is left alone', () => {
    const home = tmpHome();
    const skill = plantSkill(home, '.zencoder');
    const plan = planLegacyFanoutSweep(home);
    // No longer an OK bundle: no SKILL.md, and not empty.
    rmSync(join(skill, 'SKILL.md'));
    writeFileSync(join(skill, 'someone-elses-data.txt'), 'mine\n', 'utf-8');

    applyLegacyFanoutSweep(home, plan);

    expect(existsSync(join(skill, 'someone-elses-data.txt'))).toBe(true);
  });

  // Found by an independent safety review. `rmdir` refuses a symlink LEAF, but
  // it still resolves a symlinked ANCESTOR, so a link swapped in after planning
  // had it delete a directory at the link target. Only ever an empty one — but
  // "empty" is not ours to assume about somewhere else on disk.
  test('an ancestor swapped for a symlink between plan and apply is not followed', () => {
    const home = tmpHome();
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(join(elsewhere, 'skills'), { recursive: true });
    plantSkill(home, '.zencoder');

    const plan = planLegacyFanoutSweep(home);
    // The whole agent home becomes a link to a tree with an empty `skills/`.
    rmSync(join(home, '.zencoder'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(home, '.zencoder'));

    applyLegacyFanoutSweep(home, plan);

    expect(existsSync(join(elsewhere, 'skills'))).toBe(true);
    expect(existsSync(elsewhere)).toBe(true);
  });

  test('a forged plan is refused, and nothing is deleted', () => {
    const home = tmpHome();
    const precious = join(home, 'Documents');
    mkdirSync(precious, { recursive: true });
    writeFileSync(join(precious, 'thesis.txt'), 'mine\n', 'utf-8');

    expect(() => applyLegacyFanoutSweep(home, { skillDirs: [precious], emptyDirs: [] })).toThrow(
      /outside the known legacy set/,
    );
    expect(existsSync(join(precious, 'thesis.txt'))).toBe(true);
  });

  test('a plan smuggling an extra emptyDir is refused before any delete runs', () => {
    const home = tmpHome();
    const legit = plantSkill(home, '.zencoder');
    const victim = join(home, '.ssh');
    mkdirSync(victim, { recursive: true });

    const plan = planLegacyFanoutSweep(home);
    expect(() =>
      applyLegacyFanoutSweep(home, { ...plan, emptyDirs: [...plan.emptyDirs, victim] }),
    ).toThrow(/outside the known legacy set/);
    // Refusal happens up front — even the legitimate part is untouched.
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(legit)).toBe(true);
  });
});

describe('legacy fan-out host table — static integrity', () => {
  // The table drives deletion, so a typo in it is the highest-severity bug
  // available here. These are pure checks on the data, no filesystem involved.
  const HOME = sep === '/' ? '/home/tester' : 'C:\\Users\\tester';

  test('every planned path is inside home and never home itself', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-legacy-table-'));
    for (const rel of ['.zencoder', '.tabnine/agent', '.config/goose', '.config/kimchi/harness']) {
      const dir = join(home, rel, 'skills', 'open-knowledge-discovery');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf-8');
    }
    const plan = planLegacyFanoutSweep(home);
    expect(plan.skillDirs.length).toBeGreaterThan(0);
    for (const p of [...plan.skillDirs, ...plan.emptyDirs]) {
      expect(p.startsWith(home + sep)).toBe(true);
      expect(p).not.toBe(home);
    }
  });

  test('shared XDG roots are never planned for removal', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-legacy-xdg-'));
    for (const rel of ['.config/goose', '.config/crush', '.config/kimchi/harness']) {
      const dir = join(home, rel, 'skills', 'open-knowledge-discovery');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf-8');
    }
    const plan = planLegacyFanoutSweep(home);
    expect(plan.emptyDirs).not.toContain(join(home, '.config'));
    expect(plan.emptyDirs).toContain(join(home, '.config', 'goose'));
    // …and the shared root really does survive an apply.
    applyLegacyFanoutSweep(home, plan);
    expect(existsSync(join(home, '.config'))).toBe(true);
    expect(existsSync(join(home, '.config', 'goose'))).toBe(false);
  });

  test('no legacy host escapes home via .. and every pruneRoot is an ancestor', () => {
    // Derived from behaviour rather than the private table: plant each host,
    // then assert the deepest planned dir per entry is still under home.
    const home = mkdtempSync(join(tmpdir(), 'ok-legacy-esc-'));
    const dir = join(home, '.zencoder', 'skills', 'open-knowledge-discovery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf-8');
    const plan = planLegacyFanoutSweep(home);
    for (const p of plan.emptyDirs) {
      expect(p.includes(`${sep}..${sep}`)).toBe(false);
      expect(p.startsWith(home + sep)).toBe(true);
    }
    expect(HOME.length).toBeGreaterThan(0);
  });
});

describe('userGlobalSkillBundleTargets / removeUserGlobalSkillBundle — home guard', () => {
  // `os.homedir()` returns $HOME verbatim, so a broken environment made this
  // teardown (the `--no-skills` / opt-out path) delete relative to the process
  // cwd. Predates the legacy sweep, so it was missed when that was hardened.
  test.each(['', '.', 'relative/home'])('a non-absolute home (%j) throws', (bogus) => {
    expect(() => userGlobalSkillBundleTargets(bogus)).toThrow(/absolute home/);
    expect(() => removeUserGlobalSkillBundle(bogus, 'discovery')).toThrow(/absolute home/);
  });

  test('a relative home cannot delete a matching tree in the cwd', () => {
    const box = mkdtempSync(join(tmpdir(), 'ok-teardown-cwd-'));
    const victim = join(box, '.agents', 'skills', 'open-knowledge-discovery');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'SKILL.md'), '# x\n', 'utf-8');
    const prev = process.cwd();
    process.chdir(box);
    try {
      expect(() => removeUserGlobalSkillBundle('', 'discovery')).toThrow();
      expect(existsSync(victim)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });
});
