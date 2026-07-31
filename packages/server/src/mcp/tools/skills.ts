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
import { EDITOR_PROJECT_SKILL_ROOT, EDITOR_USER_SKILL_ROOT } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { INTERNAL_BUNDLE_SKILL_NAMES, isInternalBundleSkillName } from '../../skill-bundles.ts';
import {
  type ConfigOrResolver,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGetRows,
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
 * Project one raw `/api/skills` row into the tool's location-model shape:
 * every physical location with its role (`source` first — the skill's real
 * folder), audience (folder aliases resolving into it), and drift. This is
 * the read half of the location verbs on `install` (add/remove/mode/source).
 */
function projectListRow(s: Record<string, unknown>): {
  name: unknown;
  scope: unknown;
  description?: string;
  installed: boolean;
  hosts: string[];
  locations: Array<{
    id: string;
    path: string;
    role: 'source' | 'copy' | 'symlink';
    audience?: string[];
    drift?: boolean;
  }>;
  mode?: 'copy' | 'link';
  conflicts?: string[];
} {
  const name = String(s.name);
  const scope = s.scope === 'global' ? 'global' : 'project';
  const hosts = Array.isArray(s.hosts) ? (s.hosts as string[]) : [];
  const linked = new Set(Array.isArray(s.symlinkedHosts) ? (s.symlinkedHosts as string[]) : []);
  const aliases = (s.hostAliases ?? {}) as Record<string, string>;
  const drift = new Set(Array.isArray(s.driftPaths) ? (s.driftPaths as string[]) : []);
  const rootOf = (h: string): string => {
    if (h === 'agents') return '.agents/skills';
    if (h.includes('/')) return h; // custom-root id IS its path
    const map = scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT;
    return (map as Record<string, string | null>)[h] ?? h;
  };
  const subsOf = (root: string): string[] =>
    Object.keys(aliases).filter((k) => aliases[k] === root);
  const locations = hosts.map((h, i) => {
    const root = rootOf(h);
    const path = `${root}/${name}`;
    const audience = subsOf(root);
    return {
      id: h,
      path,
      role: (i === 0 ? 'source' : linked.has(h) ? 'symlink' : 'copy') as
        | 'source'
        | 'copy'
        | 'symlink',
      ...(audience.length > 0 ? { audience } : {}),
      ...(drift.has(path) ? { drift: true } : {}),
    };
  });
  // Recorded custom placements not already surfaced as scan hosts.
  const placements = Array.isArray(s.customPlacements)
    ? (s.customPlacements as Array<{ path: string; mode: 'copy' | 'link' }>)
    : [];
  for (const cp of placements) {
    if (locations.some((l) => l.path === cp.path)) continue;
    const root = cp.path.split('/').slice(0, -1).join('/');
    const audience = subsOf(root);
    locations.push({
      id: root,
      path: cp.path,
      role: cp.mode === 'link' ? 'symlink' : 'copy',
      ...(audience.length > 0 ? { audience } : {}),
      ...(drift.has(cp.path) ? { drift: true } : {}),
    });
  }
  const conflicts = Array.isArray(s.conflictHosts) ? (s.conflictHosts as string[]) : [];
  return {
    name: s.name,
    scope: s.scope,
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
    installed: s.installed === true,
    hosts: locations.map((l) => l.id),
    locations,
    mode: s.linkMode === true ? ('link' as const) : ('copy' as const),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

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
    'The `skills` tool covers skills wherever they live — editor dirs (`.claude/skills`, …), the `.agents/skills` hub, custom roots, and the legacy `.ok/skills` store, at project AND global (user-home) level. Built-in `open-knowledge*` skills never appear.',
  ].join(' ');
}

// Scope reads the same on the wire and in the UI — `project` / `global`
// (matching the verbs, `/api/skills`, and the persisted `__skill__/global/`
// doc names). Stated overtly so an agent knows exactly which level it targets.
const SCOPE_FIELD_DESCRIBE =
  'Which level the skill lives at. `project` = lives in this KB (wherever its folder is; shared via git); `global` = user-level under your home dir (available in every project on this machine, not shared).';

/** One LOCATION holding the skill: its id (pass to `install` add/remove/
 *  source), its bundle dir, and what it physically IS there. The `source`
 *  role is the skill itself — one per skill, always present. */
const SkillLocationEntryOutputSchema = z.object({
  id: z
    .string()
    .describe('Location id — editor host id, `agents`, or a custom root path. Pass to `install`.'),
  path: z
    .string()
    .describe(
      'Base-relative bundle dir (e.g. ".claude/skills/x"). INFORMATIONAL — for showing a user where a location lives. Skills are addressed by `name` + `scope`: pass `id` to `install`, and read bundle files with `skills({ name, file })`, never by handing this path to `exec` or a native file tool.',
    ),
  role: z
    .enum(['source', 'copy', 'symlink'])
    .describe(
      'source = the REAL folder (the skill itself); copy = independent folder, auto-refreshed from the source until hand-edited (then it forks); symlink = live link to the source.',
    ),
  audience: z
    .array(z.string())
    .optional()
    .describe(
      'Folders that RESOLVE INTO this location (folder-level symlinks) — their agents read what lands here.',
    ),
  drift: z
    .boolean()
    .optional()
    .describe('Something outside OK rewrote this path since OK last wrote it.'),
});

/** One row of the skills index, as the tool projects it. */
const SkillListEntryOutputSchema = z.object({
  name: z.string().describe('Skill name (its identity; pass to `edit`/`move`/`delete`/`install`).'),
  scope: z.enum(['project', 'global']).describe(SCOPE_FIELD_DESCRIBE),
  description: z.string().optional().describe("The skill's one-line description (when present)."),
  installed: z
    .boolean()
    .describe(
      'Always true for a managed skill — its source folder IS the skill, so it is never "not installed". Read `locations[]` for where it actually lives.',
    ),
  hosts: z
    .array(z.string())
    .describe('Flat location ids (locations[].id), SOURCE first — legacy projection.'),
  locations: z
    .array(SkillLocationEntryOutputSchema)
    .describe(
      "Everywhere the skill lives. Exactly one `source` (the skill's real folder); every other entry is a managed copy or symlink of it.",
    ),
  mode: z
    .enum(['copy', 'link'])
    .describe(
      'The form a NEW location would take, derived from the ones the skill already uses. Not a stored preference and not a claim about existing locations — read `locations[].role` for those.',
    ),
  conflicts: z
    .array(z.string())
    .optional()
    .describe('Host ids where a DIFFERENT skill with this name occupies the slot.'),
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

const SkillMarketplaceResultOutputSchema = z.object({
  name: z.string().describe('Skill name to pass as `skill` to `import`.'),
  source: z
    .string()
    .describe(
      'Import-ready repository coordinates or website hostname. Pass this exact value to `import`.',
    ),
  description: z
    .string()
    .describe('Marketplace description for deciding whether the skill matches the task.'),
  installs: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('skills.sh install count, if known.'),
  publisher: z.string().nullable().describe('Publisher, website, or GitHub owner, if known.'),
});

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Read-only discovery for SKILLS — the read half of the skill vocabulary (`write`/`edit`/`delete`/`move`/`install` are the mutate half).',
  '',
  'This is how you search the marketplace, list managed skills, and read managed skill content. Managed skills are addressed by `name` + `scope`, NOT by path — do NOT `ls`/`cat` `.ok/skills/` or pass raw `.ok/...` paths; `.ok/` is opaque internal state.',
  '',
  'Marketplace rows are external candidates; they are NOT managed content until you call `import({ source, skill: name })`, and they are NOT active in editors until `install` projects them.',
  '',
  "OpenKnowledge's own built-in `open-knowledge*` skills (e.g. the `open-knowledge` project skill) are runtime skills already loaded in your skill list — they are NOT here, and you never fetch them through this tool.",
  '',
  '**Four modes:**',
  '- **Marketplace search** (pass `query`): search skills.sh and return import-ready rows (`name`, `source`, `description`, `publisher`, installs). Use when a user asks to find/browse/add an external skill. Then call `import({ source, skill: name })` on the chosen row.',
  '- **List** (omit `name`): every skill across BOTH levels — Project (this KB) and Global (user-level). Returns name, scope, description, installed/hosts.',
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
        query: z
          .string()
          .optional()
          .describe(
            'Marketplace search query for skills.sh. Use this before `import` when looking for an external skill; do not combine with `name` or `file`.',
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Managed skill name. Omit to LIST all managed skills; pass a name to READ that skill.',
          ),
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
        results: z
          .array(SkillMarketplaceResultOutputSchema)
          .optional()
          .describe(
            'Present in Marketplace search mode: import-ready external skill candidates. Pick one, then call `import({ source, skill: name })`.',
          ),
        backend: z
          .enum(['skills.sh', 'github-fallback'])
          .optional()
          .describe('Marketplace backend that answered the query.'),
        degraded: z
          .boolean()
          .optional()
          .describe('True when the GitHub fallback answered instead of skills.sh.'),
      }),
    },
    async (args: {
      query?: string;
      name?: string;
      file?: string;
      scope?: SkillScope;
      cwd?: string;
    }) => {
      if (args.query !== undefined && (args.name !== undefined || args.file !== undefined)) {
        return textResult(
          'Error: `query` is marketplace search mode — do not combine it with `name` or `file`.',
          true,
        );
      }

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

      if (args.query !== undefined) {
        const q = args.query.trim();
        if (q.length < 2) {
          // Returning an empty result set with `backend: 'skills.sh'` claimed the
          // marketplace had answered when no request was made, so the agent
          // concluded nothing was published and stopped instead of broadening.
          return textResult(
            'Error: `query` needs at least 2 characters — the skills.sh search rejects shorter terms.',
            true,
          );
        }
        const searchRes = await httpGetRows(
          url,
          `/api/skills/search?q=${encodeURIComponent(q)}`,
          'results',
        );
        if ('error' in searchRes) return textResult(`Error: ${searchRes.error}`, true);
        const { rows: rawResults, data } = searchRes;
        const results = rawResults.flatMap((r) => {
          if (typeof r.name !== 'string' || typeof r.source !== 'string') return [];
          return [
            {
              name: r.name,
              source: r.source,
              description: typeof r.description === 'string' ? r.description : '',
              installs:
                typeof r.installs === 'number' && Number.isInteger(r.installs) && r.installs >= 0
                  ? r.installs
                  : null,
              publisher: typeof r.publisher === 'string' ? r.publisher : null,
            },
          ];
        });
        const backend =
          (data as { backend?: unknown }).backend === 'github-fallback'
            ? 'github-fallback'
            : 'skills.sh';
        const degraded = (data as { degraded?: unknown }).degraded === true;
        return textPlusStructured(JSON.stringify({ results, backend, degraded }, null, 2), {
          results,
          backend,
          degraded,
        });
      }

      // `file` is a READ-file selector — it needs a `name` to address the skill.
      if (args.file !== undefined && args.name === undefined) {
        return textResult(
          'Error: `file` reads ONE bundle file of a skill — pass `name` too: skills({ name, file: "references/x.md" }).',
          true,
        );
      }
      // Normalized once here (separators, `.`/empty segments) and reused below —
      // sending the raw string on would make this validation dead code.
      let bundleFilePath: string | undefined;
      if (args.file !== undefined) {
        const check = resolveSkillFilePath(args.file);
        if (!check.ok) return textResult(`Error: ${check.error}`, true);
        bundleFilePath = check.path;
      }

      // LIST mode — the same index the Skills sidebar uses (both scopes).
      if (args.name === undefined) {
        const listRes = await httpGetRows(url, '/api/skills', 'skills');
        if ('error' in listRes) return textResult(`Error: ${listRes.error}`, true);
        const rawSkills = listRes.rows;
        // Hide OK's own built-in `open-knowledge*` skills from the LIST: they now
        // surface in `/api/skills` (managed, read-only) for the editor UI, but
        // the agent already has them loaded (the READ short-circuit above teaches
        // that), and LISTing them here would contradict it.
        // The runtime three stay OUT of
        // the agent-facing list — an agent browsing its own steering skill is
        // recursion noise, and the read-only edit gate covers mutation. Packs
        // and every other first-party skill list ordinarily.
        const authored = rawSkills.filter((s) => !isInternalBundleSkillName(String(s.name)));
        // `scope` FILTERS the list. Accepting it and then returning both levels
        // answered a different question than the one asked: an agent asking for
        // global skills got every project skill too.
        const scoped =
          args.scope === undefined ? authored : authored.filter((s) => s.scope === args.scope);
        const skills = scoped.map((s) => projectListRow(s));
        return textPlusStructured(JSON.stringify({ skills }, null, 2), { skills });
      }

      // READ mode — resolve scope (explicit, else by name across the index).
      let scope = args.scope;
      if (scope === undefined) {
        const listRes = await httpGetRows(url, '/api/skills', 'skills');
        if ('error' in listRes) return textResult(`Error: ${listRes.error}`, true);
        const rows = listRes.rows;
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
        const fileRead = await readSkillFile(url, scope, args.name, bundleFilePath ?? args.file);
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
