import { validationCoverageLines } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  AUDIT_FILE_CAP,
  AUDIT_FILE_DIAGNOSTIC_CAP,
  agentIdentityFields,
  capAuditWarnings,
  countSummary,
  degradationBlock,
  formatDiagnosticLine,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  httpPost,
  looseObjectArray,
  normalizeDocName,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

export const DESCRIPTION = [
  '[Requires: Hocuspocus server] Lint markdown documents and report problems (rule violations); optionally auto-fix them.',
  '',
  '- `document` given → lint just that doc (extension-less path); `path` is ignored.',
  '- `document` omitted → audit every in-scope `.md`/`.mdx` doc; pass `path` to scope to a folder or single file.',
  '- `fix: true` (requires `document`) → apply auto-fixable rules to that doc IN PLACE and report what remains.',
  '- The result reports `ran`, the enabled document-lint source families selected for the run: `markdownlint`, `frontmatter`, and/or document-level `okf`. A family absent from `ran` was not checked. Project-tree OKF checks and link validation run only through `audit`.',
  '',
  "Each violation carries a `source` (the plugin, e.g. markdownlint), a `code` (the engine's native rule id, e.g. MD010), `message`, a 0-based LSP `range`, and `severity` ('error' | 'warning' | 'info' | 'hint'). The audit lists only files that have at least one violation, plus `fileCount`/`errorCount`/`warningCount`. Audit output (text and structured) is capped at 10 files × 10 diagnostics per file and project-wide at 10 warnings, with explicit '… and N more' indicators and `omittedWarningCount` when warnings are dropped; the counts always reflect the full scan — re-run with `path` scoped to a folder or file to see what was omitted. Lint rules are configured in Settings → Plugins (the toggle is committed to `config.yml`; the rules live in the project's native `.markdownlint.*` file).",
  '',
  'To auto-fix, pass `fix: true` with `document`: the fix lands through the collaborative document — attributed to you and reflected in the live preview, same as the editor. It fixes auto-fixable rules (e.g. hard tabs, trailing spaces); violations that resist auto-fix need content edits via the `edit`/`write` tools. (`ok lint --fix` from a shell remains the headless/CI path, but it writes on disk unattributed — prefer `fix: true` when the server is running.)',
].join('\n');

export const LINT_WARNINGS_DESCRIPTION =
  'Anything that made this run less than a full answer: unreadable files/dirs (audit), lint-config problems such as a broken frontmatter schema file, and selected lint plugins that threw. A source family named here is still listed in `ran` — it was selected, it just could not finish.';

function singleDocFixHint(fixableCount: number, total: number): string {
  if (fixableCount === 0) {
    return 'None are auto-fixable — these need content edits via `edit`/`write`.';
  }
  const remaining = total - fixableCount;
  const remainder =
    remaining > 0 ? ` The other ${remaining} need content edits via \`edit\`/\`write\`.` : '';
  return `${fixableCount} of ${total} are auto-fixable — pass \`fix: true\` to apply in place (attributed, live preview).${remainder}`;
}

const AUDIT_FIX_HINT =
  'Auto-fix a single file with `lint({ document, fix: true })` (attributed, live preview). Violations that resist auto-fix need content edits.';

interface LintPositionPayload {
  line?: number;
  character?: number;
}

interface LintTextEditPayload {
  range?: { start?: LintPositionPayload; end?: LintPositionPayload };
  newText?: string;
}

interface LintDiagnosticPayload {
  source?: string;
  code?: string;
  message?: string;
  severity?: string;
  range?: { start?: LintPositionPayload; end?: LintPositionPayload };
  fixes?: LintTextEditPayload[];
}

interface LintDocPayload {
  file?: string;
  diagnostics?: LintDiagnosticPayload[];
  warnings?: string[];
  ran?: string[];
}

interface LintFixPayload {
  file?: string;
  fixedCount?: number;
  diagnostics?: LintDiagnosticPayload[];
  warning?: string;
  warnings?: string[];
  ran?: string[];
}

interface LintAuditPayload {
  files?: LintDocPayload[];
  fileCount?: number;
  errorCount?: number;
  warningCount?: number;
  warnings?: string[];
  ran?: string[];
}

export interface LintDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface LintArgs {
  document?: string;
  path?: string;
  fix?: boolean;
  cwd?: string;
}

export function register(server: ServerInstance, deps: LintDeps): void {
  server.registerTool(
    'lint',
    {
      description: DESCRIPTION,
      inputSchema: {
        document: z
          .string()
          .optional()
          .describe('Doc to lint (path, extension-less). Omit to audit the whole project.'),
        path: z
          .string()
          .optional()
          .describe(
            'Audit scope when `document` is omitted: a folder or single file (content-dir-relative). Default: the whole project.',
          ),
        fix: z
          .boolean()
          .optional()
          .describe(
            'Auto-fix fixable rules in `document` IN PLACE (attributed, live preview), then report what remains. Requires `document`.',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        files: looseObjectArray
          .optional()
          .describe('Per-file diagnostics. For a single-doc lint, the one file (even if clean).'),
        fileCount: z.number().optional().describe('Audit only: total in-scope documents scanned.'),
        errorCount: z.number().describe('Total error-severity violations.'),
        warningCount: z.number().describe('Total warning-severity violations.'),
        warnings: z.array(z.string()).optional().describe(LINT_WARNINGS_DESCRIPTION),
        ran: z
          .array(z.string())
          .optional()
          .describe(
            'Lint source families selected for this run. A family absent from `ran` was not checked.',
          ),
        omittedWarningCount: z
          .number()
          .optional()
          .describe('Audit only: warnings omitted from `warnings` by the output cap.'),
        omittedFileCount: z
          .number()
          .optional()
          .describe('Audit only: files with problems omitted from `files` by the output cap.'),
        fixedCount: z
          .number()
          .optional()
          .describe('Fix mode only: problems resolved by the auto-fix.'),
        cwd: z.string().describe('Absolute directory the lint ran against.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args: LintArgs) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      if (args.fix === true) {
        if (args.document === undefined) {
          return textResult(
            'Error: `fix: true` requires `document` (fix one doc at a time). Omit `fix` to audit the whole project.',
            true,
          );
        }
        return fixLintDoc(args.document, url, cwd, deps.identityRef?.current);
      }

      return args.document !== undefined
        ? lintSingleDoc(args.document, url, cwd)
        : lintAudit(args.path, url, cwd);
    },
  );
}

async function fixLintDoc(
  document: string,
  url: string,
  cwd: string,
  identity: AgentIdentity | undefined,
) {
  const normalized = normalizeDocName(document);
  if (!normalized.ok) return textResult(normalized.error, true);
  const result = await httpPost(url, '/api/lint/fix', {
    docName: normalized.docName,
    ...agentIdentityFields(identity),
  });
  if (!result.ok) return textResult(`Error: ${String(result.error)}`, true);
  const { ok: _ok, ...rest } = result;
  const data = rest as LintFixPayload;
  const file = data.file ?? normalized.docName;
  const diagnostics = data.diagnostics ?? [];
  const fixedCount = data.fixedCount ?? 0;
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;
  const responseWarnings = data.warnings ?? [];
  const coverageLines = validationCoverageLines(data.ran);
  const structured = {
    files: [{ file, diagnostics }],
    fixedCount,
    errorCount,
    warningCount,
    ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    ...(data.ran === undefined ? {} : { ran: data.ran }),
    cwd,
  };

  const header = data.warning
    ? `Applied auto-fixes to ${file}, but re-lint failed (${data.warning}); the fix landed — problems below are the pre-fix set, re-run \`lint\` to confirm.`
    : fixedCount > 0
      ? `Fixed ${fixedCount} problem${fixedCount === 1 ? '' : 's'} in ${file}.`
      : responseWarnings.length > 0
        ? `No auto-fixable problems in ${file}, but the lint could not fully complete.`
        : `No auto-fixable problems in ${file}.`;
  const lines = diagnostics.map(formatDiagnosticLine);
  const warningBlock = degradationBlock(
    'Lint',
    responseWarnings.filter((warning) => warning !== data.warning),
  );
  const footer =
    diagnostics.length > 0 && !data.warning
      ? [
          `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'} remain (${countSummary(errorCount, warningCount)}) — need content edits via \`edit\`/\`write\`.`,
        ]
      : [];
  const textLines =
    diagnostics.length === 0
      ? [header, ...coverageLines, ...warningBlock]
      : [header, ...lines, ...warningBlock, ...footer, ...coverageLines];
  return textPlusStructured(textLines.join('\n'), structured);
}

async function lintSingleDoc(document: string, url: string, cwd: string) {
  const normalized = normalizeDocName(document);
  if (!normalized.ok) return textResult(normalized.error, true);
  const result = await httpGet(url, `/api/lint?doc=${encodeURIComponent(normalized.docName)}`);
  if (!result.ok) return textResult(`Error: ${String(result.error)}`, true);
  const { ok: _ok, ...rest } = result;
  const data = rest as LintDocPayload;
  const diagnostics = data.diagnostics ?? [];
  const configWarnings = data.warnings ?? [];
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;
  const coverageLines = validationCoverageLines(data.ran);
  const file = { file: data.file ?? normalized.docName, diagnostics };
  const structured = {
    files: [file],
    errorCount,
    warningCount,
    ...(configWarnings.length > 0 ? { warnings: configWarnings } : {}),
    ...(data.ran === undefined ? {} : { ran: data.ran }),
    cwd,
  };

  const header =
    diagnostics.length > 0
      ? `${file.file}: ${countSummary(errorCount, warningCount)}`
      : configWarnings.length > 0
        ? `No problems found in ${file.file}, but the lint could not fully complete.`
        : `No problems in ${file.file}.`;
  const lines = diagnostics.map(formatDiagnosticLine);
  const warningBlock = degradationBlock('Lint', configWarnings);
  const fixableCount = diagnostics.filter((d) => (d.fixes?.length ?? 0) > 0).length;
  const footer = diagnostics.length > 0 ? [singleDocFixHint(fixableCount, diagnostics.length)] : [];
  const textLines =
    diagnostics.length === 0
      ? [header, ...coverageLines, ...warningBlock]
      : [header, ...lines, ...warningBlock, ...footer, ...coverageLines];
  return textPlusStructured(textLines.join('\n'), structured);
}

async function lintAudit(path: string | undefined, url: string, cwd: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const result = await httpGet(url, `/api/lint/audit${query}`);
  if (!result.ok) return textResult(`Error: ${String(result.error)}`, true);
  const { ok: _ok, ...rest } = result;
  const data = rest as LintAuditPayload;
  const files = data.files ?? [];
  const fileCount = data.fileCount ?? 0;
  const errorCount = data.errorCount ?? 0;
  const warningCount = data.warningCount ?? 0;
  const coverageLines = validationCoverageLines(data.ran);

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
  const { shownWarnings, omittedWarningCount } = capAuditWarnings(warnings);

  const structured = {
    files: shownFiles,
    fileCount,
    errorCount,
    warningCount,
    ...(shownWarnings.length > 0 ? { warnings: shownWarnings } : {}),
    ...(omittedWarningCount > 0 ? { omittedWarningCount } : {}),
    ...(data.ran === undefined ? {} : { ran: data.ran }),
    ...(omittedFileCount > 0 ? { omittedFileCount } : {}),
    cwd,
  };

  const scope = path ? ` in ${path}` : '';
  const warningBlock = degradationBlock('Lint', shownWarnings, omittedWarningCount);
  if (files.length === 0) {
    const summary =
      warnings.length > 0
        ? `No problems found across ${fileCount} document${fileCount === 1 ? '' : 's'}${scope}, but the lint could not fully complete.`
        : `No problems across ${fileCount} document${fileCount === 1 ? '' : 's'}${scope}.`;
    return textPlusStructured([summary, ...coverageLines, ...warningBlock].join('\n'), structured);
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
    [header, ...fileBlocks, ...footer, ...warningBlock, AUDIT_FIX_HINT, ...coverageLines].join(
      '\n',
    ),
    structured,
  );
}
