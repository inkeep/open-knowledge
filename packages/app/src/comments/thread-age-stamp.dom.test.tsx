/**
 * The card's age stamp, at each rollover boundary.
 *
 * Every one of these was reachable before: the stamp ran hours up forever, so a
 * week-old comment read "174h". The boundaries are the whole point — a unit that
 * never hands over produces a number nobody converts in their head.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function renderAged(ageMs: number) {
  const thread: CommentThread = {
    id: 't1',
    docName: 'recipes/radishes',
    target: { kind: 'body' },
    anchor: { quote: '2 bunches radishes', prefix: '', suffix: '', start: 0, end: 18 },
    status: 'open',
    body: 'sfcs',
    createdAt: NOW - ageMs,
    queued: true,
  };
  return render(
    <ThreadCard thread={thread} now={NOW} cardRef={() => {}} focused={false} sending={false} />,
  );
}

afterEach(cleanup);

describe('the age stamp', () => {
  test('counts seconds, then minutes, then hours', () => {
    renderAged(5 * SECOND);
    expect(screen.getByText('5s')).toBeTruthy();
    cleanup();

    renderAged(5 * MINUTE);
    expect(screen.getByText('5m')).toBeTruthy();
    cleanup();

    renderAged(5 * HOUR);
    expect(screen.getByText('5h')).toBeTruthy();
  });

  test('hands over to days at 24 hours', () => {
    // The regression case: this used to render "174h".
    renderAged(174 * HOUR);
    expect(screen.queryByText('174h')).toBeNull();
    cleanup();

    renderAged(2 * DAY);
    expect(screen.getByText('2d')).toBeTruthy();
  });

  test('does not round up into a unit it should have rolled over to', () => {
    // 23.6 hours is not a day, and 6.7 days is not a week — `round` promoted
    // both, producing "24h" and "7d", ages neither branch is meant to print.
    renderAged(23.6 * HOUR);
    expect(screen.getByText('23h')).toBeTruthy();
    cleanup();

    renderAged(6.7 * DAY);
    expect(screen.getByText('6d')).toBeTruthy();
  });

  test('past a week it becomes a date', () => {
    // Days stop meaning anything at that distance, so the stamp says WHEN
    // instead of how long — the same handover the Timeline panel makes.
    renderAged(30 * DAY);
    expect(screen.queryByText('30d')).toBeNull();
    expect(screen.getByText(new Date(NOW - 30 * DAY).toLocaleDateString())).toBeTruthy();
  });
});
