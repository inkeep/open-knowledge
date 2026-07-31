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

import { getLogger } from './logger.ts';
import { readInstallReported, writeInstallReported } from './skill-state.ts';

/** The `skills` CLI's telemetry collector. Same endpoint, same query shape. */
const TELEMETRY_URL = 'https://add-skill.vercel.sh/t';

const REPORT_TIMEOUT_MS = 3000;

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
  const fresh = report.skills.filter((s) => !alreadyReported.has(`${report.source}#${s}`));
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
      fresh.map((s) => `${report.source}#${s}`),
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
    await fetchImpl(`${TELEMETRY_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch (err) {
    // A dead network is not an install error, and by the contract above this
    // one is simply not counted. Logged rather than swallowed: on a machine
    // that blocks the collector this fires on every install, and a silent
    // catch makes "why is our count flat" undiagnosable.
    getLogger('skills').warn(
      { err, source: report.source, skills: fresh },
      'skill install report could not be delivered; this install is not counted',
    );
  }
  return fresh;
}
