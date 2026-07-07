/**
 * `skills` MCP tool — the READ half of the skill vocabulary (list + read).
 *
 * Skills are first-class addressed entities (name + scope), like
 * `document`/`folder`/`template`. The mutate verbs (`write`/`edit`/`delete`/
 * `move`/`install` over `skill`) already exist; this is the missing read half.
 * It exposes the SAME index the Skills sidebar uses (`GET /api/skills`, spanning
 * Project + Global scopes) plus per-skill content (`GET /api/skill`), so an agent
 * NEVER browses `.ok/` to find or read a skill — `.ok/` stays opaque (no `ls`,
 * no raw `.ok/skills/...` paths). Read-only; mutation stays with the verb tools.
 */
import { z } from 'zod';
import { BUNDLE_SKILL_NAME } from '../../skill-bundles.ts';
import {
  type ConfigOrResolver,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  type ServerInstance,
  type ServerUrlOrResolver,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { fetchSkill, readSkillFile, type SkillScope } from './skill-target.ts';
import { resolveSkillFilePath, SkillScopeArg } from './verb-schemas.ts';

/**
 * Classify a bundle-file path into its kind by its allowed-root prefix. Used to
 * project `GET /api/skill`'s inline `files` list into the `{ path, kind }`
 * shape — the list response drops `text` (no inline content), so an agent
 * lists first, then reads one file via `skills({ name, file })`.
 */
function bundleFileKind(path: string): 'reference' | 'script' {
  return path.replace(/\\/g, '/').startsWith('scripts/') ? 'script' : 'reference';
}

/**
 * OK's own shipped bundle skills (`open-knowledge`, `open-knowledge-discovery`,
 * `open-knowledge-write-skill`) are runtime agent skills projected into editor
 * host dirs — they have no `.ok/skills` source and can never be authored as
 * content skills (the reserved-name gate blocks it), so this tool can never
 * READ them. They are addressed by `BUNDLE_SKILL_NAME` here so the set tracks
 * the canonical bundle list.
 */
const INTERNAL_BUNDLE_SKILL_NAMES = new Set<string>(Object.values(BUNDLE_SKILL_NAME));

/**
 * Teaching error for a READ aimed at one of OK's built-in skills. Without it,
 * an agent told to "load the open-knowledge skill" calls
 * `skills({ name: "open-knowledge" })`, hits a bare `Skill not found.` 404, and
 * falls back to cat-ing the bundled SKILL.md — a confusing dead end. The skill
 * is already in the agent's loaded skill list; it must not be fetched here.
 */
function internalSkillHint(name: string): string {
  return [
    `"${name}" is one of OpenKnowledge's built-in agent skills — it is NOT managed by this tool and cannot be read or listed here.`,
    "It is already provided to you in your loaded skill list (a hidden runtime skill projected into your editor); don't fetch or re-load it — just follow the skill you already have.",
    'The `skills` tool only covers skills authored as KB content (`.ok/skills` = project, `~/.ok/skills` = global). Built-in `open-knowledge*` skills never appear in either scope.',
  ].join(' ');
}

// Scope reads the same on the wire and in the UI — `project` / `global`
// (matching the verbs, `/api/skills`, and the persisted `__skill__/global/`
// doc names). Stated overtly so an agent knows exactly which level it targets.
const SCOPE_FIELD_DESCRIBE =
  "Which level the skill lives at. `project` = this KB's `.ok/skills/` (shared via git with everyone on the project); `global` = your user-level `~/.ok/skills/` (available in every project on this machine, not shared).";

/** One row of the skills index, as the tool projects it. NO filesystem path —
 *  skills are addressed by `name` + `scope`, never by a `.ok/` path. */
const SkillListEntryOutputSchema = z.object({
  name: z.string().describe('Skill name (its identity; pass to `edit`/`move`/`delete`/`install`).'),
  scope: z.enum(['project', 'global']).describe(SCOPE_FIELD_DESCRIBE),
  description: z.string().optional().describe("The skill's one-line description (when present)."),
  installed: z.boolean().describe('True when projected into ≥1 editor; false = a Draft.'),
  hosts: z.array(z.string()).describe('Editor ids the skill is installed into.'),
  updateAvailable: z
    .boolean()
    .optional()
    .describe('Starter-pack skills only: a newer bundled version is available.'),
});

/** One bundle-file row in a skill READ: path + kind, NO inline content. */
const SkillBundleFileEntrySchema = z.object({
  path: z.string().describe('Skill-relative path (e.g. "references/tiers.md").'),
  kind: z
    .enum(['reference', 'script'])
    .describe('`reference` (under references/) or `script` (under scripts/).'),
});

const SkillReadOutputSchema = z.object({
  name: z.string().describe('Skill name (its identity).'),
  scope: z.enum(['project', 'global']).describe(SCOPE_FIELD_DESCRIBE),
  description: z.string().describe("The skill's one-line description (empty if none)."),
  body: z.string().describe('The SKILL.md body (markdown, frontmatter stripped).'),
  files: z
    .array(SkillBundleFileEntrySchema)
    .describe('Bundle files beside SKILL.md (path + kind, no inline text). Read one via `file`.'),
});

const SkillFileReadOutputSchema = z.object({
  path: z.string().describe('Skill-relative path read.'),
  kind: z.enum(['reference', 'script']).describe('`reference` or `script`.'),
  text: z.string().describe('Full text of the bundle file.'),
});

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Read-only discovery for SKILLS — the read half of the skill vocabulary (`write`/`edit`/`delete`/`move`/`install` are the mutate half).',
  '',
  'This is how you find and read skills. Skills are addressed by `name` + `scope`, NOT by path — do NOT `ls`/`cat` `.ok/skills/` or pass raw `.ok/...` paths; `.ok/` is opaque internal state.',
  '',
  "Covers only skills authored as KB content. OpenKnowledge's own built-in `open-knowledge*` skills (e.g. the `open-knowledge` project skill) are runtime skills already loaded in your skill list — they are NOT here, and you never fetch them through this tool.",
  '',
  '**Three modes:**',
  '- **List** (omit `name`): every skill across BOTH levels — Project (this KB) and Global (user-level). Returns name, scope, description, installed/hosts, and (for starter packs) `updateAvailable`.',
  "- **Read skill** (pass `name`): that skill's description + body + a `files` list (`{ path, kind }`, no inline text) of its `references/**`+`scripts/**` bundle files. `scope` optional — omitted, it resolves by name (preferring Project when a name exists at both levels).",
  "- **Read file** (pass `name` + `file`): one bundle file's text — the universal read path for references + scripts (no native `cat`).",
].join('\n');

export interface SkillsToolDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

export function register(server: ServerInstance, deps: SkillsToolDeps): void {
  server.registerTool(
    'skills',
    {
      description: DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Omit to LIST all skills; pass a skill name to READ that skill.'),
        file: z
          .string()
          .optional()
          .describe(
            'With `name`: read ONE bundle file by its skill-relative path (`references/...`/`scripts/...`).',
          ),
        scope: SkillScopeArg.optional(),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        skills: z
          .array(SkillListEntryOutputSchema)
          .optional()
          .describe('Present in LIST mode: every skill across Project + Global levels.'),
        skill: SkillReadOutputSchema.optional().describe(
          'Present in READ-skill mode: the named skill (description, body, files list).',
        ),
        file: SkillFileReadOutputSchema.optional().describe(
          'Present in READ-file mode: one bundle file (path, kind, text).',
        ),
      }),
    },
    async (args: { name?: string; file?: string; scope?: SkillScope; cwd?: string }) => {
      // OK's own built-in skills are runtime/agent skills, never content skills —
      // short-circuit before touching cwd/server so the error teaches (rather
      // than 404s) regardless of scope or whether a server is running.
      if (args.name !== undefined && INTERNAL_BUNDLE_SKILL_NAMES.has(args.name)) {
        return textResult(`Error: ${internalSkillHint(args.name)}`, true);
      }

      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      // `file` is a READ-file selector — it needs a `name` to address the skill.
      if (args.file !== undefined && args.name === undefined) {
        return textResult(
          'Error: `file` reads ONE bundle file of a skill — pass `name` too: skills({ name, file: "references/x.md" }).',
          true,
        );
      }
      if (args.file !== undefined) {
        const check = resolveSkillFilePath(args.file);
        if (!check.ok) return textResult(`Error: ${check.error}`, true);
      }

      // LIST mode — the same index the Skills sidebar uses (both scopes).
      if (args.name === undefined) {
        const result = await httpGet(url, '/api/skills');
        if (!result.ok) return textResult(`Error: ${result.error}`, true);
        const { ok: _ok, ...data } = result;
        const rawSkills = Array.isArray((data as { skills?: unknown }).skills)
          ? ((data as { skills: unknown[] }).skills as Array<Record<string, unknown>>)
          : [];
        // Project to the tool shape — deliberately DROP `path`/`absolutePath`
        // so skills stay addressed by name+scope and `.ok/` is never surfaced.
        const skills = rawSkills.map((s) => ({
          name: s.name,
          scope: s.scope,
          ...(typeof s.description === 'string' ? { description: s.description } : {}),
          installed: s.installed === true,
          hosts: Array.isArray(s.hosts) ? s.hosts : [],
          ...(typeof s.updateAvailable === 'boolean' ? { updateAvailable: s.updateAvailable } : {}),
        }));
        return textPlusStructured(JSON.stringify({ skills }, null, 2), { skills });
      }

      // READ mode — resolve scope (explicit, else by name across the index).
      let scope = args.scope;
      if (scope === undefined) {
        const list = await httpGet(url, '/api/skills');
        if (!list.ok) return textResult(`Error: ${list.error}`, true);
        const { ok: _ok, ...listData } = list;
        const rows = Array.isArray((listData as { skills?: unknown }).skills)
          ? ((listData as { skills: unknown[] }).skills as Array<Record<string, unknown>>)
          : [];
        const matches = rows.filter((s) => s.name === args.name);
        if (matches.length === 0) {
          return textResult(`Error: no skill named "${args.name}" (Project or Global).`, true);
        }
        // Prefer Project when a name exists at both levels (mirrors editor scope
        // precedence); otherwise use the single matching scope.
        scope =
          matches.find((s) => s.scope === 'project') !== undefined
            ? 'project'
            : (matches[0]?.scope as SkillScope);
      }

      // READ-FILE mode — one bundle file's text (universal read path; works for
      // scripts + global refs that aren't graph-visible).
      if (args.file !== undefined) {
        const fileRead = await readSkillFile(url, scope, args.name, args.file);
        if (!fileRead.ok) return textResult(`Error: ${fileRead.error}`, true);
        const file = { path: fileRead.path, kind: fileRead.kind, text: fileRead.text };
        return textPlusStructured(JSON.stringify({ file }, null, 2), { file });
      }

      // READ-SKILL mode — description + body + the bundle-file list (no inline
      // text; an agent reads one file via `skills({ name, file })`).
      const read = await fetchSkill(url, scope, args.name);
      if (!read.ok) return textResult(`Error: ${read.error}`, true);
      const skill = {
        name: args.name,
        scope,
        description: read.description,
        body: read.body,
        files: read.files.map((f) => ({ path: f.path, kind: bundleFileKind(f.path) })),
      };
      return textPlusStructured(JSON.stringify({ skill }, null, 2), { skill });
    },
  );
}
