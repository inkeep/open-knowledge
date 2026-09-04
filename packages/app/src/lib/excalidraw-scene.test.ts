import { describe, expect, test, vi } from 'vitest';
import { restoreScene, serializeScene } from './excalidraw-scene.ts';

type StubModule = Parameters<typeof restoreScene>[0];

function stubModule() {
  const restoreElements = vi.fn((elements: unknown) => (elements as unknown[] | undefined) ?? []);
  const restoreAppState = vi.fn(() => ({ viewBackgroundColor: '#fff' }));
  const serializeAsJSON = vi.fn(
    (elements: unknown, appState: unknown, files: unknown, type: unknown) =>
      JSON.stringify({ elements, appState, files, type }),
  );
  const getNonDeletedElements = vi.fn((elements: readonly { isDeleted?: boolean }[]) =>
    elements.filter((element) => !element.isDeleted),
  );
  const mod = {
    restoreElements,
    restoreAppState,
    serializeAsJSON,
    getNonDeletedElements,
  } as unknown as StubModule;
  return { mod, restoreElements, restoreAppState, serializeAsJSON, getNonDeletedElements };
}

describe('restoreScene', () => {
  test('routes each part of the scene through its own upstream restorer', () => {
    const { mod, restoreElements, restoreAppState } = stubModule();
    const files = { 'file-1': { id: 'file-1' } };

    const scene = restoreScene(mod, {
      elements: [{ id: 'a' }],
      appState: { viewBackgroundColor: '#eee' },
      files,
    });

    expect(restoreElements).toHaveBeenCalledWith([{ id: 'a' }], null);
    expect(restoreAppState).toHaveBeenCalledWith({ viewBackgroundColor: '#eee' }, null);
    expect(scene.elements).toEqual([{ id: 'a' }]);
    expect(scene.appState).toEqual({ viewBackgroundColor: '#fff' });
    expect(scene.files).toBe(files);
  });

  test('yields a blank scene for null, and defaults files to an empty map', () => {
    const { mod, restoreElements, restoreAppState } = stubModule();

    const scene = restoreScene(mod, null);

    expect(restoreElements).toHaveBeenCalledWith(undefined, null);
    expect(restoreAppState).toHaveBeenCalledWith(undefined, null);
    expect(scene.files).toEqual({});
  });

  test('repairs a partial board rather than throwing', () => {
    const { mod } = stubModule();

    expect(restoreScene(mod, { elements: [{ id: 'a' }] }).files).toEqual({});
    expect(restoreScene(mod, 'not a board').elements).toEqual([]);
  });
});

describe('serializeScene', () => {
  test('drops soft-deleted elements before they reach the file', () => {
    const { mod, serializeAsJSON } = stubModule();
    const live = { id: 'live' };

    const written = serializeScene(
      mod,
      [live, { id: 'erased', isDeleted: true }] as never,
      {} as never,
      {} as never,
    );

    expect(serializeAsJSON.mock.calls[0]?.[0]).toEqual([live]);
    expect(JSON.parse(written).elements).toEqual([live]);
  });

  test("keeps every element the user can still see, and writes the file-tagged 'local' shape", () => {
    const { mod, serializeAsJSON } = stubModule();
    const elements = [{ id: 'a' }, { id: 'b', isDeleted: false }];

    const written = serializeScene(
      mod,
      elements as never,
      { name: 'board' } as never,
      {
        'file-1': {},
      } as never,
    );

    expect(JSON.parse(written).elements).toEqual(elements);
    expect(serializeAsJSON.mock.calls[0]?.[0]).toEqual(elements);
    expect(serializeAsJSON.mock.calls[0]?.[1]).toEqual({ name: 'board' });
    expect(serializeAsJSON.mock.calls[0]?.[2]).toEqual({ 'file-1': {} });
    expect(serializeAsJSON.mock.calls[0]?.[3]).toBe('local');
  });
});
