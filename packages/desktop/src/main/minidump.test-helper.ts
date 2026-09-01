const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 12;
const MODULE_RECORD_BYTES = 108;
const MODULE_NAME_RVA_OFFSET = 20;
const MODULE_LIST_STREAM_TYPE = 4;
const CRASHPAD_INFO_STREAM_TYPE = 0x4350_0001;
const CRASHPAD_INFO_BYTES = 64;
const CRASHPAD_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_ANNOTATIONS_RVA_OFFSET = 40;
const ANNOTATION_ENTRY_BYTES = 8;
const CRASHPAD_MODULE_LIST_SIZE_OFFSET = 44;
const CRASHPAD_MODULE_LIST_RVA_OFFSET = 48;
const MODULE_LINK_BYTES = 12;
const MODULE_CRASHPAD_INFO_BYTES = 28;
const MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET = 20;
const MODULE_ANNOTATION_OBJECTS_RVA_OFFSET = 24;
const ANNOTATION_OBJECT_BYTES = 12;
const ANNOTATION_OBJECT_TYPE_OFFSET = 4;
const ANNOTATION_OBJECT_VALUE_RVA_OFFSET = 8;
const ANNOTATION_TYPE_STRING = 1;
const EXCEPTION_STREAM_TYPE = 6;
const EXCEPTION_STREAM_BYTES = 168;
const EXCEPTION_CODE_OFFSET = 8;

export interface MinidumpPatch {
  signature?: string;
  streamCount?: number;
  streamDirectoryRva?: number;
  streamType?: number;
  moduleListRva?: number;
  moduleCount?: number;
  nameRva?: number;
  nameByteLength?: number;
  truncateTo?: number;
  streamsBefore?: number;
  annotations?: Record<string, string>;
  crashpadStreamType?: number;
  annotationsRva?: number;
  annotationsSize?: number;
  annotationCount?: number;
  annotationKeyRva?: number;
  annotationValueRva?: number;
  annotationValueByteLength?: number;
  exceptionCode?: number;
  annotationObjects?: Record<string, string>[];
  moduleLinkCount?: number;
  crashpadModuleListRva?: number;
  crashpadModuleListSize?: number;
  annotationObjectCount?: number;
  annotationObjectsRva?: number;
  annotationObjectsSize?: number;
  annotationObjectType?: number;
  annotationObjectValueRva?: number;
  annotationObjectValueByteLength?: number;
}

export function buildMinidump(modulePaths: string[], patch: MinidumpPatch = {}): Buffer {
  const decoyStreams = patch.streamsBefore ?? 0;
  const annotationEntries =
    patch.annotations === undefined ? null : Object.entries(patch.annotations);
  const objectModules = patch.annotationObjects ?? null;
  const hasCrashpadStream = annotationEntries !== null || objectModules !== null;
  const hasException = patch.exceptionCode !== undefined;
  const directoryEntries = decoyStreams + 1 + (hasCrashpadStream ? 1 : 0) + (hasException ? 1 : 0);
  const directoryRva = HEADER_BYTES;
  const moduleListRva = directoryRva + directoryEntries * DIRECTORY_ENTRY_BYTES;
  const moduleListBytes = 4 + modulePaths.length * MODULE_RECORD_BYTES;

  const nameBlocks: Buffer[] = [];
  const nameRvas: number[] = [];
  let cursor = moduleListRva + moduleListBytes;
  for (const modulePath of modulePaths) {
    const encoded = Buffer.from(modulePath, 'utf16le');
    const block = Buffer.alloc(4 + encoded.length);
    block.writeUInt32LE(encoded.length, 0);
    encoded.copy(block, 4);
    nameBlocks.push(block);
    nameRvas.push(cursor);
    cursor += block.length;
  }
  const firstName = nameBlocks[0];
  if (patch.nameByteLength !== undefined && firstName !== undefined) {
    firstName.writeUInt32LE(patch.nameByteLength, 0);
  }

  const crashpadBlocks: Buffer[] = [];
  const crashpadInfoRva = cursor;
  if (hasCrashpadStream) {
    const info = Buffer.alloc(CRASHPAD_INFO_BYTES);
    info.writeUInt32LE(1, 0);
    crashpadBlocks.push(info);
    cursor = crashpadInfoRva + CRASHPAD_INFO_BYTES;

    if (annotationEntries !== null) {
      const dictRva = cursor;
      const dictBytes = 4 + annotationEntries.length * ANNOTATION_ENTRY_BYTES;
      const stringBlocks: Buffer[] = [];
      let stringCursor = dictRva + dictBytes;
      const appendString = (value: string): { rva: number; block: Buffer } => {
        const encoded = Buffer.from(value, 'utf8');
        const block = Buffer.alloc(4 + encoded.length + 1);
        block.writeUInt32LE(encoded.length, 0);
        encoded.copy(block, 4);
        const rva = stringCursor;
        stringBlocks.push(block);
        stringCursor += block.length;
        return { rva, block };
      };

      const dict = Buffer.alloc(dictBytes);
      dict.writeUInt32LE(patch.annotationCount ?? annotationEntries.length, 0);
      annotationEntries.forEach(([key, value], index) => {
        const keyString = appendString(key);
        const valueString = appendString(value);
        const at = 4 + index * ANNOTATION_ENTRY_BYTES;
        const first = index === 0;
        dict.writeUInt32LE(first ? (patch.annotationKeyRva ?? keyString.rva) : keyString.rva, at);
        dict.writeUInt32LE(
          first ? (patch.annotationValueRva ?? valueString.rva) : valueString.rva,
          at + 4,
        );
        if (first && patch.annotationValueByteLength !== undefined) {
          valueString.block.writeUInt32LE(patch.annotationValueByteLength, 0);
        }
      });

      info.writeUInt32LE(patch.annotationsSize ?? dictBytes, CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
      info.writeUInt32LE(patch.annotationsRva ?? dictRva, CRASHPAD_ANNOTATIONS_RVA_OFFSET);
      crashpadBlocks.push(dict, ...stringBlocks);
      cursor = stringCursor;
    }

    if (objectModules !== null) {
      const linkListRva = cursor;
      const linkListBytes = 4 + objectModules.length * MODULE_LINK_BYTES;
      const moduleInfoRva = (i: number) =>
        linkListRva + linkListBytes + i * MODULE_CRASHPAD_INFO_BYTES;
      const objectListBytes = objectModules.map(
        (objects) => 4 + Object.keys(objects).length * ANNOTATION_OBJECT_BYTES,
      );
      const objectListsRva =
        linkListRva + linkListBytes + objectModules.length * MODULE_CRASHPAD_INFO_BYTES;
      const objectListRva = (i: number) =>
        objectListsRva + objectListBytes.slice(0, i).reduce((a, b) => a + b, 0);

      const stringBlocks: Buffer[] = [];
      let stringCursor = objectListsRva + objectListBytes.reduce((a, b) => a + b, 0);
      const appendString = (value: string, nulTerminated: boolean) => {
        const encoded = Buffer.from(value, 'utf8');
        const block = Buffer.alloc(4 + encoded.length + (nulTerminated ? 1 : 0));
        block.writeUInt32LE(encoded.length, 0);
        encoded.copy(block, 4);
        const rva = stringCursor;
        stringBlocks.push(block);
        stringCursor += block.length;
        return { rva, block };
      };

      const linkList = Buffer.alloc(linkListBytes);
      linkList.writeUInt32LE(patch.moduleLinkCount ?? objectModules.length, 0);
      const moduleInfos: Buffer[] = [];
      const objectLists: Buffer[] = [];

      objectModules.forEach((objects, moduleIndex) => {
        const firstModule = moduleIndex === 0;
        const at = 4 + moduleIndex * MODULE_LINK_BYTES;
        linkList.writeUInt32LE(moduleIndex + 1, at);
        linkList.writeUInt32LE(MODULE_CRASHPAD_INFO_BYTES, at + 4);
        linkList.writeUInt32LE(moduleInfoRva(moduleIndex), at + 8);

        const entries = Object.entries(objects);
        const list = Buffer.alloc(objectListBytes[moduleIndex] ?? 4);
        list.writeUInt32LE(
          firstModule ? (patch.annotationObjectCount ?? entries.length) : entries.length,
          0,
        );
        entries.forEach(([key, value], index) => {
          const first = firstModule && index === 0;
          const name = appendString(key, true);
          const valueBlock = appendString(value, false);
          const objAt = 4 + index * ANNOTATION_OBJECT_BYTES;
          list.writeUInt32LE(name.rva, objAt);
          list.writeUInt16LE(
            first ? (patch.annotationObjectType ?? ANNOTATION_TYPE_STRING) : ANNOTATION_TYPE_STRING,
            objAt + ANNOTATION_OBJECT_TYPE_OFFSET,
          );
          list.writeUInt32LE(
            first ? (patch.annotationObjectValueRva ?? valueBlock.rva) : valueBlock.rva,
            objAt + ANNOTATION_OBJECT_VALUE_RVA_OFFSET,
          );
          if (first && patch.annotationObjectValueByteLength !== undefined) {
            valueBlock.block.writeUInt32LE(patch.annotationObjectValueByteLength, 0);
          }
        });
        objectLists.push(list);

        const moduleInfo = Buffer.alloc(MODULE_CRASHPAD_INFO_BYTES);
        moduleInfo.writeUInt32LE(1, 0);
        const hasObjects = entries.length > 0;
        const declaredSize = firstModule
          ? (patch.annotationObjectsSize ?? objectListBytes[moduleIndex] ?? 0)
          : (objectListBytes[moduleIndex] ?? 0);
        const declaredRva = firstModule
          ? (patch.annotationObjectsRva ?? (hasObjects ? objectListRva(moduleIndex) : 0))
          : hasObjects
            ? objectListRva(moduleIndex)
            : 0;
        moduleInfo.writeUInt32LE(
          hasObjects || firstModule ? declaredSize : 0,
          MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET,
        );
        moduleInfo.writeUInt32LE(declaredRva, MODULE_ANNOTATION_OBJECTS_RVA_OFFSET);
        moduleInfos.push(moduleInfo);
      });

      info.writeUInt32LE(
        patch.crashpadModuleListSize ?? linkListBytes,
        CRASHPAD_MODULE_LIST_SIZE_OFFSET,
      );
      info.writeUInt32LE(
        patch.crashpadModuleListRva ?? linkListRva,
        CRASHPAD_MODULE_LIST_RVA_OFFSET,
      );
      crashpadBlocks.push(linkList, ...moduleInfos, ...objectLists, ...stringBlocks);
      cursor = stringCursor;
    }
  }

  const exceptionBlocks: Buffer[] = [];
  const exceptionRva = cursor;
  if (hasException) {
    const exception = Buffer.alloc(EXCEPTION_STREAM_BYTES);
    exception.writeUInt32LE(1, 0);
    exception.writeUInt32LE(patch.exceptionCode ?? 0, EXCEPTION_CODE_OFFSET);
    exceptionBlocks.push(exception);
    cursor += EXCEPTION_STREAM_BYTES;
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(patch.signature ?? 'MDMP', 0, 'ascii');
  header.writeUInt32LE(0xa793, 4);
  header.writeUInt32LE(patch.streamCount ?? directoryEntries, 8);
  header.writeUInt32LE(patch.streamDirectoryRva ?? directoryRva, 12);

  const directory = Buffer.alloc(directoryEntries * DIRECTORY_ENTRY_BYTES);
  for (let i = 0; i < decoyStreams; i += 1) {
    directory.writeUInt32LE(3, i * DIRECTORY_ENTRY_BYTES);
  }
  const moduleListEntry = decoyStreams * DIRECTORY_ENTRY_BYTES;
  directory.writeUInt32LE(patch.streamType ?? MODULE_LIST_STREAM_TYPE, moduleListEntry);
  directory.writeUInt32LE(moduleListBytes, moduleListEntry + 4);
  directory.writeUInt32LE(patch.moduleListRva ?? moduleListRva, moduleListEntry + 8);
  let nextEntry = moduleListEntry + DIRECTORY_ENTRY_BYTES;
  if (hasCrashpadStream) {
    directory.writeUInt32LE(patch.crashpadStreamType ?? CRASHPAD_INFO_STREAM_TYPE, nextEntry);
    directory.writeUInt32LE(CRASHPAD_INFO_BYTES, nextEntry + 4);
    directory.writeUInt32LE(crashpadInfoRva, nextEntry + 8);
    nextEntry += DIRECTORY_ENTRY_BYTES;
  }
  if (hasException) {
    directory.writeUInt32LE(EXCEPTION_STREAM_TYPE, nextEntry);
    directory.writeUInt32LE(EXCEPTION_STREAM_BYTES, nextEntry + 4);
    directory.writeUInt32LE(exceptionRva, nextEntry + 8);
    nextEntry += DIRECTORY_ENTRY_BYTES;
  }

  const moduleList = Buffer.alloc(moduleListBytes);
  moduleList.writeUInt32LE(patch.moduleCount ?? modulePaths.length, 0);
  nameRvas.forEach((rva, index) => {
    const at = 4 + index * MODULE_RECORD_BYTES + MODULE_NAME_RVA_OFFSET;
    moduleList.writeUInt32LE(index === 0 ? (patch.nameRva ?? rva) : rva, at);
  });

  const dump = Buffer.concat([
    header,
    directory,
    moduleList,
    ...nameBlocks,
    ...crashpadBlocks,
    ...exceptionBlocks,
  ]);
  return patch.truncateTo === undefined ? dump : dump.subarray(0, patch.truncateTo);
}
