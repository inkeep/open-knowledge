import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const PROJECT_SKILL_PATH = join(import.meta.dir, '../assets/skills/project/SKILL.md');
const DISCOVERY_SKILL_PATH = join(import.meta.dir, '../assets/skills/discovery/SKILL.md');

const DOCS_URL = 'https://openknowledge.ai/docs';
const SOURCE_URL = 'https://github.com/inkeep/open-knowledge';

describe('bundled skills — capability lookup contract', () => {
  const project = readFileSync(PROJECT_SKILL_PATH, 'utf-8');
  const discovery = readFileSync(DISCOVERY_SKILL_PATH, 'utf-8');

  test('both skills point at the docs site and the source repo', () => {
    for (const text of [project, discovery]) {
      expect(text).toContain(`<${DOCS_URL}>`);
      expect(text).toContain(`<${SOURCE_URL}>`);
    }
  });

  test("discovery skill's description triggers on capability questions", () => {
    const frontmatter = discovery.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/^description:.*supports a particular capability/m);
  });

  test('capability sections enumerate no individual capability', () => {
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
