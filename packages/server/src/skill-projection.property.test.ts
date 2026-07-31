import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { scanInPlaceSkills } from './in-place-skills.ts';
import {
  projectInPlaceSkill,
  relocateInPlaceCanonical,
  removeInPlaceSkillCopies,
} from './skill-projection.ts';

/**
 * PROPERTY TEST — the permanent tripwire for the skill-occurrence state machine.
 *
 * Invariant (the one that died on 2026-07-22, taking four skills' bytes with
 * it): after ANY sequence of install-menu operations, a skill has EXACTLY ONE
 * real directory, every symlink occurrence resolves to it, and no link is
 * dangling or self-referential. Random operation sequences over the three
 * primitives (fan-out, lossless removal, source relocation) must never break
 * it. Deterministic seeds — a failure prints the sequence to replay.
 */

const HOSTS = ['agents', 'claude', 'cursor', 'codex'] as const;
const ROOT_OF: Record<(typeof HOSTS)[number], string> = {
  agents: '.agents/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
  codex: '.codex/skills',
};

/** Tiny deterministic PRNG (mulberry32) so failures are replayable by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-prop-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function seedSkill(name: string): void {
  const dir = join(base, '.claude/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Use for prop.\n---\n# P`);
}

/** The invariant: NEVER zero real dirs; all real dirs byte-identical; every
 *  link resolves to a real dir (no dangles, no loops); the scan still finds
 *  the skill. Multiple real dirs are legal — that is what copy mode means. */
function assertInvariant(name: string, context: string): void {
  const realDirs: string[] = [];
  const links: string[] = [];
  for (const h of HOSTS) {
    const p = join(base, ROOT_OF[h], name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) links.push(p);
    else if (st.isDirectory()) realDirs.push(p);
  }
  expect(
    realDirs.length,
    `${context}: at least one real dir must survive (links=${links.length})`,
  ).toBeGreaterThanOrEqual(1);
  const reals = realDirs.map((d) => realpathSync(d));
  const bytes = new Set(reals.map((d) => readFileSync(join(d, 'SKILL.md'), 'utf-8')));
  expect(bytes.size, `${context}: all real dirs byte-identical`).toBe(1);
  for (const l of links) {
    let target: string;
    try {
      target = realpathSync(l);
    } catch {
      throw new Error(`${context}: dangling link ${l}`);
    }
    expect(reals.includes(target), `${context}: link ${l} resolves to a real dir`).toBe(true);
  }
  expect(
    scanInPlaceSkills(base).some((sk) => sk.name === name),
    `${context}: scan still finds the skill`,
  ).toBe(true);
}

function canonicalOf(name: string): { abs: string; hash: string; rootRel: string } {
  const scanned = scanInPlaceSkills(base).find((s) => s.name === name);
  if (!scanned) throw new Error(`skill ${name} vanished from the scan`);
  const abs = join(base, scanned.dir);
  return {
    abs,
    hash: scanned.contentHash,
    rootRel: scanned.dir.split('/').slice(0, -1).join('/'),
  };
}

describe('skill occurrence state machine (property)', () => {
  test('random op sequences keep exactly one real dir and no broken links', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const name = `prop-${seed}`;
      seedSkill(name);
      const trace: string[] = [];
      for (let step = 0; step < 12; step++) {
        const c = canonicalOf(name);
        const host = HOSTS[Math.floor(rand() * HOSTS.length)] as (typeof HOSTS)[number];
        const op = Math.floor(rand() * 4);
        if (op === 0) {
          trace.push(`fanout-copy:${host}`);
          projectInPlaceSkill({
            canonicalAbs: c.abs,
            canonicalHash: c.hash,
            canonicalRootRel: c.rootRel,
            name,
            cwd: base,
            targets: [host],
            mode: 'copy',
            convertLinks: true,
          });
        } else if (op === 1) {
          trace.push(`fanout-link:${host}`);
          projectInPlaceSkill({
            canonicalAbs: c.abs,
            canonicalHash: c.hash,
            canonicalRootRel: c.rootRel,
            name,
            cwd: base,
            targets: [host],
            mode: 'link',
          });
        } else if (op === 2) {
          trace.push(`remove:${host}`);
          removeInPlaceSkillCopies({
            canonicalAbs: c.abs,
            canonicalHash: c.hash,
            name,
            cwd: base,
            targets: [host],
          });
        } else {
          trace.push(`promote:${host}`);
          relocateInPlaceCanonical({
            canonicalAbs: c.abs,
            canonicalHash: c.hash,
            name,
            cwd: base,
            newTarget: host,
            leaveLinkBehind: rand() < 0.5,
          });
        }
        assertInvariant(name, `seed=${seed} step=${step} trace=[${trace.join(' ')}]`);
      }
    }
  });

  test('relocate refuses to operate when handed a symlink path (mis-election guard)', () => {
    const name = 'guardrail';
    seedSkill(name);
    const c = canonicalOf(name);
    // Create a link occurrence, then hand the MOVER the link path as if the
    // election had (wrongly) chosen it — the primitive must resolve to the
    // real dir instead of renaming the link file (the analyze-nuke class).
    projectInPlaceSkill({
      canonicalAbs: c.abs,
      canonicalHash: c.hash,
      canonicalRootRel: c.rootRel,
      name,
      cwd: base,
      targets: ['codex'],
      mode: 'link',
    });
    const linkPath = join(base, '.codex/skills', name);
    const moved = relocateInPlaceCanonical({
      canonicalAbs: linkPath, // the lie
      canonicalHash: c.hash,
      name,
      cwd: base,
      newTarget: 'agents',
      leaveLinkBehind: true,
    });
    expect(moved.ok).toBe(true);
    assertInvariant(name, 'after relocate-with-link-path');
    // The real bytes moved; nothing self-links.
    expect(lstatSync(join(base, '.agents/skills', name)).isSymbolicLink()).toBe(false);
  });
});
