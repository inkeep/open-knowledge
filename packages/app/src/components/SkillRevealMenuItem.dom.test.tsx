/**
 * `SkillRevealMenuItem` is the single reveal row behind every skills menu
 * surface (skill row, SKILL.md, bundle files, bundle folders), so its two gates
 * and its label are load-bearing for all of them at once: dropping the
 * `!bridge` guard throws on non-desktop hosts, dropping the `!absolutePath`
 * guard renders a row whose click reveals `undefined`, and hardcoding the macOS
 * label mislabels the shipping Windows and Linux desktops.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const showItemInFolder = vi.fn();

function setBridge(platform: 'darwin' | 'win32' | 'linux' | null) {
  if (platform === null) {
    Reflect.deleteProperty(window, 'okDesktop');
    return;
  }
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: { platform, shell: { showItemInFolder } },
  });
}

async function renderItem(absolutePath: string | undefined) {
  const { SkillRevealMenuItem } = await import('./skill-actions');
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger />
      <DropdownMenuContent>
        <SkillRevealMenuItem absolutePath={absolutePath} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe('SkillRevealMenuItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBridge('darwin');
  });

  afterEach(() => {
    setBridge(null);
  });

  test('reveals the given path when clicked', async () => {
    await renderItem('/Users/tester/.claude/skills/demo/SKILL.md');

    await userEvent.click(screen.getByText('Reveal in Finder'));

    expect(showItemInFolder).toHaveBeenCalledWith('/Users/tester/.claude/skills/demo/SKILL.md');
  });

  test('renders nothing when the path is unknown', async () => {
    await renderItem(undefined);

    expect(screen.queryByText('Reveal in Finder')).toBeNull();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  test('renders nothing off desktop, where there is no bridge to reveal through', async () => {
    setBridge(null);
    await renderItem('/Users/tester/.claude/skills/demo/SKILL.md');

    expect(screen.queryByText('Reveal in Finder')).toBeNull();
  });

  test('names the platform file manager rather than always saying Finder', async () => {
    setBridge('win32');
    await renderItem('C:\\Users\\tester\\.claude\\skills\\demo\\SKILL.md');
    expect(screen.getByText('Reveal in File Explorer')).toBeTruthy();
    expect(screen.queryByText('Reveal in Finder')).toBeNull();
  });

  test('uses the neutral Linux verb — no stable file-manager brand to reveal in', async () => {
    setBridge('linux');
    await renderItem('/home/tester/.claude/skills/demo/SKILL.md');
    expect(screen.getByText('Open containing folder')).toBeTruthy();
  });
});
