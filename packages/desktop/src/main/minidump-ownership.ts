import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { DISPLAY_LOCK_CRASH_KEY } from '../shared/display-lock-crash-key.ts';
import { asReportableAppVersion } from './crashed-app-version.ts';
import { isPathWithinProject } from './path-containment.ts';

export type MinidumpOwnership = 'ours' | 'foreign' | 'unknown';

const MINIDUMP_SIGNATURE = 0x504d_444d;
const HEADER_BYTES = 32;
const NUMBER_OF_STREAMS_OFFSET = 8;
const STREAM_DIRECTORY_RVA_OFFSET = 12;
const DIRECTORY_ENTRY_BYTES = 12;
const DIRECTORY_ENTRY_SIZE_OFFSET = 4;
const DIRECTORY_ENTRY_RVA_OFFSET = 8;
const MODULE_LIST_STREAM_TYPE = 4;
const MODULE_RECORD_BYTES = 108;
const MODULE_NAME_RVA_OFFSET = 20;
const EXCEPTION_STREAM_TYPE = 6;
const EXCEPTION_CODE_OFFSET = 8;
const EXCEPTION_CODE_BYTES = 4;

const SIMULATED_EXCEPTION_CODE_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 0x4350_7378,
};

const DUMP_WITHOUT_CRASHING_KEY = 'is-dump-process-without-crashing';

const CRASHPAD_INFO_STREAM_TYPE = 0x4350_0001;
const CRASHPAD_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_ANNOTATIONS_RVA_OFFSET = 40;
const CRASHPAD_INFO_PREFIX_BYTES = 44;
const ANNOTATION_ENTRY_BYTES = 8;
const APP_VERSION_ANNOTATION_KEY = '_version';

const CRASHPAD_MODULE_LIST_SIZE_OFFSET = 44;
const CRASHPAD_MODULE_LIST_RVA_OFFSET = 48;
const CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES = 52;
const MODULE_LINK_BYTES = 12;
const MODULE_LINK_RVA_OFFSET = 8;
const MODULE_CRASHPAD_INFO_BYTES = 28;
const MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET = 20;
const MODULE_ANNOTATION_OBJECTS_RVA_OFFSET = 24;
const ANNOTATION_OBJECT_BYTES = 12;
const ANNOTATION_OBJECT_TYPE_OFFSET = 4;
const ANNOTATION_OBJECT_VALUE_RVA_OFFSET = 8;
const ANNOTATION_TYPE_STRING = 1;

const AX_MODE_ANNOTATION_KEY = 'ax_mode';

const PROCESS_TYPE_ANNOTATION_KEY = 'process_type';

const MAX_STREAMS = 4096;
const MAX_MODULE_NAME_BYTES = 8192;
const MAX_ANNOTATIONS = 256;
const MAX_ANNOTATION_STRING_BYTES = 256;
const MAX_MODULE_LINKS = 4096;
const MAX_ANNOTATION_OBJECTS_SCANNED = 1024;

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const buf = Buffer.alloc(length);
  return readSync(fd, buf, 0, length, position) === length ? buf : null;
}

interface MinidumpFacts {
  mainModulePath: string | null;
  appVersion: string | null;
  appVersionParseFailed: boolean;
}

const NO_FACTS: MinidumpFacts = Object.freeze({
  mainModulePath: null,
  appVersion: null,
  appVersionParseFailed: false,
});

function readAnnotationString(fd: number, rva: number): string | null {
  if (rva === 0) return null;
  const length = readExactly(fd, 4, rva);
  if (length === null) return null;
  const byteLength = length.readUInt32LE(0);
  if (byteLength === 0 || byteLength > MAX_ANNOTATION_STRING_BYTES) return null;
  const bytes = readExactly(fd, byteLength, rva + 4);
  return bytes === null ? null : bytes.toString('utf8');
}

function readAppVersionAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
): { version: string | null; parseFailed: boolean } {
  try {
    return { version: parseAppVersionAnnotation(fd, infoRva, infoSize), parseFailed: false };
  } catch {
    return { version: null, parseFailed: true };
  }
}

function parseAppVersionAnnotation(fd: number, infoRva: number, infoSize: number): string | null {
  if (infoSize < CRASHPAD_INFO_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  const dictRva = info.readUInt32LE(CRASHPAD_ANNOTATIONS_RVA_OFFSET);
  if (dictRva === 0) return null;
  const count = readExactly(fd, 4, dictRva);
  if (count === null) return null;
  const entryCount = count.readUInt32LE(0);
  if (entryCount === 0 || entryCount > MAX_ANNOTATIONS) return null;
  const declaredBytes = info.readUInt32LE(CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
  if (declaredBytes < 4 + entryCount * ANNOTATION_ENTRY_BYTES) return null;

  const entries = readExactly(fd, entryCount * ANNOTATION_ENTRY_BYTES, dictRva + 4);
  if (entries === null) return null;
  for (let i = 0; i < entryCount; i += 1) {
    const at = i * ANNOTATION_ENTRY_BYTES;
    if (readAnnotationString(fd, entries.readUInt32LE(at)) !== APP_VERSION_ANNOTATION_KEY) {
      continue;
    }
    return asReportableAppVersion(readAnnotationString(fd, entries.readUInt32LE(at + 4)));
  }
  return null;
}

function readMinidumpFacts(dumpPath: string): MinidumpFacts {
  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) return NO_FACTS;
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return NO_FACTS;

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return NO_FACTS;
    let moduleListRva: number | null = null;
    let crashpadInfoRva: number | null = null;
    let crashpadInfoSize = 0;
    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      const streamType = directory.readUInt32LE(at);
      if (streamType === MODULE_LIST_STREAM_TYPE && moduleListRva === null) {
        moduleListRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
      } else if (streamType === CRASHPAD_INFO_STREAM_TYPE && crashpadInfoRva === null) {
        crashpadInfoRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
        crashpadInfoSize = directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET);
      }
      if (moduleListRva !== null && crashpadInfoRva !== null) break;
    }

    const annotation =
      crashpadInfoRva === null
        ? null
        : readAppVersionAnnotation(fd, crashpadInfoRva, crashpadInfoSize);
    return {
      mainModulePath: readMainModule(fd, moduleListRva),
      appVersion: annotation?.version ?? null,
      appVersionParseFailed: annotation?.parseFailed ?? false,
    };
  } catch {
    return NO_FACTS;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function readMainModule(fd: number, moduleListRva: number | null): string | null {
  if (moduleListRva === null) return null;
  const moduleCount = readExactly(fd, 4, moduleListRva);
  if (moduleCount === null || moduleCount.readUInt32LE(0) === 0) return null;
  const firstModule = readExactly(fd, MODULE_RECORD_BYTES, moduleListRva + 4);
  if (firstModule === null) return null;

  const nameRva = firstModule.readUInt32LE(MODULE_NAME_RVA_OFFSET);
  const nameLength = readExactly(fd, 4, nameRva);
  if (nameLength === null) return null;
  const nameBytes = nameLength.readUInt32LE(0);
  if (nameBytes === 0 || nameBytes % 2 !== 0 || nameBytes > MAX_MODULE_NAME_BYTES) return null;
  const name = readExactly(fd, nameBytes, nameRva + 4);
  return name === null ? null : name.toString('utf16le');
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function classifyMinidumpOwnership(
  dumpPath: string,
  appBundleRoot: string,
): MinidumpOwnership {
  const mainModule = readMinidumpFacts(dumpPath).mainModulePath;
  if (mainModule === null) return 'unknown';
  const ours =
    isPathWithinProject(canonicalize(mainModule), canonicalize(appBundleRoot), process.platform) ||
    isPathWithinProject(mainModule, appBundleRoot, process.platform);
  return ours ? 'ours' : 'foreign';
}

export interface MinidumpAppVersionRead {
  version: string | null;
  parseFailed: boolean;
}

export function readMinidumpAppVersion(dumpPath: string): MinidumpAppVersionRead {
  const facts = readMinidumpFacts(dumpPath);
  return { version: facts.appVersion, parseFailed: facts.appVersionParseFailed };
}

export type MinidumpCrashKind = 'crash' | 'non-crash' | 'indeterminate';

function findSimpleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): string | null {
  if (infoSize < CRASHPAD_INFO_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  const dictRva = info.readUInt32LE(CRASHPAD_ANNOTATIONS_RVA_OFFSET);
  if (dictRva === 0) return null;
  const count = readExactly(fd, 4, dictRva);
  if (count === null) return null;
  const entryCount = count.readUInt32LE(0);
  if (entryCount === 0 || entryCount > MAX_ANNOTATIONS) return null;
  const declaredBytes = info.readUInt32LE(CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
  if (declaredBytes < 4 + entryCount * ANNOTATION_ENTRY_BYTES) return null;

  const entries = readExactly(fd, entryCount * ANNOTATION_ENTRY_BYTES, dictRva + 4);
  if (entries === null) return null;
  for (let i = 0; i < entryCount; i += 1) {
    const at = i * ANNOTATION_ENTRY_BYTES;
    if (readAnnotationString(fd, entries.readUInt32LE(at)) !== key) continue;
    return readAnnotationString(fd, entries.readUInt32LE(at + 4));
  }
  return null;
}

export function classifyMinidumpCrashKind(
  dumpPath: string,
  platform: NodeJS.Platform = process.platform,
): MinidumpCrashKind {
  const simulatedCode = SIMULATED_EXCEPTION_CODE_BY_PLATFORM[platform];
  if (simulatedCode === undefined) return 'indeterminate';

  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) return 'indeterminate';
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return 'indeterminate';

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return 'indeterminate';

    let exceptionRva: number | null = null;
    let crashpadInfoRva: number | null = null;
    let crashpadInfoSize = 0;
    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      const streamType = directory.readUInt32LE(at);
      if (streamType === EXCEPTION_STREAM_TYPE && exceptionRva === null) {
        exceptionRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
      } else if (streamType === CRASHPAD_INFO_STREAM_TYPE && crashpadInfoRva === null) {
        crashpadInfoRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
        crashpadInfoSize = directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET);
      }
      if (exceptionRva !== null && crashpadInfoRva !== null) break;
    }

    if (exceptionRva !== null) {
      const code = readExactly(fd, EXCEPTION_CODE_BYTES, exceptionRva + EXCEPTION_CODE_OFFSET);
      if (code === null) return 'indeterminate';
      return code.readUInt32LE(0) === simulatedCode ? 'non-crash' : 'crash';
    }

    if (crashpadInfoRva === null) return 'indeterminate';
    const marker = findSimpleAnnotation(
      fd,
      crashpadInfoRva,
      crashpadInfoSize,
      DUMP_WITHOUT_CRASHING_KEY,
    );
    return marker === 'true' ? 'non-crash' : 'indeterminate';
  } catch {
    return 'indeterminate';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export interface MinidumpAccessibilityModeRead {
  mode: string | null;
  parseFailed: boolean;
}

const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;

function asReportableAnnotationValue(value: string | null): string | null {
  if (value === null || value === '') return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < FIRST_PRINTABLE_ASCII || code > LAST_PRINTABLE_ASCII) return null;
  }
  return value;
}

function findAnnotationObjectInModule(
  fd: number,
  moduleInfoRva: number,
  key: string,
  budget: number,
): { value: string | null; budget: number } {
  const moduleInfo = readExactly(fd, MODULE_CRASHPAD_INFO_BYTES, moduleInfoRva);
  if (moduleInfo === null) return { value: null, budget };
  const listRva = moduleInfo.readUInt32LE(MODULE_ANNOTATION_OBJECTS_RVA_OFFSET);
  if (listRva === 0) return { value: null, budget };

  const count = readExactly(fd, 4, listRva);
  if (count === null) return { value: null, budget };
  const objectCount = count.readUInt32LE(0);
  if (objectCount === 0 || objectCount > MAX_ANNOTATIONS) return { value: null, budget };
  const declaredBytes = moduleInfo.readUInt32LE(MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET);
  if (declaredBytes < 4 + objectCount * ANNOTATION_OBJECT_BYTES) return { value: null, budget };

  const objects = readExactly(fd, objectCount * ANNOTATION_OBJECT_BYTES, listRva + 4);
  if (objects === null) return { value: null, budget };

  let remaining = budget;
  for (let i = 0; i < objectCount; i += 1) {
    if (remaining === 0) return { value: null, budget: 0 };
    remaining -= 1;
    const at = i * ANNOTATION_OBJECT_BYTES;
    if (objects.readUInt16LE(at + ANNOTATION_OBJECT_TYPE_OFFSET) !== ANNOTATION_TYPE_STRING) {
      continue;
    }
    if (readAnnotationString(fd, objects.readUInt32LE(at)) !== key) continue;
    const value = readAnnotationString(
      fd,
      objects.readUInt32LE(at + ANNOTATION_OBJECT_VALUE_RVA_OFFSET),
    );
    return { value: asReportableAnnotationValue(value), budget: remaining };
  }
  return { value: null, budget: remaining };
}

function readModuleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): { value: string | null; parseFailed: boolean } {
  try {
    return { value: findModuleAnnotation(fd, infoRva, infoSize, key), parseFailed: false };
  } catch {
    return { value: null, parseFailed: true };
  }
}

function findModuleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): string | null {
  if (infoSize < CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  const listRva = info.readUInt32LE(CRASHPAD_MODULE_LIST_RVA_OFFSET);
  if (listRva === 0) return null;

  const count = readExactly(fd, 4, listRva);
  if (count === null) return null;
  const linkCount = count.readUInt32LE(0);
  if (linkCount === 0 || linkCount > MAX_MODULE_LINKS) return null;
  const declaredBytes = info.readUInt32LE(CRASHPAD_MODULE_LIST_SIZE_OFFSET);
  if (declaredBytes < 4 + linkCount * MODULE_LINK_BYTES) return null;

  const links = readExactly(fd, linkCount * MODULE_LINK_BYTES, listRva + 4);
  if (links === null) return null;

  let budget = MAX_ANNOTATION_OBJECTS_SCANNED;
  for (let i = 0; i < linkCount; i += 1) {
    const found = findAnnotationObjectInModule(
      fd,
      links.readUInt32LE(i * MODULE_LINK_BYTES + MODULE_LINK_RVA_OFFSET),
      key,
      budget,
    );
    if (found.value !== null) return found.value;
    budget = found.budget;
    if (budget === 0) return null;
  }
  return null;
}

export function readMinidumpAccessibilityMode(dumpPath: string): MinidumpAccessibilityModeRead {
  const read = readDumpAnnotation(dumpPath, AX_MODE_ANNOTATION_KEY);
  return { mode: read.value, parseFailed: read.parseFailed };
}

export interface MinidumpProcessTypeRead {
  processType: string | null;
  parseFailed: boolean;
}

export function readMinidumpProcessType(dumpPath: string): MinidumpProcessTypeRead {
  const read = readDumpAnnotation(dumpPath, PROCESS_TYPE_ANNOTATION_KEY);
  return { processType: read.value, parseFailed: read.parseFailed };
}

function readDumpAnnotation(
  dumpPath: string,
  key: string,
): { value: string | null; parseFailed: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) {
      return { value: null, parseFailed: false };
    }
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return { value: null, parseFailed: false };

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return { value: null, parseFailed: false };

    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      if (directory.readUInt32LE(at) !== CRASHPAD_INFO_STREAM_TYPE) continue;
      return readModuleAnnotation(
        fd,
        directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET),
        directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET),
        key,
      );
    }
    return { value: null, parseFailed: false };
  } catch {
    return { value: null, parseFailed: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export interface MinidumpDisplayLockRead {
  state: string | null;
  parseFailed: boolean;
}

export function readMinidumpDisplayLockState(dumpPath: string): MinidumpDisplayLockRead {
  const read = readDumpAnnotation(dumpPath, DISPLAY_LOCK_CRASH_KEY);
  return { state: read.value, parseFailed: read.parseFailed };
}
