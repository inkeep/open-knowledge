
import type { Heading } from 'mdast';
import { toString as headingText } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import { defineScopedOkfRule } from '../okf-runner.ts';

const LOG_SCOPE = '**/log';

const ISO_DATE_PREFIX = /^\s*(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/;

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const DATE_INTENT = /^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/;

function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
}

export const logShape = defineScopedOkfRule('log-shape', LOG_SCOPE, (tree, file) => {
  let previousDate: string | undefined;

  visit(tree, 'heading', (node: Heading) => {
    if (node.depth !== 2) return;
    const text = headingText(node);

    const iso = ISO_DATE_PREFIX.exec(text);
    if (!iso) {
      file.message(
        DATE_INTENT.test(text)
          ? `Log date heading "${quote(text)}" is not in ISO 8601 YYYY-MM-DD form, the one form an Open Knowledge Format log requires of its date headings.`
          : `Log entry heading "${quote(text)}" is not a date, so it falls outside the dated-entry format an Open Knowledge Format consumer reads a log as — nothing under it reaches the change-history timeline.`,
        node,
      );
      return;
    }

    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (!isRealCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
      file.message(
        `Log date heading "${date}" is not a real calendar date, so it is not ISO 8601 — the one form an Open Knowledge Format log requires of its date headings.`,
        node,
      );
      return;
    }

    if (previousDate !== undefined && date > previousDate) {
      file.message(
        `Log date heading "${date}" is newer than the entry above it — an Open Knowledge Format log is a flat list of date-grouped entries, newest first.`,
        node,
      );
    }
    previousDate = date;
  });
});
