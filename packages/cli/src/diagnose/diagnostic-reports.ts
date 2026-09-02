import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_PRODUCT_NAME } from '../integrations/desktop-state.ts';

const DIAGNOSTIC_REPORT_WINDOW_DAYS = 7;
const DIAGNOSTIC_REPORT_WINDOW_MS = DIAGNOSTIC_REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const MAX_BUNDLED_DIAGNOSTIC_REPORTS = 25;

export interface DiagnosticReportCollection {
  files: string[];
  outcome: 'not-present' | 'unreadable-directory' | 'none-in-window' | 'collected';
  directoryErrorCode?: string;
  foreignIgnored: number;
  unparseable: number;
  droppedOverCap: number;
  windowDays: number;
}

export function renderDiagnosticReportsStatus(
  collection: DiagnosticReportCollection,
  stagedCount: number,
): string {
  if (collection.outcome === 'not-present') {
    return 'not-present (no DiagnosticReports directory)';
  }
  if (collection.outcome === 'unreadable-directory') {
    return `unreadable (${collection.directoryErrorCode ?? 'unknown'} reading DiagnosticReports)`;
  }
  const notes = [
    `${collection.windowDays}d`,
    `${collection.foreignIgnored} other-process report(s) ignored`,
    `${collection.unparseable} unparseable`,
  ];
  if (collection.droppedOverCap > 0) {
    notes.push(`${collection.droppedOverCap} older dropped over cap`);
  }
  const vanished = collection.files.length - stagedCount;
  if (vanished > 0) notes.push(`${vanished} vanished before staging`);
  if (collection.outcome === 'none-in-window') {
    return `none found in window (${notes.join('; ')})`;
  }
  return `${stagedCount} collected (${notes.join('; ')})`;
}

function normalizeSolidusEscapes(content: string): string {
  return content.replace(/\\+\/?/g, (run) => {
    if (!run.endsWith('/')) return run;
    const backslashes = run.length - 1;
    return '\\'.repeat(backslashes - (backslashes % 2)) + '/';
  });
}

const LINKING_IDENTIFIER_KEYS = ['crashReporterKey', 'bootSessionUUID'] as const;

const LINKING_IDENTIFIERS = new RegExp(
  `("(?:${LINKING_IDENTIFIER_KEYS.join('|')})"\\s*:\\s*)"[^"]*"`,
  'g',
);

function stripLinkingIdentifiers(content: string): string {
  return content.replace(LINKING_IDENTIFIERS, '$1"[REDACTED-DEVICE-ID]"');
}

export function prepareDiagnosticReportText(content: string): string {
  return stripLinkingIdentifiers(normalizeSolidusEscapes(content));
}

type ReportHeader =
  | { readonly kind: 'named'; readonly name: string; readonly timestampMs: number | null }
  | { readonly kind: 'unreadable' };

const HEADER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{2})(\d{2})$/;

function parseHeaderTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = HEADER_TIMESTAMP.exec(value.trim());
  if (match === null) return null;
  const [, date, time, fraction = '', tzHours, tzMinutes] = match;
  const parsed = Date.parse(`${date}T${time}${fraction}${tzHours}:${tzMinutes}`);
  return Number.isNaN(parsed) ? null : parsed;
}

function readReportHeader(filePath: string): ReportHeader {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const newline = content.indexOf('\n');
    const firstLine = newline === -1 ? content : content.slice(0, newline);
    const header: unknown = JSON.parse(firstLine);
    if (typeof header !== 'object' || header === null) return { kind: 'unreadable' };
    const {
      name,
      app_name: appName,
      timestamp,
    } = header as { name?: unknown; app_name?: unknown; timestamp?: unknown };
    const resolved = typeof name === 'string' ? name : typeof appName === 'string' ? appName : null;
    if (resolved === null) return { kind: 'unreadable' };
    return { kind: 'named', name: resolved, timestampMs: parseHeaderTimestamp(timestamp) };
  } catch {
    return { kind: 'unreadable' };
  }
}

function isOwnedProcessName(name: string): boolean {
  return name === DESKTOP_PRODUCT_NAME || name.startsWith(`${DESKTOP_PRODUCT_NAME} `);
}

export function collectDiagnosticReports(
  diagnosticReportsDir: string,
  now: Date,
): DiagnosticReportCollection {
  const empty: Omit<DiagnosticReportCollection, 'outcome'> = {
    files: [],
    foreignIgnored: 0,
    unparseable: 0,
    droppedOverCap: 0,
    windowDays: DIAGNOSTIC_REPORT_WINDOW_DAYS,
  };

  let entries: Dirent[];
  try {
    entries = readdirSync(diagnosticReportsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ...empty, outcome: 'not-present' };
    return { ...empty, outcome: 'unreadable-directory', directoryErrorCode: code ?? 'unknown' };
  }

  const cutoffMs = now.getTime() - DIAGNOSTIC_REPORT_WINDOW_MS;
  const owned: { path: string; atMs: number }[] = [];
  let foreignIgnored = 0;
  let unparseable = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ips')) continue;

    const path = join(diagnosticReportsDir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }

    if (mtimeMs < cutoffMs) continue;

    const header = readReportHeader(path);
    const atMs =
      header.kind === 'named' && header.timestampMs !== null ? header.timestampMs : mtimeMs;

    if (header.kind === 'unreadable') {
      unparseable += 1;
      continue;
    }
    if (!isOwnedProcessName(header.name)) {
      foreignIgnored += 1;
      continue;
    }
    owned.push({ path, atMs });
  }

  owned.sort((a, b) => b.atMs - a.atMs);
  const kept = owned.slice(0, MAX_BUNDLED_DIAGNOSTIC_REPORTS);
  const counts = {
    foreignIgnored,
    unparseable,
    droppedOverCap: owned.length - kept.length,
    windowDays: DIAGNOSTIC_REPORT_WINDOW_DAYS,
  };

  if (kept.length === 0) {
    return { ...counts, files: [], outcome: 'none-in-window' };
  }
  return { ...counts, files: kept.map((r) => r.path), outcome: 'collected' };
}
