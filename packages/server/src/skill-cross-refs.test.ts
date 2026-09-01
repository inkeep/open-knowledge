import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSkillRefs } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skills');
const PLATFORM_SKILL = 'open-knowledge';

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkMarkdown(path, out);
    else if (entry.endsWith('.md') && entry !== 'README.md') out.push(path);
  }
  return out;
}

function frontmatterName(skillMd: string): string {
  const match = /^name:\s*(.+)$/m.exec(readFileSync(skillMd, 'utf-8'));
  if (match === null) throw new Error(`${skillMd} has no frontmatter name`);
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function body(path: string): string {
  const raw = readFileSync(path, 'utf-8');
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw : raw.slice(end + 4);
}

const docs = walkMarkdown(SKILLS_ROOT);
const skillFiles = docs.filter((f) => f.endsWith('SKILL.md'));
const shipped = new Set(skillFiles.map(frontmatterName));
const packSkills = skillFiles.filter((f) => f.includes(join('skills', 'packs')));

describe('shipped skills — cross-skill reference graph', () => {
  test('every `/ref` in a skill body names a skill we actually ship', () => {
    const dangling: string[] = [];
    for (const doc of docs) {
      for (const ref of extractSkillRefs(body(doc))) {
        if (!shipped.has(ref)) dangling.push(`${doc.slice(SKILLS_ROOT.length + 1)} -> /${ref}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  test('the corpus actually has edges (bare sibling names draw none)', () => {
    const edges = docs.flatMap((doc) => extractSkillRefs(body(doc)));
    expect(edges.length).toBeGreaterThan(0);
  });

  test.each(
    packSkills.map((f) => [f.slice(SKILLS_ROOT.length + 1), f] as const),
  )('pack skill %s routes to the platform skill with /open-knowledge', (_label, file) => {
    expect(extractSkillRefs(body(file))).toContain(PLATFORM_SKILL);
  });

  test('a pack orientation skill routes to each of its member skills', () => {
    const missing: string[] = [];
    for (const orientation of packSkills) {
      const packDir = dirname(orientation);
      const members = readdirSync(packDir)
        .map((entry) => join(packDir, entry, 'SKILL.md'))
        .filter((path) => skillFiles.includes(path))
        .map(frontmatterName);
      if (members.length === 0) continue;
      const refs = extractSkillRefs(body(orientation));
      for (const member of members) {
        if (!refs.includes(member)) {
          missing.push(`${orientation.slice(SKILLS_ROOT.length + 1)} -> /${member}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('a file that links a skill never also mentions it bare', () => {
    const inconsistent: string[] = [];
    for (const doc of docs) {
      const text = body(doc);
      for (const ref of extractSkillRefs(text)) {
        for (const [index, line] of text.split('\n').entries()) {
          const stripped = line
            .replaceAll(new RegExp(`--pack\\s+\`?${ref}`, 'g'), '')
            .replaceAll(`plugin install ${ref}@`, '');
          if (new RegExp(`(?<![/\\w-])${ref}(?![\\w-])`).test(stripped)) {
            inconsistent.push(`${doc.slice(SKILLS_ROOT.length + 1)}:${index + 1} bare "${ref}"`);
          }
        }
      }
    }
    expect(inconsistent).toEqual([]);
  });
});
