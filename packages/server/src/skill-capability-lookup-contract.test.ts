import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Guards the capability-lookup pointers in both bundled skills.
 *
 * The skills describe the core editing flow, so anything outside it is only
 * reachable if the agent knows to look it up. Two properties are load-bearing
 * and neither is enforced by anything else:
 *
 * - The discovery skill's `description` names capability questions. That field
 *   is the skill's activation contract — the section below it never loads on a
 *   capability ask without the clause, so dropping it silently disables the
 *   pointer while leaving the prose in place.
 * - Both skills carry the docs and source URLs. These are the whole mechanism;
 *   losing one leaves the framing sentence pointing nowhere.
 *
 * The sections deliberately name no individual capability: an enumerated list
 * drifts as features ship, which is the failure this guidance exists to avoid.
 */

const PROJECT_SKILL_PATH = join(import.meta.dir, '../assets/skills/project/SKILL.md');
const DISCOVERY_SKILL_PATH = join(import.meta.dir, '../assets/skills/discovery/SKILL.md');

const DOCS_URL = 'https://openknowledge.ai/docs';
const SOURCE_URL = 'https://github.com/inkeep/open-knowledge';

describe('bundled skills — capability lookup contract', () => {
  const project = readFileSync(PROJECT_SKILL_PATH, 'utf-8');
  const discovery = readFileSync(DISCOVERY_SKILL_PATH, 'utf-8');

  test('both skills point at the docs site and the source repo', () => {
    // Assert the angle-bracket autolink form. A bare `toContain(SOURCE_URL)`
    // passes vacuously off the frontmatter's `repository:` value, which is the
    // superstring `.../open-knowledge-skills`, so the guard would stay green
    // with the body link deleted.
    for (const text of [project, discovery]) {
      expect(text).toContain(`<${DOCS_URL}>`);
      expect(text).toContain(`<${SOURCE_URL}>`);
    }
  });

  test("discovery skill's description triggers on capability questions", () => {
    // Anchor to the `description:` key. Skill routing reads that field alone,
    // so an unanchored match would stay green if the clause moved to
    // `compatibility:` or `metadata:` while the skill stopped triggering.
    const frontmatter = discovery.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/^description:.*supports a particular capability/m);
  });

  test('capability sections enumerate no individual capability', () => {
    // Slice from each heading to the next one. Assert the heading was found
    // first — a missing heading would otherwise slice to nothing and pass the
    // negative match vacuously.
    const section = (text: string, heading: string): string => {
      const start = text.indexOf(heading);
      expect(start, `heading not found: ${heading}`).toBeGreaterThan(-1);
      const rest = text.slice(start);
      const end = rest.indexOf('\n## ', heading.length);
      const body = end === -1 ? rest : rest.slice(0, end);
      expect(body.length, `empty section: ${heading}`).toBeGreaterThan(heading.length);
      return body;
    };

    for (const body of [
      section(project, '## Capabilities beyond this skill'),
      section(discovery, '## What else OK does'),
    ]) {
      expect(body).not.toMatch(/OKF|Slidev|themes|network access/i);
    }
  });
});
