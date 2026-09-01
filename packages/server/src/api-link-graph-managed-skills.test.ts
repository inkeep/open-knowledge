import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

let tmpRoot: string;
let booted: BootedServer;

function writeSkill(contentDir: string, name: string, body: string): void {
  const dir = resolve(contentDir, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'SKILL.md'), body, 'utf-8');
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-linkgraph-managed-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));

  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nLinks to [[beta]].\n', 'utf-8');
  writeFileSync(resolve(contentDir, 'beta.md'), '# Beta\n\nBody.\n', 'utf-8');
  writeSkill(contentDir, 'open-knowledge', '---\nname: open-knowledge\n---\n\n# OK\n');
  writeSkill(
    contentDir,
    'open-knowledge-pack-worldbuilding',
    '---\nname: open-knowledge-pack-worldbuilding\n---\n\n# Pack\n',
  );
  writeSkill(contentDir, 'team-notes', '---\nname: team-notes\n---\n\n# Team\n');

  booted = await bootCompositionRig(contentDir);
  await booted.ready;
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('/api/link-graph managed-skill flagging', () => {
  test("project skills are graph nodes; only OK's own bundle is flagged", async () => {
    const res = await fetch(`http://127.0.0.1:${booted.port}/api/link-graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ docName?: string; managed?: boolean }>;
    };
    const flagByDocName = new Map(
      body.nodes
        .filter((n): n is { docName: string; managed?: boolean } => n.docName !== undefined)
        .map((n) => [n.docName, n.managed === true]),
    );

    expect([...flagByDocName.keys()].sort()).toEqual([
      '.claude/skills/open-knowledge-pack-worldbuilding/SKILL',
      '.claude/skills/open-knowledge/SKILL',
      '.claude/skills/team-notes/SKILL',
      'alpha',
      'beta',
    ]);

    expect([...flagByDocName.entries()].filter(([, flagged]) => flagged).map(([n]) => n)).toEqual([
      '.claude/skills/open-knowledge/SKILL',
    ]);
  });
});
