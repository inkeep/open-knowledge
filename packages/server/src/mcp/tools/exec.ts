/**
 * `exec` MCP tool — the enriched bash surface.
 *
 * Orchestrates:
 *   1. parseCommand (shell-quote + allowlist) — primary security boundary
 *   2. snapshotMtimes (pre) — defense-in-depth baseline
 *   3. execBash via just-bash + ReadWriteFs (sandbox)
 *   4. snapshotMtimes (post) + diff — abort on any mutation
 *   5. extractReferencedPaths
 *   6. enrichPath per path (slim shape for multi-path; rich for single-cat)
 *   7. Format: raw stdout + markdown `### Referenced files` block +
 *      structuredContent `{ enrichedPaths, cwd?, stdoutTruncated?, warnings?, error? }`
 *
 * Soft cap: 500 lines / ~24 KB with truncation marker (the body is emitted
 * twice on the wire, each copy decorated — see SOFT_CAP_BYTES).
 * Hard cap: 16 MB → `output_overflow` error (StdoutOverflowError).
 * Binary content (non-text/markdown files in `cat` argv) triggers a
 * warning banner.
 */
import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { argsOf, extractReferencedPaths, nonFlagArgs } from '../../bash/extract-paths.ts';
import { createBashInstance, execBash, StdoutOverflowError } from '../../bash/index.ts';
import { diffMtimes, snapshotMtimes } from '../../bash/mtime-scan.ts';
import {
  augmentStagesWithExcludes,
  type ErrorCategory,
  parseCommand,
  type Stage,
  serializeStages,
} from '../../bash/parse-command.ts';
import {
  type DirectoryMeta,
  type EnrichedEntry,
  type EnrichedMeta,
  enrichDirectoryRecursive,
  enrichPath,
  fetchBacklinkCountsBatch,
  pathToDocName,
} from '../../content/enrichment.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { buildListResolver, docNameFromPath, type PreviewUrlSource } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  looseObjectArray,
  outputSchemaWithText,
  resolveProjectServerContext,
  textPlusStructured,
} from './shared.ts';

/** Soft output cap: lines. */
const SOFT_CAP_LINES = 500;
/**
 * Number of times the visible body rides the wire in one tool result: once in
 * `content[].text` (the MCP spec stream) and once mirrored into
 * `structuredContent.text` (the load-bearing cross-client body mirror — see
 * `textPlusStructured` in shared.ts; Claude-class clients drop `content[].text`
 * when `structuredContent` is present, claude-code#55677). The soft cap must
 * budget the *realized* payload, not a single copy, or a read the cap considers
 * "untruncated" still overflows the client's per-result token limit.
 */
export const WIRE_BODY_COPIES = 2;
/**
 * Target realized wire size for the duplicated body (both copies) in one result.
 * Sits well under the client's per-result token ceiling (~25K tokens ≈ ~85 KB
 * for markdown), so the realized payload always clears it with margin.
 */
export const RESULT_BODY_BUDGET_BYTES = 64 * 1024;
/**
 * Each wire copy is the full decorated `content` = banner + provenance +
 * stdout + enrichment block, but the soft cap can only bound the stdout string
 * (enrichment is computed after capping). Reserve a per-copy allowance for the
 * decoration so the realized `content` — not just stdout — stays within
 * `RESULT_BODY_BUDGET_BYTES / WIRE_BODY_COPIES`. The enrichment block is rich
 * for a single `cat` (frontmatter + full backlinks); a pathological block that
 * exceeds this allowance is still absorbed by the budget↔client-ceiling margin.
 */
const PER_COPY_DECORATION_HEADROOM_BYTES = 8 * 1024;
/** Soft output cap: bytes of a single stdout string (~24 KB). */
const SOFT_CAP_BYTES =
  Math.floor(RESULT_BODY_BUDGET_BYTES / WIRE_BODY_COPIES) - PER_COPY_DECORATION_HEADROOM_BYTES;

/** Non-text extensions that trigger the binary-content warning. */
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|tgz|mp4|mov|mp3|wav|ico|bmp)$/i;

export const DESCRIPTION = [
  '**STOP — when the project has `.ok/`, do NOT use native `Read`/`Grep`/`Glob` on in-scope `.md`/`.mdx`; use `exec` (this tool).** Native tools skip the frontmatter, backlinks, shadow-repo activity, and git history `exec` returns per wiki file. Reserve native tools for source code, non-markdown, and projects without `.ok/`. (Full rule + escape hatch: the `open-knowledge` skill.)',
  '',
  'Run a read-only bash-like command against the project content directory. Returns raw stdout plus enriched metadata for every wiki file referenced (frontmatter, backlink/forward-link counts, shadow-repo activity with agent/human attribution).',
  '',
  'Allowlist: cat, ls, grep, find, head, tail, wc, sort, uniq, cut. One command or a pipe (|) per call — NOT a shell: `&&`, `;`, redirections, subshells, and writes are rejected. To do several things, make separate exec calls or pass multiple paths to one command (e.g. `ls -A a b c`, `cat a b c`).',
  '',
  "cwd: the command runs in the explicit absolute `cwd` you pass, or in the MCP client's only advertised root when there is exactly one. If the client has zero or multiple roots, pass `cwd` explicitly. Paths inside the command resolve relative to that cwd; traversal above it is rejected.",
  '',
  'Stdout provenance headers (GNU-style): `ls <dir>/` prepends `<dir>/:`, single-file `cat`/`head`/`tail` prepends `==> <path> <==`, so the subject of the command is visible in raw output. Multi-file `cat a b` emits no header — the `enrichedPaths` array still lists every file. `head`/`tail` used as pipe trimmers (no file arg) defer to the upstream producer.',
  '',
  'Examples:',
  '- `exec({ command: "cat articles/auth.md" })` — file contents + full enrichment',
  '- `exec({ command: "ls articles/" })` — listing + per-file enrichment (slim)',
  '- `exec({ command: "grep -rn oauth articles/ | head -5" })` — pipe with enrichment on matched files',
  '- `exec({ command: "ls", cwd: "/abs/path/to/other-repo" })` — run in a different project',
].join('\n');

interface ExecDeps {
  /** Async resolver for per-call cwd; see `ResolveCwd` in tools/index.ts. */
  resolveCwd: (explicit?: string) => Promise<string>;
  /**
   * Hocuspocus URL. Accepts a raw string (tests) or a lazy resolver (runtime,
   * see `packages/cli/src/mcp/server.ts`) so discovery can happen after the
   * MCP client advertises its roots rather than being frozen at startup.
   */
  serverUrl: ServerUrlOrResolver;
  /**
   * Full resolved config. Threaded through `enrichPath` / `enrichDirectory`
   * and passed to the previewUrl resolver for per-row route-only `previewUrl`
   * enrichment. A doc's frontmatter is its own on-disk YAML (no cascade);
   * a folder's own frontmatter comes from its `.ok/frontmatter.yml`.
   * Required — every registration site in `tools/index.ts` passes config.
   */
  config: ConfigOrResolver;
}

type ExecEnrichedEntry = EnrichedEntry & {
  previewUrl: string | null;
  previewUrlSource?: PreviewUrlSource;
};

export interface ExecStructuredResult {
  enrichedPaths: ExecEnrichedEntry[];
  /**
   * The directory the command actually ran in — the literal `cwd` passed (or
   * the single advertised root), NOT the walked-up project root. Lets the caller
   * verify the command executed where it was told.
   */
  cwd?: string;
  /**
   * Tool-level warnings — head/tail truncation, binary-file detection, stderr.
   * Carried in `structuredContent` because Claude-class clients drop
   * `content[].text` when `structuredContent` is present (claude-code#55677),
   * so safety signals must live in structured content too or agents miss them.
   * (The visible body is already mirrored to `structuredContent.text` by
   * `textPlusStructured`; we do NOT also re-emit a raw `stdout` copy — that was
   * a superseded duplicate of the `text` mirror, dropped.)
   */
  warnings?: string[];
  /** True when stdout was truncated by the soft cap (500 lines / ~24KB). */
  stdoutTruncated?: boolean;
  error?: { category: ErrorCategory; message: string };
}

interface CapResult {
  text: string;
  truncated: boolean;
  omittedLines: number;
}

function applySoftCap(stdout: string): CapResult {
  const lines = stdout.split('\n');
  // Trailing empty line from final newline: don't count it as "content".
  const contentLineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (contentLineCount <= SOFT_CAP_LINES && stdout.length <= SOFT_CAP_BYTES) {
    return { text: stdout, truncated: false, omittedLines: 0 };
  }
  const cutoff = Math.min(contentLineCount, SOFT_CAP_LINES);
  // Build up kept text by bytes too
  let keptBytes = 0;
  let keptLines = 0;
  for (let i = 0; i < cutoff; i++) {
    const line = lines[i];
    keptBytes += line.length + 1;
    if (keptBytes > SOFT_CAP_BYTES) break;
    keptLines++;
  }
  const kept = lines.slice(0, keptLines).join('\n');
  const omitted = contentLineCount - keptLines;
  return {
    text: `${kept}\n<truncated: ${omitted} more lines — re-run with a more-specific query>`,
    truncated: true,
    omittedLines: omitted,
  };
}

function detectBinaryArgs(stages: Stage[]): string[] {
  // Only cat args are dereferenced as content; ls/grep/find list paths.
  const hits: string[] = [];
  for (const s of stages) {
    if (s.command !== 'cat') continue;
    for (const arg of s.args.slice(1)) {
      if (arg.startsWith('-')) continue;
      if (BINARY_EXT_RE.test(arg)) hits.push(arg);
    }
  }
  return hits;
}

/**
 * Best-effort parse of a `head`/`tail` `-N` line-count limit. Recognized forms:
 *   `head -30` / `head -n 30` / `head -n30` / `head --lines=30`
 * Falls back to head/tail's POSIX default of 10 when no explicit flag is found.
 */
function extractHeadTailLimit(args: string[]): number {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    // `--lines=N`
    const longEq = arg.match(/^--lines=(\d+)$/);
    if (longEq) return Number(longEq[1]);
    // `--lines N`
    if (arg === '--lines' && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    // `-n N`
    if (arg === '-n' && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    // `-n30` (joined short form)
    const nJoined = arg.match(/^-n(\d+)$/);
    if (nJoined) return Number(nJoined[1]);
    // `-30` (classic short form)
    const shortN = arg.match(/^-(\d+)$/);
    if (shortN) return Number(shortN[1]);
  }
  return 10;
}

/**
 * When `head` or `tail` is the final pipeline stage AND the output hit its
 * line cap, the upstream stages may have had more matches that never made it
 * into stdout. Surface this as a banner so agents don't mistake a truncated
 * result for an exhaustive one. See the `open-knowledge` skill for the
 * recommended patterns (`grep -rl` for existence, unbounded `grep -rn` for
 * enumeration).
 */
function detectHeadTailTruncation(stages: Stage[], stdout: string): { banner: string } | null {
  if (stages.length < 2) return null; // need at least one upstream stage
  const last = stages[stages.length - 1];
  if (last.command !== 'head' && last.command !== 'tail') return null;
  const limit = extractHeadTailLimit(last.args);
  // Mirror applySoftCap's line counting: count all lines and only ignore the
  // trailing empty line from a final newline. Filtering ALL empty lines (the
  // previous impl) under-counted legitimate blank lines in grep output and
  // made the warning miss real truncations.
  const rawLines = stdout.split('\n');
  const contentLineCount =
    rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length;
  if (contentLineCount < limit) return null;
  const countedLines = rawLines.slice(0, contentLineCount);
  const uniqueFiles = new Set(
    countedLines.map((l) => {
      const colon = l.indexOf(':');
      return colon > 0 ? l.slice(0, colon) : l;
    }),
  ).size;
  const upstream = stages
    .slice(0, -1)
    .map((s) => s.command)
    .join(' | ');
  return {
    banner:
      `Output hit \`${last.command} -${limit}\` cap (${contentLineCount} lines, ${uniqueFiles} unique file${uniqueFiles === 1 ? '' : 's'}). ` +
      `The \`${upstream}\` stage may have had more matches that never reached stdout. ` +
      `For existence checks across many files, prefer \`grep -rl PATTERN <dir>\` (list files only, no head). ` +
      `For enumeration, drop the \`| ${last.command}\` or widen the cap.`,
  };
}

function isDirectoryMeta(e: EnrichedEntry): e is DirectoryMeta {
  return (e as DirectoryMeta).type === 'directory';
}

function formatDirectoryEntry(d: DirectoryMeta): string {
  // When the folder's own `.ok/frontmatter.yml` supplied a title, lead with it
  // like file entries do; otherwise fall back to the path label. Either way show
  // the path in parens so agents can always resolve the on-disk location.
  const leader = d.title ? `**${d.title}** (${d.path}/)` : `**${d.path}/** (directory)`;
  const parts: string[] = [leader];
  if (d.description) parts.push(d.description);
  if (d.tags && d.tags.length > 0) parts.push(`tags: ${d.tags.join(', ')}`);
  if (d.templates_available && d.templates_available.length > 0) {
    // The description is what lets an agent pick the right template for the job.
    const tpl = d.templates_available
      .map((t) =>
        t.description ? `${t.name} — ${t.description} (${t.scope})` : `${t.name} (${t.scope})`,
      )
      .join(', ');
    parts.push(`templates: ${tpl}`);
  }
  const counts: string[] = [];
  counts.push(
    d.recursiveMdCount > d.directMdCount
      ? `${d.directMdCount} md file${d.directMdCount === 1 ? '' : 's'} here (${d.recursiveMdCount} in tree)`
      : `${d.directMdCount} md file${d.directMdCount === 1 ? '' : 's'}`,
  );
  if (d.childDirCount > 0) {
    counts.push(`${d.childDirCount} subdir${d.childDirCount === 1 ? '' : 's'}`);
  }
  parts.push(counts.join(', '));
  if (d.mostRecentMd) {
    const when = d.mostRecentMd.updatedAt ? `, ${d.mostRecentMd.updatedAt.slice(0, 10)}` : '';
    parts.push(
      `most recent: ${d.mostRecentMd.title ?? d.mostRecentMd.path} (${d.mostRecentMd.path}${when})`,
    );
  }
  if (d.truncated) parts.push('scan truncated');
  return `- ${parts.join(' — ')}`;
}

export function formatFileEntry(m: EnrichedMeta): string {
  const title = m.title ?? m.path;
  const parts: string[] = [`**${title}** (${m.path})`];
  if (m.description) parts.push(m.description);
  if (m.tags.length > 0) parts.push(`tags: ${m.tags.join(', ')}`);
  if (m.graphRole) parts.push(`graph: ${m.graphRole}`);
  const fmStatus = typeof m.frontmatter.status === 'string' ? m.frontmatter.status : null;
  const fmType = typeof m.frontmatter.type === 'string' ? m.frontmatter.type : null;
  if (fmStatus) parts.push(`status: ${fmStatus}`);
  if (fmType) parts.push(`type: ${fmType}`);
  if (m.backlinkCount !== null) {
    // Source paths are populated on single-cat rich only (null on multi-path); render
    // them so the agent can follow a backlink without a second links() call.
    let line = `backlinks: ${m.backlinkCount}`;
    if (m.backlinks && m.backlinks.length > 0) {
      const names = m.backlinks.slice(0, 5).map((b) => b.source);
      line += ` (${names.join(', ')}${m.backlinks.length > 5 ? ', …' : ''})`;
    }
    parts.push(line);
  }
  if (m.forwardLinkCount !== null) {
    let line = `forward links: ${m.forwardLinkCount}`;
    if (m.forwardLinks && m.forwardLinks.length > 0) {
      const names = m.forwardLinks.slice(0, 5).map((f) => (f.kind === 'doc' ? f.docName : f.url));
      line += ` (${names.join(', ')}${m.forwardLinks.length > 5 ? ', …' : ''})`;
    }
    parts.push(line);
  }
  if (m.history && m.history.length > 0) {
    const entries = m.history.map((h) => {
      const who =
        h.writerClassification === 'agent'
          ? `agent: ${h.writerName}`
          : h.writerClassification === 'principal'
            ? `human: ${h.writerName}`
            : `${h.writerClassification}: ${h.writerName}`;
      return `${h.hash.slice(0, 7)} [${who}] ${h.message}`;
    });
    parts.push(`OK edits: ${entries.join(' · ')}`);
  }
  if (m.projectHistory && m.projectHistory.length > 0) {
    const entries = m.projectHistory.map(
      (c) => `${c.hash.slice(0, 7)} ${c.authorName}: ${c.subject}`,
    );
    parts.push(`commits: ${entries.join(' · ')}`);
  }
  return `- ${parts.join(' — ')}`;
}

/**
 * Prepend a self-identifying header to stdout so the agent can see the
 * subject of the command (dir for `ls`, single file for `cat`/`head`/`tail`)
 * directly in the raw output — not only in the enriched `Referenced files`
 * block. Mirrors GNU conventions: `ls -R` uses `<dir>/:` headers, and
 * `head`/`tail` use `==> <path> <==`.
 *
 * Walks the stage list backwards like `extractReferencedPaths` so the last
 * subject-identifying stage wins. `head`/`tail` are skipped when used as
 * pipe trimmers (no file arg) so upstream `cat` / `ls` headers survive.
 *
 * Gated on the path actually being enriched (present in `dirByPath` /
 * `fileByPath`) — avoids emitting misleading headers for invalid args.
 *
 * Multi-file `cat a b` emits no header: we cannot interleave boundaries
 * into concatenated content (would require re-executing per file), and a
 * block of headers at the top implies boundaries that don't exist. The
 * `enrichedPaths` entries still list every file read.
 */
function buildStdoutProvenance(
  stages: Stage[],
  dirByPath: Map<string, DirectoryMeta>,
  fileByPath: Map<string, EnrichedMeta>,
  // Command args are relative to where bash ran (`executionCwd`); the enriched
  // maps are keyed project-relative. Rebase an arg before lookup. Identity when
  // execution and project roots coincide.
  rebase: (p: string) => string,
): string {
  let stage: Stage | null = null;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    const cmd = s.command;
    if (cmd === 'ls' || cmd === 'cat') {
      stage = s;
      break;
    }
    if ((cmd === 'head' || cmd === 'tail') && nonFlagArgs(argsOf(s)).length > 0) {
      stage = s;
      break;
    }
  }
  if (!stage) return '';

  const pathArgs = nonFlagArgs(argsOf(stage));

  if (stage.command === 'ls') {
    const dirArg = pathArgs[pathArgs.length - 1];
    if (!dirArg || dirArg === '.') return '';
    let n = dirArg.replace(/\/+/g, '/');
    if (n.startsWith('./')) n = n.slice(2);
    if (n.endsWith('/')) n = n.slice(0, -1);
    if (!n) return '';
    const key = rebase(n);
    if (!dirByPath.has(key)) return '';
    return `${key}/:\n`;
  }

  // cat / head / tail: emit `==> <path> <==` only for single-file reads.
  // Multi-file → no header (can't interleave boundaries).
  const wikiFiles = pathArgs.filter((p) => /\.(md|mdx)$/.test(p) && fileByPath.has(rebase(p)));
  if (wikiFiles.length !== 1) return '';
  return `==> ${rebase(wikiFiles[0])} <==\n`;
}

function formatEnrichedBlock(enriched: EnrichedEntry[]): string {
  if (enriched.length === 0) return '';
  const lines: string[] = ['', '### Referenced files', ''];
  for (const e of enriched) {
    lines.push(isDirectoryMeta(e) ? formatDirectoryEntry(e) : formatFileEntry(e));
  }
  return lines.join('\n');
}

/** Classify candidate paths into files vs directories via stat. */
async function classifyPaths(
  cwd: string,
  paths: string[],
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  await Promise.all(
    paths.map(async (p) => {
      try {
        const st = await stat(resolve(cwd, p));
        if (st.isDirectory()) {
          dirs.push(p);
        } else if (st.isFile()) {
          files.push(p);
        }
      } catch {
        // Path doesn't exist (e.g., grep-matched path from stdin, or parse artifact).
        // Fall back to extension heuristic: .md/.mdx → file, else skip.
        if (/\.(md|mdx)$/i.test(p)) files.push(p);
      }
    }),
  );
  return { files, dirs };
}

function errorCategoryResult(category: ErrorCategory, message: string) {
  const structured: ExecStructuredResult = {
    enrichedPaths: [],
    error: { category, message },
  };
  return textPlusStructured(message, structured, true);
}

/**
 * Attach `previewUrl` + optional `previewUrlSource` to each enriched entry.
 * Files use `docNameFromPath` (strip `.md`/`.mdx`); directories pass through
 * their path unchanged so a docName-addressable directory page resolves. When
 * `resolve` returns null the field is `null` — never missing.
 */
function withPreviewUrls(
  entries: EnrichedEntry[],
  resolve: (docName: string) => { url: string; source: PreviewUrlSource } | null,
): ExecEnrichedEntry[] {
  return entries.map((entry) => {
    const docName = docNameFromPath(entry.path);
    const resolved = resolve(docName);
    const withFields: ExecEnrichedEntry = {
      ...entry,
      previewUrl: resolved?.url ?? null,
      ...(resolved ? { previewUrlSource: resolved.source } : {}),
    } as ExecEnrichedEntry;
    return withFields;
  });
}

export async function buildExecResult(
  args: { command: string; cwd?: string },
  deps: ExecDeps,
): Promise<ReturnType<typeof textPlusStructured>> {
  const context = await resolveProjectServerContext(
    deps.resolveCwd,
    deps.config,
    deps.serverUrl,
    args.cwd,
  );
  if (!context.ok) {
    return errorCategoryResult('shell_construct_blocked', `exec failed: ${context.error}`);
  }
  // 0. Resolve effective cwd (explicit arg → single client root → error).
  //
  // `cwd` is the project root — it anchors enrichment (docName, backlinks,
  // history, preview are all project-relative) plus the server URL and lock.
  // `executionCwd` is the literal directory the caller passed; bash runs there
  // so a command executes where it was told (the tool's contract). The two
  // differ only when the caller targets a subdirectory of the project.
  const { cwd, executionCwd, config, url: resolvedServerUrl } = context;

  // Referenced paths emerge from stdout relative to where bash ran
  // (`executionCwd`); enrichment addresses them project-relative, so rebase each
  // onto the project root. Identity no-op when the two coincide (the common
  // case: caller passed the project root or no cwd at all), which keeps the
  // existing single-directory behavior byte-for-byte.
  const rebaseToProject =
    executionCwd === cwd
      ? (p: string) => p
      : (p: string) => relative(cwd, resolve(executionCwd, p));

  // 1. Parse + validate
  const parsed = parseCommand(args.command);
  if ('error' in parsed) {
    return errorCategoryResult(parsed.error.category, parsed.error.message);
  }
  // Auto-inject `WIKI_EXCLUDE_DIRS` filters into recursive grep/find stages so
  // agents don't wait 20s scanning `node_modules/` etc. Safe: user-provided
  // excludes disable injection for the affected stage.
  const stages = augmentStagesWithExcludes(parsed.stages);
  const effectiveCommand = serializeStages(stages);

  // 2. Pre-exec mtime snapshot (baseline). Scoped to `executionCwd` — the
  // bash sandbox is rooted there (`ReadWriteFs` root), so a read-only command
  // can only mutate files inside it; scanning the whole project root would be
  // wasteful and would false-positive on concurrent writers elsewhere.
  const pre = await snapshotMtimes(executionCwd);

  // 3. Execute via just-bash in the literal directory the caller passed.
  const bash = createBashInstance(executionCwd);
  let stdout = '';
  let stderr = '';
  try {
    const result = await execBash(bash, effectiveCommand);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    if (err instanceof StdoutOverflowError) {
      return errorCategoryResult(
        'output_overflow',
        `Output exceeded 16 MB buffer. Narrow the command (e.g., add a more specific grep pattern, use head, restrict the path).`,
      );
    }
    return errorCategoryResult(
      'shell_construct_blocked',
      `exec failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Post-exec mtime check (backstop) — same scope as the pre snapshot.
  const post = await snapshotMtimes(executionCwd);
  const mtimeDiff = diffMtimes(pre.snapshot, post.snapshot);
  if (mtimeDiff.changed.length > 0) {
    return errorCategoryResult(
      'security_invariant_violation',
      `Security invariant violated: file(s) in the content directory were modified during a read-only exec call: ${mtimeDiff.changed.join(', ')}. This indicates a parser bug; the command has been logged.`,
    );
  }

  // 5. Apply soft cap to stdout
  const capped = applySoftCap(stdout);

  // 6. Extract referenced wiki paths + enrich
  //
  // Containment filter: even though the bash sandbox blocks `ls ../etc/`
  // at execution time, `extractFromLs` still emits the `..`-prefixed
  // argument as a referenced path. Without this filter `enrichDirectory`
  // would `readdir` /etc/ and surface its listing in `enrichedPaths`,
  // turning a blocked exec into a directory-disclosure oracle. Same
  // class for grep/find stdout that names paths outside cwd. Drop any
  // path that lexically escapes `executionCwd` (the sandbox root) before
  // stat / enrichment ever sees it.
  const rawPaths = extractReferencedPaths(stdout, stages);
  // Containment against `executionCwd` mirrors the bash sandbox boundary (the
  // command could only legitimately reference paths under where it ran). Rebase
  // the survivors onto the project root so classification + enrichment resolve
  // and address them correctly regardless of which subdirectory bash ran in.
  const paths = rawPaths.filter((p) => resolveWithinRoot(executionCwd, p).ok).map(rebaseToProject);
  const { files, dirs } = await classifyPaths(cwd, paths);
  // Single-path cat enrichment gets rich fields; all others get slim.
  const isSinglePathCat = stages.length === 1 && stages[0].command === 'cat' && files.length === 1;
  // A doc's frontmatter is its own on-disk YAML; folder descriptive
  // metadata lives in nested <folder>/.ok/frontmatter.yml (self-only).
  const fileEnriched: EnrichedMeta[] = await Promise.all(
    files.map((p) =>
      enrichPath(
        p,
        { projectDir: cwd, serverUrl: resolvedServerUrl },
        {
          includeRichFields: isSinglePathCat,
        },
      ).catch(
        (): EnrichedMeta => ({
          path: p,
          tags: [],
          frontmatter: {},
          backlinkCount: null,
          backlinks: null,
          forwardLinkCount: null,
          forwardLinks: null,
          history: null,
          historySource: null,
          projectHistory: null,
          projectHistorySource: null,
          graphRole: null,
        }),
      ),
    ),
  );
  // Routed through `enrichDirectoryRecursive(p, 1, ...)` (instead of the
  // depth-1 alias `enrichDirectory`) so the `ls` enrichment emits the
  // folder's own `title`/`description`/`tags` + `templates_available`
  // — the folder metadata + template menu agents need when planning a write.
  // The explicit recursive call signals intent and leaves depth>1 a one-arg
  // change away.
  const dirEnriched: DirectoryMeta[] = await Promise.all(
    dirs.map((p) =>
      enrichDirectoryRecursive(p, 1, { projectDir: cwd }).catch(
        (): DirectoryMeta => ({
          path: p,
          type: 'directory',
          directMdCount: 0,
          recursiveMdCount: 0,
          childDirCount: 0,
          truncated: false,
        }),
      ),
    ),
  );
  // Backfill backlinkCount on slim entries via one batched server call so
  // multi-path listings (ls/grep/find/multi-cat) get connection-density
  // without N-amplifying /api/backlinks. Single-path rich cat already has it.
  if (!isSinglePathCat && resolvedServerUrl && fileEnriched.length > 0) {
    const docNames = fileEnriched.map((f) => pathToDocName(f.path));
    const counts = await fetchBacklinkCountsBatch(resolvedServerUrl, docNames).catch(() => null);
    if (counts) {
      for (const f of fileEnriched) {
        const c = counts.get(pathToDocName(f.path));
        if (typeof c === 'number') f.backlinkCount = c;
      }
    }
  }
  // Preserve stdout order: walk `paths` and pick up the matching entry.
  const fileByPath = new Map(fileEnriched.map((e) => [e.path, e]));
  const dirByPath = new Map(dirEnriched.map((e) => [e.path, e]));
  const enriched: EnrichedEntry[] = [];
  for (const p of paths) {
    const f = fileByPath.get(p);
    if (f) {
      enriched.push(f);
      continue;
    }
    const d = dirByPath.get(p);
    if (d) enriched.push(d);
  }

  // 7. Format output
  const binaryHits = detectBinaryArgs(stages);
  const banners: string[] = [];
  if (binaryHits.length > 0) {
    banners.push(
      `File${binaryHits.length > 1 ? 's' : ''} ${binaryHits.join(', ')} appear${binaryHits.length === 1 ? 's' : ''} to be binary (image/PDF/etc.) — exec returns text only (NG8). For binary retrieval, use native Read.`,
    );
  }
  const truncation = detectHeadTailTruncation(stages, stdout);
  if (truncation) {
    banners.push(truncation.banner);
  }
  if (stderr) {
    banners.push(`stderr: ${stderr.trim()}`);
  }

  const bannerText = banners.length > 0 ? `${banners.join('\n')}\n\n` : '';
  const provenance = buildStdoutProvenance(stages, dirByPath, fileByPath, rebaseToProject);
  const stdoutText = provenance + capped.text;
  const enrichmentBlock = formatEnrichedBlock(enriched);
  const content = `${bannerText}${stdoutText}${enrichmentBlock}`;

  // Attach per-row route-only previewUrl. The browser base is not emitted on
  // this response — agents that need it call the `preview_url` tool.
  const { resolve: resolvePreviewUrl } = await buildListResolver({
    config,
    resolveCwd: async () => cwd,
  });
  const enrichedWithPreview: ExecEnrichedEntry[] = withPreviewUrls(enriched, resolvePreviewUrl);

  // The visible body reaches the model via `content[].text` AND
  // `structuredContent.text` (the cross-client mirror auto-added by
  // `textPlusStructured`, shared.ts). We deliberately do NOT also carry a raw
  // `stdout` copy here: it was a byte-subset duplicate of the `text` mirror
  // with no consumer, and tripled the wire payload.
  const structured: ExecStructuredResult = {
    enrichedPaths: enrichedWithPreview,
    stdoutTruncated: capped.truncated,
    // Report the directory the command actually ran in (the literal cwd passed),
    // not the walked-up project root — so the caller can trust it.
    cwd: executionCwd,
    ...(banners.length > 0 ? { warnings: banners } : {}),
  };
  return textPlusStructured(content, structured);
}

export function register(server: ServerInstance, deps: ExecDeps): void {
  server.registerTool(
    'exec',
    {
      description: DESCRIPTION,
      inputSchema: {
        command: z
          .string()
          .describe(
            'Read-only bash command (allowlist: cat, ls, grep, find, head, tail, wc, sort, uniq, cut; pipes OK)',
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            'Absolute host path to run the command from. Defaults only when the MCP client advertises exactly one root; otherwise pass `cwd` explicitly.',
          ),
      },
      outputSchema: outputSchemaWithText({
        enrichedPaths: looseObjectArray.describe(
          'Per-referenced-file metadata: frontmatter, backlink/forward-link counts, recent shadow-repo activity, and a route-only previewUrl.',
        ),
        stdoutTruncated: z
          .boolean()
          .optional()
          .describe('True when stdout was truncated by the soft cap.'),
        warnings: z
          .array(z.string())
          .optional()
          .describe('Tool-level warnings — head/tail truncation, binary detection, stderr.'),
        cwd: z.string().optional().describe('Absolute directory the command ran in.'),
        error: z
          .object({ category: z.string(), message: z.string() })
          .optional()
          .describe('Present on failure — the error category + message.'),
      }),
    },
    async (args: { command: string; cwd?: string }) => {
      try {
        return await buildExecResult(args, deps);
      } catch (err) {
        const message = `exec handler error: ${err instanceof Error ? err.message : String(err)}`;
        return errorCategoryResult('shell_construct_blocked', message);
      }
    },
  );
}
