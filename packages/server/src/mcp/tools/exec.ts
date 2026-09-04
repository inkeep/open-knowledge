import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  type PersistedLinterConfig,
  selectAdvertisedFrontmatterMappings,
  toEffectiveBase,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { expandGlobStages } from '../../bash/expand-globs.ts';
import { extractReferencedPaths, isWikiPath, pathArgs } from '../../bash/extract-paths.ts';
import {
  createBashInstance,
  erofsTarget,
  execBash,
  StdoutOverflowError,
} from '../../bash/index.ts';
import {
  deriveScanRoots,
  diffMtimes,
  SCAN_CAP,
  snapshotMtimesForRoots,
} from '../../bash/mtime-scan.ts';
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
  fetchCommentCountsBatch,
  pathToDocName,
} from '../../content/enrichment.ts';
import { getLogger } from '../../logger.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { buildListResolver, docNameFromPath, type PreviewUrlSource } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  looseObjectArray,
  outputSchemaWithText,
  resolveProjectServerContext,
  textPlusStructured,
} from './shared.ts';

const log = getLogger('mcp:exec');

const SOFT_CAP_LINES = 500;
export const WIRE_BODY_COPIES = 2;
export const RESULT_BODY_BUDGET_BYTES = 64 * 1024;
const PER_COPY_DECORATION_HEADROOM_BYTES = 8 * 1024;
const SOFT_CAP_BYTES =
  Math.floor(RESULT_BODY_BUDGET_BYTES / WIRE_BODY_COPIES) - PER_COPY_DECORATION_HEADROOM_BYTES;

const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|tgz|mp4|mov|mp3|wav|ico|bmp)$/i;

export const DESCRIPTION = [
  '**STOP — when the project has `.ok/`, do NOT use native `Read`/`Grep`/`Glob` on in-scope `.md`/`.mdx`; use `exec` (this tool).** Native tools skip the frontmatter, backlinks, unresolved comments, shadow-repo activity, and git history `exec` returns per wiki file. Reserve native tools for source code, non-markdown, and projects without `.ok/`. (Full rule + escape hatch: the `open-knowledge` skill.)',
  '',
  'Run a read-only bash-like command against the project content directory. Returns raw stdout plus enriched metadata for every wiki file referenced (frontmatter, backlink/forward-link counts, shadow-repo activity with agent/human attribution).',
  '',
  '`⚠ N unresolved comment(s)` = open human review requests — factor in before editing, and report them.',
  '',
  'Allowlist: cat, ls, grep, find, head, tail, wc, sort, uniq, cut. One command or a pipe (|) per call — NOT a shell: `&&`, `;`, subshells, writes, and ALL redirection are rejected, `<` too (read via `cat a.md`, not `< a.md`). For several things use separate exec calls or multiple paths (`cat a b c`).',
  '',
  "cwd: the command runs in the explicit absolute `cwd` you pass, or in the MCP client's only advertised root when there is exactly one. If the client has zero or multiple roots, pass `cwd` explicitly. Paths inside the command resolve relative to that cwd; traversal above it is rejected.",
  '',
  'Stdout provenance headers (GNU-style): `ls <dir>/` prepends `<dir>/:`, single-file `cat`/`head`/`tail` prepends `==> <path> <==`. Multi-file `cat a b` emits no header — the `enrichedPaths` array still lists every file. `head`/`tail` used as pipe trimmers (no file arg) defer to the upstream producer.',
  '',
  'Examples:',
  '- `exec({ command: "cat articles/auth.md" })` — file contents + full enrichment',
  '- `exec({ command: "ls articles/" })` — listing + per-file enrichment (slim)',
  '- `exec({ command: "grep -rn oauth articles/ | head -5" })` — pipe with enrichment on matched files',
  '- `exec({ command: "ls", cwd: "/abs/path/to/other-repo" })` — run in a different project',
].join('\n');

interface ExecDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
}

type ExecEnrichedEntry = EnrichedEntry & {
  previewUrl: string | null;
  previewUrlSource?: PreviewUrlSource;
};

export interface ExecStructuredResult {
  enrichedPaths: ExecEnrichedEntry[];
  cwd?: string;
  warnings?: string[];
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
  const contentLineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (contentLineCount <= SOFT_CAP_LINES && stdout.length <= SOFT_CAP_BYTES) {
    return { text: stdout, truncated: false, omittedLines: 0 };
  }
  const cutoff = Math.min(contentLineCount, SOFT_CAP_LINES);
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

function extractHeadTailLimit(args: string[]): number {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const longEq = arg.match(/^--lines=(\d+)$/);
    if (longEq) return Number(longEq[1]);
    if (arg === '--lines' && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    if (arg === '-n' && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    const nJoined = arg.match(/^-n(\d+)$/);
    if (nJoined) return Number(nJoined[1]);
    const shortN = arg.match(/^-(\d+)$/);
    if (shortN) return Number(shortN[1]);
  }
  return 10;
}

function detectHeadTailTruncation(stages: Stage[], stdout: string): { banner: string } | null {
  if (stages.length < 2) return null;
  const last = stages[stages.length - 1];
  if (last.command !== 'head' && last.command !== 'tail') return null;
  const limit = extractHeadTailLimit(last.args);
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

export function formatDirectoryEntry(d: DirectoryMeta): string {
  const leader = d.title ? `**${d.title}** (${d.path}/)` : `**${d.path}/** (directory)`;
  const parts: string[] = [leader];
  if (d.description) parts.push(d.description);
  if (d.tags && d.tags.length > 0) parts.push(`tags: ${d.tags.join(', ')}`);
  if (d.templates_available && d.templates_available.length > 0) {
    const tpl = d.templates_available
      .map((t) =>
        t.description ? `${t.name} — ${t.description} (${t.scope})` : `${t.name} (${t.scope})`,
      )
      .join(', ');
    parts.push(`templates: ${tpl}`);
  }
  if (d.schemas_applicable && d.schemas_applicable.length > 0) {
    parts.push(`schemas: ${d.schemas_applicable.join(', ')}`);
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
  if (d.commentCount !== undefined && d.commentCount > 0) {
    let line = `⚠ ${d.commentCount} unresolved comment${d.commentCount === 1 ? '' : 's'} in tree`;
    if (d.commentedDocs && d.commentedDocs.length > 0) {
      const where = d.commentedDocs.map((c) => `${c.docName} (${c.count})`).join(', ');
      const listed = d.commentedDocs.reduce((sum, c) => sum + c.count, 0);
      line += `: ${where}${listed < d.commentCount ? ', …' : ''}`;
    }
    parts.push(line);
  }
  if (d.truncated) parts.push('scan truncated');
  return `- ${parts.join(' — ')}`;
}

const COMMENT_PREVIEW_CAP = 3;

function formatCommentPreview(c: NonNullable<EnrichedMeta['comments']>[number]): string {
  const flags = [c.state === 'orphaned' ? 'passage gone' : null, c.queued ? 'queued' : null].filter(
    (f) => f !== null,
  );
  const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  return c.quote === '' ? `"${c.body}"${suffix}` : `"${c.body}" on “${c.quote}”${suffix}`;
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
  if (m.schemas_applicable && m.schemas_applicable.length > 0) {
    parts.push(`schemas: ${m.schemas_applicable.join(', ')}`);
  }
  if (m.commentCount !== null && m.commentCount > 0) {
    let line = `⚠ ${m.commentCount} unresolved comment${m.commentCount === 1 ? '' : 's'}`;
    if (m.comments && m.comments.length > 0) {
      const notes = m.comments.slice(0, COMMENT_PREVIEW_CAP).map(formatCommentPreview);
      line += `: ${notes.join('; ')}${m.comments.length > COMMENT_PREVIEW_CAP ? '; …' : ''}`;
    }
    parts.push(line);
  }
  if (m.backlinkCount !== null) {
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

function buildStdoutProvenance(
  stages: Stage[],
  dirByPath: Map<string, DirectoryMeta>,
  fileByPath: Map<string, EnrichedMeta>,
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
    if ((cmd === 'head' || cmd === 'tail') && pathArgs(s).length > 0) {
      stage = s;
      break;
    }
  }
  if (!stage) return '';

  const operands = pathArgs(stage);

  if (stage.command === 'ls') {
    const dirArg = operands[operands.length - 1];
    if (!dirArg || dirArg === '.') return '';
    let n = dirArg.replace(/\/+/g, '/');
    if (n.startsWith('./')) n = n.slice(2);
    if (n.endsWith('/')) n = n.slice(0, -1);
    if (!n) return '';
    const key = rebase(n);
    if (!dirByPath.has(key)) return '';
    return `${key}/:\n`;
  }

  const wikiFiles = operands.filter((p) => isWikiPath(p) && fileByPath.has(rebase(p)));
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
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          log.warn({ path: p, code }, 'stat failed for a reported path; dropping it');
        }
        return;
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

function writeBlockedResult(target: string | null) {
  if (target === null) log.warn({}, 'the engine refused a write without naming the file');
  const named = target === null ? 'a file' : `'${target}'`;
  return errorCategoryResult(
    'write_blocked',
    `Write operation blocked: the command tried to write ${named}. exec is read-only. For document changes, use the \`write\` or \`edit\` tool.`,
  );
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
  const { cwd, executionCwd, config, url: resolvedServerUrl } = context;

  const advertisedSchemas = selectAdvertisedFrontmatterMappings(
    toEffectiveBase(config.contentRules as PersistedLinterConfig),
  );
  const enrichSchemaDeps =
    advertisedSchemas.length > 0
      ? {
          contentDir: resolve(cwd, config.content.dir),
          frontmatterSchemas: advertisedSchemas,
        }
      : {};

  const rebaseToProject =
    executionCwd === cwd
      ? (p: string) => p
      : (p: string) => relative(cwd, resolve(executionCwd, p));

  const parsed = parseCommand(args.command);
  if ('error' in parsed) {
    return errorCategoryResult(parsed.error.category, parsed.error.message);
  }
  const expanded = await expandGlobStages(parsed.stages, executionCwd);
  if ('error' in expanded) {
    return errorCategoryResult(expanded.error.category, expanded.error.message);
  }
  const stages = augmentStagesWithExcludes(expanded.stages);
  const effectiveCommand = serializeStages(stages);

  const scanRoots = [
    ...new Set(
      deriveScanRoots(parsed.stages)
        .map((r) => resolveWithinRoot(executionCwd, r))
        .filter((r) => r.ok)
        .map((r) => r.rel),
    ),
  ];
  const pre = await snapshotMtimesForRoots(executionCwd, scanRoots);

  const bash = createBashInstance(executionCwd);
  let stdout = '';
  let stderr = '';
  try {
    const result = await execBash(bash, effectiveCommand);
    if (result.exitCode !== 0) {
      const refused = erofsTarget(result.stderr);
      if (refused.blocked) return writeBlockedResult(refused.target);
    }
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    if (err instanceof StdoutOverflowError) {
      return errorCategoryResult(
        'output_overflow',
        `Output exceeded 16 MB buffer. Narrow the command (e.g., add a more specific grep pattern, use head, restrict the path).`,
      );
    }
    const refused = erofsTarget(err);
    if (refused.blocked) return writeBlockedResult(refused.target);
    log.warn({ err, command: args.command }, 'exec failed');
    return errorCategoryResult(
      'shell_construct_blocked',
      `exec failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const post = await snapshotMtimesForRoots(executionCwd, scanRoots);
  const mtimeDiff = diffMtimes(pre.snapshot, post.snapshot);
  if (mtimeDiff.changed.length > 0) {
    log.error({ command: args.command, changed: mtimeDiff.changed }, 'files changed during exec');
    return errorCategoryResult(
      'security_invariant_violation',
      `Security invariant violated: file(s) in the content directory were modified during a read-only exec call: ${mtimeDiff.changed.join(', ')}. Either the read-only mount let a write through, or another writer (the live server, a human editor) touched these files at the same time. Logged.`,
    );
  }
  const sweepPartial = pre.truncated || post.truncated;

  const capped = applySoftCap(stdout);

  const rawPaths = extractReferencedPaths(stdout, stages);
  const paths = rawPaths.filter((p) => resolveWithinRoot(executionCwd, p).ok).map(rebaseToProject);
  const { files, dirs } = await classifyPaths(cwd, paths);
  const isSinglePathCat = stages.length === 1 && stages[0].command === 'cat' && files.length === 1;
  const fileEnriched: EnrichedMeta[] = await Promise.all(
    files.map((p) =>
      enrichPath(
        p,
        { projectDir: cwd, serverUrl: resolvedServerUrl, ...enrichSchemaDeps },
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
          commentCount: null,
          comments: null,
        }),
      ),
    ),
  );
  const dirEnriched: DirectoryMeta[] = await Promise.all(
    dirs.map((p) =>
      enrichDirectoryRecursive(p, 1, {
        projectDir: cwd,
        serverUrl: resolvedServerUrl,
        ...enrichSchemaDeps,
      }).catch(
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
  if (!isSinglePathCat && resolvedServerUrl && fileEnriched.length > 0) {
    const docNames = fileEnriched.map((f) => pathToDocName(f.path));
    const [counts, commentCounts] = await Promise.all([
      fetchBacklinkCountsBatch(resolvedServerUrl, docNames).catch(() => null),
      fetchCommentCountsBatch(resolvedServerUrl, docNames).catch(() => null),
    ]);
    for (const f of fileEnriched) {
      const docName = pathToDocName(f.path);
      const c = counts?.get(docName);
      if (typeof c === 'number') f.backlinkCount = c;
      const comments = commentCounts?.get(docName);
      if (typeof comments === 'number') f.commentCount = comments;
    }
  }
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
  if (sweepPartial) {
    banners.push(
      `Read-only mutation sweep was partial: the files in scope exceed the ${SCAN_CAP}-file cap, so only the first ${SCAN_CAP} were checked for unexpected writes. Narrow the command to a subdirectory for full sweep coverage.`,
    );
  }

  const bannerText = banners.length > 0 ? `${banners.join('\n')}\n\n` : '';
  const provenance = buildStdoutProvenance(stages, dirByPath, fileByPath, rebaseToProject);
  const stdoutText = provenance + capped.text;
  const enrichmentBlock = formatEnrichedBlock(enriched);
  const content = `${bannerText}${stdoutText}${enrichmentBlock}`;

  const { resolve: resolvePreviewUrl } = await buildListResolver({
    config,
    resolveCwd: async () => cwd,
  });
  const enrichedWithPreview: ExecEnrichedEntry[] = withPreviewUrls(enriched, resolvePreviewUrl);

  const structured: ExecStructuredResult = {
    enrichedPaths: enrichedWithPreview,
    stdoutTruncated: capped.truncated,
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
          'Per-referenced-file metadata: frontmatter, backlink/forward-link counts, unresolved comment threads (`commentCount`, plus `comments` on a single-file read), recent shadow-repo activity, and a route-only previewUrl. Directory entries carry a recursive `commentCount` + `commentedDocs`.',
        ),
        stdoutTruncated: z
          .boolean()
          .optional()
          .describe('True when stdout was truncated by the soft cap.'),
        warnings: z
          .array(z.string())
          .optional()
          .describe(
            'Tool-level warnings — head/tail truncation, binary detection, stderr, partial mutation-sweep coverage.',
          ),
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
