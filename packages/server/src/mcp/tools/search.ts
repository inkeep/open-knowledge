import {
  assertNeverSemanticQueryOutcome,
  classifySemanticProviderError,
  type SearchSemanticStatus,
  SearchSemanticStatusSchema,
  SemanticProviderErrorReasonSchema,
  SemanticQueryOutcomeSchema,
  semanticProviderErrorBlocks,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { LocalApiDispatch } from '../../http/local-api-dispatch.ts';
import { getLogger } from '../../logger.ts';
import {
  buildListResolver,
  docNameFromPath,
  PREVIEW_URL_SOURCES,
  type PreviewUrlSource,
} from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  apiTarget,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

const log = getLogger('mcp:search');

export const DESCRIPTION = [
  'Ranked search across ALL non-ignored files and folders. Requires the Hocuspocus server. All file name/path values are indexed; only markdown bodies are indexed. Run in parallel with exec grep for exhaustive literal content search, especially code/config/data.',
  'Pass query; intent full_text (default) includes bodies, omnibar searches title/path/folders. scopes: page/folder/file/content; defaults follow intent. limit: 20 default, 100 max. Ranking combines title boost, BM25 and recency; hits include signals, and pages include snippets (other files are name-only).',
  'When workspace semantic search is enabled, full_text adds embeddings by default; query and matching content go to the configured provider. Set semantic:false for lexical-only/no embedding egress. Response semantic reports coverage.',
  'ready:false means an incomplete cold index, not an authoritative empty result. Wait 2–3 seconds before retrying; after 2–3 retries use exec grep. If the server is down, follow recovery text; exec grep is the server-free search fallback.',
].join('\n');

interface SearchDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
  config: ConfigOrResolver;
  serverUrl: ServerUrlOrResolver;
  localApi?: LocalApiDispatch;
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
  outcome?: unknown;
  providerErrorReason?: unknown;
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
  const applied = semantic.applied === true;
  const coverage = {
    embedded: typeof semantic.coverage?.embedded === 'number' ? semantic.coverage.embedded : 0,
    total: typeof semantic.coverage?.total === 'number' ? semantic.coverage.total : 0,
  };
  const providerErrorReason = SemanticProviderErrorReasonSchema.safeParse(
    semantic.providerErrorReason,
  );
  if (!providerErrorReason.success && semantic.providerErrorReason != null) {
    log.warn(
      { providerErrorReason: semantic.providerErrorReason },
      '[mcp:search] invalid semantic provider error reason',
    );
  }
  const reason = providerErrorReason.success ? providerErrorReason.data : null;
  const outcome = SemanticQueryOutcomeSchema.safeParse(semantic.outcome);
  if (!outcome.success) {
    log.warn({ outcome: semantic.outcome }, '[mcp:search] invalid semantic outcome');
  }
  const reconstructedProviderStatus = {
    providerError: semantic.providerErrorReason != null,
    providerErrorReason: reason,
  };
  return {
    capable: semantic.capable,
    applied,
    outcome: outcome.success
      ? outcome.data
      : applied
        ? 'applied'
        : ((semanticProviderErrorBlocks(reconstructedProviderStatus, 'query')
            ? classifySemanticProviderError(reconstructedProviderStatus)
            : null) ??
          (!semantic.capable
            ? 'incapable'
            : coverage.embedded === 0 && coverage.total > 0
              ? 'warming'
              : 'no_match')),
    providerErrorReason: reason,
    coverage,
  };
}

function formatSemanticNote(semantic: SearchSemanticStatus | undefined): string {
  if (!semantic) return '';
  const { embedded, total } = semantic.coverage;
  switch (semantic.outcome) {
    case 'restart_required':
      return '> Semantic: the provider changed vector dimensions repeatedly — restart OpenKnowledge before retrying.';
    case 'provider_error':
      return '> Semantic: provider unavailable — lexical ranking only.';
    case 'incapable':
      return semantic.providerErrorReason === 'configured_dimensions'
        ? "> Semantic: the configured vector size does not match the provider — remove search.semantic.dimensions to use the model's own size."
        : '> Semantic: enabled but unavailable (no usable embeddings provider) — lexical ranking only.';
    case 'applied':
      return `> Semantic: on — vector signal contributed (${embedded}/${total} pages embedded).`;
    case 'query_too_short':
      return '> Semantic: the query is too short for vector ranking — lexical ranking only.';
    case 'warming':
      return `> Semantic: on — indexing ${embedded}/${total} pages; vectors are still filling in, re-run for fuller coverage.`;
    case 'no_match':
      return embedded < total
        ? `> Semantic: on — indexing ${embedded}/${total} pages; vectors are still filling in, re-run for fuller coverage.`
        : '> Semantic: on — no page cleared the similarity threshold for this query.';
    default:
      return assertNeverSemanticQueryOutcome(semantic.outcome);
  }
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

        const result = (await httpPost(
          apiTarget(url, deps.localApi),
          '/api/search',
          body,
        )) as SearchApiResponse;
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
