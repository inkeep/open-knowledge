import { expectTypeOf } from 'vitest';
import type { createApiExtension as createTestApiExtension } from './api-extension.test-helper.ts';
import type { ApiExtensionOptions } from './api-extension.ts';
import type {
  DerivedDocumentIndexApiPort,
  DerivedDocumentIndexLivePort,
  DerivedDocumentIndexPersistencePort,
} from './derived-document-index.ts';
import type { DiskEvent, FileIndexEntry } from './file-watcher.ts';
import type { LiveDerivedIndexOptions } from './live-derived-index.ts';
import type { PersistenceOptions } from './persistence.ts';
import type { ServerOptions } from './server-factory.ts';

type RawIndexMember =
  | 'backlinkIndex'
  | 'tagIndex'
  | 'updateDocumentFromMarkdown'
  | 'deleteDocument'
  | 'renameDocument'
  | 'saveToDisk'
  | 'loadFromDisk'
  | 'rebuildFromDisk'
  | 'reconcileWithDisk'
  | 'ingestGlobalSkillBundles'
  | 'init'
  | 'close'
  | 'switchBranch';

type ConsumerOptionKey =
  | keyof ApiExtensionOptions
  | keyof LiveDerivedIndexOptions
  | keyof PersistenceOptions;

type ConsumerPortKey =
  | keyof DerivedDocumentIndexApiPort
  | keyof DerivedDocumentIndexLivePort
  | keyof DerivedDocumentIndexPersistencePort;

expectTypeOf<ApiExtensionOptions['derivedDocumentIndex']>().toEqualTypeOf<
  DerivedDocumentIndexApiPort | undefined
>();
expectTypeOf<
  LiveDerivedIndexOptions['derivedDocumentIndex']
>().toEqualTypeOf<DerivedDocumentIndexLivePort>();
expectTypeOf<PersistenceOptions['derivedDocumentIndex']>().toEqualTypeOf<
  DerivedDocumentIndexPersistencePort | undefined
>();

expectTypeOf<Extract<ConsumerOptionKey, RawIndexMember>>().toEqualTypeOf<never>();
expectTypeOf<Extract<ConsumerPortKey, RawIndexMember>>().toEqualTypeOf<never>();

expectTypeOf<
  Extract<keyof ServerOptions, 'backlinkIndex' | 'tagIndex' | 'derivedDocumentIndex'>
>().toEqualTypeOf<never>();

type AllFilesOptionBase = Omit<ApiExtensionOptions, 'getAllFilesIndex' | 'mutateFileIndex'>;
type GeneralFileEntryIterable = Iterable<readonly [string, FileIndexEntry]>;
type ExplicitIndexWriter = (event: DiskEvent) => void;
type AcceptsApiOptions<T> = T extends ApiExtensionOptions ? true : false;

type IterableWithWriter = AllFilesOptionBase & {
  getAllFilesIndex: () => GeneralFileEntryIterable;
  mutateFileIndex: ExplicitIndexWriter;
};
type IterableWithoutWriter = AllFilesOptionBase & {
  getAllFilesIndex: () => GeneralFileEntryIterable;
};
type LegacyMapGetter = AllFilesOptionBase & {
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>;
};
type WriterWithDefaultGetter = AllFilesOptionBase & {
  mutateFileIndex: ExplicitIndexWriter;
};

expectTypeOf<AcceptsApiOptions<IterableWithWriter>>().toEqualTypeOf<true>();
expectTypeOf<AcceptsApiOptions<IterableWithoutWriter>>().toEqualTypeOf<false>();
expectTypeOf<AcceptsApiOptions<LegacyMapGetter>>().toEqualTypeOf<true>();
expectTypeOf<AcceptsApiOptions<AllFilesOptionBase>>().toEqualTypeOf<true>();
expectTypeOf<AcceptsApiOptions<WriterWithDefaultGetter>>().toEqualTypeOf<true>();

type TestHelperOptions = Parameters<typeof createTestApiExtension>[0];
type TestHelperOptionBase = Omit<TestHelperOptions, 'getAllFilesIndex' | 'mutateFileIndex'>;
type AcceptsTestHelperOptions<T> = T extends TestHelperOptions ? true : false;

expectTypeOf<
  AcceptsTestHelperOptions<
    TestHelperOptionBase & {
      getAllFilesIndex: () => GeneralFileEntryIterable;
      mutateFileIndex: ExplicitIndexWriter;
    }
  >
>().toEqualTypeOf<true>();
expectTypeOf<
  AcceptsTestHelperOptions<
    TestHelperOptionBase & { getAllFilesIndex: () => GeneralFileEntryIterable }
  >
>().toEqualTypeOf<false>();
expectTypeOf<
  AcceptsTestHelperOptions<
    TestHelperOptionBase & { getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry> }
  >
>().toEqualTypeOf<true>();
expectTypeOf<AcceptsTestHelperOptions<TestHelperOptionBase>>().toEqualTypeOf<true>();
expectTypeOf<
  AcceptsTestHelperOptions<TestHelperOptionBase & { mutateFileIndex: ExplicitIndexWriter }>
>().toEqualTypeOf<true>();
