import { act, createEvent, fireEvent, screen } from '@testing-library/react';
import { expect } from 'vitest';

const DROP_TEST_PNG_BYTES = [0x89, 0x50, 0x4e, 0x47];
export const DROP_TEST_PNG_BASE64 = btoa(String.fromCharCode(...DROP_TEST_PNG_BYTES));
export const DROP_TEST_FILE_NAME = 'drop-me.png';

export function backfillElementFromPoint() {
  const doc = document as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  if (typeof doc.elementFromPoint !== 'function') doc.elementFromPoint = () => null;
}

export function makeImageFile(name = DROP_TEST_FILE_NAME) {
  return new File([new Uint8Array(DROP_TEST_PNG_BYTES)], name, { type: 'image/png' });
}

export function makeFilesDataTransfer(files: readonly File[]) {
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
  };
}

function dropFilesOn(element: Element, files: readonly File[]) {
  const dataTransfer = makeFilesDataTransfer(files);
  act(() => {
    fireEvent.dragEnter(element, { dataTransfer });
    fireEvent.dragOver(element, { dataTransfer });
    fireEvent.drop(element, { dataTransfer });
  });
}

export function dropImageOn(element: Element, file = makeImageFile()) {
  dropFilesOn(element, [file]);
}

export function expectDragOverIsCancelled(element: Element, file = makeImageFile()) {
  const dataTransfer = makeFilesDataTransfer([file]);
  const event = createEvent.dragOver(element, { dataTransfer });
  act(() => {
    fireEvent(element, event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(dataTransfer.dropEffect).toBe('copy');
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function attachmentChipEvidence(name: string): HTMLElement | null {
  const pattern = new RegExp(escapeForRegExp(name), 'i');
  const isUploadPlaceholder = (element: HTMLElement) =>
    element.closest('[data-testid$="-pending-upload"]') !== null;
  const candidates = [
    ...screen.queryAllByLabelText(pattern),
    ...screen.queryAllByAltText(pattern),
    ...screen.queryAllByText(pattern),
  ].filter((element) => !isUploadPlaceholder(element));
  if (candidates.length > 0) return candidates[0] ?? null;
  return document.querySelector<HTMLElement>(
    `[title*="${name}"]:not([data-testid$="-pending-upload"])`,
  );
}

export function removeAttachmentButton(name: string): HTMLElement | undefined {
  const pattern = new RegExp(escapeForRegExp(name), 'i');
  return screen
    .queryAllByRole('button', { name: /remove|delete|dismiss/i })
    .find((button) => pattern.test(button.getAttribute('aria-label') ?? ''));
}

export function dropRefusalText(): string {
  return Array.from(document.querySelectorAll('[data-testid="composer-drop-refusal"]'))
    .map((el) => el.textContent?.trim() ?? '')
    .join(' ')
    .trim();
}

export function liveRegionTexts(): string[] {
  return Array.from(document.querySelectorAll('[role="status"],[role="alert"],[aria-live]'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

export function collectImageParts(
  value: unknown,
  seen = new Set<object>(),
): Array<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectImageParts(item, seen));
  }
  const record = value as Record<string, unknown>;
  const own = record.kind === 'image' ? [record] : [];
  return [...own, ...Object.values(record).flatMap((nested) => collectImageParts(nested, seen))];
}
