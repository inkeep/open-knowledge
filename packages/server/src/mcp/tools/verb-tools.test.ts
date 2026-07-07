/**
 * CRUD-verb surface tests — the load-bearing teaching-error mitigation (
 * the `target` discriminator the JSON Schema can't fully gate), the
 * server-required contract for folder + template mutations (server-routed for
 * attribution; the full round-trips move to the integration
 * suite), and the migration meta-test that fails if the shipped skill
 * surface still teaches a retired tool name.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerDelete } from './delete.ts';
import { register as registerEdit } from './edit.ts';
import type { ServerInstance } from './shared.ts';
import { register as registerWrite } from './write.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function capture<D>(register: (server: ServerInstance, deps: D) => void, cwd: string): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  register(server, {
    serverUrl: undefined,
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
  } as unknown as D);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

function newProject(): string {
  return mkdtempSync(join(tmpdir(), 'ok-verb-tools-'));
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('write — exactly-one-target teaching error (D8/D9 mitigation)', () => {
  test('zero targets returns the corrective shape', async () => {
    const write = capture(registerWrite, newProject());
    const r = await write({});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Name exactly one of');
    expect(textOf(r)).toContain('document'); // the corrective example names the targets
  });

  test('two targets returns a "name exactly ONE" error', async () => {
    const write = capture(registerWrite, newProject());
    const r = await write({ document: { path: 'a', content: '# a' }, folder: { path: 'b' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/name exactly ONE/i);
    expect(textOf(r)).toContain('document');
    expect(textOf(r)).toContain('folder');
  });
});

describe('edit — body-XOR-frontmatter + exactly-one-target teaching errors', () => {
  test('find without replace teaches the corrective shape', async () => {
    const edit = capture(registerEdit, newProject());
    const r = await edit({ document: { path: 'a', find: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('`find` needs a `replace`');
  });

  test('body + frontmatter in one call is rejected', async () => {
    const edit = capture(registerEdit, newProject());
    const r = await edit({
      document: { path: 'a', find: 'x', replace: 'y', frontmatter: { t: 1 } },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Pick ONE/i);
  });

  test('zero targets teaches exactly-one-target', async () => {
    const edit = capture(registerEdit, newProject());
    const r = await edit({});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Name exactly one of');
  });
});

describe('delete — exactly-one-target teaching error', () => {
  test('two targets rejected', async () => {
    const del = capture(registerDelete, newProject());
    const r = await del({ document: 'a', folder: 'b' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/name exactly ONE/i);
  });
});

describe('edit({ folder }) frontmatter — server-routed for attribution (PRD-6933 P2)', () => {
  // Folder frontmatter writes route through PUT /api/folder-config so they are
  // attributed in the folder timeline; they therefore require a running server.
  // The full round-trip (set → merge-patch → clear, on-disk shape, no `match`
  // fossil) + attribution is verified against a real server in the integration
  // suite — these unit tests pin only the server-required contract.
  test('requires a running server (attribution lives server-side)', async () => {
    const edit = capture(registerEdit, newProject());
    const r = await edit({
      folder: { path: 'meetings', frontmatter: { title: 'Meetings', tags: ['m'] } },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Hocuspocus server is not running');
  });
});

describe('write/edit/delete({ template }) — server-routed for attribution (PRD-6933 P2)', () => {
  // Template mutations route through PUT/DELETE /api/template so they are
  // attributed in the folder timeline; they therefore require a running server.
  // The full create → body edit → frontmatter patch → delete round-trip +
  // attribution is verified against a real server in the integration suite;
  // these unit tests pin only the server-required contract + name grammar
  // (which is rejected pre-server).
  test('mutations require a running server (attribution lives server-side)', async () => {
    const cwd = newProject();
    const write = capture(registerWrite, cwd);
    const edit = capture(registerEdit, cwd);
    const del = capture(registerDelete, cwd);
    const results = [
      await write({
        template: {
          path: 'fishing-log/trip-log',
          content: '# x',
          frontmatter: { title: 'Trip Log' },
        },
      }),
      await edit({ template: { path: 'fishing-log/trip-log', find: 'x', replace: 'y' } }),
      await del({ template: { path: 'fishing-log/trip-log' } }),
    ];
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Hocuspocus server is not running');
    }
  });

  test('invalid template name is rejected by the name grammar', async () => {
    const cwd = newProject();
    const write = capture(registerWrite, cwd);
    // The final segment is the template name; a dot violates /^[A-Za-z0-9_-]+$/.
    // `resolveTemplatePath` returns a teaching error (not a throw), so the
    // handler responds with `isError: true` and the file is never created.
    const r = await write({
      template: { path: 'x/a.b', content: 'ok', frontmatter: { title: 'A' } },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('must be letters, digits');
    expect(existsSync(join(cwd, 'x', '.ok', 'templates', 'a.b.md'))).toBe(false);
  });
});

describe('edit({ template }) — fence trailing whitespace (fm-delimiter hazard)', () => {
  // A body edit reads the template's frontmatter from disk and writes it
  // back through PUT /api/template. When the stored fences carry trailing
  // whitespace (`--- ` is one in-tolerance keystroke from `---`), the
  // read-back must still see the frontmatter — otherwise the edit silently
  // rewrites the template with `title: ''` and the FM lines leak into the
  // body. The PUT payload is the tool's observable contract with the server.
  test('a body edit preserves frontmatter stored under trailing-whitespace fences', async () => {
    const cwd = newProject();
    mkdirSync(join(cwd, 'fishing-log', '.ok', 'templates'), { recursive: true });
    writeFileSync(
      join(cwd, 'fishing-log', '.ok', 'templates', 'trip-log.md'),
      '--- \ntitle: Trip Log\ndescription: Catch log\n---\n\n# Log\n\nFish: none\n',
    );

    let putPayload: Record<string, unknown> | undefined;
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'PUT' && new URL(req.url).pathname === '/api/template') {
          putPayload = (await req.json()) as Record<string, unknown>;
          return Response.json({ path: 'fishing-log/.ok/templates/trip-log.md' });
        }
        return Response.json({ error: 'unexpected request' }, { status: 404 });
      },
    });
    try {
      let handler: Handler | undefined;
      const server = {
        registerTool(_name: string, _cfg: unknown, h: Handler) {
          handler = h;
        },
      } as unknown as ServerInstance;
      registerEdit(server, {
        serverUrl: `http://127.0.0.1:${stub.port}`,
        config: BASE_CONFIG,
        resolveCwd: async () => cwd,
      } as unknown as Parameters<typeof registerEdit>[1]);
      if (!handler) throw new Error('tool did not register');

      const r = await handler({
        template: { path: 'fishing-log/trip-log', find: 'none', replace: 'two bass' },
      });

      expect(r.isError).toBeUndefined();
      const fm = putPayload?.frontmatter as Record<string, unknown> | undefined;
      expect(fm?.title).toBe('Trip Log');
      expect(fm?.description).toBe('Catch log');
      const body = putPayload?.body as string | undefined;
      expect(body).toContain('two bass');
      expect(body).not.toContain('title: Trip Log');
    } finally {
      stub.stop(true);
    }
  });
});

describe('write({ document }) — template-availability nudge on create', () => {
  // Templates only get used if the agent knows they exist; it may write from
  // memory without an `exec ls` first. So a create into a folder that ships a
  // template, with no `template` passed, surfaces the folder's menu — without
  // blocking the write that already landed.
  function withWriteStub(cwd: string, run: (handler: Handler) => Promise<void>) {
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'POST' && new URL(req.url).pathname === '/api/agent-write-md') {
          const body = (await req.json()) as { docName?: string };
          return Response.json({
            docName: body.docName,
            systemSubscriberCount: 1,
            brokenLinks: [],
          });
        }
        return Response.json({ error: 'unexpected request' }, { status: 404 });
      },
    });
    let handler: Handler | undefined;
    const server = {
      registerTool(_name: string, _cfg: unknown, h: Handler) {
        handler = h;
      },
    } as unknown as ServerInstance;
    registerWrite(server, {
      serverUrl: `http://127.0.0.1:${stub.port}`,
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
    } as unknown as Parameters<typeof registerWrite>[1]);
    if (!handler) throw new Error('tool did not register');
    return (async () => {
      try {
        await run(handler);
      } finally {
        stub.stop(true);
      }
    })();
  }

  function seedNoteTemplate(cwd: string) {
    mkdirSync(join(cwd, 'notes', '.ok', 'templates'), { recursive: true });
    writeFileSync(
      join(cwd, 'notes', '.ok', 'templates', 'note.md'),
      '---\ntitle: Note\ndescription: A plain note\n---\n\n# \n',
    );
  }

  test('create with no template nudges toward the folder template (text + structured)', async () => {
    const cwd = newProject();
    seedNoteTemplate(cwd);
    await withWriteStub(cwd, async (write) => {
      const r = await write({ document: { path: 'notes/first', content: '# First\n' } });
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).toContain('templates you can start from: note (A plain note)');
      const doc = (r.structuredContent?.document ?? {}) as Record<string, unknown>;
      const hint = doc.templateHint as Array<{ name: string }> | undefined;
      expect(hint?.[0]?.name).toBe('note');
    });
  });

  test('create WITH a template does not nudge', async () => {
    const cwd = newProject();
    seedNoteTemplate(cwd);
    await withWriteStub(cwd, async (write) => {
      const r = await write({ document: { path: 'notes/second', template: 'note' } });
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).not.toContain('templates you can start from');
    });
  });

  test('create in a folder with no templates does not nudge', async () => {
    const cwd = newProject();
    mkdirSync(join(cwd, 'scratch'), { recursive: true });
    await withWriteStub(cwd, async (write) => {
      const r = await write({ document: { path: 'scratch/note', content: '# Note\n' } });
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).not.toContain('templates you can start from');
    });
  });
});

describe('D13 migration meta-test — no retired tool name survives in the skill surface', () => {
  const RETIRED = [
    'write_document',
    'edit_document',
    'edit_frontmatter',
    'delete_document',
    'folder_config',
    'set_folder_rule',
    'write_template',
    'delete_template',
    'rename_document',
    'rename_folder',
    // merges/splits + get_ prefix drops. Only snake_case names that can't
    // collide with prose are listed here — `ingest` / `research` / `consolidate` /
    // `discover` survive as `workflow({ kind })` values, and `version` (now split
    // into the standalone `checkpoint` + `restore_version` tools) is an ordinary
    // English word; all are guarded by the registry test, not this bare-substring
    // scan.
    'get_history',
    'get_config',
    'get_preview_url',
    'get_components',
    'get_authoring_palette',
    'list_conflicts',
    'get_conflict_content',
  ];

  function mdFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...mdFiles(p));
      else if (entry.endsWith('.md') || entry.endsWith('.mdx')) out.push(p);
    }
    return out;
  }

  test('packages/server/assets/skills/** teaches only the verb surface', () => {
    const skillsDir = fileURLToPath(new URL('../../../assets/skills', import.meta.url));
    const offenders: string[] = [];
    for (const file of mdFiles(skillsDir)) {
      const body = readFileSync(file, 'utf-8');
      for (const name of RETIRED) {
        if (body.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
