import { z } from 'zod';
import {
  buildListResolver,
  docNameFromPath,
  PREVIEW_URL_SOURCES,
  type PreviewUrlSource,
} from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

export const DESCRIPTION = [
  '[Requires: Hocuspocus server] Ranked retrieval across ALL non-ignored files (markdown by title/body, other file types by name/path, plus folders) — pair with `exec` `grep` for exhaustive content search. The cmd-K engine (title boost + body BM25 + recency).',
  '',
  'NAMES/paths are indexed for all files; BODY content for markdown only. Two-tier agent model: run this fast indexed `search` (all files by name/path + markdown content) IN PARALLEL with `exec` (`grep`) for exhaustive literal-string content search across every file — instant ranked hits plus full content coverage. Reach for `exec` grep when you need to match content inside code/config/data files.',
  '',
  'When semantic search is enabled for the workspace (an opt-in setting with an API key), an embeddings signal is additionally fused into `full_text` ranking, surfacing conceptually-related pages that share no keywords. This tool opts in by default; the `semantic` block in the response reports coverage. Note: with semantic enabled, the query and matching page content are sent to the configured embeddings provider (content egress). Set `semantic: false` to force pure-lexical ranking for a call.',
  '',
  'Returns scored `page`, `folder`, and name-only `file` hits, each with a `signals` breakdown (lexical / fullText / recency / vector); markdown `page` hits also carry a body snippet (`file` hits never do — name-only). `exec`-grep covers every content occurrence and needs no server.',
  '',
  'Cold start: right after the server boots, the response may carry `ready: false` with an empty `results` while the index is still building. That empty set is NOT authoritative — wait ~2-3 seconds, then retry (agents have no built-in delay, so do not retry in immediate succession). If it is still `ready: false` after 2-3 retries (e.g. a very large workspace), fall back to `exec("grep ...")` rather than polling further. Once `ready` is true/omitted the results are complete.',
  '',
  '**Parameters:**',
  '- `query` — Free-form; tokenized across title, name, path segments, and (with `full_text`) body.',
  '- `intent` (optional) — `omnibar` searches title/path/folders only (fast); `full_text` includes body. Default `full_text`.',
  '- `scopes` (optional) — Result scope: `page` | `folder` | `file` | `content`. Defaults derive from `intent`.',
  '- `limit` (optional) — Max rows; default 20, max 100.',
  '- `semantic` (optional) — Set `false` to force pure-lexical ranking even when semantic search is enabled. Omit to use semantic when available.',
  '',
  'If the server is down, the tool returns a recovery hint — use `exec("grep ...")` as the server-free fallback.',
].join('\n');

interface SearchDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
  config: ConfigOrResolver;
  serverUrl: ServerUrlOrResolver;
}

const SCOPE_VALUES = ['page', 'folder', 'content', 'file'] as const;
const INTENT_VALUES = ['omnibar', 'full_text'] as const;

const InputSchema = {
  query: z.string().describe('Search query — title, path, or body terms.'),
  intent: z
    .enum(INTENT_VALUES)
    .optional()
    .describe(
      "'omnibar' for title/path/folder only (fast); 'full_text' includes body content. Default 'full_text'.",
    ),
  scopes: z
    .array(z.enum(SCOPE_VALUES))
    .optional()
    .describe(
      "Override the default scope set. Members: 'page', 'folder', 'file', 'content'. Defaults derive from intent.",
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Max rows; default 20, max 100.'),
  semantic: z
    .boolean()
    .optional()
    .describe(
      'Set false to force pure-lexical ranking for this call even when semantic search is enabled. Omit to use semantic when available.',
    ),
  cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
} as const;

const SearchResultRowSchema = z.object({
  kind: z.enum(['page', 'folder', 'file']),
  path: z.string(),
  docName: z.string(),
  title: z.string().nullable(),
  score: z.number(),
  signals: z.object({
    lexical: z.number(),
    fullText: z.number(),
    recency: z.number(),
    vector: z.number().optional(),
  }),
  snippet: z.string().optional(),
  previewUrl: z.string().nullable(),
  previewUrlSource: z.enum(PREVIEW_URL_SOURCES).optional(),
});

const SearchSemanticStatusSchema = z.object({
  capable: z.boolean(),
  applied: z.boolean(),
  coverage: z.object({ embedded: z.number().int(), total: z.number().int() }),
});

const OutputSchema = outputSchemaWithText({
  cwd: z.string(),
  query: z.string(),
  intent: z.string(),
  resultCount: z.number().int(),
  results: z.array(SearchResultRowSchema),
  elapsedMs: z.number().nullable(),
  semantic: SearchSemanticStatusSchema.optional(),
  ready: z.literal(false).optional(),
});

type SearchKind = 'page' | 'folder' | 'file';

interface SearchApiRow {
  kind?: SearchKind;
  path?: string;
  title?: string | null;
  score?: number;
  signals?: { lexical?: number; fullText?: number; recency?: number; vector?: number };
  snippet?: string;
}

interface SearchApiSemanticStatus {
  capable?: boolean;
  applied?: boolean;
  coverage?: { embedded?: number; total?: number };
}

interface SearchApiResponse {
  ok: boolean;
  error?: string;
  query?: string;
  intent?: string;
  results?: SearchApiRow[];
  elapsedMs?: number;
  semantic?: SearchApiSemanticStatus;
  ready?: boolean;
  [key: string]: unknown;
}

interface SearchResultRow {
  kind: SearchKind;
  path: string;
  docName: string;
  title: string | null;
  score: number;
  signals: { lexical: number; fullText: number; recency: number; vector?: number };
  snippet?: string;
  previewUrl: string | null;
  previewUrlSource?: PreviewUrlSource;
}

interface SearchSemanticStatus {
  capable: boolean;
  applied: boolean;
  coverage: { embedded: number; total: number };
}

interface SearchStructuredResult {
  cwd: string;
  query: string;
  intent: string;
  resultCount: number;
  results: SearchResultRow[];
  elapsedMs: number | null;
  semantic?: SearchSemanticStatus;
  ready?: false;
}

function isSearchKind(value: unknown): value is SearchKind {
  return value === 'page' || value === 'folder' || value === 'file';
}

function normalizeSignals(signals: SearchApiRow['signals']): {
  lexical: number;
  fullText: number;
  recency: number;
  vector?: number;
} {
  return {
    lexical: typeof signals?.lexical === 'number' ? signals.lexical : 0,
    fullText: typeof signals?.fullText === 'number' ? signals.fullText : 0,
    recency: typeof signals?.recency === 'number' ? signals.recency : 0,
    ...(typeof signals?.vector === 'number' ? { vector: signals.vector } : {}),
  };
}

function normalizeSemanticStatus(
  semantic: SearchApiSemanticStatus | undefined,
): SearchSemanticStatus | undefined {
  if (!semantic || typeof semantic.capable !== 'boolean') return undefined;
  return {
    capable: semantic.capable,
    applied: semantic.applied === true,
    coverage: {
      embedded: typeof semantic.coverage?.embedded === 'number' ? semantic.coverage.embedded : 0,
      total: typeof semantic.coverage?.total === 'number' ? semantic.coverage.total : 0,
    },
  };
}

function formatSemanticNote(semantic: SearchSemanticStatus | undefined): string {
  if (!semantic) return '';
  if (!semantic.capable) {
    return '> Semantic: enabled but not ready (no API key, or warming up) — lexical ranking only.';
  }
  const { embedded, total } = semantic.coverage;
  if (semantic.applied) {
    return `> Semantic: on — vector signal contributed (${embedded}/${total} pages embedded).`;
  }
  if (embedded < total) {
    return `> Semantic: on — indexing ${embedded}/${total} pages; vectors are still filling in, re-run for fuller coverage.`;
  }
  return '> Semantic: on — no page cleared the similarity threshold for this query.';
}

function formatResultsBlock(results: SearchResultRow[]): string {
  if (results.length === 0) return '';
  const lines: string[] = [];
  for (const r of results) {
    const title = r.title?.trim() || r.path;
    lines.push(`### ${title} (${r.path})`);
    lines.push(`Score ${r.score.toFixed(2)} — kind: ${r.kind}`);
    if (r.snippet) lines.push(r.snippet);
    lines.push('');
  }
  return lines.join('\n');
}

export function register(server: ServerInstance, deps: SearchDeps): void {
  server.registerTool(
    'search',
    {
      description: DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args: {
      query: string;
      intent?: (typeof INTENT_VALUES)[number];
      scopes?: Array<(typeof SCOPE_VALUES)[number]>;
      limit?: number;
      semantic?: boolean;
      cwd?: string;
    }) => {
      try {
        const context = await resolveProjectServerContext(
          deps.resolveCwd,
          deps.config,
          deps.serverUrl,
          args.cwd,
        );
        if (!context.ok) return textResult(`Error: ${context.error}`, true);
        const { cwd, config, url } = context;
        if (!url) {
          return textResult(
            `${HOCUSPOCUS_NOT_RUNNING_ERROR}\nFor server-free literal-string search, use \`exec("grep ...")\` instead — it walks the filesystem and does not need Hocuspocus.`,
            true,
          );
        }

        const intent = args.intent ?? 'full_text';
        const limit = args.limit ?? 20;
        const body: Record<string, unknown> = {
          query: args.query,
          intent,
          limit,
          semantic: args.semantic ?? true,
          source: 'mcp',
        };
        if (args.scopes) body.scopes = args.scopes;

        const result = (await httpPost(url, '/api/search', body)) as SearchApiResponse;
        if (!result.ok) {
          return textResult(`Error: ${result.error}`, true);
        }

        const { resolve } = await buildListResolver({ config, resolveCwd: async () => cwd }, cwd);

        const rows: SearchResultRow[] = (result.results ?? []).flatMap((row) => {
          if (!isSearchKind(row.kind) || typeof row.path !== 'string') return [];
          const docName = docNameFromPath(row.path);
          const resolved = resolve(docName);
          return [
            {
              kind: row.kind,
              path: row.path,
              docName,
              title: row.title ?? null,
              score: typeof row.score === 'number' ? row.score : 0,
              signals: normalizeSignals(row.signals),
              ...(row.snippet ? { snippet: row.snippet } : {}),
              previewUrl: resolved?.url ?? null,
              ...(resolved ? { previewUrlSource: resolved.source } : {}),
            },
          ];
        });

        const semantic = normalizeSemanticStatus(result.semantic);
        const ready = result.ready !== false;
        const structured: SearchStructuredResult = {
          cwd,
          query: args.query,
          intent,
          resultCount: rows.length,
          results: rows,
          elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : null,
          ...(semantic ? { semantic } : {}),
          ...(ready ? {} : { ready: false }),
        };

        const header = `## Search results for "${args.query}" (${rows.length} hit${rows.length === 1 ? '' : 's'}, intent: ${intent})`;
        const semanticNote = formatSemanticNote(semantic);
        const resultsText = !ready
          ? `The workspace search index is still warming — results for "${args.query}" are not ready yet. Wait ~2-3 seconds, then retry; if it is still warming after 2-3 retries, use \`exec("grep ...")\` for an index-free search instead.`
          : rows.length === 0
            ? `No matches for "${args.query}".`
            : `${header}\n\n${formatResultsBlock(rows)}`;
        const text = semanticNote ? `${resultsText}\n${semanticNote}` : resultsText;

        return textPlusStructured(text, structured);
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );
}
