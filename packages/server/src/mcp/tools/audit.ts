import { BrokenLinkSuppressionSchema, validationCoverageLines } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import {
  formatAuditBrokenLinkSuppressionLine,
  formatUnreadableAuditSuppressionWarning,
} from '../../broken-link-suppression.ts';
import { parseBrokenLinkSuppression } from './advisory-warnings.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  AUDIT_FILE_CAP,
  AUDIT_FILE_DIAGNOSTIC_CAP,
  capAuditWarnings,
  countSummary,
  degradationBlock,
  formatDiagnosticLine,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  looseObjectArray,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
  zeroFindingsSummary,
} from './shared.ts';

export const DESCRIPTION = [
  'Read-only validation of markdownlint, frontmatter, OKF and broken internal links. Requires the Hocuspocus server. No args scans all in-scope .md/.mdx; `path` narrows to file/folder. `links` is the navigation/graph tool.',
  'ran names selected `markdownlint`, `frontmatter`, `okf`, `links`. A family absent from `ran` was not checked. A selected family remains in ran if degraded; warnings explain why and it may still have contributed findings. okf covers document and project-tree OKF checks here.',
  "Broken links are reported under the source doc. Default-on validation.suppressLogLinkAdvisories omits links inside lowercase log.md/log.mdx at any depth; LOG.md is ordinary. brokenLinkSuppression reports reason reserved-log-policy and count without paths/hrefs. Logs are append-only history: never rewrite old entries to clear links. links({kind:'dead'}) reads raw state.",
  'Diagnostics carry source, code, message, 0-based LSP range (link columns approximate) and severity. Broken links default to warning; validation.links can raise/hide them. Only problematic files are listed; fileCount/errorCount/warningCount reflect full scan. Output is capped at 10 files × 10 diagnostics each and project-wide at 10 warnings; omittedWarningCount reports dropped warnings. Narrow path reduces competing files; per-file caps still apply. Follow runtime hints for document lint and raw dead links; project-tree OKF findings remain capped.',
  'Nothing is modified. Auto-fix document lint with lint({document,fix:true}); fix broken links with edit/write.',
].join('\n');

export const AUDIT_WARNINGS_DESCRIPTION =
  'Anything that made this run less than a full answer: unreadable files/dirs, config problems, a validator that could not run, or a family that ran only partially (`… validation degraded: …`). A source family named here is still listed in `ran` — it was selected, and a degraded family may still have contributed findings.';

const FIX_ROUTING_HINT =
  'Auto-fix fixable lint findings with `lint({ document, fix: true })`; broken links need content edits via `edit`/`write`.';

interface AuditPositionPayload {
  line?: number;
  character?: number;
}

interface AuditDiagnosticPayload {
  source?: string;
  code?: string;
  message?: string;
  severity?: string;
  range?: { start?: AuditPositionPayload; end?: AuditPositionPayload };
}

interface AuditDocPayload {
  file?: string;
  diagnostics?: AuditDiagnosticPayload[];
}

interface AuditResponsePayload {
  files?: AuditDocPayload[];
  fileCount?: number;
  errorCount?: number;
  warningCount?: number;
  warnings?: string[];
  ran?: string[];
  brokenLinkSuppression?: unknown;
}

export interface AuditDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

interface AuditArgs {
  path?: string;
  cwd?: string;
}

export function register(server: ServerInstance, deps: AuditDeps): void {
  server.registerTool(
    'audit',
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Audit scope: a folder or single doc file (content-dir-relative). Default: the whole project.',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        files: looseObjectArray
          .optional()
          .describe('Per-file diagnostics — only files with at least one problem.'),
        fileCount: z.number().optional().describe('Total in-scope documents scanned.'),
        errorCount: z.number().describe('Total error-severity findings across validators.'),
        warningCount: z.number().describe('Total warning-severity findings across validators.'),
        warnings: z.array(z.string()).optional().describe(AUDIT_WARNINGS_DESCRIPTION),
        ran: z
          .array(z.string())
          .optional()
          .describe(
            'Validation source families selected for this run. A family absent from `ran` was not checked.',
          ),
        brokenLinkSuppression: BrokenLinkSuppressionSchema.optional().describe(
          'Present when the reserved-log policy withheld broken-link findings. Carries only the reason and count, never paths or hrefs. Absent both when nothing was withheld and when a withholding arrived in a shape this build cannot validate. In that second case `warnings` carries the disclosure, so an empty `brokenLinkSuppression` beside a non-empty `warnings` is not an all-clear.',
        ),
        omittedWarningCount: z
          .number()
          .optional()
          .describe('Warnings omitted from `warnings` by the output cap.'),
        omittedFileCount: z
          .number()
          .optional()
          .describe('Files with problems omitted from `files` by the output cap.'),
        cwd: z.string().describe('Absolute directory the audit ran against.'),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args: AuditArgs) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
      return runAudit(args.path, url, cwd);
    },
  );
}

async function runAudit(path: string | undefined, url: string, cwd: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const result = await httpGet(url, `/api/audit${query}`);
  if (!result.ok) return textResult(`Error: ${String(result.error)}`, true);
  const { ok: _ok, ...rest } = result;
  const data = rest as AuditResponsePayload;
  const files = data.files ?? [];
  const fileCount = data.fileCount ?? 0;
  const errorCount = data.errorCount ?? 0;
  const warningCount = data.warningCount ?? 0;
  const coverageLines = validationCoverageLines(data.ran, fileCount);
  const rawSuppression = data.brokenLinkSuppression;
  const suppressionPresent = rawSuppression !== undefined && rawSuppression !== null;
  const suppression = parseBrokenLinkSuppression(rawSuppression);
  const suppressionUnreadable = suppressionPresent && suppression === undefined;
  const suppressionLine = suppression
    ? formatAuditBrokenLinkSuppressionLine(suppression, { surface: 'mcp' })
    : undefined;

  const shownFiles = files.slice(0, AUDIT_FILE_CAP).map((file) => {
    const diagnostics = file.diagnostics ?? [];
    const shown = diagnostics.slice(0, AUDIT_FILE_DIAGNOSTIC_CAP);
    const omitted = diagnostics.length - shown.length;
    return {
      ...file,
      diagnostics: shown,
      ...(omitted > 0 ? { omittedDiagnosticCount: omitted } : {}),
    };
  });
  const omittedFileCount = files.length - shownFiles.length;

  const warnings = [
    ...(suppressionUnreadable ? [formatUnreadableAuditSuppressionWarning({ surface: 'mcp' })] : []),
    ...(data.warnings ?? []),
  ];
  const { shownWarnings, omittedWarningCount } = capAuditWarnings(warnings);

  const structured = {
    files: shownFiles,
    fileCount,
    errorCount,
    warningCount,
    ...(data.ran === undefined ? {} : { ran: data.ran }),
    ...(suppression === undefined ? {} : { brokenLinkSuppression: suppression }),
    ...(shownWarnings.length > 0 ? { warnings: shownWarnings } : {}),
    ...(omittedWarningCount > 0 ? { omittedWarningCount } : {}),
    ...(omittedFileCount > 0 ? { omittedFileCount } : {}),
    cwd,
  };

  const warningBlock = degradationBlock('Audit', shownWarnings, omittedWarningCount);

  const scope = path ? ` in ${path}` : '';
  if (files.length === 0) {
    const summary = zeroFindingsSummary('Audit', fileCount, warnings, scope);
    return textPlusStructured(
      [
        summary,
        ...(suppressionLine === undefined ? [] : [suppressionLine]),
        ...coverageLines,
        ...warningBlock,
      ].join('\n'),
      structured,
    );
  }
  const header = `${files.length} of ${fileCount} document${fileCount === 1 ? '' : 's'}${scope} with problems — ${countSummary(errorCount, warningCount)}:`;
  const fileBlocks = shownFiles.map((file) => {
    const lines = file.diagnostics.map(formatDiagnosticLine);
    if (file.omittedDiagnosticCount !== undefined) {
      lines.push(
        `  … and ${file.omittedDiagnosticCount} more problem${file.omittedDiagnosticCount === 1 ? '' : 's'}. For lint findings, use lint({ document: ${JSON.stringify(file.file)} }); for broken links, use links({ kind: "dead", sourceDocuments: [${JSON.stringify(file.file)}] }). Project-tree OKF findings remain capped.`,
      );
    }
    return [`${file.file ?? '(unknown)'}:`, ...lines].join('\n');
  });
  const footer =
    omittedFileCount > 0
      ? [
          `… and ${omittedFileCount} more file${omittedFileCount === 1 ? '' : 's'} with problems. Narrow path to reduce competing files; per-file caps still apply.`,
        ]
      : [];
  return textPlusStructured(
    [
      header,
      ...fileBlocks,
      ...footer,
      ...warningBlock,
      ...(suppressionLine === undefined ? [] : [suppressionLine]),
      FIX_ROUTING_HINT,
      ...coverageLines,
    ].join('\n'),
    structured,
  );
}
