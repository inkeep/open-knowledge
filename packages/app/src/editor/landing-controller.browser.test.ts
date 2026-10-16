import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { type LandingHandle, type LandingOutcome, startLanding } from './landing-controller';
import { getDocScrollState, isScrollRestoreSuppressed } from './scroll-restore-coordination';

const disposers: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.useRealTimers();
  await userEvent.cleanup();
});

function fixture(startInMicrotask = false) {
  const docName = `native-landing-${crypto.randomUUID()}`;
  const container = document.createElement('div');
  const content = document.createElement('div');
  container.style.cssText = 'height: 300px; overflow: auto;';
  content.style.cssText = 'height: 2000px;';
  content.contentEditable = 'true';
  content.textContent = 'Landing target';
  container.append(content);
  document.body.append(container);
  disposers.push(() => container.remove());
  content.focus();
  expect(document.activeElement).toBe(content);
  const outcomes: LandingOutcome[] = [];
  const events: Array<Record<string, unknown>> = [];
  let handle: LandingHandle | undefined;
  disposers.push(() => handle?.cancel('superseded'));
  const record = (phase: string, event: KeyboardEvent) => {
    events.push({
      phase,
      key: event.key,
      code: event.code,
      trusted: event.isTrusted,
      eventPhase: event.eventPhase,
      prevented: event.defaultPrevented,
    });
  };
  const stopAtDescendant = (event: KeyboardEvent) => {
    record('descendant', event);
    event.stopPropagation();
  };
  content.addEventListener('keydown', stopAtDescendant);
  const start = () => {
    handle = startLanding({
      docName,
      container,
      contentColumn: content,
      measureTarget: () => ({ top: 56, height: 40 }),
      placement: 'top',
      intent: 'toggle',
      grade: 'exact',
      landedMode: 'source',
      onOutcome: (outcome) => {
        outcomes.push(outcome);
        events.push({ phase: 'outcome', ...outcome });
      },
    });
    events.push({ phase: 'started', suppressed: isScrollRestoreSuppressed(docName) });
  };
  const fromWindow = (event: KeyboardEvent) => {
    if (!matchesKeyboardShortcut(event, 'toggle-editor-mode')) return;
    record('window', event);
    event.preventDefault();
    if (startInMicrotask) queueMicrotask(start);
    else start();
    queueMicrotask(() => record('window-microtask', event));
  };
  const startFromWindow = () => {
    window.addEventListener('keydown', fromWindow, true);
    disposers.push(() => window.removeEventListener('keydown', fromWindow, true));
  };
  return { docName, container, content, outcomes, events, start, startFromWindow };
}

test.each([false, true])(
  'native initiating toggle chord keeps its landing (microtask start: %s)',
  async (startInMicrotask) => {
    const f = fixture(startInMicrotask);
    f.startFromWindow();
    await userEvent.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    expect(f.events.filter((event) => event.phase === 'window')).toEqual([
      expect.objectContaining({ code: 'KeyM', trusted: true }),
    ]);
    expect(f.events).toContainEqual(
      expect.objectContaining({ phase: 'started', suppressed: true }),
    );
    expect(f.events).toContainEqual(
      expect.objectContaining({ phase: 'descendant', code: 'KeyM', trusted: true }),
    );
    expect(f.outcomes).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(f.outcomes).toEqual([{ status: 'landed', delta: 0 }]);
    expect(getDocScrollState(f.docName)?.mode).toBe('source');
  },
);

test.each(['End', 'e'])(
  'later native %s keeps its viewport despite descendant stopPropagation',
  async (key) => {
    const f = fixture();
    f.start();
    expect(isScrollRestoreSuppressed(f.docName)).toBe(true);
    await userEvent.keyboard(key === 'End' ? '{End}' : key);
    expect(f.events).toContainEqual(
      expect.objectContaining({ phase: 'descendant', key, trusted: true }),
    );
    expect(f.outcomes).toEqual([{ status: 'cancelled', reason: 'user-scroll' }]);
    expect(isScrollRestoreSuppressed(f.docName)).toBe(false);
    f.container.scrollTop = 1000;
    f.container.dispatchEvent(new Event('contentvisibilityautostatechange'));
    vi.runAllTimers();
    expect(f.container.scrollTop).toBe(1000);
    expect(getDocScrollState(f.docName)).toBeUndefined();
  },
);
