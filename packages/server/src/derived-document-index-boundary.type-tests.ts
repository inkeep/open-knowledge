import { expectTypeOf } from 'vitest';
import type { ApiExtensionOptions } from './api-extension.ts';
import type {
  DerivedDocumentIndexApiPort,
  DerivedDocumentIndexLivePort,
  DerivedDocumentIndexPersistencePort,
} from './derived-document-index.ts';
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
