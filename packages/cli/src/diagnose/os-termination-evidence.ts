import { type ExecFileException, execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { DESKTOP_PRODUCTS, desktopWindowsExecutableName } from '@inkeep/open-knowledge-core';
import {
  DIAGNOSTIC_REPORT_WINDOW_DAYS,
  isOwnedProcessName,
  parseHeaderTimestamp,
} from './diagnostic-reports.ts';

export const OS_TERMINATION_EVIDENCE_PATH = 'state/os-termination-evidence.json';

const WINDOW_MS = DIAGNOSTIC_REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_JETSAM_FILES = 50;
const MAX_EVENTS = 50;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

const MACOS_SYSTEM_DIAGNOSTIC_REPORTS_DIR = '/Library/Logs/DiagnosticReports';

const OWNED_NAME = /openknowledge/i;

const WINDOWS_EXECUTABLES = Object.values(DESKTOP_PRODUCTS).map(desktopWindowsExecutableName);

type OsTerminationSource = 'macos-jetsam' | 'linux-journal' | 'windows-event-log';

interface JetsamProcess {
  name: string;
  pid: number | null;
  killReason: string | null;
  residentPages: number | null;
  lifetimeMaxPages: number | null;
}

interface JetsamEvidenceEvent {
  kind: 'jetsam';
  at: string | null;
  file: string;
  pageSize: number | null;
  largestProcessOwned: boolean;
  ownedProcesses: JetsamProcess[];
}

interface JournalEvidenceEvent {
  kind: 'journal';
  at: string;
  origin: 'kernel' | 'systemd-oomd';
  action: 'oom-invoked' | 'oom-kill' | 'oomd-kill';
  pid: number | null;
  processName: string | null;
  unit: string | null;
  trigger: 'memory-pressure' | 'swap' | null;
}

interface WindowsEvidenceEvent {
  kind: 'windows-event';
  at: string;
  log: 'System' | 'Application';
  provider: string;
  eventId: number;
  mentionsOpenKnowledge: boolean;
  data: string[];
}

type OsTerminationEvent = JetsamEvidenceEvent | JournalEvidenceEvent | WindowsEvidenceEvent;

export interface OsTerminationEvidence {
  schemaVersion: 1;
  platform: string;
  source: OsTerminationSource | null;
  outcome: 'unsupported' | 'unavailable' | 'partial' | 'none-in-window' | 'collected';
  readFrom: string[];
  unavailableReason?: string;
  restrictedToCurrentUser?: boolean;
  windowDays: number;
  foreignIgnored: number;
  unparseable: number;
  droppedOverCap: number;
  events: OsTerminationEvent[];
}

interface OsTerminationNotCollected {
  schemaVersion: 1;
  outcome: 'not-collected';
}

type OsTerminationEvidenceDocument = OsTerminationEvidence | OsTerminationNotCollected;

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  signal?: string;
}

type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export interface OsTerminationEvidenceDeps {
  platform?: NodeJS.Platform;
  now?: () => Date;
  macosReportsDir?: string;
  systemRoot?: string;
  runCommand?: RunCommand;
}

export function createRunCommand(
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): RunCommand {
  return (command, args) =>
    new Promise((resolvePromise) => {
      try {
        execFile(
          command,
          args,
          {
            encoding: 'utf8',
            timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
            maxBuffer: options.maxBuffer ?? COMMAND_MAX_BUFFER,
            windowsHide: true,
          },
          (error: ExecFileException | null, stdout, stderr) => {
            resolvePromise({ ...describeExit(error), stdout, stderr });
          },
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        resolvePromise({
          status: null,
          stdout: '',
          stderr: '',
          errorCode: typeof code === 'string' ? code : 'spawn-failed',
        });
      }
    });
}

function describeExit(
  error: ExecFileException | null,
): Pick<CommandResult, 'status' | 'errorCode' | 'signal'> {
  if (error === null) return { status: 0 };
  if (typeof error.code === 'string') return { status: null, errorCode: error.code };
  if (typeof error.code === 'number') return { status: error.code };
  if (error.killed === true) return { status: null, errorCode: 'ETIMEDOUT' };
  return error.signal ? { status: null, signal: error.signal } : { status: null };
}

function describeFailure(result: CommandResult): string {
  if (result.errorCode !== undefined) return result.errorCode;
  if (result.signal !== undefined) return `signal ${result.signal}`;
  const firstLine = (result.stderr.trim().split('\n')[0] ?? '')
    .replace(/\S*\/journal\/\S*/g, '<journal path>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<id>');
  return `exit ${result.status}${firstLine === '' ? '' : `: ${firstLine}`}`;
}

function base(
  platform: string,
  source: OsTerminationSource | null,
  readFrom: string[],
): OsTerminationEvidence {
  return {
    schemaVersion: 1,
    platform,
    source,
    outcome: 'none-in-window',
    readFrom,
    windowDays: DIAGNOSTIC_REPORT_WINDOW_DAYS,
    foreignIgnored: 0,
    unparseable: 0,
    droppedOverCap: 0,
    events: [],
  };
}

function unavailable(evidence: OsTerminationEvidence, reason: string): OsTerminationEvidence {
  return { ...evidence, outcome: 'unavailable', unavailableReason: reason };
}

function settle(evidence: OsTerminationEvidence): OsTerminationEvidence {
  return { ...evidence, outcome: evidence.events.length > 0 ? 'collected' : 'none-in-window' };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseJetsamReport(file: string, content: string): JetsamEvidenceEvent | null {
  const newline = content.indexOf('\n');
  if (newline === -1) return null;
  let header: Record<string, unknown> | null;
  let body: Record<string, unknown> | null;
  try {
    header = asRecord(JSON.parse(content.slice(0, newline)));
    body = asRecord(JSON.parse(content.slice(newline + 1)));
  } catch {
    return null;
  }
  if (header === null || body === null || !Array.isArray(body.processes)) return null;
  const ownedProcesses: JetsamProcess[] = [];
  for (const entry of body.processes) {
    const p = asRecord(entry);
    if (p === null || typeof p.name !== 'string' || !isOwnedProcessName(p.name)) continue;
    ownedProcesses.push({
      name: p.name,
      pid: finiteOrNull(p.pid),
      killReason: typeof p.reason === 'string' ? p.reason : null,
      residentPages: finiteOrNull(p.rpages),
      lifetimeMaxPages: finiteOrNull(p.lifetimeMax),
    });
  }
  const atMs = parseHeaderTimestamp(header.timestamp);
  return {
    kind: 'jetsam',
    at: atMs === null ? null : new Date(atMs).toISOString(),
    file,
    pageSize: finiteOrNull(asRecord(body.memoryStatus)?.pageSize),
    largestProcessOwned:
      typeof body.largestProcess === 'string' && isOwnedProcessName(body.largestProcess),
    ownedProcesses,
  };
}

async function collectMacosJetsam(dir: string, now: Date): Promise<OsTerminationEvidence> {
  const evidence = base('darwin', 'macos-jetsam', [join(dir, 'JetsamEvent-*.ips')]);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    return unavailable(evidence, (err as NodeJS.ErrnoException).code ?? 'unknown');
  }
  const cutoff = now.getTime() - WINDOW_MS;
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const file of names) {
    if (!/^JetsamEvent-.*\.ips$/.test(file)) continue;
    try {
      const { mtimeMs } = await stat(join(dir, file));
      if (mtimeMs >= cutoff) candidates.push({ file, mtimeMs });
    } catch {
      evidence.unparseable += 1;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  evidence.droppedOverCap = Math.max(0, candidates.length - MAX_JETSAM_FILES);
  for (const { file } of candidates.slice(0, MAX_JETSAM_FILES)) {
    let parsed: JetsamEvidenceEvent | null = null;
    try {
      parsed = parseJetsamReport(file, await readFile(join(dir, file), 'utf8'));
    } catch {}
    if (parsed === null) {
      evidence.unparseable += 1;
    } else if (parsed.ownedProcesses.length === 0) {
      evidence.foreignIgnored += 1;
    } else {
      evidence.events.push(parsed);
    }
  }
  return settle(evidence);
}

export const LINUX_JOURNAL_GREP = 'Out of memory|oom-kill|Killed process|Killed /|memory pressure';

const LINUX_JOURNAL_ARGS: readonly string[] = [
  '--no-pager',
  '--output=short-iso-precise',
  '--since=-7d',
  `--grep=${LINUX_JOURNAL_GREP}`,
  '_TRANSPORT=kernel',
  '+',
  '_SYSTEMD_UNIT=systemd-oomd.service',
];

const JOURNAL_LINE = /^(\S+) \S+ ([^:\s[]+)(?:\[\d+\])?: (.*)$/;

function parseJournalMessage(
  origin: string,
  message: string,
): Omit<JournalEvidenceEvent, 'kind' | 'at'> | null {
  if (origin === 'systemd-oomd') {
    const killed = /^Killed (\S+)/.exec(message);
    if (killed === null) return null;
    const leaf = killed[1]?.split('/').pop() ?? '';
    return {
      origin: 'systemd-oomd',
      action: 'oomd-kill',
      pid: null,
      processName: null,
      unit: OWNED_NAME.test(leaf) ? leaf : null,
      trigger: /swap used/.test(message)
        ? 'swap'
        : /memory pressure/.test(message)
          ? 'memory-pressure'
          : null,
    };
  }
  if (origin !== 'kernel') return null;
  const killedProcess = /Killed process (\d+) \(([^)]+)\)/.exec(message);
  if (killedProcess !== null) {
    return {
      origin: 'kernel',
      action: 'oom-kill',
      pid: Number(killedProcess[1]),
      processName: killedProcess[2] ?? null,
      unit: null,
      trigger: null,
    };
  }
  const task = /task=([^,]+),pid=(\d+)/.exec(message);
  if (task !== null) {
    return {
      origin: 'kernel',
      action: 'oom-kill',
      pid: Number(task[2]),
      processName: task[1] ?? null,
      unit: null,
      trigger: null,
    };
  }
  const invoked = /^(\S+) invoked oom-killer/.exec(message);
  if (invoked !== null) {
    return {
      origin: 'kernel',
      action: 'oom-invoked',
      pid: null,
      processName: invoked[1] ?? null,
      unit: null,
      trigger: null,
    };
  }
  return null;
}

function parseJournalOutput(stdout: string): {
  events: JournalEvidenceEvent[];
  foreignIgnored: number;
  unparseable: number;
} {
  const events: JournalEvidenceEvent[] = [];
  let foreignIgnored = 0;
  let unparseable = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '' || line.startsWith('-- ')) continue;
    const match = JOURNAL_LINE.exec(line);
    if (match === null) {
      unparseable += 1;
      continue;
    }
    const [, at = '', origin = '', message = ''] = match;
    if (!OWNED_NAME.test(message)) {
      foreignIgnored += 1;
      continue;
    }
    const parsed = parseJournalMessage(origin, message);
    if (parsed === null) {
      unparseable += 1;
      continue;
    }
    events.push({ kind: 'journal', at, ...parsed });
  }
  return { events, foreignIgnored, unparseable };
}

async function collectLinuxJournal(run: RunCommand): Promise<OsTerminationEvidence> {
  const evidence = base('linux', 'linux-journal', [`journalctl ${LINUX_JOURNAL_ARGS.join(' ')}`]);
  const result = await run('journalctl', [...LINUX_JOURNAL_ARGS]);
  const emptyWindow = result.status === 1 && /^-- No entries --$/m.test(result.stdout);
  if (result.status !== 0 && !emptyWindow) return unavailable(evidence, describeFailure(result));
  const parsed = parseJournalOutput(result.stdout);
  evidence.droppedOverCap = Math.max(0, parsed.events.length - MAX_EVENTS);
  evidence.events.push(...parsed.events.slice(-MAX_EVENTS));
  evidence.foreignIgnored = parsed.foreignIgnored;
  evidence.unparseable = parsed.unparseable;
  if (/not seeing messages from other users/i.test(`${result.stdout}\n${result.stderr}`)) {
    evidence.restrictedToCurrentUser = true;
  }
  return settle(evidence);
}

const WINDOWS_SYSTEM_PROVIDERS: Record<number, string> = {
  41: 'Microsoft-Windows-Kernel-Power',
  1074: 'User32',
  2004: 'Microsoft-Windows-Resource-Exhaustion-Detector',
  6008: 'EventLog',
};

const WINDOWS_APPLICATION_PROVIDERS: Record<number, string> = {
  1000: 'Application Error',
  1001: 'Windows Error Reporting',
  1002: 'Application Hang',
};

type WindowsLog = 'System' | 'Application';

function providersFor(log: WindowsLog): Record<number, string> {
  return log === 'System' ? WINDOWS_SYSTEM_PROVIDERS : WINDOWS_APPLICATION_PROVIDERS;
}

function windowsQuery(log: WindowsLog): string {
  const ids = Object.keys(providersFor(log))
    .map((id) => `EventID=${id}`)
    .join(' or ');
  const system = `System[(${ids}) and TimeCreated[timediff(@SystemTime) <= ${WINDOW_MS}]]`;
  if (log === 'System') return `*[${system}]`;
  const names = WINDOWS_EXECUTABLES.map((exe) => `Data='${exe}'`).join(' or ');
  return `*[${system} and EventData[${names}]]`;
}

export function windowsEventLogArgs(log: WindowsLog): string[] {
  return ['qe', log, `/q:${windowsQuery(log)}`, '/f:xml', '/rd:true', '/c:200'];
}

export function windowsEventLogExecutable(systemRoot: string | undefined): string {
  return win32.join(systemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-z]:/i.test(value);
}

function elementTexts(record: string, element: string): string[] {
  const pattern = new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`, 'g');
  return [...record.matchAll(pattern)].map((m) => decodeXml(m[1] ?? '').trim());
}

function parseWindowsEventXml(
  log: WindowsLog,
  xml: string,
): { events: WindowsEvidenceEvent[]; foreignIgnored: number; unparseable: number } {
  const providers = providersFor(log);
  const events: WindowsEvidenceEvent[] = [];
  let foreignIgnored = 0;
  let unparseable = 0;
  for (const record of xml.match(/<Event[\s>][\s\S]*?<\/Event>/g) ?? []) {
    const provider = /<Provider\s+Name=['"]([^'"]+)['"]/.exec(record)?.[1];
    const eventId = Number(/<EventID[^>]*>(\d+)<\/EventID>/.exec(record)?.[1]);
    const at = /<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/.exec(record)?.[1];
    if (provider === undefined || !Number.isInteger(eventId) || at === undefined) {
      unparseable += 1;
      continue;
    }
    if (providers[eventId] !== provider) {
      foreignIgnored += 1;
      continue;
    }
    const values = elementTexts(record, 'Data');
    const processNames = elementTexts(record, 'Name');
    const mentionsOpenKnowledge = [...values, ...processNames].some((v) => OWNED_NAME.test(v));
    if (log === 'Application' && !mentionsOpenKnowledge) {
      foreignIgnored += 1;
      continue;
    }
    events.push({
      kind: 'windows-event',
      at,
      log,
      provider,
      eventId,
      mentionsOpenKnowledge,
      data: log === 'Application' ? values.filter((v) => v !== '' && !looksLikePath(v)) : [],
    });
  }
  return { events, foreignIgnored, unparseable };
}

async function collectWindowsEventLog(
  run: RunCommand,
  systemRoot: string | undefined,
): Promise<OsTerminationEvidence> {
  const executable = windowsEventLogExecutable(systemRoot);
  const logs = ['System', 'Application'] as const;
  const evidence = base(
    'win32',
    'windows-event-log',
    logs.map((log) => `${executable} ${windowsEventLogArgs(log).join(' ')}`),
  );
  const results = await Promise.all(
    logs.map(async (log) => ({ log, result: await run(executable, windowsEventLogArgs(log)) })),
  );
  const failures: string[] = [];
  for (const { log, result } of results) {
    if (result.status !== 0) {
      failures.push(`${log}: ${describeFailure(result)}`);
      continue;
    }
    const parsed = parseWindowsEventXml(log, result.stdout);
    evidence.droppedOverCap += Math.max(0, parsed.events.length - MAX_EVENTS);
    evidence.events.push(...parsed.events.slice(0, MAX_EVENTS));
    evidence.foreignIgnored += parsed.foreignIgnored;
    evidence.unparseable += parsed.unparseable;
  }
  if (failures.length === logs.length) return unavailable(evidence, failures.join('; '));
  if (failures.length > 0) {
    return { ...evidence, outcome: 'partial', unavailableReason: failures.join('; ') };
  }
  return settle(evidence);
}

export async function collectOsTerminationEvidence(
  deps: OsTerminationEvidenceDeps = {},
): Promise<OsTerminationEvidence> {
  const platform = deps.platform ?? process.platform;
  const run = deps.runCommand ?? createRunCommand();
  const now = (deps.now ?? (() => new Date()))();
  switch (platform) {
    case 'darwin':
      return collectMacosJetsam(deps.macosReportsDir ?? MACOS_SYSTEM_DIAGNOSTIC_REPORTS_DIR, now);
    case 'linux':
      return collectLinuxJournal(run);
    case 'win32':
      return collectWindowsEventLog(run, deps.systemRoot ?? process.env.SystemRoot);
    default:
      return { ...base(platform, null, []), outcome: 'unsupported' };
  }
}

const NOT_COLLECTED: OsTerminationNotCollected = { schemaVersion: 1, outcome: 'not-collected' };

export function renderOsTerminationEvidence(evidence: OsTerminationEvidence | undefined): string {
  const document: OsTerminationEvidenceDocument = evidence ?? NOT_COLLECTED;
  return `${JSON.stringify(document, null, 2)}\n`;
}

const SOURCE_NAMES: Record<OsTerminationSource, string> = {
  'macos-jetsam': 'macOS low-memory reports',
  'linux-journal': 'system journal',
  'windows-event-log': 'Windows event logs',
};

export function describeOsTerminationEvidence(evidence: OsTerminationEvidence): string {
  const counts = [
    `${evidence.windowDays}d`,
    `${evidence.events.length} kept`,
    `${evidence.foreignIgnored} other-process record(s) ignored`,
    `${evidence.unparseable} unparseable`,
  ];
  if (evidence.droppedOverCap > 0) counts.push(`${evidence.droppedOverCap} older dropped over cap`);
  const source = evidence.source ? ` from ${SOURCE_NAMES[evidence.source]}` : '';
  const reason = evidence.unavailableReason ? `, ${evidence.unavailableReason}` : '';
  return `${evidence.outcome}${source}${reason} (${counts.join('; ')})`;
}
