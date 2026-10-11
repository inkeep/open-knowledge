import { FileTree } from '@pierre/trees';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { commands } from 'vitest/browser';
import { createFileTreeStyle, FILE_TREE_DENSITY_OPTIONS } from '@/components/file-tree-density';

let css: string;
let frame: HTMLIFrameElement | undefined;
let tree: FileTree | undefined;

beforeAll(async () => {
  css = await commands.buildAppStylesheet();
});

afterEach(() => {
  tree?.cleanUp();
  tree = undefined;
  frame?.remove();
  frame = undefined;
});

async function renderColor(mode: 'light' | 'dark', theme: string, consumer: string) {
  frame = document.createElement('iframe');
  frame.width = '640';
  frame.height = '400';
  document.body.append(frame);
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) throw new Error('Missing isolated stylesheet document');
  doc.documentElement.classList.toggle('dark', mode === 'dark');
  doc.documentElement.style.colorScheme = mode;
  if (theme !== 'default') doc.documentElement.dataset.colorTheme = theme;
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.append(style);
  const parent = doc.createElement('div');
  parent.className = 'text-muted-foreground';
  doc.body.append(parent);

  if (consumer === 'sidebar utility') {
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'text-tree-muted');
    parent.append(icon);
    return view.getComputedStyle(icon).color;
  }

  const mount = doc.createElement('div');
  mount.style.height = '320px';
  parent.append(mount);
  tree = new FileTree({
    ...FILE_TREE_DENSITY_OPTIONS,
    paths: ['folder/note.md'],
    initialExpansion: 'open',
  });
  tree.render({ containerWrapper: mount });
  const host = tree.getFileTreeContainer();
  if (!host) throw new Error('The real tree did not mount');
  for (const [property, value] of Object.entries(createFileTreeStyle(mode))) {
    host.style.setProperty(property, String(value));
  }
  const chevron = await vi.waitFor(() => {
    const icon = host.shadowRoot?.querySelector('[role="treeitem"] [data-item-section="icon"] svg');
    expect(icon).toBeTruthy();
    if (!icon) throw new Error('The real tree did not render its disclosure icon');
    return icon;
  });
  return view.getComputedStyle(chevron).color;
}

describe('built tree muted colors', () => {
  for (const consumer of ['sidebar utility', 'tree disclosure']) {
    test(`${consumer} uses the intended default light color`, async () => {
      expect(await renderColor('light', 'default', consumer)).toBe('oklch(0.709 0.01 56.259)');
    });

    test(`${consumer} uses the intended default dark color`, async () => {
      expect(await renderColor('dark', 'default', consumer)).toBe('oklch(0.553 0.013 58.071)');
    });

    test(`${consumer} retains the named light theme color`, async () => {
      expect(await renderColor('light', 'catppuccin-latte', consumer)).toBe(
        'oklch(0.709 0.01 56.259)',
      );
    });

    test(`${consumer} retains the named dark theme color`, async () => {
      expect(await renderColor('dark', 'dracula', consumer)).toBe('oklch(0.553 0.013 58.071)');
    });
  }
});
