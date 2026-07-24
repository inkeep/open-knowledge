/**
 * `audit` MCP tool — unified read-only validation audit.
 *
 * One call runs every registered content validator — markdownlint rules AND
 * internal-link resolution — and returns the merged per-file diagnostic plane
 * from `GET /api/audit`. Broken links are reported under the SOURCE doc that
 * contains them (a dead link is fixed by editing its source), with a line
 * position. Report-only: there is no fix shape here — auto-fixable lint rules
 * go through `lint({ document, fix: true })`, link repairs through
 * `edit`/`write`.
 */

import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  AUDIT_FILE_CAP,
  AUDIT_FILE_DIAGNOSTIC_CAP,
  countSummary,
  formatDiagnosticLine,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  looseObjectArray,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

export const DESCRIPTION = [
  '[Requires: Hocuspocus server] Unified validation audit: every content problem — markdown-lint violations AND broken internal links — in one read-only call, grouped by the file to fix.',
  '',
  '- No args → audit every in-scope `.md`/`.mdx` doc; pass `path` to scope to a folder or a single file.',
  '- To CHECK whether links resolve, use this tool: each broken link is reported under the SOURCE doc that contains it, at the offending line. (The `links` tool is the navigation/graph reader — backlinks, forward links, orphans, hubs — not the validation surface.)',
  '',
  "Each diagnostic carries a `source` naming the validator ('markdownlint' rule violations; 'links' broken internal links), a `code` (e.g. MD010, dead-link), `message`, a 0-based LSP `range` (for links: line exact, column approximate), and `severity` ('error' | 'warning' — broken links default to warnings; the project's `validation.links` setting can raise them to errors or hide them). Only files with at least one problem are listed, plus `fileCount`/`errorCount`/`warningCount` totals. Output (text and structured) is capped at 10 files × 10 diagnostics per file, with explicit '… and N more' indicators; the counts always reflect the full scan — re-run with `path` scoped to a folder or file to see what was omitted.",
  '',
  'Read-only: nothing is modified. Auto-fix fixable lint findings with `lint({ document, fix: true })`; broken links need content edits via `edit`/`write`.',
].join('\n');

/**
 * Degradation warnings (unreadable files/dirs, an unavailable validator) are
 * agent-context-bound like the diagnostics, so the same cap applies — a project
 * with many unreadable files must not flood the agent through this channel. The
 * HTTP endpoint stays the uncapped surface for GUI consumers.
 */
export const AUDIT_WARNING_CAP = 10;

/** Fix routing is per-validator: lint has an auto-fix shape, links never do. */
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
        warnings: z
          .array(z.string())
          .optional()
          .describe('Non-fatal issues (unreadable files/dirs, unavailable validators).'),
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

  // Both channels are agent-context-bound, so both get the cap; the HTTP
  // endpoint stays the uncapped surface for GUI consumers.
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

  const warnings = data.warnings ?? [];
  const shownWarnings = warnings.slice(0, AUDIT_WARNING_CAP);
  const omittedWarningCount = warnings.length - shownWarnings.length;

  const structured = {
    files: shownFiles,
    fileCount,
    errorCount,
    warningCount,
    ...(shownWarnings.length > 0 ? { warnings: shownWarnings } : {}),
    ...(omittedWarningCount > 0 ? { omittedWarningCount } : {}),
    ...(omittedFileCount > 0 ? { omittedFileCount } : {}),
    cwd,
  };

  // Surface degradation warnings in the text channel too: an agent reads text,
  // so a partial run (a skipped/unreadable file, an unavailable validator) must
  // not be byte-indistinguishable from a genuinely clean one.
  const warningBlock =
    warnings.length > 0
      ? [
          `Audit incomplete — ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (findings may be partial):`,
          ...shownWarnings.map((w) => `  ⚠ ${w}`),
          ...(omittedWarningCount > 0
            ? [`  … and ${omittedWarningCount} more warning${omittedWarningCount === 1 ? '' : 's'}`]
            : []),
        ]
      : [];

  const scope = path ? ` in ${path}` : '';
  if (files.length === 0) {
    const summary =
      warnings.length > 0
        ? `No problems found across ${fileCount} document${fileCount === 1 ? '' : 's'}${scope}, but the audit could not fully complete.`
        : `No problems across ${fileCount} document${fileCount === 1 ? '' : 's'}${scope}.`;
    return textPlusStructured([summary, ...warningBlock].join('\n'), structured);
  }
  const header = `${files.length} of ${fileCount} document${fileCount === 1 ? '' : 's'}${scope} with problems — ${countSummary(errorCount, warningCount)}:`;
  const fileBlocks = shownFiles.map((file) => {
    const lines = file.diagnostics.map(formatDiagnosticLine);
    if (file.omittedDiagnosticCount !== undefined) {
      lines.push(
        `  … and ${file.omittedDiagnosticCount} more problem${file.omittedDiagnosticCount === 1 ? '' : 's'}`,
      );
    }
    return [`${file.file ?? '(unknown)'}:`, ...lines].join('\n');
  });
  const footer =
    omittedFileCount > 0
      ? [`… and ${omittedFileCount} more file${omittedFileCount === 1 ? '' : 's'} with problems`]
      : [];
  return textPlusStructured(
    [header, ...fileBlocks, ...footer, ...warningBlock, FIX_ROUTING_HINT].join('\n'),
    structured,
  );
}
