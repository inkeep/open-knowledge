import { afterEach, describe, expect, test } from 'vitest';
import { createInteractionLayer, type InteractionLayerHandle } from './interaction-layer';

const layers: InteractionLayerHandle[] = [];

function createFocusFixture() {
  const editor = document.createElement('div');
  editor.tabIndex = 0;

  const chip = document.createElement('button');
  chip.dataset.markId = 'link-1';
  editor.append(chip);

  const unrelated = document.createElement('button');
  document.body.append(editor, unrelated);

  const layer = createInteractionLayer({ editor: { editorView: { dom: editor } } });
  layers.push(layer);
  layer.register({ nodeId: 'link-1', type: 'internalLink', controls: {} });

  return { chip, editor, layer, unrelated };
}

function appendPropPanelWithFocusableChild(): HTMLButtonElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-ok-prop-panel', 'internal-link');
  const panelButton = document.createElement('button');
  panel.append(panelButton);
  document.body.append(panel);
  return panelButton;
}

function appendLayerSpawnedWithFocusableChild(): HTMLButtonElement {
  const spawned = document.createElement('div');
  spawned.setAttribute('data-ok-layer-spawned', '');
  const spawnedButton = document.createElement('button');
  spawned.append(spawnedButton);
  document.body.append(spawned);
  return spawnedButton;
}

function appendInteractionLayerWithFocusableChild(): HTMLButtonElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-ok-interaction-layer', '');
  const wrapperButton = document.createElement('button');
  wrapper.append(wrapperButton);
  document.body.append(wrapper);
  return wrapperButton;
}

afterEach(() => {
  for (const layer of layers.splice(0)) layer.destroy();
  document.body.replaceChildren();
});

describe('createInteractionLayer focus ownership', () => {
  test('deactivation restores a connected chip that owned focus at activation', () => {
    const { chip, layer, unrelated } = createFocusFixture();

    chip.focus();
    expect(document.activeElement).toBe(chip);
    layer.setActiveNode('link-1');

    unrelated.focus();
    expect(document.activeElement).toBe(unrelated);
    layer.setActiveNode(null);

    expect(document.activeElement).toBe(chip);
  });

  test('deactivation without a chip owner preserves unrelated focus', () => {
    const { layer, unrelated } = createFocusFixture();

    unrelated.focus();
    expect(document.activeElement).toBe(unrelated);
    layer.setActiveNode('link-1');
    layer.setActiveNode(null);

    expect(document.activeElement).toBe(unrelated);
  });

  test('deactivation returns focus to the editor when the closing panel owned it', () => {
    const { editor, layer } = createFocusFixture();

    layer.setActiveNode('link-1');
    const panelButton = appendPropPanelWithFocusableChild();
    panelButton.focus();
    expect(document.activeElement).toBe(panelButton);

    layer.setActiveNode(null);

    expect(document.activeElement).toBe(editor);
  });

  test('deactivation returns focus to the editor when a layer-spawned element owned it', () => {
    const { editor, layer } = createFocusFixture();
    const spawnedButton = appendLayerSpawnedWithFocusableChild();

    layer.setActiveNode('link-1');
    spawnedButton.focus();
    expect(document.activeElement).toBe(spawnedButton);

    layer.setActiveNode(null);

    expect(document.activeElement).toBe(editor);
  });

  test('deactivation returns focus to the editor when a layer toolbar control owned it', () => {
    const { editor, layer } = createFocusFixture();
    const toolbarButton = appendInteractionLayerWithFocusableChild();

    layer.setActiveNode('link-1');
    toolbarButton.focus();
    expect(document.activeElement).toBe(toolbarButton);

    layer.setActiveNode(null);

    expect(document.activeElement).toBe(editor);
  });

  test('deactivation falls back to the editor when the captured chip left the document', () => {
    const { chip, editor, layer } = createFocusFixture();

    chip.focus();
    layer.setActiveNode('link-1');
    chip.remove();

    layer.setActiveNode(null);

    expect(document.activeElement).toBe(editor);
  });
});
