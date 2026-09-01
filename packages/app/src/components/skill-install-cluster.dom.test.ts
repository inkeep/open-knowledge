import { afterEach, describe, expect, test } from 'vitest';
import { applyInstallClusters } from './skill-install-cluster';

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
    expect(cluster?.getAttribute('title')).toBe(decor.title);
    expect(cluster?.getAttribute('data-ok-cluster-hint')).toBe(decor.title);
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
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(shadow.querySelector('[role="tooltip"]')).toBeNull();
  });
});
