import { STATUS_CODES } from 'node:http';
import type { LogEntry } from './error-filters.ts';

export interface ConsoleRecordCase {
  readonly label: string;
  readonly path: string;
  readonly status: number;
  readonly retainedByClassifier: boolean;
}

export const AUDIT_CONSOLE_RECORD_CASES: readonly ConsoleRecordCase[] = [
  {
    label: 'an expected-by-design audit-superseded 409 from the query-less /api/audit call',
    path: '/api/audit',
    status: 409,
    retainedByClassifier: false,
  },
  {
    label: 'an expected-by-design audit-superseded 409 from the query-carrying /api/audit call',
    path: '/api/audit?doc=uv-open-c77a7381',
    status: 409,
    retainedByClassifier: false,
  },
  {
    label: 'a 409 from an endpoint that is not /api/audit',
    path: '/api/create-page',
    status: 409,
    retainedByClassifier: true,
  },
  {
    label: 'a 409 on the sibling /api/lint/audit route, which no page-side code calls',
    path: '/api/lint/audit',
    status: 409,
    retainedByClassifier: true,
  },
  {
    label: 'a 409 on a URL whose path continues past /api/audit into more characters',
    path: '/api/audit-history',
    status: 409,
    retainedByClassifier: true,
  },
  {
    label: 'a 409 on /api/create-page whose query string ends with /api/audit',
    path: '/api/create-page?ref=/api/audit',
    status: 409,
    retainedByClassifier: true,
  },
  {
    label: 'a non-409 failure on /api/audit itself',
    path: '/api/audit?doc=uv-open-broken',
    status: 500,
    retainedByClassifier: true,
  },
];

export function chromiumResourceFailureRecord(origin: string, entry: ConsoleRecordCase): LogEntry {
  const phrase = STATUS_CODES[entry.status];
  if (phrase === undefined) {
    throw new Error(
      `case '${entry.label}' uses status ${entry.status}, which has no reason phrase`,
    );
  }
  return {
    type: 'error',
    text: `Failed to load resource: the server responded with a status of ${entry.status} (${phrase})`,
    url: `${origin}${entry.path}`,
    line: 0,
  };
}
