import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { RegisteredAgentIcon } from './RegisteredAgentIcon';

describe('RegisteredAgentIcon', () => {
  afterEach(cleanup);

  test('uses the local colorized Claude icon instead of the registry image', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="claude-acp"
        iconUrl="https://example.com/claude.svg"
        className="size-4"
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-[#D97757]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  test('uses the local Codex brand gradient instead of the registry image', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="codex-acp"
        iconUrl="https://example.com/codex.svg"
        className="size-4"
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('linearGradient')).toBeTruthy();
    expect(
      [...container.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color')),
    ).toEqual(['#B1A7FF', '#7A9DFF', '#3941FF']);
  });

  test('uses the local adaptive Cursor brand icon instead of the registry image', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="cursor"
        iconUrl="https://example.com/cursor.svg"
        className="size-4"
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-[#1B1912]');
    expect(icon?.getAttribute('class')).toContain('dark:text-white');
  });

  test('keeps the registry image for agents without a local treatment', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="gemini"
        iconUrl="https://example.com/gemini.svg"
        className="size-4"
      />,
    );

    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/gemini.svg',
    );
  });

  test('inverts the registry image on dark themes so black marks stay visible', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="gemini"
        iconUrl="https://example.com/gemini.svg"
        className="size-4"
      />,
    );

    expect(container.querySelector('img')?.getAttribute('class')).toContain('dark:invert');
  });

  test('falls back to the neutral glyph when the registry image fails to load', () => {
    const { container } = render(
      <RegisteredAgentIcon
        agentId="gemini"
        iconUrl="https://example.com/gone.svg"
        className="size-4"
      />,
    );

    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
