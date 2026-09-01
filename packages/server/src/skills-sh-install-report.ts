import { realpathSync } from 'node:fs';
import { getLogger } from './logger.ts';
import { clearInstallReported, readInstallReported, writeInstallReported } from './skill-state.ts';

const TELEMETRY_URL = 'https://add-skill.vercel.sh/t';

const REPORT_TIMEOUT_MS = 3000;

const RETRYABLE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);

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
  if (parts.length === 1) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(source)) {
      return false;
    }
    return !PRIVATE_HOST_SUFFIXES.some((suffix) => source.toLowerCase().endsWith(suffix));
  }
  if (parts.length !== 2) return false;
  return parts.every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');
}

export interface SkillInstallReport {
  source: string;
  skills: readonly string[];
  agents?: readonly string[];
  global?: boolean;
  version?: string;
  scope?: string;
}

function ledgerKey(report: SkillInstallReport, skill: string): string {
  if (report.scope === undefined) return `${report.source}#${skill}`;
  let scope = report.scope;
  try {
    scope = realpathSync(scope);
  } catch {}
  return `${report.source}#${skill}@${scope}`;
}

export interface ReportSkillInstallDeps {
  home: string;
  enabled: boolean;
  fetchImpl?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

function envOptOut(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISABLE_TELEMETRY || env.DO_NOT_TRACK);
}

export async function reportSkillInstall(
  report: SkillInstallReport,
  deps: ReportSkillInstallDeps,
): Promise<readonly string[]> {
  const env = deps.env ?? process.env;
  if (!deps.enabled || envOptOut(env)) return [];
  if (!isPublicRepoSource(report.source.trim())) return [];

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

  try {
    await writeInstallReported(
      deps.home,
      fresh.map((s) => ledgerKey(report, s)),
    );
  } catch (err) {
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
    if (!res.ok && RETRYABLE_REJECTION_STATUSES.has(res.status)) {
      getLogger('skills').warn(
        { status: res.status, source: report.source, skills: fresh },
        'skill install report rejected by the collector; releasing the claim to retry later',
      );
      await clearInstallReported(
        deps.home,
        fresh.map((s) => ledgerKey(report, s)),
      ).catch((err: unknown) => {
        getLogger('skills').warn(
          { err, status: res.status, source: report.source, skills: fresh },
          'could not release the install-report claim; this install will not be retried',
        );
      });
      return [];
    }
    if (!res.ok) {
      getLogger('skills').warn(
        { status: res.status, source: report.source, skills: fresh },
        'skill install report rejected with an ambiguous status; keeping the claim so a counted install cannot be double-reported',
      );
    }
  } catch (err) {
    getLogger('skills').warn(
      { err, source: report.source, skills: fresh },
      'skill install report could not be delivered; this install is not counted',
    );
  }
  return fresh;
}
