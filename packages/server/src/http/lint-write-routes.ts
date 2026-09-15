import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import {
  AGENT_ICON_COLORS,
  colorFromSeed,
  DEFAULT_LINTER_CONFIG,
  FrontmatterSchemaWriteRequestSchema,
  LintConfigResponseSchema,
  type LinterConfig,
  LintFixRequestSchema,
  LintFixResultSchema,
  type LintPluginFailure,
  lintDocument,
  MarkdownlintRuleWriteRequestSchema,
  type Principal,
  type ReLintFailure,
  summarizeLintPluginFailures,
} from '@inkeep/open-knowledge-core';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import {
  AgentSessionCapacityError,
  type AgentSessionManager,
  applyAgentMarkdownWrite,
  iconFromClientName,
} from '../agent-sessions.ts';
import type { NormalizedSummary, SummaryResponse } from '../agent-write-summary.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import type { ConflictAuthority } from '../conflict-authority.ts';
import { DocInConflictError, respondDocInConflict } from '../conflict-errors.ts';
import { recordContributor } from '../contributor-tracker.ts';
import { stripDocExtension } from '../doc-extensions.ts';
import type { StoreFailure } from '../document-durability-state.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import {
  FrontmatterMalformedError,
  respondFrontmatterMalformed,
} from '../frontmatter-malformed-error.ts';
import { assertNoSymlinkEscape, isContainmentRejection } from '../fs-safety.ts';
import { lintAndFixSource } from '../lint/audit.ts';
import {
  createEmptyFrontmatterSchemaFile,
  deleteFrontmatterSchemaFile,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  type WriteFrontmatterSchemaResult,
  writeFrontmatterSchemaField,
} from '../lint/frontmatter-schema-write.ts';
import { type WriteMarkdownlintResult, writeMarkdownlintRule } from '../lint/markdownlint-write.ts';
import {
  composeEffectiveLinterConfig,
  composeFrontmatterSchemasConfig,
  resolveNativeConfigForDoc,
} from '../lint/resolve-config.ts';
import type { PinoLogger } from '../logger.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface LintWriteRouteDeps {
  conflicts: Pick<ConflictAuthority, 'findByDocName'>;
  contentDir: string;
  projectDir: string | undefined;
  signalLintConfigChanged: () => void;
  getLinterBaseConfig: (() => LinterConfig) | undefined;
  unmatchedGlobProblems: (effective: LinterConfig) => string[];
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  requireNonEmptyDocName: (
    docName: string | undefined,
    res: ServerResponse,
    handler: string,
  ) => string | null;
  resolveAlias: (docName: string) => string;
  getPrincipal: (() => Principal | null) | undefined;
  resolveDocFilePath: (contentDir: string, docName: string) => string | null;
  summaryResponseFields: (normalized: NormalizedSummary) => {
    response?: SummaryResponse;
    stored: string | undefined;
  };
  sessionManager: AgentSessionManager;
  agentPresenceBroadcaster: AgentPresenceBroadcaster | undefined;
  buildAgentActor: (args: {
    clientName: string | undefined;
    clientVersion?: string;
    label?: string;
  }) => {
    principalId?: string;
    agentType?: string;
    clientName?: string;
    clientVersion?: string;
    label?: string;
  };
  flushDiskAndDetectOutcome: (
    docName: string,
  ) => Promise<
    | { kind: 'failure'; failure: StoreFailure }
    | { kind: 'divergence' }
    | { kind: 'stale-external-write' }
    | null
  >;
  respondPersistenceFailure: (res: ServerResponse, failure: StoreFailure, handler: string) => void;
  respondDiskDivergence: (res: ServerResponse, handler: string) => void;
  respondStaleExternalWrite: (res: ServerResponse, handler: string, docName: string) => void;
  flushDocToDisk: (docName: string, label: string) => void;
  log: PinoLogger;
}

export function createLintWriteRoutes(deps: LintWriteRouteDeps): ApiRouteGroup {
  const {
    conflicts,
    contentDir,
    projectDir,
    signalLintConfigChanged,
    getLinterBaseConfig,
    unmatchedGlobProblems,
    signalChannel,
    requireNonEmptyDocName,
    resolveAlias,
    getPrincipal,
    resolveDocFilePath,
    summaryResponseFields,
    sessionManager,
    agentPresenceBroadcaster,
    buildAgentActor,
    flushDiskAndDetectOutcome,
    respondPersistenceFailure,
    respondDiskDivergence,
    respondStaleExternalWrite,
    flushDocToDisk,
    log,
  } = deps;

  const handleWriteMarkdownlintRule = withValidation(
    MarkdownlintRuleWriteRequestSchema,
    async (_req, res, body) => {
      let writeResult: WriteMarkdownlintResult;
      try {
        writeResult = writeMarkdownlintRule(resolve(contentDir), body.ruleId, body.value);
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write markdownlint config.',
          { handler: 'markdownlint-config', cause: e },
        );
        return;
      }
      if (writeResult.action === 'declined-executable') {
        errorResponse(
          res,
          409,
          'urn:ok:error:config-not-writable',
          `The native markdownlint config (${writeResult.file}) is an executable module OK will not rewrite — edit it directly or convert it to JSON/JSONC/YAML.`,
          { handler: 'markdownlint-config' },
        );
        return;
      }
      signalLintConfigChanged();
      try {
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'markdownlint-config' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'The markdownlint rule was saved, but the effective config could not be re-read.',
          { handler: 'markdownlint-config', cause: e },
        );
      }
    },
    { handler: 'markdownlint-config', method: 'POST' },
  );

  const handleWriteFrontmatterSchema = withValidation(
    FrontmatterSchemaWriteRequestSchema,
    async (_req, res, body) => {
      let writeResult: WriteFrontmatterSchemaResult;
      try {
        const root = resolve(projectDir ?? contentDir);
        const parentPath = body.parentPath ?? [];
        writeResult = body.delete
          ? deleteFrontmatterSchemaFile(root, body.file)
          : body.field !== undefined && body.removeField
            ? removeFrontmatterSchemaField(root, body.file, body.field, parentPath)
            : body.field !== undefined && body.renameTo !== undefined
              ? renameFrontmatterSchemaField(root, body.file, body.field, body.renameTo, parentPath)
              : body.field !== undefined && body.constraint !== undefined
                ? writeFrontmatterSchemaField(
                    root,
                    body.file,
                    body.field,
                    body.constraint,
                    parentPath,
                  )
                : createEmptyFrontmatterSchemaFile(root, body.file);
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write the frontmatter schema.',
          { handler: 'frontmatter-schema', cause: e },
        );
        return;
      }
      if (writeResult.action === 'refused') {
        errorResponse(
          res,
          409,
          'urn:ok:error:config-not-writable',
          `The frontmatter schema (${writeResult.file}) was not written: ${writeResult.reason}.`,
          { handler: 'frontmatter-schema' },
        );
        return;
      }
      if (writeResult.action === 'created' || writeResult.action === 'deleted') {
        signalChannel?.('files');
      }
      signalLintConfigChanged();
      try {
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'frontmatter-schema' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'The schema was saved, but the effective config could not be re-read.',
          { handler: 'frontmatter-schema', cause: e },
        );
      }
    },
    { handler: 'frontmatter-schema', method: 'POST' },
  );

  const handleLintFix = withValidation(
    LintFixRequestSchema,
    async (_req, res, body) => {
      try {
        const effectiveDocName = requireNonEmptyDocName(body.docName, res, 'lint-fix');
        if (effectiveDocName === null) return;
        const resolvedDocName = resolveAlias(effectiveDocName);

        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'lint-fix',
          });
          return;
        }
        const agentId = actor.kind === 'anonymous' ? 'principal-anonymous' : actor.writerId;
        const agentName = actor.kind === 'anonymous' ? 'Anonymous' : actor.displayName;
        const colorSeed = actor.kind === 'anonymous' ? agentId : actor.colorSeed;
        const clientName = actor.kind === 'agent' ? actor.clientName : undefined;

        if (isSystemDoc(resolvedDocName) || isConfigDoc(resolvedDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${resolvedDocName}' is a reserved document name.`,
            { handler: 'lint-fix' },
          );
          return;
        }

        const docRelPath = resolveDocFilePath(contentDir, resolvedDocName);
        if (docRelPath === null) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Document not found.', {
            handler: 'lint-fix',
          });
          return;
        }
        assertNoSymlinkEscape(resolve(contentDir, docRelPath), contentDir);

        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const { stored: storedSummary } = summaryResponseFields(actor.summary);
        const session = await sessionManager.getSession(resolvedDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });

        const source = session.dc.document.getText('source').toString();
        const configWarnings: string[] = [];
        const { cfg, before, fixed, ran, failures } = await lintAndFixSource({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          docRelPath,
          source,
          onConfigProblem: (problem) => configWarnings.push(problem),
        });

        let after = before;
        let reLintFailure: ReLintFailure | undefined;
        const reLintFailures: LintPluginFailure[] = [];
        if (fixed !== source) {
          try {
            const icon = iconFromClientName(clientName);
            const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed ?? agentId);
            agentPresenceBroadcaster?.setPresence(agentId, {
              displayName: agentName,
              icon,
              color,
              currentDoc: resolvedDocName,
              mode: 'writing',
              ts: Date.now(),
            });
            session.dc.document.transact(() => {
              applyAgentMarkdownWrite(session.dc.document, fixed, 'patch');
            }, session.origin);

            if (actor.kind !== 'anonymous') {
              recordContributor(
                resolvedDocName,
                agentId,
                agentName,
                colorSeed,
                undefined,
                actor.kind === 'agent'
                  ? buildAgentActor({
                      clientName: actor.clientName,
                      clientVersion: actor.clientVersion,
                      label: actor.label,
                    })
                  : actor.actor,
                storedSummary,
              );
            }
          } finally {
            agentPresenceBroadcaster?.touchMode(agentId, 'idle');
          }

          const flushOutcome = await flushDiskAndDetectOutcome(resolvedDocName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'lint-fix');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'lint-fix');
            return;
          }
          if (flushOutcome?.kind === 'stale-external-write') {
            respondStaleExternalWrite(res, 'lint-fix', resolvedDocName);
            return;
          }
          flushDocToDisk(resolvedDocName, 'lint-fix');

          try {
            after = await lintDocument(
              session.dc.document.getText('source').toString(),
              cfg,
              docRelPath,
              (failure) => reLintFailures.push(failure),
            );
          } catch (relintErr) {
            const relintMessage =
              relintErr instanceof Error ? relintErr.message : String(relintErr);
            reLintFailure = {
              reason: 're-lint-threw',
              message:
                relintMessage.trim().length > 0
                  ? relintMessage
                  : `${relintErr instanceof Error ? relintErr.name : 'non-Error value'} thrown with no message`,
            };
            log.warn(
              { err: relintErr, handler: 'lint-fix', doc: resolvedDocName, agentId },
              'post-write re-lint failed; reporting pre-fix diagnostics',
            );
            after = before;
          }
        }

        const blindBeforeFix = new Set(
          failures.filter((f) => f.phase === 'lint').map((f) => f.source),
        );
        const blindOnlyAfterFix = [
          ...new Set(
            reLintFailures
              .filter((f) => f.phase === 'lint' && !blindBeforeFix.has(f.source))
              .map((f) => f.source),
          ),
        ];
        if (reLintFailure === undefined && blindOnlyAfterFix.length > 0) {
          reLintFailure = {
            reason: 'source-went-blind',
            message: `${blindOnlyAfterFix.join(', ')} linted the pre-fix text and failed on the post-fix text, so the re-lint is short their diagnostics and cannot be compared against the pre-fix run`,
          };
          log.warn(
            { handler: 'lint-fix', doc: resolvedDocName, agentId, sources: blindOnlyAfterFix },
            'post-write re-lint lost a source that linted before the fix; reporting pre-fix diagnostics',
          );
          after = before;
        }

        const errorCount = after.filter((d) => d.severity === 'error').length;
        const warningCount = after.length - errorCount;
        const comparable = (d: (typeof before)[number]) => !blindBeforeFix.has(d.source);
        const fixedCount = Math.max(
          0,
          before.filter(comparable).length - after.filter(comparable).length,
        );
        const responseWarnings = [
          ...configWarnings,
          ...summarizeLintPluginFailures([...failures, ...reLintFailures]),
        ];

        successResponse(
          res,
          200,
          LintFixResultSchema,
          {
            file: docRelPath,
            fixedCount,
            diagnostics: after,
            errorCount,
            warningCount,
            ran,
            ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
            ...(reLintFailure ? { diagnosticsArePreFix: true, reLintFailure } : {}),
          },
          { handler: 'lint-fix' },
        );
      } catch (e) {
        if (isContainmentRejection(e)) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
            handler: 'lint-fix',
          });
          return;
        }
        if (e instanceof DocInConflictError) {
          respondDocInConflict(
            res,
            e,
            'lint-fix',
            conflicts.findByDocName(stripDocExtension(e.file)),
          );
          return;
        }
        if (e instanceof FrontmatterMalformedError) {
          respondFrontmatterMalformed(res, e, 'lint-fix');
          return;
        }
        if (e instanceof AgentSessionCapacityError) {
          errorResponse(
            res,
            503,
            'urn:ok:error:too-many-agent-sessions',
            'Too many agent sessions.',
            { handler: 'lint-fix', cause: e, extraHeaders: { 'Retry-After': '10' } },
          );
          return;
        }
        log.error({ err: e }, '[lint-fix] handler failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to fix document.', {
          handler: 'lint-fix',
          cause: e,
        });
      }
    },
    { handler: 'lint-fix', method: 'POST' },
  );

  return createApiRouteGroup(
    {
      '/api/lint/markdownlint-config': handleWriteMarkdownlintRule,
      '/api/lint/frontmatter-schema': handleWriteFrontmatterSchema,
      '/api/lint/fix': handleLintFix,
    },
    {
      mutating: ['/api/lint/markdownlint-config', '/api/lint/frontmatter-schema', '/api/lint/fix'],
    },
  );
}
