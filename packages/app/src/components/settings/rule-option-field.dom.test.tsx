/**
 * Behavior tests for the generic rule-option widget vocabulary
 * (`RuleOptionField`): each `RuleOptionSpec.type` dispatches to its control
 * and edits emit typed values. Specs come from the real generated catalog so
 * the vocabulary is exercised against what ships — including MD022, whose
 * union-typed `lines_above`/`lines_below` must fall back to the read-only
 * chip while its sibling `include_front_matter` stays editable.
 */

import { MARKDOWNLINT_RULE_CATALOG, type RuleOptionSpec } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RULE_OPTION_WIDGET_OVERRIDES, RuleOptionField } from './rule-option-field';

// Radix primitives reach for pointer-capture and scroll APIs the jsdom
// preload doesn't expose; hoist the same shims the sibling DOM tests use.
const ElementProto = Element.prototype as Element & {
  hasPointerCapture?: () => boolean;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
ElementProto.hasPointerCapture ??= () => false;
ElementProto.releasePointerCapture ??= () => {};
ElementProto.scrollIntoView ??= () => {};
type GlobalWithDomShims = typeof globalThis & { ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

function catalogSpec(ruleId: string, key: string): RuleOptionSpec {
  const rule = MARKDOWNLINT_RULE_CATALOG.find((r) => r.id === ruleId);
  const spec = rule?.options.find((o) => o.key === key);
  if (!spec) throw new Error(`generated catalog is missing ${ruleId}.${key}`);
  return spec;
}

afterEach(() => {
  cleanup();
});

describe('RuleOptionField — boolean', () => {
  test('renders a Switch seeded from the spec default and emits the flipped boolean', async () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD022"
        spec={catalogSpec('MD022', 'include_front_matter')}
        value={undefined}
        onChange={onChange}
      />,
    );
    const control = screen.getByLabelText('include_front_matter');
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('a set value wins over the spec default and toggles back off', async () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD022"
        spec={catalogSpec('MD022', 'include_front_matter')}
        value={true}
        onChange={onChange}
      />,
    );
    const control = screen.getByLabelText('include_front_matter');
    expect(control.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  test('shows the option description and default, associated to the control', () => {
    render(
      <RuleOptionField
        ruleId="MD022"
        spec={catalogSpec('MD022', 'include_front_matter')}
        value={undefined}
        onChange={() => {}}
      />,
    );
    const control = screen.getByLabelText('include_front_matter');
    const describedBy = control.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const description = document.getElementById(describedBy as string);
    expect(description?.textContent).toContain('Include front matter content');
    expect(description?.textContent).toContain('Default:');
    expect(description?.textContent).toContain('false');
  });

  test('disabled renders an inert control', () => {
    render(
      <RuleOptionField
        ruleId="MD022"
        spec={catalogSpec('MD022', 'include_front_matter')}
        value={undefined}
        disabled
        onChange={() => {}}
      />,
    );
    expect((screen.getByLabelText('include_front_matter') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('RuleOptionField — unsupported fallback (MD022)', () => {
  test('lines_above/lines_below render the read-only chip while include_front_matter stays a Switch', () => {
    const md022 = MARKDOWNLINT_RULE_CATALOG.find((r) => r.id === 'MD022');
    if (!md022) throw new Error('generated catalog is missing MD022');
    render(
      <div>
        {md022.options.map((spec) => (
          <RuleOptionField
            key={spec.key}
            ruleId="MD022"
            spec={spec}
            value={undefined}
            onChange={() => {}}
          />
        ))}
      </div>,
    );
    expect(screen.getByLabelText('include_front_matter').getAttribute('role')).toBe('switch');
    for (const key of ['lines_above', 'lines_below']) {
      const chip = screen.getByTestId(`rule-option-MD022-${key}-unsupported`);
      expect(chip.textContent).toBe('Edit in config file');
      // Read-only: the field offers no editing control.
      const field = screen.getByTestId(`rule-option-MD022-${key}`);
      expect(field.querySelector('input, button, select, textarea')).toBeNull();
    }
  });

  test('the chip field still shows the option description and default', () => {
    render(
      <RuleOptionField
        ruleId="MD022"
        spec={catalogSpec('MD022', 'lines_above')}
        value={undefined}
        onChange={() => {}}
      />,
    );
    const field = screen.getByTestId('rule-option-MD022-lines_above');
    expect(field.textContent).toContain('lines_above');
    expect(field.textContent).toContain('Blank lines above heading');
    expect(field.textContent).toContain('Default:');
    expect(field.textContent).toContain('1');
  });
});

describe('RuleOptionField — integer', () => {
  test('shows the spec default when unset and emits the typed number on blur', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD013"
        spec={catalogSpec('MD013', 'line_length')}
        value={undefined}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('line_length') as HTMLInputElement;
    expect(input.value).toBe('80');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(120);
  });

  test('a set value wins over the default and Enter commits', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD013"
        spec={catalogSpec('MD013', 'line_length')}
        value={100}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('line_length') as HTMLInputElement;
    expect(input.value).toBe('100');
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(90);
  });

  test('honors the schema minimum by clamping the committed value', () => {
    // MD013 line_length carries minimum 1 in the vendored schema.
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD013"
        spec={catalogSpec('MD013', 'line_length')}
        value={80}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('line_length') as HTMLInputElement;
    expect(input.min).toBe('1');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(1);
    expect(input.value).toBe('1');
  });

  test('an emptied input reverts to the committed value without emitting', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD013"
        spec={catalogSpec('MD013', 'line_length')}
        value={100}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('line_length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('100');
  });

  test('re-committing the unchanged value does not emit', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD013"
        spec={catalogSpec('MD013', 'line_length')}
        value={100}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('line_length') as HTMLInputElement;
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(0);
  });
});

describe('RuleOptionField — string', () => {
  test('shows the spec default when unset and emits the edited string on blur', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD001"
        spec={catalogSpec('MD001', 'front_matter_title')}
        value={undefined}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('front_matter_title') as HTMLInputElement;
    expect(input.value).toBe('^\\s*title\\s*[:=]');
    fireEvent.change(input, { target: { value: '^title:' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('^title:');
  });

  test('an emptied string commits (a meaningful markdownlint value)', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD001"
        spec={catalogSpec('MD001', 'front_matter_title')}
        value={'^title:'}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('front_matter_title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('RuleOptionField — enum', () => {
  test('renders a Select showing the effective value and emits the chosen literal', async () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD003"
        spec={catalogSpec('MD003', 'style')}
        value={undefined}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByLabelText('style');
    expect(trigger.textContent).toContain('consistent');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'atx' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('atx');
  });

  test('lists every enum literal from the schema', async () => {
    render(
      <RuleOptionField
        ruleId="MD003"
        spec={catalogSpec('MD003', 'style')}
        value={'atx'}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText('style');
    expect(trigger.textContent).toContain('atx');
    await userEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'consistent',
      'atx',
      'atx_closed',
      'setext',
      'setext_with_atx',
      'setext_with_atx_closed',
    ]);
  });
});

describe('RuleOptionField — string-array', () => {
  test('renders existing entries as pills and commits grammar-free values verbatim', () => {
    // MD043 headings hold values like `## Summary` — spaces and a leading
    // `#` must survive (the frontmatter tag grammar would reject/mangle).
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD043"
        spec={catalogSpec('MD043', 'headings')}
        value={['*']}
        onChange={onChange}
      />,
    );
    const field = screen.getByTestId('rule-option-MD043-headings');
    expect(field.textContent).toContain('*');
    expect(field.querySelectorAll('[data-tag-invalid="true"]')).toHaveLength(0);
    const input = screen.getByLabelText('headings') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '## Summary' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['*', '## Summary']);
  });

  test('removing a pill emits the shortened array', () => {
    const onChange = vi.fn(() => {});
    render(
      <RuleOptionField
        ruleId="MD043"
        spec={catalogSpec('MD043', 'headings')}
        value={['*', '## Summary']}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove ## Summary'));
    expect(onChange).toHaveBeenCalledWith(['*']);
  });

  test('unset value starts from the spec default (empty list)', () => {
    render(
      <RuleOptionField
        ruleId="MD043"
        spec={catalogSpec('MD043', 'headings')}
        value={undefined}
        onChange={() => {}}
      />,
    );
    const field = screen.getByTestId('rule-option-MD043-headings');
    expect(field.querySelectorAll('[data-slot="tag-pill-input"] .font-mono')).toHaveLength(0);
  });
});

describe('RuleOptionField — per-rule override escape hatch', () => {
  test('the override map ships empty', () => {
    expect(Object.keys(RULE_OPTION_WIDGET_OVERRIDES)).toHaveLength(0);
  });
});
