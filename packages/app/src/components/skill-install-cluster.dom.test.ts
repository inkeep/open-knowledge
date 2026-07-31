import { afterEach, describe, expect, test } from 'vitest';
import { applyInstallClusters } from './skill-install-cluster';

/**
 * The sidebar rows live in a style-isolated shadow root, so their install marks
 * cannot use Radix and must not use the native `title` attribute (which does not
 * render while the window is unfocused). These cover the replacement.
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

  test('the cluster carries its hint as data, never as a native title', () => {
    const { shadow } = buildTree();
    applyInstallClusters(shadow, {
      decorFor: () => decor as never,
      iconPool: null,
      installLabel: 'Install',
      version: 'light',
    });
    const cluster = shadow.querySelector<HTMLElement>('[data-ok-install-cluster]');
    expect(cluster).not.toBeNull();
    // A native title would be the regression: invisible on an unfocused window.
    expect(cluster?.getAttribute('title')).toBeNull();
    expect(cluster?.getAttribute('data-ok-cluster-hint')).toBe(decor.title);
    // Still announced — the hint is the only place the marks are named.
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
