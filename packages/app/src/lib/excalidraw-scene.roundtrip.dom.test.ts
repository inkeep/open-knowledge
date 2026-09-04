import * as excalidraw from '@excalidraw/excalidraw';
import { describe, expect, test } from 'vitest';
import { restoreScene, serializeScene } from './excalidraw-scene.ts';

type Element = ExcalidrawSceneElement;
type ExcalidrawSceneElement = ReturnType<typeof excalidraw.restoreElements>[number];

function board(elements: unknown[]) {
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} };
}

function freedraw(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'freedraw',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    points: [
      [0, 0],
      [10, 10],
    ],
    pressures: [],
    simulatePressure: true,
    ...extra,
  };
}

function arrowElement(extra: Record<string, unknown> = {}) {
  return {
    id: 'arrow',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    points: [
      [0, 0],
      [10, 10],
    ],
    ...extra,
  };
}

function serialize(elements: readonly Element[], appState: Parameters<typeof serializeScene>[2]) {
  return serializeScene(excalidraw, elements, appState, {});
}

describe('a board round-trips through the real package', () => {
  test('writes a document the format recognises', () => {
    const scene = restoreScene(excalidraw, board([freedraw('a')]));

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.type).toBe('excalidraw');
    expect(doc.elements.map((element: { id: string }) => element.id)).toEqual(['a']);
  });

  test('erased strokes do not reach the file', () => {
    const scene = restoreScene(
      excalidraw,
      board([freedraw('live'), freedraw('erased', { isDeleted: true })]),
    );

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.elements.map((element: { id: string }) => element.id)).toEqual(['live']);
  });

  test('is a fixpoint: restoring our own output and re-serializing is byte-stable', () => {
    const first = serialize(
      restoreScene(excalidraw, board([freedraw('a')])).elements,
      restoreScene(excalidraw, board([freedraw('a')])).appState,
    );

    const reloaded = restoreScene(excalidraw, JSON.parse(first));
    const second = serialize(reloaded.elements, reloaded.appState);

    expect(second).toBe(first);
  });

  test('a board holding an arrow is a fixpoint too', () => {
    const arrow = arrowElement();
    const first = serialize(
      restoreScene(excalidraw, board([arrow])).elements,
      restoreScene(excalidraw, board([arrow])).appState,
    );

    const reloaded = restoreScene(excalidraw, JSON.parse(first));

    expect(serialize(reloaded.elements, reloaded.appState)).toBe(first);
  });

  test('a blank board restores to an empty element list', () => {
    const scene = restoreScene(excalidraw, null);

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.elements).toEqual([]);
  });

  test('this build never invents lastCommittedPoint on a linear element', () => {
    const scene = restoreScene(excalidraw, board([arrowElement()]));

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.elements).toHaveLength(1);
    expect(Object.hasOwn(doc.elements[0], 'lastCommittedPoint')).toBe(false);
  });

  test('a legacy lastCommittedPoint is still null after a round trip', () => {
    const legacy = board([arrowElement({ lastCommittedPoint: null })]);

    const first = serialize(
      restoreScene(excalidraw, legacy).elements,
      restoreScene(excalidraw, legacy).appState,
    );
    const reloaded = restoreScene(excalidraw, JSON.parse(first));

    expect(serialize(reloaded.elements, reloaded.appState)).toBe(first);
    expect(JSON.parse(first).elements[0].lastCommittedPoint).toBeNull();
  });

  test('freedraw keeps the legacy pressure encoding beside the new stroke options', () => {
    const scene = restoreScene(
      excalidraw,
      board([
        freedraw('a', {
          simulatePressure: false,
          pressures: [0.5, 0.7],
          strokeOptions: { variability: 'constant', streamline: 0.3 },
        }),
      ]),
    );

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.elements[0]).toMatchObject({
      simulatePressure: false,
      pressures: [0.5, 0.7],
      strokeOptions: { variability: 'constant', streamline: 0.3 },
    });
  });

  test("a freedraw with no strokeOptions restores the defaults, 'variable' and 0.5", () => {
    const scene = restoreScene(excalidraw, board([freedraw('a')]));

    const doc = JSON.parse(serialize(scene.elements, scene.appState));

    expect(doc.elements[0].strokeOptions.variability).toBe('variable');
    expect(doc.elements[0].strokeOptions.streamline).toBe(0.5);
  });

  test('files pass through to the written document', () => {
    const files = {
      'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
    };
    const image = {
      id: 'img',
      type: 'image',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fileId: 'file-1',
    };
    const scene = restoreScene(excalidraw, { ...board([image]), files });

    const doc = JSON.parse(serializeScene(excalidraw, scene.elements, scene.appState, scene.files));

    expect(doc.files).toEqual(files);
  });
});
