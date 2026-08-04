/**
 * Report a skill install to skills.sh so a published skill's install count
 * reflects real adoption.
 *
 * This is the ONLY outbound third-party call OK makes on the skill paths — the
 * `telemetry.localSink.*` config keys are all local-only sinks. It exists
 * because skills.sh counts installs from an explicit event, NOT from serving
 * files: `npx skills add` fetches bundle content from `skills.sh/api/download/…`
 * and separately fires this event. OK acquires skills by cloning the source
 * repo directly, so without this it is invisible to the counter no matter how
 * many people install through OK.
 *
 * Wire format is the `skills` CLI's, matched field for field so both clients
 * land in one bucket rather than two shapes the receiver has to reconcile.
 *
 * Three rules keep this honest:
 *   1. ONE report per (skill, source) per machine. The desktop reclaim sweep
 *      runs on every launch and `ok init` is re-runnable; reporting per call
 *      would climb the counter without anyone installing anything. The
 *      dedupe ledger is what makes the number mean "installs", not "launches".
 *   2. PUBLIC sources only. A private repo's name is the user's information,
 *      not ours to send — the same reason the upstream CLI gates its own event
 *      on a repo-privacy probe. Local paths are skipped for the same reason.
 *   3. Never blocks and never fails an install. Fire-and-forget with a short
 *      timeout; a dead network is not an install error.
 */

import { realpathSync } from 'node:fs';
import { getLogger } from './logger.ts';
import { clearInstallReported, readInstallReported, writeInstallReported } from './skill-state.ts';

/** The `skills` CLI's telemetry collector. Same endpoint, same query shape. */
const TELEMETRY_URL = 'https://add-skill.vercel.sh/t';

const REPORT_TIMEOUT_MS = 3000;

/**
 * Statuses that prove the COLLECTOR APPLICATION saw the event and declined it,
 * so nothing was counted and re-reporting later cannot double-count. Everything
 * else a non-2xx can be — 5xx and 429 from a serverless platform, 403 from an
 * edge WAF — may have been issued after the origin already recorded the event,
 * so those keep their claim.
 */
const RETRYABLE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);

/**
 * `owner/repo` — the only source shape we report. Deliberately NOT a general
 * URL matcher: a git URL can carry credentials, and a local path is nobody's
 * business but the user's. Anything else is skipped silently.
 *
 * The dot segments are excluded explicitly: `[\w.-]+` happily matches `.` and
 * `..`, so a plain character-class check reads `./local` and `../vendor` as
 * `owner/repo` and would have shipped a local directory name to a third party.
 * A leading dot elsewhere is fine (`acme/.github` is a real repository).
 */
/**
 * Reserved / private-network suffixes (RFC 6762 `.local`, RFC 8375 `.home.arpa`,
 * RFC 6761 `.test`/`.invalid`/`.localhost`, plus the conventional intranet
 * names). A source under one of these is an internal host, never a public
 * marketplace listing.
 */
const PRIVATE_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.intranet',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.private',
  '.test',
  '.invalid',
  '.localhost',
  '.localdomain',
] as const;

function isPublicRepoSource(source: string): boolean {
  const parts = source.split('/');
  // A website catalog publishes under a bare hostname (`open.feishu.cn`) — the
  // other shape skills.sh indexes. A dot is what separates it from a bare local
  // directory name.
  if (parts.length === 1) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(source)) {
      return false;
    }
    // An internal hostname is not a marketplace publisher, and its NAME is the
    // sensitive part — `skills.corp.acme` tells a third party about a network
    // it has no business knowing. A source that only resolves inside someone's
    // VPN cannot be a skills.sh listing anyway.
    return !PRIVATE_HOST_SUFFIXES.some((suffix) => source.toLowerCase().endsWith(suffix));
  }
  if (parts.length !== 2) return false;
  return parts.every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');
}

export interface SkillInstallReport {
  /** `owner/repo` the skill came from. Non-matching sources are skipped. */
  source: string;
  /** Skill names installed from that source in this operation. */
  skills: readonly string[];
  /** Editor/host ids the skill was placed into (`claude`, `codex`, …). */
  agents?: readonly string[];
  /** True when the install landed at user-global scope. */
  global?: boolean;
  /** OK version, sent as the client version so the receiver can tell us apart. */
  version?: string;
  /**
   * Dedupe scope. Absent means machine-wide: the skill is installed once per
   * machine (the user-global bundles), so a re-init or a launch reclaim must
   * contribute nothing. Present means the install is PER-PROJECT — each project
   * gets its own copy of the skill in its own editor dirs — so the ledger keys
   * by project and a genuinely new project counts, while re-running init or
   * re-seeding the SAME project still contributes nothing.
   *
   * Local only: this never leaves the machine. It keys the ledger; the payload
   * sent to the collector is unchanged.
   */
  scope?: string;
}

/**
 * Ledger key: machine-wide by default, per-project when the report is scoped.
 *
 * The scope is canonicalized because callers disagree about it: `ok init`
 * reports the un-realpath'd cwd for a project that has no `.ok/` yet and the
 * realpath'd root afterwards, while the desktop always realpaths. Any project
 * reached through a symlinked ancestor (`/tmp` → `/private/tmp`, a `~/code`
 * symlink) would otherwise claim two different keys for one project and count
 * the same install twice. Local-only, so canonicalizing costs nothing.
 */
function ledgerKey(report: SkillInstallReport, skill: string): string {
  if (report.scope === undefined) return `${report.source}#${skill}`;
  let scope = report.scope;
  try {
    scope = realpathSync(scope);
  } catch {
    // Not on disk (yet, or ever) — the raw string is still a stable key.
  }
  return `${report.source}#${skill}@${scope}`;
}

export interface ReportSkillInstallDeps {
  /** `$HOME` — the dedupe ledger lives beside the other skill state. */
  home: string;
  /** Resolved `telemetry.skillInstallReports.enabled`. */
  enabled: boolean;
  /** Test seam. */
  fetchImpl?: typeof globalThis.fetch;
  /** Test seam — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The two environment variables the `skills` CLI itself honors, plus the
 * broader `DO_NOT_TRACK` convention. Checked in addition to the config toggle
 * so a machine-wide opt-out works without editing OK's config.
 */
function envOptOut(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISABLE_TELEMETRY || env.DO_NOT_TRACK);
}

/**
 * Report an install, once. Resolves when the attempt is done (or immediately
 * when skipped) so callers may `void` it without an unhandled rejection.
 *
 * Returns the skills actually reported — empty when the report was skipped,
 * which is the normal case on every run after the first.
 */
export async function reportSkillInstall(
  report: SkillInstallReport,
  deps: ReportSkillInstallDeps,
): Promise<readonly string[]> {
  const env = deps.env ?? process.env;
  if (!deps.enabled || envOptOut(env)) return [];
  if (!isPublicRepoSource(report.source.trim())) return [];

  // Drop the ones already reported from this machine, so a re-init or a
  // launch-time reclaim contributes nothing.
  // A read failure reads as "nothing reported yet", which risks a duplicate —
  // logged so an over-count investigation has a trail rather than a mystery.
  const alreadyReported = await readInstallReported(deps.home).catch((err: unknown) => {
    getLogger('skills').warn(
      { err, source: report.source },
      'could not read the install-report ledger; a duplicate report is possible',
    );
    return new Set<string>();
  });
  const fresh = report.skills.filter((s) => !alreadyReported.has(ledgerKey(report, s)));
  if (fresh.length === 0) return [];

  const params = new URLSearchParams({
    event: 'install',
    source: report.source,
    skills: fresh.join(','),
  });
  if (report.agents && report.agents.length > 0) params.set('agents', report.agents.join(','));
  if (report.global) params.set('global', '1');
  if (report.version) params.set('v', report.version);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return [];

  // Claim the ledger entries BEFORE sending, and never un-claim them.
  //
  // The alternative — record only on a confirmed 2xx — reads as more careful
  // but errs the wrong way. Nothing awaits this call (it must not sit on the
  // `ok init` or seed critical path), so a process that exits mid-flight would
  // leave the entry unwritten and re-report the same install on the next run.
  // That inflates someone's public count. Claiming first inverts the failure to
  // "a dropped send is never retried", which under-counts instead — the safe
  // direction for a number we are asserting about other people's skills.
  try {
    await writeInstallReported(
      deps.home,
      fresh.map((s) => ledgerKey(report, s)),
    );
  } catch (err) {
    // No claim, no send. Reporting anyway would leave nothing on disk to
    // suppress the next run — the duplicate this ordering exists to prevent.
    getLogger('skills').warn(
      { err, source: report.source, skills: fresh },
      'skill install report ledger write failed; not reporting this install',
    );
    return [];
  }

  try {
    const res = await fetchImpl(`${TELEMETRY_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    // Only an APPLICATION rejection proves nothing was counted: the collector
    // parsed the event and declined it (an unknown-skill 4xx while a freshly
    // renamed listing is still being indexed). Releasing the claim there cannot
    // double-count, and a later run reports it again once the listing resolves
    // — which matters most right after a rename, when the collector meets every
    // new name for the first time and a permanent claim would silently discard
    // exactly the installs the rename is measured by.
    //
    // Every other non-2xx is AMBIGUOUS and keeps its claim. The collector is a
    // serverless function behind an edge: 502/504 are synthesized by the
    // platform and can fire AFTER the origin recorded the event, 429 can be
    // issued post-increment, and a WAF 403 never reaches the function at all.
    // Releasing on those re-reports something already counted, which inflates a
    // public number — the one direction this module must never err in.
    if (!res.ok && RETRYABLE_REJECTION_STATUSES.has(res.status)) {
      getLogger('skills').warn(
        { status: res.status, source: report.source, skills: fresh },
        'skill install report rejected by the collector; releasing the claim to retry later',
      );
      await clearInstallReported(
        deps.home,
        fresh.map((s) => ledgerKey(report, s)),
      ).catch((err: unknown) => {
        // The claim stays, so this install is simply never retried — the old
        // behavior. Logged so a stuck counter is traceable to the ledger.
        // Carries the status that triggered the release attempt: the two warns
        // can interleave under load, so this one has to stand on its own.
        getLogger('skills').warn(
          { err, status: res.status, source: report.source, skills: fresh },
          'could not release the install-report claim; this install will not be retried',
        );
      });
      return [];
    }
    if (!res.ok) {
      // Ambiguous rejection (5xx, 429, 403, 408): the event may already have
      // been counted upstream, so the claim stays and this install is simply
      // never retried — under-counting once beats inflating a public count.
      getLogger('skills').warn(
        { status: res.status, source: report.source, skills: fresh },
        'skill install report rejected with an ambiguous status; keeping the claim so a counted install cannot be double-reported',
      );
    }
  } catch (err) {
    // A dead network is not an install error. Unlike the delivered-rejection
    // branch above, this outcome is AMBIGUOUS — the request may have reached the
    // collector and had its response lost — so the claim is deliberately kept:
    // under-counting once beats double-counting someone's public install count. Logged rather than swallowed: on a machine
    // that blocks the collector this fires on every install, and a silent
    // catch makes "why is our count flat" undiagnosable.
    getLogger('skills').warn(
      { err, source: report.source, skills: fresh },
      'skill install report could not be delivered; this install is not counted',
    );
  }
  return fresh;
}
