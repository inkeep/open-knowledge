import { spawnSync } from 'node:child_process';
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, TestInfo } from '@playwright/test';
import { appBundleRootFromExecutable } from '../../../src/main/bundle-paths.ts';
import {
  classifyMinidumpCrashKind,
  classifyMinidumpOwnership,
  type MinidumpCrashKind,
  type MinidumpOwnership,
} from '../../../src/main/minidump-ownership.ts';

const MINIDUMP_SIGNATURE = 0x504d_444d;
const HEADER_BYTES = 32;
const HEADER_STREAM_COUNT_OFFSET = 8;
const HEADER_DIRECTORY_RVA_OFFSET = 12;
const HEADER_TIME_DATE_STAMP_OFFSET = 20;
const DIRECTORY_ENTRY_BYTES = 12;
const DIRECTORY_ENTRY_SIZE_OFFSET = 4;
const DIRECTORY_ENTRY_RVA_OFFSET = 8;
const MODULE_LIST_STREAM_TYPE = 4;
const EXCEPTION_STREAM_TYPE = 6;
const MISC_INFO_STREAM_TYPE = 15;
const CRASHPAD_INFO_STREAM_TYPE = 0x4350_0001;
const MODULE_RECORD_BYTES = 108;
const MODULE_BASE_OFFSET = 0;
const MODULE_SIZE_OFFSET = 8;
const MODULE_NAME_RVA_OFFSET = 20;
const EXCEPTION_THREAD_ID_OFFSET = 0;
const EXCEPTION_CODE_OFFSET = 8;
const EXCEPTION_FLAGS_OFFSET = 12;
const EXCEPTION_ADDRESS_OFFSET = 24;
const MISC_INFO_MIN_BYTES = 24;
const MISC_INFO_FLAGS_OFFSET = 4;
const MISC_INFO_PROCESS_ID_OFFSET = 8;
const MISC_INFO_PROCESS_CREATE_TIME_OFFSET = 12;
const MISC_INFO_PROCESS_ID_FLAG = 0x1;
const MISC_INFO_PROCESS_TIMES_FLAG = 0x2;
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_RVA_OFFSET = 40;
const CRASHPAD_INFO_MODULE_LIST_SIZE_OFFSET = 44;
const CRASHPAD_INFO_MODULE_LIST_RVA_OFFSET = 48;
const SIMPLE_ANNOTATION_ENTRY_BYTES = 8;
const MODULE_LINK_BYTES = 12;
const MODULE_LINK_RVA_OFFSET = 8;
const MODULE_CRASHPAD_INFO_BYTES = 28;
const MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET = 20;
const MODULE_ANNOTATION_OBJECTS_RVA_OFFSET = 24;
const ANNOTATION_OBJECT_BYTES = 12;
const ANNOTATION_OBJECT_TYPE_OFFSET = 4;
const ANNOTATION_OBJECT_VALUE_RVA_OFFSET = 8;
const ANNOTATION_TYPE_STRING = 1;

const MAX_DUMP_BYTES = 512 * 1024 * 1024;
const MAX_STREAMS = 4096;
const MAX_MODULES = 4096;
const MAX_MODULE_NAME_BYTES = 8192;
const MAX_ANNOTATIONS = 1024;
const MAX_ANNOTATION_BYTES = 1024;
const DUMP_SCAN_DEPTH = 4;
const DESCRIBED_ANNOTATIONS = 40;
const DESCRIBED_ANNOTATION_VALUE_CHARS = 60;
const PROCESS_TABLE_READ_TIMEOUT_MS = 10_000;

const WINDOWS_EXCEPTION_NAMES: ReadonlyMap<number, string> = new Map([
  [0x8000_0003, 'EXCEPTION_BREAKPOINT'],
  [0xc000_0005, 'EXCEPTION_ACCESS_VIOLATION'],
  [0xc000_001d, 'EXCEPTION_ILLEGAL_INSTRUCTION'],
  [0xc000_00fd, 'EXCEPTION_STACK_OVERFLOW'],
  [0xc000_0374, 'STATUS_HEAP_CORRUPTION'],
  [0xc000_0409, 'STATUS_STACK_BUFFER_OVERRUN'],
  [0xe06d_7363, 'MSVC C++ exception'],
]);

const NODE_PTY_HOST_ADDONS = new Set(['conpty.node', 'pty.node']);
const NODE_PTY_CONSOLE_LIST_ADDON = 'conpty_console_list.node';

export interface LoadedModule {
  path: string;
  base: bigint;
  size: number;
}

export interface CrashDumpException {
  code: number;
  flags: number;
  address: bigint;
  threadId: number;
}

export interface CrashDumpAnnotation {
  key: string;
  value: string;
  source: 'simple' | 'module';
}

export interface CrashDumpFacts {
  modules: readonly LoadedModule[];
  exception: CrashDumpException | null;
  processId: number | null;
  processCreatedAtSec: number | null;
  writtenAtSec: number | null;
  annotations: readonly CrashDumpAnnotation[];
  unreadable: string | null;
}

export interface CrashDumpWatch {
  dir: string;
  appBundleRoot: string;
  platform: NodeJS.Platform;
  baseline: ReadonlyMap<string, number>;
}

export interface AppProcess {
  pid: number;
  type: string;
  serviceName: string | null;
  name: string | null;
  creationTime: number | null;
}

export interface QuitObservation {
  processes: readonly AppProcess[];
  quitRequestedAtMs: number;
}

export interface CrashDumpFinding {
  path: string;
  mtimeMs: number;
  ownership: MinidumpOwnership;
  crashKind: MinidumpCrashKind | null;
  facts: CrashDumpFacts;
  countsAsCrash: boolean;
}

export interface CrashDumpVerdict {
  findings: readonly CrashDumpFinding[];
  crashes: readonly CrashDumpFinding[];
  headline: string;
  lines: readonly string[];
}

export interface ProcessTableRead {
  status: number | null;
  stdout: string;
}

export type ProcessTableReader = (file: string, args: readonly string[]) => ProcessTableRead;

export type CrashDumpAttemptInfo = Pick<TestInfo, 'testId'> & {
  project: Pick<TestInfo['project'], 'outputDir'>;
};

export type CrashDumpTestInfo = Pick<TestInfo, 'attach'> & CrashDumpAttemptInfo;

function crashDumpVerdictDir(testInfo: CrashDumpAttemptInfo): string {
  return join(testInfo.project.outputDir, 'crash-dump-verdicts');
}

function crashDumpVerdictFile(testInfo: CrashDumpAttemptInfo): string {
  return join(crashDumpVerdictDir(testInfo), `${testInfo.testId}.txt`);
}

function recordCrashDumpVerdict(testInfo: CrashDumpAttemptInfo, verdict: CrashDumpVerdict): void {
  mkdirSync(crashDumpVerdictDir(testInfo), { recursive: true });
  writeFileSync(crashDumpVerdictFile(testInfo), [verdict.headline, ...verdict.lines].join('\n'));
}

export function failIfEarlierAttemptFoundCrashDump(testInfo: CrashDumpAttemptInfo): void {
  let recorded: string;
  try {
    recorded = readFileSync(crashDumpVerdictFile(testInfo), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    `an earlier attempt of this test found a crash dump from the app, so no retry of it can pass: ${recorded}`,
  );
}

class DumpBytes {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  u16(at: number): number | null {
    return at >= 0 && at + 2 <= this.#bytes.length ? this.#bytes.readUInt16LE(at) : null;
  }

  u32(at: number): number | null {
    return at >= 0 && at + 4 <= this.#bytes.length ? this.#bytes.readUInt32LE(at) : null;
  }

  u64(at: number): bigint | null {
    return at >= 0 && at + 8 <= this.#bytes.length ? this.#bytes.readBigUInt64LE(at) : null;
  }

  slice(at: number, length: number): Buffer | null {
    return at >= 0 && length >= 0 && at + length <= this.#bytes.length
      ? this.#bytes.subarray(at, at + length)
      : null;
  }

  utf16String(rva: number): string | null {
    const byteLength = this.u32(rva);
    if (byteLength === null || byteLength === 0 || byteLength % 2 !== 0) return null;
    if (byteLength > MAX_MODULE_NAME_BYTES) return null;
    return this.slice(rva + 4, byteLength)?.toString('utf16le') ?? null;
  }

  utf8String(rva: number): string | null {
    if (rva === 0) return null;
    const byteLength = this.u32(rva);
    if (byteLength === null || byteLength > MAX_ANNOTATION_BYTES) return null;
    return this.slice(rva + 4, byteLength)?.toString('utf8') ?? null;
  }
}

function emptyFacts(unreadable: string): CrashDumpFacts {
  return {
    modules: [],
    exception: null,
    processId: null,
    processCreatedAtSec: null,
    writtenAtSec: null,
    annotations: [],
    unreadable,
  };
}

function readModules(dump: DumpBytes, rva: number | undefined): LoadedModule[] {
  if (rva === undefined) return [];
  const count = dump.u32(rva);
  if (count === null) return [];
  const modules: LoadedModule[] = [];
  for (let index = 0; index < Math.min(count, MAX_MODULES); index += 1) {
    const at = rva + 4 + index * MODULE_RECORD_BYTES;
    const base = dump.u64(at + MODULE_BASE_OFFSET);
    const size = dump.u32(at + MODULE_SIZE_OFFSET);
    const nameRva = dump.u32(at + MODULE_NAME_RVA_OFFSET);
    if (base === null || size === null || nameRva === null) break;
    const path = dump.utf16String(nameRva);
    if (path !== null) modules.push({ path, base, size });
  }
  return modules;
}

function readException(dump: DumpBytes, rva: number | undefined): CrashDumpException | null {
  if (rva === undefined) return null;
  const threadId = dump.u32(rva + EXCEPTION_THREAD_ID_OFFSET);
  const code = dump.u32(rva + EXCEPTION_CODE_OFFSET);
  const flags = dump.u32(rva + EXCEPTION_FLAGS_OFFSET);
  const address = dump.u64(rva + EXCEPTION_ADDRESS_OFFSET);
  if (threadId === null || code === null || flags === null || address === null) return null;
  return { code, flags, address, threadId };
}

function readMiscInfo(
  dump: DumpBytes,
  rva: number | undefined,
): { processId: number | null; processCreatedAtSec: number | null } {
  const none = { processId: null, processCreatedAtSec: null };
  if (rva === undefined) return none;
  const size = dump.u32(rva);
  const flags = dump.u32(rva + MISC_INFO_FLAGS_OFFSET);
  if (size === null || size < MISC_INFO_MIN_BYTES || flags === null) return none;
  const processId = dump.u32(rva + MISC_INFO_PROCESS_ID_OFFSET);
  const createdAt = dump.u32(rva + MISC_INFO_PROCESS_CREATE_TIME_OFFSET);
  return {
    processId: (flags & MISC_INFO_PROCESS_ID_FLAG) !== 0 ? processId : null,
    processCreatedAtSec: (flags & MISC_INFO_PROCESS_TIMES_FLAG) !== 0 ? createdAt : null,
  };
}

function readSimpleAnnotations(dump: DumpBytes, infoRva: number): CrashDumpAnnotation[] {
  const size = dump.u32(infoRva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_SIZE_OFFSET);
  const rva = dump.u32(infoRva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_RVA_OFFSET);
  if (size === null || rva === null || rva === 0) return [];
  const count = dump.u32(rva);
  if (count === null || count > MAX_ANNOTATIONS) return [];
  if (size < 4 + count * SIMPLE_ANNOTATION_ENTRY_BYTES) return [];
  const annotations: CrashDumpAnnotation[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = rva + 4 + index * SIMPLE_ANNOTATION_ENTRY_BYTES;
    const keyRva = dump.u32(at);
    const valueRva = dump.u32(at + 4);
    if (keyRva === null || valueRva === null) break;
    const key = dump.utf8String(keyRva);
    const value = dump.utf8String(valueRva);
    if (key !== null && value !== null) annotations.push({ key, value, source: 'simple' });
  }
  return annotations;
}

function readModuleAnnotationObjects(dump: DumpBytes, infoRva: number): CrashDumpAnnotation[] {
  const size = dump.u32(infoRva + CRASHPAD_INFO_MODULE_LIST_SIZE_OFFSET);
  const rva = dump.u32(infoRva + CRASHPAD_INFO_MODULE_LIST_RVA_OFFSET);
  if (size === null || rva === null || rva === 0) return [];
  const linkCount = dump.u32(rva);
  if (linkCount === null || linkCount > MAX_MODULES) return [];
  if (size < 4 + linkCount * MODULE_LINK_BYTES) return [];
  const annotations: CrashDumpAnnotation[] = [];
  let budget = MAX_ANNOTATIONS;
  for (let link = 0; link < linkCount && budget > 0; link += 1) {
    const moduleInfoRva = dump.u32(rva + 4 + link * MODULE_LINK_BYTES + MODULE_LINK_RVA_OFFSET);
    if (moduleInfoRva === null || dump.slice(moduleInfoRva, MODULE_CRASHPAD_INFO_BYTES) === null) {
      continue;
    }
    const listSize = dump.u32(moduleInfoRva + MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET);
    const listRva = dump.u32(moduleInfoRva + MODULE_ANNOTATION_OBJECTS_RVA_OFFSET);
    if (listSize === null || listRva === null || listRva === 0) continue;
    const objectCount = dump.u32(listRva);
    if (objectCount === null || objectCount > MAX_ANNOTATIONS) continue;
    if (listSize < 4 + objectCount * ANNOTATION_OBJECT_BYTES) continue;
    for (let index = 0; index < objectCount && budget > 0; index += 1) {
      budget -= 1;
      const at = listRva + 4 + index * ANNOTATION_OBJECT_BYTES;
      if (dump.u16(at + ANNOTATION_OBJECT_TYPE_OFFSET) !== ANNOTATION_TYPE_STRING) continue;
      const nameRva = dump.u32(at);
      const valueRva = dump.u32(at + ANNOTATION_OBJECT_VALUE_RVA_OFFSET);
      if (nameRva === null || valueRva === null) continue;
      const key = dump.utf8String(nameRva);
      const value = dump.utf8String(valueRva);
      if (key !== null && value !== null) annotations.push({ key, value, source: 'module' });
    }
  }
  return annotations;
}

export function readCrashDumpFacts(dumpPath: string): CrashDumpFacts {
  let bytes: Buffer;
  try {
    if (statSync(dumpPath).size > MAX_DUMP_BYTES) return emptyFacts('larger than the reader bound');
    bytes = readFileSync(dumpPath);
  } catch (error) {
    return emptyFacts(`unreadable file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dump = new DumpBytes(bytes);
  if (bytes.length < HEADER_BYTES || dump.u32(0) !== MINIDUMP_SIGNATURE) {
    return emptyFacts('no minidump signature');
  }
  const streamCount = dump.u32(HEADER_STREAM_COUNT_OFFSET) ?? 0;
  const directoryRva = dump.u32(HEADER_DIRECTORY_RVA_OFFSET) ?? 0;
  if (streamCount === 0 || streamCount > MAX_STREAMS) return emptyFacts('no stream directory');
  const streams = new Map<number, { rva: number; size: number }>();
  for (let index = 0; index < streamCount; index += 1) {
    const at = directoryRva + index * DIRECTORY_ENTRY_BYTES;
    const type = dump.u32(at);
    const size = dump.u32(at + DIRECTORY_ENTRY_SIZE_OFFSET);
    const rva = dump.u32(at + DIRECTORY_ENTRY_RVA_OFFSET);
    if (type === null || size === null || rva === null) break;
    if (!streams.has(type)) streams.set(type, { rva, size });
  }
  const crashpadInfoRva = streams.get(CRASHPAD_INFO_STREAM_TYPE)?.rva;
  const misc = readMiscInfo(dump, streams.get(MISC_INFO_STREAM_TYPE)?.rva);
  return {
    modules: readModules(dump, streams.get(MODULE_LIST_STREAM_TYPE)?.rva),
    exception: readException(dump, streams.get(EXCEPTION_STREAM_TYPE)?.rva),
    processId: misc.processId,
    processCreatedAtSec: misc.processCreatedAtSec,
    writtenAtSec: dump.u32(HEADER_TIME_DATE_STAMP_OFFSET) || null,
    annotations:
      crashpadInfoRva === undefined
        ? []
        : [
            ...readSimpleAnnotations(dump, crashpadInfoRva),
            ...readModuleAnnotationObjects(dump, crashpadInfoRva),
          ],
    unreadable: null,
  };
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '');
}

function fileNameOf(path: string): string {
  return pathSegments(path).at(-1) ?? path;
}

export function packageOfModule(path: string): string | null {
  const segments = pathSegments(path);
  const nodeModules = segments.lastIndexOf('node_modules');
  if (nodeModules === -1) return null;
  const name = segments[nodeModules + 1];
  if (name === undefined) return null;
  if (!name.startsWith('@')) return name;
  const scoped = segments[nodeModules + 2];
  return scoped === undefined ? null : `${name}/${scoped}`;
}

export function nativeAddonsOf(facts: CrashDumpFacts): string[] {
  const addons: string[] = [];
  for (const module of facts.modules) {
    const file = fileNameOf(module.path);
    const owner = packageOfModule(module.path);
    const isAddon = file.toLowerCase().endsWith('.node');
    const isPackagedLibrary = owner !== null && file.toLowerCase().endsWith('.dll');
    if (!isAddon && !isPackagedLibrary) continue;
    addons.push(owner === null ? file : `${owner}/${file}`);
  }
  return addons;
}

export function processRoleOf(facts: CrashDumpFacts): string {
  const loaded = facts.modules.map((module) => ({
    file: fileNameOf(module.path).toLowerCase(),
    owner: packageOfModule(module.path),
  }));
  const fromNodePty = loaded.filter((module) => module.owner === 'node-pty');
  if (fromNodePty.some((module) => NODE_PTY_HOST_ADDONS.has(module.file))) {
    return 'pty-host (node-pty terminal addon loaded)';
  }
  if (fromNodePty.some((module) => module.file === NODE_PTY_CONSOLE_LIST_ADDON)) {
    return 'node-pty console-list agent';
  }
  if (loaded.some((module) => module.owner?.startsWith('@parcel/watcher') === true)) {
    return 'project server (@parcel/watcher addon loaded)';
  }
  return 'no identifying addon loaded';
}

export function faultingModuleOf(facts: CrashDumpFacts): LoadedModule | null {
  const address = facts.exception?.address;
  if (address === undefined) return null;
  return (
    facts.modules.find(
      (module) => address >= module.base && address < module.base + BigInt(module.size),
    ) ?? null
  );
}

function hex(value: number | bigint, width = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

export function exceptionNameOf(code: number, platform: NodeJS.Platform): string | null {
  return platform === 'win32' ? (WINDOWS_EXCEPTION_NAMES.get(code) ?? null) : null;
}

function printable(value: string, limit: number): string {
  const cleaned = value.replace(/[^\x20-\x7e]/g, '?');
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

function processIdentity(finding: CrashDumpFinding, observation: QuitObservation): string {
  const pid = finding.facts.processId;
  if (pid === null) return 'pid unknown (no process id in the dump)';
  const known = observation.processes.find((entry) => entry.pid === pid);
  if (known === undefined) return `pid ${pid} (not among the app processes listed before quit)`;
  const label = known.serviceName ?? known.name;
  return label === null ? `pid ${pid} ${known.type}` : `pid ${pid} ${known.type} "${label}"`;
}

function exceptionSummary(finding: CrashDumpFinding, platform: NodeJS.Platform): string {
  const exception = finding.facts.exception;
  if (exception === null) return 'no exception record';
  const name = exceptionNameOf(exception.code, platform);
  const faulting = faultingModuleOf(finding.facts);
  return [
    `exception ${hex(exception.code)}${name === null ? '' : ` ${name}`}`,
    `at ${hex(exception.address, 12)}`,
    faulting === null ? 'outside every listed module' : `in ${fileNameOf(faulting.path)}`,
  ].join(' ');
}

function timingSummary(finding: CrashDumpFinding, observation: QuitObservation): string {
  const deltaMs = Math.round(finding.mtimeMs - observation.quitRequestedAtMs);
  return deltaMs >= 0
    ? `written ${deltaMs} ms after quit was requested`
    : `written ${-deltaMs} ms before quit was requested`;
}

function identify(
  finding: CrashDumpFinding,
  observation: QuitObservation,
  platform: NodeJS.Platform,
): string {
  return [
    processIdentity(finding, observation),
    processRoleOf(finding.facts),
    exceptionSummary(finding, platform),
    timingSummary(finding, observation),
  ].join('; ');
}

export function describeCrashDump(
  finding: CrashDumpFinding,
  observation: QuitObservation,
  platform: NodeJS.Platform,
): string {
  const facts = finding.facts;
  const processType = facts.annotations.find((entry) => entry.key === 'process_type')?.value;
  const mainModule = facts.modules[0];
  const addons = nativeAddonsOf(facts);
  const annotations = facts.annotations
    .slice(0, DESCRIBED_ANNOTATIONS)
    .map(
      (entry) =>
        `${printable(entry.key, DESCRIBED_ANNOTATION_VALUE_CHARS)}=${printable(entry.value, DESCRIBED_ANNOTATION_VALUE_CHARS)}`,
    );
  return [
    fileNameOf(finding.path),
    identify(finding, observation, platform),
    `process_type=${processType === undefined ? '(absent)' : printable(processType, DESCRIBED_ANNOTATION_VALUE_CHARS)}`,
    `native addons: ${addons.length === 0 ? '(none)' : addons.join(', ')}`,
    `main module ${mainModule === undefined ? '(none)' : fileNameOf(mainModule.path)}`,
    `ownership ${finding.ownership}, crash kind ${finding.crashKind ?? 'unread'}`,
    `${facts.modules.length} modules`,
    ...(facts.unreadable === null ? [] : [`unreadable: ${facts.unreadable}`]),
    `annotations: ${annotations.length === 0 ? '(none)' : annotations.join(', ')}`,
  ].join('; ');
}

function listCrashDumpFiles(dir: string, depth: number, out: Map<string, number>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) listCrashDumpFiles(entryPath, depth - 1, out);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.dmp')) continue;
    try {
      out.set(entryPath, statSync(entryPath).mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function crashDumpFiles(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  listCrashDumpFiles(dir, DUMP_SCAN_DEPTH, out);
  return out;
}

export function crashDumpWatchFor(
  dir: string,
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): CrashDumpWatch {
  return {
    dir,
    appBundleRoot: appBundleRootFromExecutable(executablePath, platform),
    platform,
    baseline: crashDumpFiles(dir),
  };
}

export async function watchCrashDumps(app: ElectronApplication): Promise<CrashDumpWatch> {
  const paths = await app.evaluate(({ app: electronApp }) => ({
    crashDumps: electronApp.getPath('crashDumps'),
    executable: electronApp.getPath('exe'),
  }));
  return crashDumpWatchFor(paths.crashDumps, paths.executable);
}

export async function observeQuit(app: ElectronApplication): Promise<QuitObservation> {
  const processes = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      serviceName: metric.serviceName ?? null,
      name: metric.name ?? null,
      creationTime: metric.creationTime,
    })),
  );
  return { processes, quitRequestedAtMs: Date.now() };
}

export function crashDumpsSince(watch: CrashDumpWatch): CrashDumpFinding[] {
  const findings: CrashDumpFinding[] = [];
  for (const [path, mtimeMs] of crashDumpFiles(watch.dir)) {
    const before = watch.baseline.get(path);
    if (before !== undefined && before >= mtimeMs) continue;
    const ownership = classifyMinidumpOwnership(path, watch.appBundleRoot);
    const crashKind = ownership === 'ours' ? classifyMinidumpCrashKind(path, watch.platform) : null;
    findings.push({
      path,
      mtimeMs,
      ownership,
      crashKind,
      facts: readCrashDumpFacts(path),
      countsAsCrash: ownership !== 'foreign' && crashKind !== 'non-crash',
    });
  }
  return findings.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function crashDumpVerdict(
  findings: readonly CrashDumpFinding[],
  observation: QuitObservation,
  platform: NodeJS.Platform = process.platform,
): CrashDumpVerdict {
  const crashes = findings.filter((finding) => finding.countsAsCrash);
  const [first] = crashes;
  const headline =
    first === undefined
      ? 'the quit left no crash dump from the app'
      : `the quit left ${crashes.length} crash dump(s) from the app; first: ${identify(first, observation, platform)}`;
  return {
    findings,
    crashes,
    headline,
    lines: crashes.map((finding) => describeCrashDump(finding, observation, platform)),
  };
}

function factsForAttachment(finding: CrashDumpFinding): Record<string, unknown> {
  const { facts } = finding;
  return {
    file: fileNameOf(finding.path),
    mtime: new Date(finding.mtimeMs).toISOString(),
    ownership: finding.ownership,
    crashKind: finding.crashKind,
    countsAsCrash: finding.countsAsCrash,
    processId: facts.processId,
    processCreatedAtSec: facts.processCreatedAtSec,
    writtenAtSec: facts.writtenAtSec,
    role: processRoleOf(facts),
    exception:
      facts.exception === null
        ? null
        : {
            code: hex(facts.exception.code),
            flags: hex(facts.exception.flags),
            address: hex(facts.exception.address, 12),
            threadId: facts.exception.threadId,
            faultingModule: faultingModuleOf(facts)?.path ?? null,
          },
    annotations: facts.annotations,
    modules: facts.modules.map((module) => ({
      path: module.path,
      base: hex(module.base, 12),
      size: module.size,
    })),
    unreadable: facts.unreadable,
  };
}

export async function collectCrashDumps(
  watch: CrashDumpWatch,
  observation: QuitObservation,
  testInfo: CrashDumpTestInfo,
): Promise<CrashDumpVerdict> {
  const verdict = crashDumpVerdict(crashDumpsSince(watch), observation, watch.platform);
  if (verdict.crashes.length > 0) recordCrashDumpVerdict(testInfo, verdict);
  if (verdict.findings.length === 0) return verdict;
  await testInfo.attach('crash-dump-facts', {
    body: JSON.stringify(
      {
        headline: verdict.headline,
        processesBeforeQuit: observation.processes,
        quitRequestedAt: new Date(observation.quitRequestedAtMs).toISOString(),
        dumps: verdict.findings.map(factsForAttachment),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  for (const [index, finding] of verdict.crashes.entries()) {
    await testInfo.attach(`crash-dump-${index + 1}`, {
      path: finding.path,
      contentType: 'application/octet-stream',
    });
  }
  return verdict;
}

function readProcessTable(file: string, args: readonly string[]): ProcessTableRead {
  const result = spawnSync(file, [...args], {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_READ_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function listedWindowsPids(stdout: string): Set<number> {
  const listed = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"[^"]*","(\d+)"/.exec(line.trim());
    if (match?.[1] !== undefined) listed.add(Number(match[1]));
  }
  return listed;
}

function listedPosixPids(stdout: string): Set<number> {
  return new Set(
    stdout
      .split(/\s+/)
      .filter((token) => /^\d+$/.test(token))
      .map(Number),
  );
}

export function runningAppProcesses(
  processes: readonly AppProcess[],
  options: { platform?: NodeJS.Platform; read?: ProcessTableReader } = {},
): AppProcess[] {
  const candidates = processes.filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  if (candidates.length === 0) return [];
  const platform = options.platform ?? process.platform;
  const read = options.read ?? readProcessTable;
  if (platform === 'win32') {
    const table = read('tasklist', ['/FO', 'CSV', '/NH']);
    if (table.status !== 0) return candidates;
    const listed = listedWindowsPids(table.stdout);
    if (listed.size === 0) return candidates;
    return candidates.filter((entry) => listed.has(entry.pid));
  }
  const table = read('ps', ['-o', 'pid=', '-p', candidates.map((entry) => entry.pid).join(',')]);
  if (table.status !== 0 && table.status !== 1) return candidates;
  const listed = listedPosixPids(table.stdout);
  return candidates.filter((entry) => listed.has(entry.pid));
}
