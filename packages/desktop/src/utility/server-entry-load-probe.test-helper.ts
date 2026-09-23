import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

interface ProbeResolveEvent {
  seq: number;
  specifier: string;
  url: string;
}

interface ProbeLoadEvent {
  seq: number;
  url: string;
}

export interface UtilityLoadProbeRecord {
  entryPath: string;
  parentPortListenerRegisteredAtSeq: number | null;
  totalEventCount: number;
  bareSpecifierResolves: ProbeResolveEvent[];
  moduleLoads: ProbeLoadEvent[];
  parentPortMessagesPosted: number;
  signalsAttemptedByEntry: { pid: number; signal: string | number | undefined }[];
  entryImportFailure: { message: string; code: string | undefined } | null;
}

const entryPath = process.argv[2];
const recordPath = process.argv[3];

if (entryPath === undefined || recordPath === undefined) {
  process.stderr.write(
    'usage: node server-entry-load-probe.test-helper.ts <entryPath> <recordPath>\n',
  );
  process.exit(2);
}

let seq = 0;
const bareSpecifierResolves: ProbeResolveEvent[] = [];
const moduleLoads: ProbeLoadEvent[] = [];

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('data:')
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (isBareSpecifier(specifier)) {
      bareSpecifierResolves.push({ seq: seq++, specifier, url: resolved.url });
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    moduleLoads.push({ seq: seq++, url });
    return nextLoad(url, context);
  },
});

const signalsAttemptedByEntry: { pid: number; signal: string | number | undefined }[] = [];
process.kill = ((pid: number, signal?: string | number) => {
  signalsAttemptedByEntry.push({ pid, signal });
  return true;
}) as typeof process.kill;

let parentPortListenerRegisteredAtSeq: number | null = null;
let parentPortMessagesPosted = 0;

const recordingParentPort = {
  on(event: string, _handler: (event: { data: unknown }) => void): void {
    if (event === 'message' && parentPortListenerRegisteredAtSeq === null) {
      parentPortListenerRegisteredAtSeq = seq;
    }
  },
  postMessage(_value: unknown): void {
    parentPortMessagesPosted += 1;
  },
};

Object.defineProperty(process, 'parentPort', {
  value: recordingParentPort,
  configurable: true,
  writable: true,
});

let entryImportFailure: UtilityLoadProbeRecord['entryImportFailure'] = null;
try {
  await import(pathToFileURL(entryPath).href);
} catch (err) {
  entryImportFailure = {
    message: err instanceof Error ? err.message : String(err),
    code: (err as NodeJS.ErrnoException | undefined)?.code,
  };
}

const record: UtilityLoadProbeRecord = {
  entryPath,
  parentPortListenerRegisteredAtSeq,
  totalEventCount: seq,
  bareSpecifierResolves,
  moduleLoads,
  parentPortMessagesPosted,
  signalsAttemptedByEntry,
  entryImportFailure,
};

writeFileSync(recordPath, JSON.stringify(record), 'utf-8');
process.exit(0);
