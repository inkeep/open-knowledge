import { afterEach, describe, expect, test } from 'vitest';
import { applyInstallClusters } from './skill-install-cluster';

/**
 * The sidebar rows live in a style-isolated shadow root, so their install marks
 * cannot use Radix. They carry the hint on the native `title` attribute (plus a
 * data attribute and `aria-label`) — imperfect while the window is unfocused,
 * but the only hover surface that exists inside the shadow root.
 */
function buildTree(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const row = document.createElement('div');
  row.setAttribute('data-type', 'item');
  row.setAttribute('data-item-path', 'Project/my-skill/');
  shadow.appendChild(row);
  document.body.appendChild(host);
  return { host, shadow };
}

const decor = { kind: 'icons', poolKeys: ['claude', 'codex'], title: 'Installed in Claude, Codex' };

describe('install cluster hints', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('the cluster names its install paths on hover and to assistive tech', () => {
    const { shadow } = buildTree();
    applyInstallClusters(shadow, {
      decorFor: () => decor as never,
      iconPool: null,
      installLabel: 'Install',
      version: 'light',
    });
    const cluster = shadow.querySelector<HTMLElement>('[data-ok-install-cluster]');
    expect(cluster).not.toBeNull();
    // This assertion used to be its opposite — no native title, on the grounds
    // that one is invisible while the window is unfocused and that something
    // else would render the hint. Nothing ever did: the attribute below has no
    // reader and no `content: attr()` rule, and `aria-label` is not a tooltip,
    // so hovering the marks said NOTHING. A tooltip that is missing when the
    // window is unfocused beats one that never exists.
    expect(cluster?.getAttribute('title')).toBe(decor.title);
    expect(cluster?.getAttribute('data-ok-cluster-hint')).toBe(decor.title);
    // Still announced — the marks themselves are aria-hidden brand glyphs.
    expect(cluster?.getAttribute('aria-label')).toBe(decor.title);
  });

  test('a cluster renders no tooltip of its own', () => {
    const { shadow } = buildTree();
    applyInstallClusters(shadow, {
      decorFor: () => decor as never,
      iconPool: null,
      installLabel: 'Install',
      version: 'light',
    });
    shadow
      .querySelector<HTMLElement>('[data-ok-install-cluster]')
      ?.dispatchEvent(new Event('pointerover', { bubbles: true }));
    // The row's own native tooltip is the single explanation for every row in
    // this tree; a second bubble on the marks read as a rendering glitch.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(shadow.querySelector('[role="tooltip"]')).toBeNull();
  });
});
