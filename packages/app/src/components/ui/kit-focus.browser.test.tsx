import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, onTestFinished, test } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { Attachment, AttachmentContent, AttachmentTitle, AttachmentTrigger } from './attachment';
import { Button } from './button';
import { Checkbox } from './checkbox';
import {
  Combobox,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from './combobox';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Input } from './input';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from './menubar';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSubButton,
} from './sidebar';
import { Switch } from './switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { TagPillInput } from './tag-pill-input';
import { Textarea } from './textarea';
import { Toggle } from './toggle';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

function canvasContext() {
  const context = new OffscreenCanvas(1, 1).getContext('2d');
  if (context === null) throw new Error('The browser did not supply a canvas context');
  return context;
}

function effectiveBackground(element: Element): string {
  const ancestors: Element[] = [];
  let current: Element | null = element;
  while (current !== null) {
    ancestors.unshift(current);
    current = current.parentElement;
  }
  const context = canvasContext();
  context.fillStyle = 'white';
  context.fillRect(0, 0, 1, 1);
  for (const ancestor of ancestors) {
    context.fillStyle = getComputedStyle(ancestor).backgroundColor;
    context.fillRect(0, 0, 1, 1);
  }
  return [...context.getImageData(0, 0, 1, 1).data].join(',');
}

function paintedColor(color: string, element: Element): string {
  const context = canvasContext();
  const [red, green, blue] = effectiveBackground(element).split(',');
  context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].join(',');
}

function visibleOutline(element: Element): string | null {
  const style = getComputedStyle(element);
  const color = paintedColor(style.outlineColor, element);
  if (
    style.outlineStyle === 'none' ||
    style.outlineStyle === 'hidden' ||
    Number.parseFloat(style.outlineWidth) === 0 ||
    color === effectiveBackground(element)
  ) {
    return null;
  }
  return [style.outlineStyle, style.outlineWidth, style.outlineOffset, color].join(' ');
}

function readPaint(target: HTMLElement, surface: HTMLElement) {
  const elements: Element[] = [];
  let current: Element | null = target;
  while (current !== null && current !== surface) {
    elements.push(current);
    current = current.parentElement;
  }
  expect(current, 'The observed target belongs to the captured surface').toBe(surface);
  return elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      outline: visibleOutline(element),
      borders: ['top', 'right', 'bottom', 'left'].map((side) => {
        const width = style.getPropertyValue(`border-${side}-width`);
        const borderStyle = style.getPropertyValue(`border-${side}-style`);
        if (Number.parseFloat(width) === 0 || borderStyle === 'none') return null;
        return [
          width,
          borderStyle,
          paintedColor(style.getPropertyValue(`border-${side}-color`), element),
        ];
      }),
      background: effectiveBackground(element),
      foreground: paintedColor(style.color, element),
      shadow: style.boxShadow,
      decoration: style.textDecorationLine,
    };
  });
}

async function capture(surface: HTMLElement) {
  const frame = window.frameElement;
  if (frame === null) throw new Error('The browser test iframe was not found');
  const frameRect = frame.getBoundingClientRect();
  const rect = surface.getBoundingClientRect();
  const x = Math.floor(frameRect.x + window.parent.scrollX + rect.x);
  const y = Math.floor(frameRect.y + window.parent.scrollY + rect.y);
  const activeElement = document.activeElement;
  const viewport = [innerWidth, innerHeight, scrollX, scrollY];
  const { data: base64 } = await cdp().send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x,
      y,
      width: Math.ceil(frameRect.x + window.parent.scrollX + rect.right) - x,
      height: Math.ceil(frameRect.y + window.parent.scrollY + rect.bottom) - y,
      scale: 1,
    },
  });
  expect(document.activeElement, 'Capture preserves the current focus owner').toBe(activeElement);
  expect([innerWidth, innerHeight, scrollX, scrollY]).toEqual(viewport);
  expect(surface.getBoundingClientRect().toJSON()).toEqual(rect.toJSON());
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The screenshot could not be decoded');
  context.drawImage(image, 0, 0);
  image.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function media(forcedColors: 'active' | 'none') {
  onTestFinished(async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  });
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'forced-colors', value: forcedColors },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  });
  expect(matchMedia('(forced-colors: active)').matches).toBe(forcedColors === 'active');
}

function mount(children: ReactNode) {
  renderWithI18n(
    <div>
      <Button>Before controls</Button>
      <div data-testid="focus-surface" style={{ padding: 16, width: 320 }}>
        {children}
      </div>
      <Button>After controls</Button>
    </div>,
  );
  return screen.getByTestId('focus-surface');
}

async function settle() {
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  await document.fonts.ready;
}

type Subject = {
  target: HTMLElement;
  surface: HTMLElement;
  focus: () => Promise<void>;
  leave: () => Promise<void>;
  highlightOwner?: HTMLElement;
};

type Scenario = {
  name: string;
  prepare: () => Promise<Subject>;
};

async function prepare(children: ReactNode, target: () => HTMLElement, tabs = 1): Promise<Subject> {
  const surface = mount(children);
  await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
  return {
    target: target(),
    surface,
    focus: async () => {
      for (let index = 0; index < tabs; index++) await userEvent.tab();
    },
    leave: async () => {
      await userEvent.click(screen.getByRole('button', { name: 'After controls' }));
    },
  };
}

function mountPortal(children: ReactNode) {
  renderWithI18n(
    <div>
      <Button>Before controls</Button>
      {children}
      <Button>After controls</Button>
    </div>,
  );
  return document.body;
}

function portalSubject(target: () => HTMLElement, steps: number): Subject {
  return {
    target: target(),
    surface: document.body,
    focus: async () => {
      for (let index = 0; index < steps; index++) await userEvent.keyboard('{ArrowDown}');
    },
    leave: async () => {
      for (let index = 0; index < steps; index++) await userEvent.keyboard('{ArrowUp}');
    },
  };
}

function menubarOwner(name: string, target: () => HTMLElement, steps: number): Scenario {
  return {
    name,
    prepare: async () => {
      const surface = mountPortal(
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>Menu</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Sentinel</MenubarItem>
              <MenubarItem>Item owner</MenubarItem>
              <MenubarCheckboxItem checked>Checkbox owner</MenubarCheckboxItem>
              <MenubarRadioGroup value="one">
                <MenubarRadioItem value="one">Radio owner</MenubarRadioItem>
              </MenubarRadioGroup>
              <MenubarSub>
                <MenubarSubTrigger>Sub owner</MenubarSubTrigger>
                <MenubarSubContent>
                  <MenubarItem>Nested owner</MenubarItem>
                </MenubarSubContent>
              </MenubarSub>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.tab();
      await userEvent.keyboard('{ArrowDown}');
      await expect.element(screen.getByRole('menuitem', { name: 'Sentinel' })).toHaveFocus();
      return { ...portalSubject(target, steps), surface };
    },
  };
}

function dropdownOwner(name: string, target: () => HTMLElement, steps: number): Scenario {
  return {
    name,
    prepare: async () => {
      const surface = mountPortal(
        <DropdownMenu>
          <DropdownMenuTrigger>Dropdown</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Sentinel</DropdownMenuItem>
            <DropdownMenuItem>Item owner</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked>Checkbox owner</DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup value="one">
              <DropdownMenuRadioItem value="one">Radio owner</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Sub owner</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Nested owner</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.click(screen.getByRole('button', { name: 'Dropdown' }));
      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard('{Home}');
      await expect.element(screen.getByRole('menuitem', { name: 'Sentinel' })).toHaveFocus();
      return { ...portalSubject(target, steps), surface };
    },
  };
}

function contextMenuOwner(name: string, target: () => HTMLElement, steps: number): Scenario {
  return {
    name,
    prepare: async () => {
      const surface = mountPortal(
        <ContextMenu>
          <ContextMenuTrigger>Context area</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Sentinel</ContextMenuItem>
            <ContextMenuItem>Item owner</ContextMenuItem>
            <ContextMenuCheckboxItem checked>Checkbox owner</ContextMenuCheckboxItem>
            <ContextMenuRadioGroup value="one">
              <ContextMenuRadioItem value="one">Radio owner</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Sub owner</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>Nested owner</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.click(screen.getByText('Context area'), { button: 'right' });
      await userEvent.keyboard('{Home}');
      await expect.element(screen.getByRole('menuitem', { name: 'Sentinel' })).toHaveFocus();
      return { ...portalSubject(target, steps), surface };
    },
  };
}

function ComboboxOwner() {
  const anchor = useComboboxAnchor();
  return (
    <Combobox multiple items={['Sentinel', 'Option owner']} defaultValue={[]}>
      <ComboboxChips ref={anchor}>
        <ComboboxChipsInput aria-label="Combobox owner" />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

const expandedScenarios: Scenario[] = [
  {
    name: 'MenubarTrigger',
    prepare: async () => {
      const surface = mount(
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>Menu</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Menu item</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      return {
        target: screen.getByRole('menuitem', { name: 'Menu' }),
        surface,
        focus: () => userEvent.tab(),
        leave: () => userEvent.click(screen.getByRole('button', { name: 'After controls' })),
      };
    },
  },
  menubarOwner('MenubarItem', () => screen.getByRole('menuitem', { name: 'Item owner' }), 1),
  menubarOwner(
    'MenubarCheckboxItem',
    () => screen.getByRole('menuitemcheckbox', { name: 'Checkbox owner' }),
    2,
  ),
  menubarOwner(
    'MenubarRadioItem',
    () => screen.getByRole('menuitemradio', { name: 'Radio owner' }),
    3,
  ),
  {
    name: 'SidebarGroupLabel asChild',
    prepare: () =>
      prepare(
        <SidebarGroupLabel asChild>
          <a href="#sidebar-label">Sidebar label</a>
        </SidebarGroupLabel>,
        () => screen.getByRole('link', { name: 'Sidebar label' }),
      ),
  },
  {
    name: 'SidebarGroupAction',
    prepare: () =>
      prepare(
        <SidebarGroup>
          <SidebarGroupAction aria-label="Sidebar group action">G</SidebarGroupAction>
        </SidebarGroup>,
        () => screen.getByRole('button', { name: 'Sidebar group action' }),
      ),
  },
  {
    name: 'SidebarMenuButton',
    prepare: () =>
      prepare(<SidebarMenuButton>Sidebar menu</SidebarMenuButton>, () =>
        screen.getByRole('button', { name: 'Sidebar menu' }),
      ),
  },
  {
    name: 'SidebarMenuButton asChild',
    prepare: () =>
      prepare(
        <SidebarMenuButton asChild>
          <a href="#sidebar-menu">Sidebar menu link</a>
        </SidebarMenuButton>,
        () => screen.getByRole('link', { name: 'Sidebar menu link' }),
      ),
  },
  {
    name: 'SidebarMenuAction',
    prepare: () =>
      prepare(
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>Sidebar menu row</SidebarMenuButton>
            <SidebarMenuAction aria-label="Sidebar menu action">M</SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>,
        () => screen.getByRole('button', { name: 'Sidebar menu action' }),
        2,
      ),
  },
  {
    name: 'SidebarMenuSubButton',
    prepare: () =>
      prepare(<SidebarMenuSubButton href="#sidebar-sub">Sidebar sub</SidebarMenuSubButton>, () =>
        screen.getByRole('link', { name: 'Sidebar sub' }),
      ),
  },
  dropdownOwner('DropdownMenuItem', () => screen.getByRole('menuitem', { name: 'Item owner' }), 1),
  dropdownOwner(
    'DropdownMenuCheckboxItem',
    () => screen.getByRole('menuitemcheckbox', { name: 'Checkbox owner' }),
    2,
  ),
  dropdownOwner(
    'DropdownMenuRadioItem',
    () => screen.getByRole('menuitemradio', { name: 'Radio owner' }),
    3,
  ),
  dropdownOwner(
    'DropdownMenuSubTrigger',
    () => screen.getByRole('menuitem', { name: 'Sub owner' }),
    4,
  ),
  contextMenuOwner(
    'ContextMenuItem',
    () => screen.getByRole('menuitem', { name: 'Item owner' }),
    1,
  ),
  contextMenuOwner(
    'ContextMenuCheckboxItem',
    () => screen.getByRole('menuitemcheckbox', { name: 'Checkbox owner' }),
    2,
  ),
  contextMenuOwner(
    'ContextMenuRadioItem',
    () => screen.getByRole('menuitemradio', { name: 'Radio owner' }),
    3,
  ),
  contextMenuOwner(
    'ContextMenuSubTrigger',
    () => screen.getByRole('menuitem', { name: 'Sub owner' }),
    4,
  ),
  {
    name: 'SelectItem',
    prepare: async () => {
      mount(
        <Select defaultValue="sentinel">
          <SelectTrigger aria-label="Select owner">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sentinel">Sentinel</SelectItem>
            <SelectItem value="target">Select owner</SelectItem>
          </SelectContent>
        </Select>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
      await expect.element(screen.getByRole('option', { name: 'Sentinel' })).toHaveFocus();
      return {
        target: screen.getByRole('option', { name: 'Select owner' }),
        surface: screen.getByRole('listbox'),
        focus: () => userEvent.keyboard('{ArrowDown}'),
        leave: () => userEvent.keyboard('{ArrowUp}'),
      };
    },
  },
  {
    name: 'Input',
    prepare: () =>
      prepare(<Input aria-label="Input owner" />, () =>
        screen.getByRole('textbox', { name: 'Input owner' }),
      ),
  },
  {
    name: 'Textarea',
    prepare: () =>
      prepare(<Textarea aria-label="Textarea owner" />, () =>
        screen.getByRole('textbox', { name: 'Textarea owner' }),
      ),
  },
  {
    name: 'Checkbox',
    prepare: () =>
      prepare(<Checkbox aria-label="Checkbox field owner" />, () =>
        screen.getByRole('checkbox', { name: 'Checkbox field owner' }),
      ),
  },
  {
    name: 'RadioGroupItem',
    prepare: () =>
      prepare(
        <RadioGroup defaultValue="one">
          <RadioGroupItem value="one" aria-label="Radio field owner" />
        </RadioGroup>,
        () => screen.getByRole('radio', { name: 'Radio field owner' }),
      ),
  },
  {
    name: 'Switch',
    prepare: () =>
      prepare(<Switch aria-label="Switch owner" />, () =>
        screen.getByRole('switch', { name: 'Switch owner' }),
      ),
  },
  {
    name: 'SelectTrigger',
    prepare: () =>
      prepare(
        <Select defaultValue="alpha">
          <SelectTrigger aria-label="Select trigger owner">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectContent>
        </Select>,
        () => screen.getByRole('combobox', { name: 'Select trigger owner' }),
      ),
  },
  {
    name: 'ComboboxItem',
    prepare: async () => {
      mountPortal(<ComboboxOwner />);
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.tab();
      const input = screen.getByRole('combobox', { name: 'Combobox owner' });
      await expect.element(input).toHaveFocus();
      await userEvent.keyboard('{ArrowDown}');
      const sentinel = await screen.findByRole('option', { name: 'Sentinel' });
      await expect.element(sentinel).toHaveAttribute('data-highlighted');
      return {
        target: screen.getByRole('option', { name: 'Option owner' }),
        surface: screen.getByRole('listbox'),
        focus: () => userEvent.keyboard('{ArrowDown}'),
        leave: () => userEvent.keyboard('{ArrowUp}'),
        highlightOwner: input,
      };
    },
  },
];

const scenarios: Scenario[] = [
  {
    name: 'Toggle',
    prepare: () =>
      prepare(<Toggle>Toggle</Toggle>, () =>
        screen.getByRole('button', { name: 'Toggle', exact: true }),
      ),
  },
  {
    name: 'ToggleGroupItem',
    prepare: () =>
      prepare(
        <ToggleGroup type="multiple">
          <ToggleGroupItem value="one" aria-label="Group toggle">
            One
          </ToggleGroupItem>
        </ToggleGroup>,
        () => screen.getByRole('button', { name: 'Group toggle' }),
      ),
  },
  ...['alpha', 'beta'].map((tag, index) => ({
    name: `TagPillInput remove ${tag}`,
    prepare: () =>
      prepare(
        <TagPillInput value={['alpha', 'beta']} onChange={() => {}} />,
        () => screen.getByRole('button', { name: `Remove ${tag}` }),
        index + 1,
      ),
  })),
  {
    name: 'AttachmentTrigger',
    prepare: () =>
      prepare(
        <Attachment>
          <AttachmentTrigger aria-label="Open attachment" />
          <AttachmentContent>
            <AttachmentTitle>sample.txt</AttachmentTitle>
          </AttachmentContent>
        </Attachment>,
        () => screen.getByRole('button', { name: 'Open attachment' }),
      ),
  },
  {
    name: 'TabsContent',
    prepare: () =>
      prepare(
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">Tab one</TabsTrigger>
          </TabsList>
          <TabsContent value="one">Panel text</TabsContent>
        </Tabs>,
        () => screen.getByRole('tabpanel', { name: 'Tab one' }),
        2,
      ),
  },
  {
    name: 'MenubarSubTrigger',
    prepare: async () => {
      renderWithI18n(
        <>
          <Button>Before controls</Button>
          <Menubar>
            <MenubarMenu>
              <MenubarTrigger>Menu</MenubarTrigger>
              <MenubarContent>
                <MenubarItem>First item</MenubarItem>
                <div data-testid="focus-surface" style={{ padding: 16 }}>
                  <MenubarSub>
                    <MenubarSubTrigger>Submenu</MenubarSubTrigger>
                    <MenubarSubContent>
                      <MenubarItem>Nested item</MenubarItem>
                    </MenubarSubContent>
                  </MenubarSub>
                </div>
                <MenubarItem>Last item</MenubarItem>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
        </>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Before controls' }));
      await userEvent.tab();
      await userEvent.keyboard('{ArrowDown}');
      const first = await screen.findByRole('menuitem', { name: 'First item' });
      await expect.element(first).toHaveFocus();
      return {
        target: screen.getByRole('menuitem', { name: 'Submenu' }),
        surface: screen.getByTestId('focus-surface'),
        focus: () => userEvent.keyboard('{ArrowDown}'),
        leave: () => userEvent.keyboard('{ArrowUp}'),
      };
    },
  },
];

function isActive(subject: Subject) {
  if (subject.highlightOwner === undefined) return subject.target.matches(':focus');
  return subject.target.hasAttribute('data-highlighted');
}

async function expectActive(subject: Subject) {
  if (subject.highlightOwner === undefined) {
    await expect.element(subject.target).toHaveFocus();
    return;
  }
  await expect.element(subject.target).toHaveAttribute('data-highlighted');
  await expect.element(subject.highlightOwner).toHaveFocus();
}

async function expectInactive(subject: Subject) {
  if (subject.highlightOwner === undefined) {
    await expect.element(subject.target).not.toHaveFocus();
    return;
  }
  await expect.element(subject.target).not.toHaveAttribute('data-highlighted');
  await expect.element(subject.highlightOwner).toHaveFocus();
}

async function observeKeyboardFocus(subject: Subject) {
  const { target, surface } = subject;
  await settle();
  const before = readPaint(target, surface);
  const beforePixels = await capture(surface);
  await subject.focus();
  await expectActive(subject);
  expect((subject.highlightOwner ?? target).matches(':focus-visible')).toBe(true);
  await settle();
  const focused = readPaint(target, surface);
  const focusedPixels = await capture(surface);
  expect([focusedPixels.width, focusedPixels.height]).toEqual([
    beforePixels.width,
    beforePixels.height,
  ]);
  expect(
    focused,
    'Keyboard focus changes a visible paint feature of the target or its wrapper',
  ).not.toEqual(before);
  expect(
    focusedPixels.data.some((value, index) => value !== beforePixels.data[index]),
    'The focus cue is painted in the captured surface',
  ).toBe(true);
}

async function observePermanentOutline(subject: Subject) {
  await settle();
  const before = readPaint(subject.target, subject.surface);
  expect(isActive(subject)).toBe(false);
  expect(
    before.every((paint) => paint.outline === null),
    'Unfocused control has no permanent outline',
  ).toBe(true);
  const beforePixels = await capture(subject.surface);
  await subject.focus();
  await expectActive(subject);
  await subject.leave();
  await expectInactive(subject);
  await settle();
  expect(readPaint(subject.target, subject.surface)).toEqual(before);
  const afterPixels = await capture(subject.surface);
  expect([afterPixels.width, afterPixels.height]).toEqual([
    beforePixels.width,
    beforePixels.height,
  ]);
  expect(
    afterPixels.data.every((value, index) => value === beforePixels.data[index]),
    'Unfocused rendering is restored after keyboard focus leaves',
  ).toBe(true);
}

describe('kit keyboard focus', () => {
  for (const scenario of [...scenarios, ...expandedScenarios]) {
    test(`${scenario.name} has a visible cue in forced colors`, async () => {
      await media('active');
      await observeKeyboardFocus(await scenario.prepare());
    });

    for (const mode of ['none', 'active'] as const) {
      test(`${scenario.name} has no permanent outline with forced colors ${mode}`, async () => {
        await media(mode);
        await observePermanentOutline(await scenario.prepare());
      });
    }
  }

  test('a border cue remains observable in forced colors', async () => {
    await media('active');
    await observeKeyboardFocus(
      await prepare(<Button>Border control</Button>, () =>
        screen.getByRole('button', { name: 'Border control' }),
      ),
    );
  });

  test('a sidebar outline color cue remains observable in forced colors', async () => {
    await media('active');
    await observeKeyboardFocus(
      await prepare(<SidebarMenuButton>Sidebar control</SidebarMenuButton>, () =>
        screen.getByRole('button', { name: 'Sidebar control' }),
      ),
    );
  });

  test('the outline reader observes an existing unfocused outline', async () => {
    await media('active');
    renderWithI18n(
      <div data-testid="outline-reader" style={{ outline: '2px solid black' }}>
        Outline control
      </div>,
    );
    const target = screen.getByTestId('outline-reader');
    expect(target.matches(':focus')).toBe(false);
    expect(visibleOutline(target)).not.toBeNull();
  });
});
