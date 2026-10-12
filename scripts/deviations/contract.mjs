const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const ISSUE_URL =
  /^https:\/\/(?:github\.com\/inkeep\/[\w.-]+\/issues\/\d+|linear\.app\/inkeep\/issue\/[A-Z]+-\d+(?:\/[\w-]*)?)$/;
export const ISSUE_URL_RULE =
  'a GitHub issue URL in the inkeep organization or a Linear issue URL in the inkeep workspace';
export const HORIZON_DAYS = 90;

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function isRealDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function asOfDay(asOf) {
  if (!isRealDate(asOf)) {
    throw new TypeError(`the as-of day must be a YYYY-MM-DD UTC date, not ${JSON.stringify(asOf)}`);
  }
  return asOf;
}

export function addDays(day, days) {
  return new Date(Date.parse(`${asOfDay(day)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function isNonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function trackingProblems(entry, { required, optional = [], owners }) {
  if (!isRecord(entry)) return ['is not an object'];
  const problems = required
    .filter((field) => !isNonBlank(entry[field]))
    .map((field) => `has no ${field}`);
  for (const field of optional) {
    if (entry[field] !== undefined && !isNonBlank(entry[field])) {
      problems.push(`has a blank ${field}`);
    }
  }
  if (isNonBlank(entry.issue) && !ISSUE_URL.test(entry.issue)) {
    problems.push(`has issue ${JSON.stringify(entry.issue)}, which is not ${ISSUE_URL_RULE}`);
  }
  if (isNonBlank(entry.owner) && !owners.includes(entry.owner)) {
    problems.push(
      `has owner ${JSON.stringify(entry.owner)}, which is not one of ${owners.join(', ')}`,
    );
  }
  if (isNonBlank(entry.until) && !isRealDate(entry.until)) {
    problems.push(`has until ${JSON.stringify(entry.until)}, which is not a YYYY-MM-DD date`);
  }
  return problems;
}

export function horizonProblem(until, asOf) {
  const horizon = addDays(asOf, HORIZON_DAYS);
  if (!isRealDate(until) || until <= horizon) return null;
  return `has until ${until}, beyond the ${HORIZON_DAYS}-day horizon (${horizon})`;
}

export function reviewState(until, asOf, { soonDays = 0 } = {}) {
  asOfDay(asOf);
  if (!isRealDate(until)) return 'undated';
  if (until < asOf) return 'expired';
  if (soonDays > 0 && until <= addDays(asOf, soonDays)) return 'due-soon';
  return 'current';
}
