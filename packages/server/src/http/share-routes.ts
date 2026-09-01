/**
 * The share family — `share/construct-url`, `share/target-status`, and the
 * publish trio (`share/publish/owners`, `share/publish/name-check`,
 * `share/publish`) — natively routed as one group. Handler bodies move
 * byte-identically from the legacy dispatch; what they closed over in the
 * extension arrives as {@link ShareRouteDeps}.
 *
 * None of these paths was a legacy `MUTATING_ROUTES` member, `share/publish`
 * included: its admission posture is external egress behind the
 * `checkLocalOpSecurity` pre-body gate rather than content mutation, and the
 * lift preserves that membership byte-exactly (pinned in the co-located
 * table-tier test).
 */

import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EmptyRequestSchema,
  encodeShareUrl,
  InvalidShareUrlError,
  parseCanonicalGitHubShareUrl,
  ShareConstructUrlRequestSchema,
  ShareConstructUrlResponseSchema,
  SharePublishNameCheckResponseSchema,
  SharePublishOwnersResponseSchema,
  SharePublishRequestSchema,
  SharePublishResponseSchema,
  ShareTargetStatusRequestSchema,
  ShareTargetStatusResponseSchema,
} from '@inkeep/open-knowledge-core';
import {
  LOCAL_OP_PIPE_STDIO_OPTIONS,
  withHiddenWindowsConsole,
} from '../child-process-windows-hide.ts';
import { isValidBranchInfoPath } from '../git-branch-info.ts';
import { buildSyncCredentialConfig } from '../git-handle.ts';
import type { ConcurrencyGuard } from '../local-op-security.ts';
import type { PinoLogger } from '../logger.ts';
import {
  buildGitHubBlobUrl,
  buildGitHubTreeUrl,
  emitShareConstructUrlLog,
  isValidSharePath,
  SHARE_BASE_URL,
  SHARE_CONSTRUCT_URL_HANDLER_TAG,
} from '../share/construct-url.ts';
import { computeShareFreshness } from '../share/freshness.ts';
import {
  branchExistsOnOrigin,
  readGitHeadBranch,
  readOriginGitHubRepo,
  shouldResetAmbientCredentials,
} from '../share/git-context.ts';
import {
  emitSharePublishLog,
  isValidShareOwnerName,
  isValidShareRepoName,
  parseNameCheckEvent,
  parseOwnersEvent,
  parsePublishEvent,
  pickTerminalJsonLine,
  redactShareSubprocessStderr,
  SHARE_PUBLISH_HANDLER_TAG,
  SHARE_PUBLISH_KEY,
  SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
  SHARE_PUBLISH_NAME_CHECK_KEY,
  SHARE_PUBLISH_OWNERS_HANDLER_TAG,
  SHARE_PUBLISH_OWNERS_KEY,
  SHARE_PUBLISH_TIMEOUT_MS,
} from '../share/publish.ts';
import {
  computeShareTargetStatus,
  SHARE_TARGET_STATUS_HANDLER_TAG,
} from '../share/target-status.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { parseQuery } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface ShareRouteDeps {
  projectDir: string | undefined;
  contentDir: string;
  log: PinoLogger;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  /** The resolved CLI argv the extension spawns share subcommands with. */
  localOpCliArgs: string[];
  /** The extension's per-endpoint concurrency guard — one slot per publish key. */
  localOpGuard: ConcurrencyGuard;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  /**
   * Repo-root-relative projection for an absolute path, or null when the path
   * escapes the project — stays in the extension (shared with the rename
   * spine) and arrives by reference.
   */
  toGitRelativePath: (projectDir: string, absolutePath: string) => string | null;
}

export function createShareRoutes(deps: ShareRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    contentDir,
    log,
    checkLocalOpSecurity,
    localOpCliArgs,
    localOpGuard,
    getSyncEngine,
    toGitRelativePath,
  } = deps;

  /**
   * `POST /api/share/construct-url` — read the project's local git state and
   * emit a marketing-safe share URL (`https://openknowledge.ai/d/<base64url>`)
   * pinned to HEAD branch + the focused doc. Read-only against the working
   * tree: no commits, no pushes, no fetches, no `git ls-remote`.
   * Branch-existence is checked locally against `refs/remotes/origin/<branch>`;
   * the false-negative window (last fetch ran before the push) is acceptable;
   * the toast prompts the user to
   * push, the retry succeeds.
   *
   * Returns HTTP 200 with `{ok: false, error: code}` for the six business-
   * logic failures (no-remote, detached-head, branch-not-on-origin,
   * non-github-remote, invalid-path, unsupported-share-url) — DELIBERATE
   * departure from RFC 9457 for these branches. The Share UI maps each code to a per-toast string;
   * routing through 4xx would conflate share-flow outcomes with transport
   * errors the client retries differently. Transport-class failures
   * (loopback gate, payload-too-large, body-parse) still emit RFC 9457 via
   * `errorResponse`.
   */
  const handleShareConstructUrl = withValidation(
    ShareConstructUrlRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // Path validation is kind-specific: doc paths always name a file
        // (non-empty); folder paths may target the content root (empty).
        const sharePath = body.kind === 'doc' ? body.docPath : body.folderPath;
        if (!isValidSharePath(sharePath, body.kind)) {
          emitShareConstructUrlLog('invalid-path', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'invalid-path' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branch = readGitHeadBranch(projectDir);
        if (branch === null) {
          // Two upstream causes ride this branch: (a) detached HEAD — the
          // sender must check out a branch; (b) no `.git/HEAD` at all (not a
          // git repo) — also caught downstream by `readOriginGitHubRepo`
          // returning `no-remote`. Disambiguate via the origin lookup so the
          // toast says the right thing.
          const originPeek = readOriginGitHubRepo(projectDir);
          if (originPeek.kind === 'no-remote') {
            emitShareConstructUrlLog('no-remote', { kind: body.kind });
            successResponse(
              res,
              200,
              ShareConstructUrlResponseSchema,
              { ok: false, error: 'no-remote' },
              { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
            );
            return;
          }
          emitShareConstructUrlLog('detached-head', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'detached-head' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const origin = readOriginGitHubRepo(projectDir);
        if (origin.kind === 'no-remote') {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // Known non-GitHub forges (gitlab, bitbucket) can't produce a GitHub
        // share URL. GitHub hosts — github.com AND GHES — are supported: the
        // builders below take `origin.host` and the receive side accepts the
        // enterprise host behind its trust gate.
        if (origin.kind === 'non-github') {
          emitShareConstructUrlLog('non-github-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'non-github-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branchExists = branchExistsOnOrigin(projectDir, branch);
        if (!branchExists) {
          emitShareConstructUrlLog('branch-not-on-origin', {
            branchExists: false,
            kind: body.kind,
          });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'branch-not-on-origin', branch },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        // content.dir relative to the repo root. `''` when `content.dir === '.'`
        // (the dominant case). `null` (distinct from `''`) means contentDir
        // escapes projectDir — a project misconfiguration that breaks the
        // content-root invariant; fail loud via the outer catch (→ 500) rather
        // than collapsing to `''`, which would silently mint a share link
        // pointing at the repo root instead of the (broken) content dir.
        const contentRel = toGitRelativePath(projectDir, contentDir);
        if (contentRel === null) {
          throw new Error('content dir is not contained within the project dir');
        }
        const repositorySharePath =
          contentRel === ''
            ? sharePath
            : sharePath === ''
              ? contentRel
              : `${contentRel}/${sharePath}`;
        let sharedUrl: string;
        if (body.kind === 'doc') {
          sharedUrl = buildGitHubBlobUrl(
            origin.host,
            origin.owner,
            origin.repo,
            branch,
            repositorySharePath,
          );
        } else {
          sharedUrl = buildGitHubTreeUrl(
            origin.host,
            origin.owner,
            origin.repo,
            branch,
            repositorySharePath,
          );
        }
        // Derive depth through the same canonical build + parse contract the
        // reader uses. For valid contentRel values this count equals a raw
        // slash split; the round-trip also validates the encoded URL before
        // minting the token.
        let shareUrl: string;
        try {
          const contentRootDepth =
            contentRel === ''
              ? 0
              : parseCanonicalGitHubShareUrl(
                  buildGitHubTreeUrl(origin.host, origin.owner, origin.repo, branch, contentRel),
                ).targetSegments.length;
          shareUrl = `${SHARE_BASE_URL}${encodeShareUrl(sharedUrl, contentRootDepth)}`;
        } catch (err) {
          if (!(err instanceof InvalidShareUrlError)) throw err;
          emitShareConstructUrlLog('unsupported-share-url', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'unsupported-share-url' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const freshness = await computeShareFreshness(
          projectDir,
          branch,
          repositorySharePath,
          body.kind,
        );
        emitShareConstructUrlLog('ok', { branchExists: true, kind: body.kind, freshness });
        successResponse(
          res,
          200,
          ShareConstructUrlResponseSchema,
          { ok: true, shareUrl, sharedUrl, branch, freshness },
          { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
        );
      } catch (err) {
        // Defensive: a future dependency change might add a throwing branch,
        // and the structured 200 contract above would otherwise leak the throw as an
        // unhandled-rejection 500. Generic title — raw `err.message` could
        // include FS paths.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG }),
    },
  );

  /**
   * `POST /api/share/target-status` — receive-side verdict for a share link
   * whose target is missing on the receiver's current ref. Runs a targeted
   * `git fetch origin <branch>` (authenticated by the user's ambient git
   * credential helper, same as checkout's fetch; no explicit token injection)
   * bounded by a timeout, then classifies the miss from git's rename detection:
   * on-origin (the local ref was stale) / renamed (+ a new path verified to
   * resolve at the origin ref) / deleted / never-on-branch / unknown (fetch
   * failed). Fail-open: any error returns `unknown`, and the caller falls back
   * to today's guidance.
   *
   * Updates only remote-tracking refs, no CRDT mutation — so the
   * attribution-sweep meta-test exempts it (see EXEMPT_HANDLERS).
   */
  function projectRenamedShareTarget(
    repositoryPath: string,
    renamedRepositoryPath: string,
    contentRootDepth: number,
  ): { verdict: 'renamed'; renamedTo: string } | { verdict: 'unknown' } {
    const originalSegments = repositoryPath.split('/');
    const renamedSegments = renamedRepositoryPath.split('/');
    if (contentRootDepth >= originalSegments.length || contentRootDepth >= renamedSegments.length) {
      return { verdict: 'unknown' };
    }
    for (let index = 0; index < contentRootDepth; index += 1) {
      if (originalSegments[index] !== renamedSegments[index]) return { verdict: 'unknown' };
    }
    return { verdict: 'renamed', renamedTo: renamedSegments.slice(contentRootDepth).join('/') };
  }

  const handleShareTargetStatus = withValidation(
    ShareTargetStatusRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'projectDir is not configured for this server.',
            { handler: SHARE_TARGET_STATUS_HANDLER_TAG },
          );
          return;
        }
        // Validate the path shape before it reaches git's `<ref>:<path>`
        // ref-spec, mirroring the sibling share handlers (construct-url's
        // `isValidSharePath`, branch-info's `isValidBranchInfoPath`) —
        // precedent #55 content-scope predicate symmetry. Kind-aware: an empty
        // path is the folder-root sentinel, invalid for a doc; `..`, `.git`,
        // control chars, and backslashes are rejected so a malformed path can't
        // reach git and degrade the verdict classification.
        if (!isValidBranchInfoPath(body.path, body.kind)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'path is missing or malformed.', {
            handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          });
          return;
        }
        const status = await computeShareTargetStatus(
          projectDir,
          body.branch,
          body.path,
          body.kind,
          {
            credentialConfig: buildSyncCredentialConfig(localOpCliArgs, {
              resetAmbient: shouldResetAmbientCredentials(projectDir),
            }),
          },
        );
        const contentStatus =
          status.verdict !== 'renamed' || body.contentRootDepth === undefined
            ? status
            : projectRenamedShareTarget(body.path, status.renamedTo, body.contentRootDepth);
        successResponse(res, 200, ShareTargetStatusResponseSchema, contentStatus, {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_TARGET_STATUS_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_TARGET_STATUS_HANDLER_TAG }),
    },
  );

  /**
   * Spawn the share-flow CLI subcommand once, with a bounded timeout, and
   * collect its stdout. Returns the captured text + exit code. Used by all
   * three publish handlers; the shape mirrors `handleLocalOpAuthStatus`'s
   * inline spawn so the route-shape meta-tests scan one consistent pattern.
   *
   * stderr is piped + collected; on non-zero exit, a redacted prefix is
   * logged via the `api` logger (`[share] subprocess ...`) so production
   * failures (git binary missing, keychain denied, Octokit auth error)
   * leave a diagnostic trail. Credential URLs of the form
   * `x-access-token:<token>@github.com` get the token replaced with `***`
   * before logging — the CLI uses inline-token push URLs and a partial git
   * error could otherwise leak the PAT.
   *
   * Throws on spawn-failure / timeout — the handlers map to `errorResponse`.
   */
  async function spawnShareSubprocess(
    args: readonly string[],
  ): Promise<{ stdout: string; code: number | null }> {
    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, ...args];
    return await new Promise<{ stdout: string; code: number | null }>((resolveSpawn, reject) => {
      const child = spawn(
        cmd,
        spawnArgs,
        withHiddenWindowsConsole({
          ...LOCAL_OP_PIPE_STDIO_OPTIONS,
          env: { ...process.env },
        }),
      );
      // Settle AT the timer, not at 'close' — the package-wide timeout-kill
      // shape (illustrative precedents: `rename-log.ts`, `acp/archive.ts`,
      // `acp/login-shell-path.ts`; the auth-status/signout/repos spawns in
      // `api-extension.ts` carry the same latch).
      // Settlement must not depend on the child cooperating: 'close' fires only
      // after every shared stdio stream ends (a grandchild holding the pipe
      // write-ends delays it past 'exit'), SIGKILL cannot reap a process in
      // uninterruptible sleep (stalled network mount), and `child.kill()`
      // signals one PID, not the tree. So the timer rejects immediately —
      // freeing the caller's `finally { localOpGuard.release() }` slot — and
      // the SIGKILL is fire-and-forget process hygiene, not a precondition.
      let settled = false;
      const killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // child may already be dead
        }
        // Tear the pipes down at settle: a D-state child (or a grandchild
        // holding the write-ends) can keep streaming into the chunk buffers
        // after the request has already 500'd — destroy bounds that memory.
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`share subprocess timed out after ${SHARE_PUBLISH_TIMEOUT_MS}ms`));
      }, SHARE_PUBLISH_TIMEOUT_MS);
      killTimer.unref?.();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          const redacted = redactShareSubprocessStderr(stderr).slice(0, 500);
          log.warn(
            { code, stderr: redacted },
            `[share] subprocess exited code=${code} stderr=${redacted}`,
          );
        }
        resolveSpawn({ stdout, code });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  /**
   * GET /api/share/publish/owners — list GitHub owners the user can host a
   * new repo under (owner eligibility). Spawns `open-knowledge share owners --json` and
   * returns one of:
   *   { ok: true, owners: [...] }
   *   { ok: false, error: 'auth-required' | 'network' }
   *
   * The owners endpoint is read-only and idempotent. Its localOpGuard slot is
   * keyed per endpoint (`SHARE_PUBLISH_OWNERS_KEY`), so it serializes only
   * concurrent owner-list calls against each other — it does NOT mutually
   * exclude owner-list from name-check or publish-create, each of which holds
   * its own distinct key.
   */
  const handleSharePublishOwners = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_OWNERS_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share owners operation is already in progress.',
          { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess(['share', 'owners', '--json']);
        const event = pickTerminalJsonLine(stdout);
        const body = parseOwnersEvent(event);
        emitSharePublishLog(
          'owners-list',
          body.ok ? 'ok' : body.error,
          body.ok ? { count: body.owners.length } : undefined,
        );
        successResponse(res, 200, SharePublishOwnersResponseSchema, body, {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_OWNERS_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG }),
    },
  );

  /**
   * GET /api/share/publish/name-check?owner=<o>&name=<n> — pre-flight a repo
   * name for conflict. Spawns `open-knowledge share name-check --json
   * --owner X --name Y` and returns one of:
   *   { ok: true, available: boolean }
   *   { ok: false, error: 'auth-required' | 'network' }
   *
   * Query-param validation runs server-side: missing/invalid `owner` or
   * `name` short-circuits to 400 invalid-request BEFORE the subprocess
   * spawns. This keeps a malformed wizard call from triggering a CLI
   * exec on every keypress.
   */
  const handleSharePublishNameCheck = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const params = parseQuery(req);
      const owner = params.get('owner') ?? '';
      const name = params.get('name') ?? '';
      if (!isValidShareOwnerName(owner) || !isValidShareRepoName(name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name query params must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_NAME_CHECK_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share name-check operation is already in progress.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess([
          'share',
          'name-check',
          '--owner',
          owner,
          '--name',
          name,
          '--json',
        ]);
        const event = pickTerminalJsonLine(stdout);
        const body = parseNameCheckEvent(event);
        emitSharePublishLog(
          'name-check',
          body.ok ? 'ok' : body.error,
          body.ok ? { available: body.available } : undefined,
        );
        successResponse(res, 200, SharePublishNameCheckResponseSchema, body, {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_NAME_CHECK_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG }),
    },
  );

  /**
   * POST /api/share/publish — drive a no-remote project to first share (publish flow).
   * Spawns `open-knowledge share publish --json --owner ... --name ...
   * --visibility ... [--description ...] --project-dir <projectDir>` and
   * returns one of:
   *   { ok: true, ownerLogin, repoName, cloneUrl, defaultBranch }
   *   { ok: false, error: <SharePublishErrorCode> }
   *
   * `projectDir` is sourced from the server's own `ApiExtensionOptions` —
   * never trusted from the client — so a hostile caller can't redirect
   * the publish flow at another project on disk. Absent `projectDir`
   * surfaces as `no-project` (the editor's wizard knows what to do).
   */
  const handleSharePublish = withValidation(
    SharePublishRequestSchema,
    async (_req, res, body) => {
      if (!projectDir) {
        emitSharePublishLog('publish-create', 'no-project');
        successResponse(
          res,
          200,
          SharePublishResponseSchema,
          { ok: false, error: 'no-project' },
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!isValidShareOwnerName(body.owner) || !isValidShareRepoName(body.name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share publish operation is already in progress.',
          { handler: SHARE_PUBLISH_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const args = [
          'share',
          'publish',
          '--owner',
          body.owner,
          '--name',
          body.name,
          '--visibility',
          body.visibility,
          '--project-dir',
          projectDir,
          '--json',
        ];
        if (body.description !== undefined && body.description.length > 0) {
          args.push('--description', body.description);
        }
        const { stdout } = await spawnShareSubprocess(args);
        const event = pickTerminalJsonLine(stdout);
        const responseBody = parsePublishEvent(event);
        emitSharePublishLog('publish-create', responseBody.ok ? 'ok' : responseBody.error);
        if (responseBody.ok) {
          // A successful publish just added `origin` to the local repo (the
          // CLI's runPublishFlow addRemote step). The sync engine snapshotted
          // `hasRemote: false` at boot, so without a nudge the client keeps
          // routing the Share button into THIS wizard — and the republish
          // 422s on the repo that now exists. Fire-and-forget re-detection
          // flips `hasRemote` and signals CC1 'sync-status' so the next Share
          // click constructs the URL directly. Mirrors the set-identity
          // handler's refreshIdentity nudge.
          void getSyncEngine?.()
            ?.refreshRemote()
            .catch((err) => {
              // Best-effort — status catches up on next poll / restart — but a
              // SYSTEMATIC failure here (broken git config, `.git` perms) leaves
              // the Share button stuck reopening the first-publish wizard with
              // nothing in the logs to explain it, so record the rejection.
              log.warn({ err }, '[share] post-publish refreshRemote failed');
            });
        }
        successResponse(res, 200, SharePublishResponseSchema, responseBody, {
          handler: SHARE_PUBLISH_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_HANDLER_TAG }),
    },
  );

  const routes = {
    '/api/share/construct-url': handleShareConstructUrl,
    '/api/share/target-status': handleShareTargetStatus,
    '/api/share/publish/owners': handleSharePublishOwners,
    '/api/share/publish/name-check': handleSharePublishNameCheck,
    '/api/share/publish': handleSharePublish,
  } satisfies ApiRouteRecord;

  // No mutating declaration — byte-exact legacy membership: no share path
  // rode `MUTATING_ROUTES` (see the module docblock).
  return createApiRouteGroup(routes);
}
