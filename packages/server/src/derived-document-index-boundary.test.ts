import { describe, expectTypeOf, test } from 'vitest';
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

describe('derived document index ownership boundary', () => {
  test('runtime consumers accept only their coordinator ports', () => {
    expectTypeOf<ApiExtensionOptions['derivedDocumentIndex']>().toEqualTypeOf<
      DerivedDocumentIndexApiPort | undefined
    >();
    expectTypeOf<
      LiveDerivedIndexOptions['derivedDocumentIndex']
    >().toEqualTypeOf<DerivedDocumentIndexLivePort>();
    expectTypeOf<PersistenceOptions['derivedDocumentIndex']>().toEqualTypeOf<
      DerivedDocumentIndexPersistencePort | undefined
    >();
  });

  test('consumer options and ports do not expose raw relationship indexes', () => {
    expectTypeOf<Extract<ConsumerOptionKey, RawIndexMember>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<ConsumerPortKey, RawIndexMember>>().toEqualTypeOf<never>();
  });

  test('server composition owns coordinator construction', () => {
    expectTypeOf<
      Extract<keyof ServerOptions, 'backlinkIndex' | 'tagIndex' | 'derivedDocumentIndex'>
    >().toEqualTypeOf<never>();
  });
});
