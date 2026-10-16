import { bindConfigDoc } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import type { SavedThemeListEntry } from '@inkeep/open-knowledge-core/schemas/api';
import { deriveSavedThemeName } from '@inkeep/open-knowledge-core/theme/theme-plugins';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import * as Y from 'yjs';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DocumentProvider } from '@/editor/DocumentContext';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { SavedThemesProvider } from '@/lib/saved-themes-client';
import { stubApiRoutes } from './api-routes.test-helper';
import { renderWithI18n } from './render-with-i18n.test-helper';

type SavedThemeRow = Extract<SavedThemeListEntry, { ok: true }>;

const PALETTE = {
  base00: '#0f1419',
  base01: '#131721',
  base02: '#272d38',
  base03: '#3e4b59',
  base04: '#bfbdb6',
  base05: '#e6e1cf',
  base06: '#e6e1cf',
  base07: '#f3f4f5',
  base08: '#f07178',
  base09: '#ff8f40',
  base0A: '#ffb454',
  base0B: '#b8cc52',
  base0C: '#95e6cb',
  base0D: '#59c2ff',
  base0E: '#d2a6ff',
  base0F: '#e6b673',
};
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const OPEN_TIMEOUT_MS = 5_000;
const SETTLED_FRAMES = 10;
const MAX_SETTLE_FRAMES = 600;
const RE_ENTRY_OBSERVED_FRAMES = 30;

let savedThemes: SavedThemeRow[] = [];
let stylesheet: HTMLStyleElement;
let initialViewport = { width: 0, height: 0 };
let headBaseline = new Set<Element>();
let rootAttributeBaseline: [string, string][] = [];

function savedThemeRow(name: string): SavedThemeRow {
  const derived = deriveSavedThemeName(name);
  if (!derived.ok) throw new Error(`${name} cannot name a saved theme`);
  return {
    ok: true,
    id: derived.id,
    filename: `${derived.stem}.yaml`,
    scheme: { name: derived.name, variant: 'dark', palette: PALETTE },
  };
}

function serveSavedThemes(names: string[]): void {
  savedThemes = names.map(savedThemeRow);
  stubApiRoutes({
    '/api/config': () => new Response(null, { status: 404 }),
    '/api/principal': () => new Response(null, { status: 404 }),
    '/api/skill/install-state': () => new Response(null, { status: 404 }),
    '/api/saved-themes': () => Response.json({ themes: savedThemes, truncated: false }),
    '/api/saved-theme': (_url, init) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body)) as {
        name: string;
        scheme: SavedThemeRow['scheme'];
      };
      const row = { ...savedThemeRow(request.name), scheme: request.scheme };
      savedThemes = [...savedThemes, row];
      return Response.json({ id: row.id, filename: row.filename }, { status: 201 });
    },
  });
}

function renderSettings(): void {
  const userBinding = bindConfigDoc(
    { document: new Y.Doc(), on: (_event, synced) => synced(), off: () => {} },
    'user',
  );
  const config: ConfigContextValue = {
    userBinding,
    userSynced: true,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: null,
    projectSynced: false,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: null,
  };
  renderWithI18n(
    <TooltipProvider>
      <SavedThemesProvider>
        <ConfigContext value={config}>
          <DocumentProvider>
            <SettingsDialogShell open initialSection="plugin:theme" onOpenChange={() => {}} />
          </DocumentProvider>
        </ConfigContext>
      </SavedThemesProvider>
    </TooltipProvider>,
  );
}

function settingsContent(): HTMLElement {
  return screen.getByRole('region', { name: 'Settings content' });
}

function findPencil(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: `Edit ${name}` }, { timeout: OPEN_TIMEOUT_MS });
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function scrollSettled(container: HTMLElement): Promise<void> {
  let previous = container.scrollTop;
  let stillFrames = 0;
  for (let frame = 0; frame < MAX_SETTLE_FRAMES; frame += 1) {
    await nextFrame();
    stillFrames = container.scrollTop === previous ? stillFrames + 1 : 0;
    previous = container.scrollTop;
    if (stillFrames >= SETTLED_FRAMES) return;
  }
  throw new Error(`the settings content was still scrolling after ${MAX_SETTLE_FRAMES} frames`);
}

function recordScrollTop(container: HTMLElement): () => number[] {
  const samples = [container.scrollTop];
  let handle = requestAnimationFrame(function sample() {
    samples.push(container.scrollTop);
    handle = requestAnimationFrame(sample);
  });
  const stop = () => {
    cancelAnimationFrame(handle);
    return samples;
  };
  onTestFinished(() => {
    stop();
  });
  return stop;
}

function intermediatePositions(path: number[]): number[] {
  const start = path[0];
  const end = path[path.length - 1];
  return [...new Set(path.filter((position) => position !== start && position !== end))];
}

function measureEditor(name: string) {
  const container = settingsContent();
  const editor = screen.getByRole('region', { name: `Editing ${name}` });
  const heading = within(editor).getByRole('heading', { name: `Editing ${name}` });
  const viewTop = container.getBoundingClientRect().top + container.clientTop;
  const viewBottom = viewTop + container.clientHeight;
  const headingBox = heading.getBoundingClientRect();
  const editorBox = editor.getBoundingClientRect();
  return {
    viewTop,
    viewBottom,
    headingTop: headingBox.top,
    headingBottom: headingBox.bottom,
    editorHeight: editorBox.height,
    editorVisible: Math.max(
      0,
      Math.min(editorBox.bottom, viewBottom) - Math.max(editorBox.top, viewTop),
    ),
    clientHeight: container.clientHeight,
    scrollTop: container.scrollTop,
  };
}

function revealShortfalls(name: string): string[] {
  const measured = measureEditor(name);
  const detail = JSON.stringify(measured);
  const shortfalls: string[] = [];
  if (measured.headingTop < measured.viewTop - 1) {
    shortfalls.push(
      `the "Editing ${name}" heading starts above the settings content's visible area: ${detail}`,
    );
  }
  if (measured.headingBottom > measured.viewBottom + 1) {
    shortfalls.push(
      `the "Editing ${name}" heading ends below the settings content's visible area: ${detail}`,
    );
  }
  if (measured.editorVisible < Math.min(measured.editorHeight, measured.clientHeight) / 2) {
    shortfalls.push(
      `the ${name} editor fills less than half of the settings content's visible area: ${detail}`,
    );
  }
  return shortfalls;
}

function expectEditorRevealed(name: string): void {
  expect(revealShortfalls(name)).toEqual([]);
}

function expectEditorHiddenAt(name: string, scrollTop: number): void {
  settingsContent().scrollTo({ top: scrollTop, behavior: 'instant' });
  expect(
    revealShortfalls(name),
    `the ${name} editor must open unrevealed at scrollTop ${scrollTop}, or the reveal is not what showed it`,
  ).not.toEqual([]);
}

async function expectEditorRevealedOnceSettled(name: string): Promise<void> {
  await waitFor(() => expectEditorRevealed(name), { timeout: OPEN_TIMEOUT_MS });
  await scrollSettled(settingsContent());
  expectEditorRevealed(name);
}

function describeFocus(element: Element | null): string {
  if (element === null) return 'nothing';
  if (element === document.body) return '<body>';
  const label = element.getAttribute('aria-label') ?? element.getAttribute('data-testid') ?? '';
  return `<${element.tagName.toLowerCase()}${label ? ` ${label}` : ''}>`;
}

function expectFocusOnCreateTile(): void {
  const createTile = screen.getByRole('button', { name: 'Create new theme' });
  const focused = document.activeElement;
  expect(
    focused === createTile,
    `focus is on ${describeFocus(focused)}, not the "Create new theme" tile`,
  ).toBe(true);
}

function expectFocusInsideEditor(name: string): void {
  const editor = screen.getByRole('region', { name: `Editing ${name}` });
  const focused = document.activeElement;
  expect(
    editor.contains(focused),
    `focus is on ${describeFocus(focused)}, outside the "Editing ${name}" editor`,
  ).toBe(true);
}

async function expectFocusSettledInsideEditor(name: string): Promise<void> {
  await waitFor(() => expectFocusInsideEditor(name), { timeout: OPEN_TIMEOUT_MS });
  await scrollSettled(settingsContent());
  expectFocusInsideEditor(name);
}

type FocusLanding = { target: Element; label: string; underAriaHidden: boolean };

function focusLabel(element: Element): string {
  if (element instanceof HTMLInputElement) {
    const fieldLabel = element.labels?.[0]?.textContent?.trim();
    if (fieldLabel) return fieldLabel;
  }
  return describeFocus(element);
}

function recordFocusLandings(): FocusLanding[] {
  const landings: FocusLanding[] = [];
  const record = (event: FocusEvent) => {
    if (!(event.target instanceof Element)) return;
    landings.push({
      target: event.target,
      label: focusLabel(event.target),
      underAriaHidden: event.target.closest('[aria-hidden="true"]') !== null,
    });
  };
  document.addEventListener('focusin', record, true);
  onTestFinished(() => {
    document.removeEventListener('focusin', record, true);
  });
  return landings;
}

function describeLandings(landings: FocusLanding[]): string {
  return landings
    .map((landing) => `${landing.label}${landing.underAriaHidden ? ' (aria-hidden)' : ''}`)
    .join(' → ');
}

async function emulateReducedMotion(): Promise<void> {
  onTestFinished(async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  });
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
}

async function createAndEdit(name: string, submit: 'pointer' | 'keyboard'): Promise<number> {
  const container = settingsContent();
  await userEvent.click(await screen.findByRole('button', { name: 'Create new theme' }));
  const dialog = await screen.findByRole('dialog', { name: 'Name your theme' });
  await userEvent.fill(within(dialog).getByLabelText('Theme name'), name);
  const scrollTopAtSubmit = container.scrollTop;
  if (submit === 'pointer') {
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create & edit' }));
  } else {
    await userEvent.keyboard('{Enter}');
  }
  await waitFor(
    () => expect(screen.queryByRole('dialog', { name: 'Name your theme' })).toBeNull(),
    { timeout: OPEN_TIMEOUT_MS },
  );
  await screen.findByRole('heading', { name: `Editing ${name}` }, { timeout: OPEN_TIMEOUT_MS });
  return scrollTopAtSubmit;
}

beforeAll(async () => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = await commands.buildAppStylesheet();
  document.head.append(stylesheet);
  initialViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
});

afterAll(async () => {
  stylesheet.remove();
  await page.viewport(initialViewport.width, initialViewport.height);
});

beforeEach(() => {
  headBaseline = new Set(document.head.children);
  rootAttributeBaseline = [...document.documentElement.attributes].map((attribute) => [
    attribute.name,
    attribute.value,
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const element of Array.from(document.head.children)) {
    if (!headBaseline.has(element)) element.remove();
  }
  const root = document.documentElement;
  for (const attribute of Array.from(root.attributes)) root.removeAttribute(attribute.name);
  for (const [name, value] of rootAttributeBaseline) root.setAttribute(name, value);
  localStorage.clear();
});

describe('Opening the saved-theme editor in Settings', () => {
  test.each(['pointer', 'keyboard'] as const)(
    "pressing a saved theme's pencil by %s reveals its editor in the settings content",
    async (input) => {
      serveSavedThemes(['Ocean']);
      renderSettings();
      const pencil = await findPencil('Ocean');
      pencil.scrollIntoView({ block: 'nearest' });
      const scrollTopAtOpen = settingsContent().scrollTop;

      if (input === 'pointer') {
        await userEvent.click(pencil);
      } else {
        pencil.focus();
        await userEvent.keyboard('{Enter}');
      }

      await expectEditorRevealedOnceSettled('Ocean');
      expectEditorHiddenAt('Ocean', scrollTopAtOpen);
    },
  );

  test("Create & edit reveals the new theme's editor in the settings content", async () => {
    serveSavedThemes(['Ocean']);
    renderSettings();
    await findPencil('Ocean');

    const scrollTopAtSubmit = await createAndEdit('Lagoon', 'pointer');

    await expectEditorRevealedOnceSettled('Lagoon');
    expectEditorHiddenAt('Lagoon', scrollTopAtSubmit);
  });

  test("pressing another saved theme's pencil while the editor is open reveals the re-targeted editor", async () => {
    serveSavedThemes(['Ocean', 'Reef']);
    renderSettings();
    await userEvent.click(await findPencil('Ocean'));
    await screen.findByRole('heading', { name: 'Editing Ocean' });
    const reefPencil = screen.getByRole('button', { name: 'Edit Reef' });
    reefPencil.scrollIntoView({ block: 'end' });
    const beforeSwitch = measureEditor('Ocean');
    expect(
      beforeSwitch.headingTop,
      `the open editor must start out of view: ${JSON.stringify(beforeSwitch)}`,
    ).toBeGreaterThanOrEqual(beforeSwitch.viewBottom);

    await userEvent.click(reefPencil);

    await expectEditorRevealedOnceSettled('Reef');
  });

  test('with reduced motion, the pencil reveals the editor without animating the scroll', async () => {
    serveSavedThemes(['Ocean']);
    renderSettings();
    const pencil = await findPencil('Ocean');
    await emulateReducedMotion();
    const container = settingsContent();
    pencil.scrollIntoView({ block: 'nearest' });
    const scrollTopAtOpen = container.scrollTop;
    const stopRevealPath = recordScrollTop(container);

    await userEvent.click(pencil);

    await expectEditorRevealedOnceSettled('Ocean');
    const revealPath = stopRevealPath();
    const stopSmoothControl = recordScrollTop(container);
    container.scrollTo({ top: scrollTopAtOpen, behavior: 'smooth' });
    await scrollSettled(container);
    const smoothPath = stopSmoothControl();
    expect(
      intermediatePositions(smoothPath).length,
      `a smooth scroll back over the reveal's distance under reduced motion must be observable here: ${smoothPath.join(',')}`,
    ).toBeGreaterThan(1);
    expect(
      intermediatePositions(revealPath).length,
      `the reveal animated through ${revealPath.join(',')}`,
    ).toBeLessThanOrEqual(1);
  });

  test('re-entering Themes with the editor open leaves the section at its top', async () => {
    serveSavedThemes(['Ocean']);
    renderSettings();
    await userEvent.click(await findPencil('Ocean'));
    await screen.findByRole('heading', { name: 'Editing Ocean' });
    await userEvent.click(screen.getByTestId('settings-sidebar-item-preferences'));
    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'Editing Ocean' })).toBeNull(),
      { timeout: OPEN_TIMEOUT_MS },
    );
    const container = settingsContent();
    container.scrollTop = 0;
    await scrollSettled(container);
    const stopReEntryPath = recordScrollTop(container);

    await userEvent.click(screen.getByTestId('settings-sidebar-item-plugin:theme'));
    const heading = await screen.findByRole(
      'heading',
      { name: 'Editing Ocean' },
      { timeout: OPEN_TIMEOUT_MS },
    );
    for (let frame = 0; frame < RE_ENTRY_OBSERVED_FRAMES; frame += 1) await nextFrame();

    const reEntryPath = stopReEntryPath();
    expect(container.contains(heading)).toBe(true);
    expect(container.scrollHeight).toBeGreaterThan(container.clientHeight);
    const afterReEntry = measureEditor('Ocean');
    expect(
      afterReEntry.headingTop,
      `the editor must still sit below the fold: ${JSON.stringify(afterReEntry)}`,
    ).toBeGreaterThanOrEqual(afterReEntry.viewBottom);
    expect(new Set(reEntryPath), `scrollTop moved through ${reEntryPath.join(',')}`).toEqual(
      new Set([0]),
    );
  });

  test.each(['pointer', 'keyboard'] as const)(
    "pressing a saved theme's pencil by %s moves focus into its editor",
    async (input) => {
      serveSavedThemes(['Ocean']);
      renderSettings();
      const pencil = await findPencil('Ocean');

      if (input === 'pointer') {
        await userEvent.click(pencil);
      } else {
        pencil.focus();
        await userEvent.keyboard('{Enter}');
      }

      await screen.findByRole('heading', { name: 'Editing Ocean' }, { timeout: OPEN_TIMEOUT_MS });
      await expectFocusSettledInsideEditor('Ocean');
    },
  );

  test("pressing another saved theme's pencil while the editor is open moves focus into the re-targeted editor", async () => {
    serveSavedThemes(['Ocean', 'Reef']);
    renderSettings();
    await userEvent.click(await findPencil('Ocean'));
    await screen.findByRole('heading', { name: 'Editing Ocean' }, { timeout: OPEN_TIMEOUT_MS });
    await scrollSettled(settingsContent());

    await userEvent.click(screen.getByRole('button', { name: 'Edit Reef' }));

    await screen.findByRole('heading', { name: 'Editing Reef' }, { timeout: OPEN_TIMEOUT_MS });
    await expectFocusSettledInsideEditor('Reef');
  });

  test.each(['pointer', 'keyboard'] as const)(
    "Create & edit submitted by %s moves focus into the new theme's editor",
    async (submit) => {
      serveSavedThemes(['Ocean']);
      renderSettings();
      await findPencil('Ocean');

      await createAndEdit('Lagoon', submit);

      await expectFocusSettledInsideEditor('Lagoon');
    },
  );

  test.each(['pointer', 'keyboard'] as const)(
    "Create & edit submitted by %s while another theme's editor is open first focuses the new theme's editor once the name dialog stops hiding it",
    async (submit) => {
      serveSavedThemes(['Ocean']);
      renderSettings();
      await userEvent.click(await findPencil('Ocean'));
      await screen.findByRole('heading', { name: 'Editing Ocean' }, { timeout: OPEN_TIMEOUT_MS });
      await scrollSettled(settingsContent());
      const landings = recordFocusLandings();

      await createAndEdit('Lagoon', submit);

      expect(
        landings.some((landing) => landing.label === 'Theme name'),
        `the focus recorder must have heard the name field take focus: ${describeLandings(landings)}`,
      ).toBe(true);
      const firstEditorLanding = await waitFor(
        () => {
          const editor = screen.getByRole('region', { name: 'Editing Lagoon' });
          const landing = landings.find((candidate) => editor.contains(candidate.target));
          assert(
            landing,
            `focus never landed inside the "Editing Lagoon" editor; it moved through ${describeLandings(landings)}`,
          );
          return landing;
        },
        { timeout: OPEN_TIMEOUT_MS },
      );
      expect(
        firstEditorLanding.underAriaHidden,
        `focus first landed in the "Editing Lagoon" editor while it was under aria-hidden: ${describeLandings(landings)}`,
      ).toBe(false);
    },
  );

  test.each(['Escape', 'Cancel'] as const)(
    'dismissing the name dialog with %s returns focus to the Create new theme tile',
    async (dismiss) => {
      serveSavedThemes(['Ocean']);
      renderSettings();
      await findPencil('Ocean');
      await userEvent.click(await screen.findByRole('button', { name: 'Create new theme' }));
      const dialog = await screen.findByRole('dialog', { name: 'Name your theme' });

      if (dismiss === 'Escape') {
        await userEvent.keyboard('{Escape}');
      } else {
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      }

      await waitFor(
        () => expect(screen.queryByRole('dialog', { name: 'Name your theme' })).toBeNull(),
        { timeout: OPEN_TIMEOUT_MS },
      );
      await waitFor(expectFocusOnCreateTile, { timeout: OPEN_TIMEOUT_MS });
      await scrollSettled(settingsContent());
      expectFocusOnCreateTile();
    },
  );
});
