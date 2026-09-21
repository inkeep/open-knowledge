import { describe, expect, it } from 'vitest';
import {
  AUDIT_CONSOLE_RECORD_CASES,
  type ConsoleRecordCase,
  chromiumResourceFailureRecord,
} from '../stress/_helpers/audit-console-records.test-helper.ts';
import { filterCriticalErrors } from '../stress/_helpers/error-filters.ts';

describe('filterCriticalErrors', () => {
  const prebundled = 'http://localhost:5173/node_modules/.vite/deps/@codemirror_state.js';

  it('keeps a runtime exception reported from a pre-bundled chunk', () => {
    const entry = {
      type: 'error',
      text: 'Uncaught TypeError: EditorSelection.undirectionalRange is not a function',
      url: prebundled,
    };
    expect(filterCriticalErrors([entry])).toEqual([entry]);
  });

  it('still drops a genuine pre-bundle load failure', () => {
    expect(
      filterCriticalErrors([
        {
          type: 'error',
          text: 'Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)',
          url: prebundled,
        },
        {
          type: 'error',
          text: 'GET /@vite/client net::ERR_ABORTED 404',
          url: 'http://localhost:5173/@vite/client',
        },
      ]),
    ).toEqual([]);
  });

  it('keeps an ordinary application error with no URL', () => {
    const entry = { type: 'uncaught', text: 'Cannot read properties of undefined' };
    expect(filterCriticalErrors([entry])).toEqual([entry]);
  });
});

describe('console records a product endpoint is designed to produce', () => {
  const origin = 'http://127.0.0.1:63824';

  for (const entry of AUDIT_CONSOLE_RECORD_CASES) {
    it(`${entry.retainedByClassifier ? 'keeps' : 'drops'} ${entry.label}`, () => {
      const record = chromiumResourceFailureRecord(origin, entry);
      expect(
        filterCriticalErrors([record]),
        `${entry.label} must be ${entry.retainedByClassifier ? 'retained' : 'dropped'}`,
      ).toEqual(entry.retainedByClassifier ? [record] : []);
    });
  }

  it('refuses a case whose status has no reason phrase instead of building a record for it', () => {
    const unmapped: ConsoleRecordCase = {
      label: 'a status with no registered reason phrase',
      path: '/api/audit',
      status: 599,
      retainedByClassifier: false,
    };
    expect(() => chromiumResourceFailureRecord(origin, unmapped)).toThrow(String(unmapped.status));
  });

  it('drops only the audit-superseded 409s when every case arrives together', () => {
    const records = AUDIT_CONSOLE_RECORD_CASES.map((entry) =>
      chromiumResourceFailureRecord(origin, entry),
    );
    expect(
      records,
      'the shared fixture table gained or lost a case; update this literal deliberately, because deriving it from AUDIT_CONSOLE_RECORD_CASES.length makes this toHaveLength assertion a tautology and lets the table resize silently',
    ).toHaveLength(7);
    const retained = AUDIT_CONSOLE_RECORD_CASES.filter((entry) => entry.retainedByClassifier).map(
      (entry) => chromiumResourceFailureRecord(origin, entry),
    );
    expect(filterCriticalErrors(records)).toEqual(retained);
  });
});
