import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const skill = readFileSync(join(import.meta.dirname, '../assets/skills/project/SKILL.md'), 'utf8');

const safetyAnchors = [
  '## STOP — native tools on in-scope `.md` / `.mdx`',
  '## Grounding — every factual claim needs a source (MUST)',
  '## Linking — standard markdown links (MUST)',
  '**Read the folder before writing (MUST).**',
  '**Use a template when one fits (MUST).**',
  '**When recurring per-doc properties emerge (MUST).**',
  '**Preview / open a doc — determine your ONE surface FIRST (once per session).**',
  '**Persist incrementally — the knowledge base IS your checkpoint (MUST).**',
];

const routingRules = [
  {
    name: 'markdown reads and source-code escape',
    anchor: '1. **Reads:**',
    required: [
      '`exec("cat …")`',
      '`exec("ls -A …")`',
      '`exec("grep …")`',
      '`search` for ranked retrieval',
      'never on in-scope `.md` / `.mdx`',
    ],
  },
  {
    name: 'body and metadata writes',
    anchor: '2. **Writes:**',
    required: [
      'edit({ document: { path, frontmatter } })',
      '`null` deletes a key',
      'Body find/replace is body-only',
      'one-line `summary`',
    ],
  },
  {
    name: 'preview surface selection',
    anchor: '3. **Preview / open a doc',
    required: [
      'Stop at first match',
      '`OK_DESKTOP_TERMINAL` or `OK_HOSTED_AGENT`',
      '`ok open <name>`',
      'in-app browser',
      '`preview_url`, then open/navigate',
      "Don't `preview_screenshot` to confirm edits",
    ],
  },
  {
    name: 'direct questions before persistence',
    anchor: '4. **Direct questions:**',
    required: [
      '`search` / `exec` + a cited chat answer',
      'Persist only when durable + multi-doc + not already covered, and *offer* first',
    ],
  },
  {
    name: 'skill source routing',
    anchor: '5. **Authoring or improving a skill**',
    required: [
      'STOP and invoke **`/open-knowledge-write-skill`**',
      'Author through `write({ skill })`, never a document path',
      'Read/edit via `skills` and `edit({ skill })`',
      'Never hand-edit a non-source copy',
    ],
  },
  {
    name: 'validation coverage and link authority',
    anchor: '**Read `ran`**',
    required: [
      'a family absent from `ran` was not checked',
      '`[]` means no checks were selected',
      'For link VALIDATION use audit; links reports relationships',
    ],
  },
  {
    name: 'skill placement and move recovery',
    anchor: 'Skill placement is separate from skill content:',
    required: [
      'removing an installed copy does not delete the skill',
      'history resets',
      '`droppedLocations` (success: re-add with install)',
      'Read the returned outcome before recovery',
      'self-only (does NOT cascade)',
    ],
  },
  {
    name: 'markdown MCP-only routing',
    anchor: '**Route every in-scope markdown read and write',
    required: [
      "through OK's MCP tools — never your host's native file tools",
      'Native `Edit` / `sed` / direct `Write`',
      'native reads skip frontmatter, backlinks',
    ],
  },
  {
    name: 'tool discovery before declaring MCP unavailable',
    anchor: '**Not seeing `exec` is NOT the escape hatch.**',
    required: [
      'Registration is the test, not top-level-symbol visibility',
      'run tool discovery for `open-knowledge` first',
    ],
  },
  {
    name: 'narrow and visible native-tool fallback',
    anchor: '**Escape hatch.**',
    required: [
      'allowed **only** when, after running tool discovery',
      'no OpenKnowledge MCP server is registered',
      'immediately after you actually invoked an MCP call and it failed',
      'begin a user-visible sentence with `OpenKnowledge MCP unavailable:`',
    ],
  },
  {
    name: 'incremental persistence',
    anchor: '**Persist incrementally',
    required: [
      'write completed work to the KB as you finish each unit',
      'Never hold finished findings only in your context',
      'Create the target doc early',
    ],
  },
  {
    name: 'local evidence for factual claims',
    anchor: '- **Every factual claim MUST',
    required: ['cite its source at the point of claim', 'No unsourced speculation'],
  },
  {
    name: 'ingest before citing external sources',
    anchor: '- **Closed loop.**',
    required: [
      'pulled in by the ingest procedure, then cited locally',
      '**not** a citation',
      'every leaf is a local doc',
    ],
  },
  {
    name: 'link resolution after writes',
    anchor: 'Link every noun-phrase',
    required: [
      'Every link must resolve to a doc that exists',
      'After every `write`/`edit`, read `brokenLinks`: fix reported `href`s',
      '`brokenLinkSuppression` withheld reserved-log findings (not yours to repair)',
      'a `link-check-deferred` warning says nothing was checked yet',
      '`audit` is authoritative',
    ],
  },
  {
    name: 'folder context before writes',
    anchor: '- **Read the folder before writing (MUST).**',
    required: [
      'call `exec("ls -A <folder>")` once per folder per session',
      '`templates_available`',
    ],
  },
  {
    name: 'template selection',
    anchor: '- **Use a template when one fits (MUST).**',
    required: [
      'write({ document: { path, template } })',
      'inherited templates count',
      'Skip only when none match or the user asked for free-form',
    ],
  },
  {
    name: 'template defaults instead of cascading folder metadata',
    anchor: '- **When recurring per-doc properties emerge (MUST).**',
    required: ['write({ template })', 'Folder frontmatter does not cascade values into docs'],
  },
  {
    name: 'tracked conflict recovery in the app',
    anchor: 'For a conflict refusal,',
    required: [
      "follow the tool's recovery instructions",
      '`references/conflict-resolution.md`',
      'ask the user to resolve tracked conflicts in the app',
    ],
  },
  {
    name: 'procedure and log contracts',
    anchor: "Don't chain silently:",
    required: [
      'let the user drive ingest → research → consolidate',
      "a procedure's STOP gates override",
      'After any turn that changes KB content, check for a `log.md` and follow its contract',
    ],
  },
  {
    name: 'content scope and worktree routing',
    anchor: 'OK looks for documents under',
    required: [
      'resolved `content.dir`',
      '`.gitignore` and `.okignore`',
      'not excluded is an OpenKnowledge document',
      "Pass the worktree's absolute path as `cwd`",
    ],
  },
];

function assertRoutingRule(text: string, rule: (typeof routingRules)[number]): void {
  const paragraph = text.split('\n').find((line) => line.startsWith(rule.anchor));
  expect(paragraph, rule.name).toBeDefined();
  for (const required of rule.required) expect(paragraph, rule.name).toContain(required);
}

describe('project skill tool selection and safety contract', () => {
  test.each(routingRules)('retains the $name instructions, beyond their heading', (rule) => {
    assertRoutingRule(skill, rule);
  });

  test.each(routingRules)(
    'removing a $name instruction is detected even with its heading',
    (rule) => {
      const paragraph = skill.split('\n').find((line) => line.startsWith(rule.anchor));
      if (paragraph === undefined) throw new Error(`Missing rule: ${rule.name}`);
      for (const required of rule.required) {
        const incomplete = skill.replace(paragraph, paragraph.replaceAll(required, ''));
        expect(incomplete).toContain(rule.anchor);
        expect(() => assertRoutingRule(incomplete, rule), required).toThrow();
      }
    },
  );

  test.each(safetyAnchors)('retains %s in the core skill', (anchor) => {
    expect(skill).toContain(anchor);
  });

  test('keeps one worked call for every content verb and teaching-error recovery', () => {
    for (const call of [
      'write({ document: { path, content } })',
      'edit({ document: { path, find, replace } })',
      'delete({ document })',
      'move({ from, to })',
    ])
      expect(skill).toContain(call);
    expect(skill).toContain('Read it and retry with that shape');
  });

  test('keeps the tool router compact and delegates calling contracts', () => {
    const router = skill.split('## Tool index')[1]?.split('**Self-correcting on misuse:')[0];
    expect(router).toBeDefined();
    expect(router).toContain('calling contracts live in tool descriptions and input schemas');
    expect(Buffer.byteLength(router ?? '', 'utf8')).toBeLessThanOrEqual(2_000);
    expect(skill).not.toContain('## Reads — examples');
    expect(skill).not.toContain('## Server lifecycle');
    expect(skill).toContain('references/conflict-resolution.md');
  });
});
