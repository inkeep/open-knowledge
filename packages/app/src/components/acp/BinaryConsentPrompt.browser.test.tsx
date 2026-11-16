import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { getAgentThreadClient } from '@/lib/acp/thread-client';
import { buildThreadRenderModel } from '@/lib/acp/thread-event-model';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { BinaryConsentPrompt } from './BinaryConsentPrompt';

class Socket {
  static readonly OPEN = 1;
  static last: Socket;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage = null;
  onclose: (() => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() {
    Socket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const request = {
  kind: 'binary_consent_request',
  requestId: 'approval',
  agentName: 'Cursor',
  version: '1.0.0',
  archive: 'https://downloads.example.com/agent.tar.gz',
  ts: 1,
} as const;

function item(decision: 'granted' | 'declined' | 'timeout' | null = null) {
  const model = buildThreadRenderModel(
    decision === null
      ? [request]
      : [
          request,
          {
            kind: 'binary_consent_resolved',
            requestId: request.requestId,
            decision,
            ts: 2,
          },
        ],
    null,
  );
  const rendered = model.items[0];
  if (rendered?.kind !== 'binary_consent') throw new Error('missing approval prompt');
  return rendered;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  getAgentThreadClient().setUrl('ws://localhost:5173/collab/thread');
  Socket.last.onopen?.();
});

afterEach(() => {
  getAgentThreadClient().setUrl(null);
  vi.unstubAllGlobals();
});

describe('unverified binary approval', () => {
  test('keeps approval actionable when the socket cannot send it', async () => {
    Socket.last.readyState = 3;
    renderWithI18n(<BinaryConsentPrompt item={item()} threadId="thread" actionable />);
    await userEvent.click(
      page.getByRole('button', { name: 'Trust source and continue', exact: true }),
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByText('Approved without verification')).toBeNull();
    expect(Socket.last.sent.map((frame) => JSON.parse(frame))).not.toContainEqual(
      expect.objectContaining({ op: 'binary_consent_response' }),
    );
  });

  test('keeps decision buttons within the viewport for a long archive URL', () => {
    renderWithI18n(
      <BinaryConsentPrompt
        item={{ ...item(), archive: `${request.archive}?source=${'abcdef'.repeat(5000)}` }}
        threadId="thread"
        actionable
      />,
    );
    const bounds = screen
      .getByRole('button', { name: 'Trust source and continue', exact: true })
      .getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  test('keeps abandoned approvals closed after the thread becomes live again', () => {
    const model = buildThreadRenderModel(
      [request, { kind: 'status', status: 'spawning', ts: 2 }],
      null,
    );
    const abandoned = model.items[0];
    if (abandoned?.kind !== 'binary_consent') throw new Error('missing approval prompt');
    renderWithI18n(<BinaryConsentPrompt item={abandoned} threadId="thread" actionable />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(Socket.last.sent.map((frame) => JSON.parse(frame))).not.toContainEqual(
      expect.objectContaining({ op: 'binary_consent_response' }),
    );
  });

  test.each([
    ['Trust source and continue', 'granted'],
    ['Not now', 'declined'],
  ] as const)('sends explicit approval choice: %s', async (label, kind) => {
    renderWithI18n(<BinaryConsentPrompt item={item()} threadId="thread" actionable />);
    expect(
      screen.getByRole('alertdialog', { description: /downloads\.example\.com/ }),
    ).toBeTruthy();
    expect(screen.getByText(request.archive).textContent).toBe(request.archive);
    expect(screen.getByText(/will run with your permissions/).textContent).toContain('No checksum');
    expect(
      Socket.last.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.op === 'binary_consent_response'),
    ).toEqual([]);
    await userEvent.click(page.getByRole('button', { name: label, exact: true }));
    expect(Socket.last.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      op: 'binary_consent_response',
      threadId: 'thread',
      requestId: request.requestId,
      outcome: { kind },
    });
  });

  test.each(['granted', 'declined', 'timeout'] as const)(
    'keeps the source and verification warning after %s',
    (decision) => {
      renderWithI18n(<BinaryConsentPrompt item={item(decision)} threadId="thread" actionable />);
      expect(screen.getByText(request.archive).textContent).toBe(request.archive);
      expect(screen.getByText(/will run with your permissions/).textContent).toContain(
        'No checksum',
      );
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(
        screen.getByText(
          decision === 'granted'
            ? 'Approved without verification'
            : decision === 'declined'
              ? 'Not approved'
              : 'Approval request timed out',
        ),
      ).toBeTruthy();
    },
  );

  test('names the actual host when userinfo resembles a trusted domain', () => {
    renderWithI18n(
      <BinaryConsentPrompt
        item={{ ...item(), archive: 'https://downloads.example.com@evil.example/agent.tgz' }}
        threadId="thread"
        actionable
      />,
    );
    expect(screen.getByText('evil.example', { exact: true })).toBeTruthy();
  });

  test('keeps a submitted approval when Escape is pressed before a server echo', async () => {
    renderWithI18n(<BinaryConsentPrompt item={item()} threadId="thread" actionable />);
    await userEvent.click(
      page.getByRole('button', { name: 'Trust source and continue', exact: true }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Approved without verification')).toBeTruthy();
    expect(
      Socket.last.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.op === 'binary_consent_response'),
    ).toEqual([
      {
        op: 'binary_consent_response',
        threadId: 'thread',
        requestId: request.requestId,
        outcome: { kind: 'granted' },
      },
    ]);
  });

  test.each(['escape', 'cancel'] as const)(
    'dismisses an orphaned request locally on %s without a server echo',
    async (action) => {
      renderWithI18n(<BinaryConsentPrompt item={item()} threadId="thread" actionable />);
      expect(screen.getByRole('alertdialog')).toBeTruthy();
      if (action === 'escape') await userEvent.keyboard('{Escape}');
      else await userEvent.click(page.getByRole('button', { name: 'Not now', exact: true }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByText('Not approved')).toBeTruthy();
      expect(Socket.last.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        op: 'binary_consent_response',
        threadId: 'thread',
        requestId: request.requestId,
        outcome: { kind: 'declined' },
      });
    },
  );

  test('disables approval on an inactive thread', () => {
    renderWithI18n(<BinaryConsentPrompt item={item()} threadId="thread" actionable={false} />);
    expect(
      screen.getByRole('button', { name: 'Trust source and continue' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
