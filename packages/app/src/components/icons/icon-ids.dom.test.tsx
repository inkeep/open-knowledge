import { render } from '@testing-library/react';
import type { ComponentType, SVGProps } from 'react';
import { describe, expect, test } from 'vitest';
import { ClaudeIcon } from './claude';
import { CodexBrandIcon } from './codex';
import { OkIcon } from './ok';
import { OpenClawIcon } from './openclaw';

function idReferences(root: ParentNode): Array<{ element: Element; id: string }> {
  const found: Array<{ element: Element; id: string }> = [];
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      const match = /url\(#([^)]+)\)/.exec(element.getAttribute(attribute) ?? '');
      if (match?.[1]) found.push({ element, id: match[1] });
    }
  }
  return found;
}

describe.each<[string, ComponentType<SVGProps<SVGSVGElement>>]>([
  ['ClaudeIcon', ClaudeIcon],
  ['OpenClawIcon', OpenClawIcon],
  ['CodexBrandIcon', CodexBrandIcon],
  ['OkIcon', OkIcon],
])('%s on a page with two copies', (_name, Icon) => {
  test('every id is unique and every id reference resolves inside its own svg', () => {
    const { container } = render(
      <>
        <Icon />
        <Icon />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { element, id } of idReferences(container)) {
      const owner = element.closest('svg');
      expect(owner?.querySelector(`[id="${id}"]`), `${id} resolves inside its svg`).not.toBeNull();
    }
  });
});

test('ClaudeIcon carries no ids and no id references at all', () => {
  const { container } = render(<ClaudeIcon />);
  expect(container.querySelectorAll('[id]')).toHaveLength(0);
  expect(idReferences(container)).toHaveLength(0);
});
